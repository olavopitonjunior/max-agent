import { query } from "./db";
import { reportDeliveryOutcome } from "./cm";
import type { StatusCallback } from "./zapi";

/**
 * Reconciliação de entrega (Fase 4A).
 *
 * `sent` sempre significou só "a Z-API aceitou" — desemparelhada, ela aceita
 * com 200 e `messageId` válido e não entrega nada. Este módulo fecha o laço:
 * o `MessageStatusCallback` confirma o que CHEGOU, o reconcile marca o que
 * ficou sem confirmação, e o desfecho volta ao Contractmaker pela
 * `dedupe_key` — que é a mesma chave dos logs de notificação de lá
 * (`DealNotificationLog`/`UserNotificationDelivery`).
 */

/**
 * Ordem de progresso. Upgrade MONOTÔNICO: os callbacks chegam fora de ordem
 * (READ pode vir antes do RECEIVED da mesma mensagem) e um SENT atrasado não
 * pode regredir um `read`. `unconfirmed` fica no degrau do `sent` de
 * propósito: é "sem notícia", não "não entregue" — um callback atrasado o
 * corrige para `delivered`/`read`.
 */
const RANK: Record<string, number> = {
  sent: 1,
  unconfirmed: 1,
  delivered: 2,
  read: 3,
};

/** SENT/RECEIVED/READ/PLAYED da Z-API → nosso vocabulário. `null` = ignorar. */
export function mapZapiStatus(status: string): "sent" | "delivered" | "read" | null {
  switch (status.toUpperCase()) {
    case "SENT":
      return "sent";
    case "RECEIVED":
      return "delivered";
    case "READ":
    case "PLAYED":
      return "read";
    default:
      return null;
  }
}

const RANK_SQL = `CASE delivery_status
  WHEN 'sent' THEN 1 WHEN 'unconfirmed' THEN 1
  WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END`;

const REPLY_RANK_SQL = RANK_SQL.replace("delivery_status", "reply_delivery_status");

export interface ApplyTotals {
  outbox: number;
  replies: number;
}

/**
 * Aplica um callback de status às duas filas.
 *
 * O id pode ser de uma notificação (`outbox.provider_message_id`) ou de uma
 * resposta do Max (`inbound_queue.reply_message_id`) — o callback não diz
 * qual, então tenta os dois; os índices parciais da 008 tornam os dois
 * baratos. Id desconhecido é o caso NORMAL (mensagens mandadas por humanos
 * pelo mesmo número também geram callback) e é ignorado.
 *
 * O timestamp usado é o `momment` do provedor quando presente — é a hora do
 * EVENTO, não a do processamento; um callback reentregue não empurra
 * `read_at` para frente (COALESCE preserva o primeiro).
 */
export async function applyStatusCallback(cb: StatusCallback): Promise<ApplyTotals> {
  const status = mapZapiStatus(cb.status);
  if (!status) return { outbox: 0, replies: 0 };

  const at = cb.momment ? new Date(cb.momment) : new Date();
  const rank = RANK[status];

  const outboxRows = await query<{ id: string }>(
    `UPDATE outbox
        SET delivery_status = $2,
            delivered_at = CASE WHEN $3 >= 2 THEN COALESCE(delivered_at, $4) ELSE delivered_at END,
            read_at      = CASE WHEN $3 >= 3 THEN COALESCE(read_at, $4)      ELSE read_at END,
            -- Desfecho novo é notícia nova: o report ao Contractmaker
            -- reabre para contar o upgrade (delivered → read).
            reported_at  = CASE WHEN $3 > ${RANK_SQL} THEN NULL ELSE reported_at END
      WHERE provider_message_id = ANY($1)
        AND ${RANK_SQL} < $3
      RETURNING id`,
    [cb.messageIds, status, rank, at]
  );

  const replyRows = await query<{ id: string }>(
    `UPDATE inbound_queue
        SET reply_delivery_status = $2,
            reply_delivered_at = CASE WHEN $3 >= 2 THEN COALESCE(reply_delivered_at, $4) ELSE reply_delivered_at END,
            reply_read_at      = CASE WHEN $3 >= 3 THEN COALESCE(reply_read_at, $4)      ELSE reply_read_at END
      WHERE reply_message_id = ANY($1)
        AND ${REPLY_RANK_SQL} < $3
      RETURNING id`,
    [cb.messageIds, status, rank, at]
  );

  return { outbox: outboxRows.length, replies: replyRows.length };
}

