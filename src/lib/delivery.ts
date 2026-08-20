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

/**
 * O CASE do SQL é DERIVADO do mesmo RANK — três cópias sincronizadas à mão
 * (mapa JS + duas strings) era corrupção silenciosa esperando um drift
 * (achado do code review): um status novo só no mapa faria o guard comparar
 * contra ELSE 0 e callbacks atrasados regredirem linhas.
 */
function rankSql(column: string): string {
  const whens = Object.entries(RANK)
    .map(([status, rank]) => `WHEN '${status}' THEN ${rank}`)
    .join(" ");
  return `CASE ${column} ${whens} ELSE 0 END`;
}

const RANK_SQL = rankSql("delivery_status");
const REPLY_RANK_SQL = rankSql("reply_delivery_status");

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
        -- 'sent' vindo de callback também é "sem notícia de ENTREGA": número
        -- bloqueado/aparelho morto recebe SENT e nunca RECEIVED — isentá-lo
        -- invisibilizava exatamente o caso que a feature caça (achado do
        -- code review). O que conta é delivered_at.
        AND (delivery_status IS NULL OR delivery_status = 'sent')
        AND delivered_at IS NULL
        AND sent_at < now() - ($1 || ' minutes')::interval
        -- Piso de 24h: o acervo antigo não vira avalanche de unconfirmed no
        -- dia do deploy (a 009 também backfilla, isto é a segunda cerca).
        AND sent_at > now() - interval '24 hours'
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

  /**
   * Orçamento de PAREDE do lote de reports: cada POST pode custar até 8s
   * (IMOBPRO_TIMEOUT_MS) e o cron inteiro tem 60s — 50 reports sequenciais
   * num Contractmaker pendurado matariam a function no meio e calariam até o
   * alarme de instância desemparelhada que loga DEPOIS daqui (achado do code
   * review). O que não coube fica para a próxima passada (1 min).
   */
  const deadline = Date.now() + 20_000;

  /** Depois disso, desiste da linha — cabe a alguém olhar o log. */
  const MAX_REPORT_ATTEMPTS = 10;

  // Desfechos devendo report: entrega confirmada/lida, sem confirmação, ou a
  // própria falha de envio. `sent` puro NÃO é reportado — o Contractmaker já
  // tratou o 202/409 como assumido; reportá-lo seria um POST de ruído por
  // mensagem. `report_attempts` primeiro na ordem: linha condenada não pode
  // monopolizar o lote (head-of-line) — as novas passam na frente das que já
  // falharam.
  const devendo = await query<{
    id: string;
    org_id: string;
    dedupe_key: string;
    status: string;
    delivery_status: string | null;
    provider_message_id: string | null;
    sent_at: Date | null;
    delivered_at: Date | null;
    read_at: Date | null;
    report_attempts: number;
  }>(
    `SELECT id, org_id, dedupe_key, status, delivery_status, provider_message_id,
            sent_at, delivered_at, read_at, report_attempts
       FROM outbox
      WHERE reported_at IS NULL
        AND report_attempts < $1
        AND (delivery_status IN ('delivered', 'read', 'unconfirmed')
             OR status = 'failed')
      ORDER BY report_attempts, created_at
      LIMIT 20`,
    [MAX_REPORT_ATTEMPTS]
  );

  for (const row of devendo) {
    if (Date.now() > deadline) break;
    const outcome = row.status === "failed" ? "failed" : row.delivery_status!;
    const at =
      outcome === "read"
        ? row.read_at
        : outcome === "delivered"
          ? row.delivered_at
          : row.sent_at;
    const resultado = await reportDeliveryOutcome({
      orgId: row.org_id,
      dedupeKey: row.dedupe_key,
      status: outcome,
      at: (at ?? new Date()).toISOString(),
      providerMessageId: row.provider_message_id,
    });

    /**
     * Integração FORA (404 antes do deploy da rota lá, 503 sem secret, rede):
     * não é defeito da linha — nada de queimar report_attempts, e o resto do
     * lote esperaria o mesmo muro. Para tudo e tenta na próxima passada.
     */
    if (resultado === "unavailable") {
      totals.reportFailed += 1;
      break;
    }

    if (resultado === "ok") {
      /**
       * Compare-and-set no que foi DE FATO reportado: um upgrade (delivered →
       * read) que chegar durante o POST zera o reported_at via
       * applyStatusCallback, e um carimbo incondicional aqui engoliria a
       * notícia — o Contractmaker ficaria com "entregue e nunca lida" para
       * sempre (achado do code review). Estado mudou → não carimba → a
       * próxima passada reporta o upgrade.
       */
      await query(
        `UPDATE outbox SET reported_at = now()
          WHERE id = $1
            AND status = $2
            AND delivery_status IS NOT DISTINCT FROM $3`,
        [row.id, row.status, row.delivery_status]
      );
      totals.reported += 1;
    } else {
      // "rejected": o Contractmaker recusou ESTA linha — conta tentativa.
      await query(
        `UPDATE outbox SET report_attempts = report_attempts + 1 WHERE id = $1`,
        [row.id]
      );
      if (row.report_attempts + 1 >= MAX_REPORT_ATTEMPTS) {
        console.error(
          `[reconcile] report desistido após ${MAX_REPORT_ATTEMPTS} tentativas ` +
            `(${row.dedupe_key}) — o Contractmaker não aceitou o desfecho.`
        );
      }
      totals.reportFailed += 1;
    }
  }

  return totals;
}