/**
 * `sent` sem callback por este prazo vira `unconfirmed`. Quinze minutos: o
 * RECEIVED chega em segundos com o aparelho online; um WhatsApp offline por
 * minutos é normal, por um quarto de hora é o que a tela precisa mostrar.
 */
const UNCONFIRMED_AFTER_MIN = 15;

export interface ReconcileTotals {
  unconfirmed: number;
  reported: number;
  reportFailed: number;
}

/**
 * A passada de reconciliação — extensão do cron do outbox, não um cron novo.
 *
 * 1. Marca `unconfirmed` o que está `sent` há mais de 15 min sem callback —
 *    com log ruidoso, no padrão do bloco "INSTÂNCIA DESEMPARELHADA".
 * 2. Entrega ao Contractmaker os desfechos ainda não reportados e carimba
 *    `reported_at`. Falha de report NÃO bloqueia nada: `reported_at` fica
 *    nulo e a próxima passada retenta (idempotente do lado de lá pela
 *    dedupe_key). Sem `MAX_WEBHOOK_SECRET` configurada, o report é pulado em
 *    silêncio — é o estado normal até o PR do Contractmaker entrar.
 */
export async function reconcile(): Promise<ReconcileTotals> {
  const totals: ReconcileTotals = { unconfirmed: 0, reported: 0, reportFailed: 0 };

  const viraramUnconfirmed = await query<{ id: string }>(
    `UPDATE outbox
        SET delivery_status = 'unconfirmed'
      WHERE status = 'sent'
        AND delivery_status IS NULL
        AND sent_at < now() - ($1 || ' minutes')::interval
      RETURNING id`,
    [String(UNCONFIRMED_AFTER_MIN)]
  );
  totals.unconfirmed = viraramUnconfirmed.length;
  if (totals.unconfirmed > 0) {
    console.error(
      `[reconcile] ${totals.unconfirmed} notificação(ões) sem confirmação de entrega ` +
        `após ${UNCONFIRMED_AFTER_MIN} min — enviadas à Z-API e sem notícia. Se for geral, ` +
        `suspeite da instância; se for pontual, do número.`
    );
  }

  if (!process.env.MAX_WEBHOOK_SECRET) return totals;

  // Desfechos devendo report: entrega confirmada/lida, sem confirmação, ou a
  // própria falha de envio. `sent` puro NÃO é reportado — o Contractmaker já
  // tratou o 202/409 como assumido; reportá-lo seria um POST de ruído por
  // mensagem. Lote pequeno — o cron roda a cada minuto.
  const devendo = await query<{
    id: string;
    dedupe_key: string;
    status: string;
    delivery_status: string | null;
    provider_message_id: string | null;
    sent_at: Date | null;
    delivered_at: Date | null;
    read_at: Date | null;
  }>(
    `SELECT id, dedupe_key, status, delivery_status, provider_message_id,
            sent_at, delivered_at, read_at
       FROM outbox
      WHERE reported_at IS NULL
        AND (delivery_status IN ('delivered', 'read', 'unconfirmed')
             OR status = 'failed')
      ORDER BY created_at
      LIMIT 50`
  );

  for (const row of devendo) {
    const outcome = row.status === "failed" ? "failed" : row.delivery_status!;
    const at =
      outcome === "read"
        ? row.read_at
        : outcome === "delivered"
          ? row.delivered_at
          : row.sent_at;
    const ok = await reportDeliveryOutcome({
      dedupeKey: row.dedupe_key,
      status: outcome,
      at: (at ?? new Date()).toISOString(),
      providerMessageId: row.provider_message_id,
    });
    if (ok) {
      await query(`UPDATE outbox SET reported_at = now() WHERE id = $1`, [row.id]);
      totals.reported += 1;
    } else {
      totals.reportFailed += 1;
    }
  }

  return totals;
}
