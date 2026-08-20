import { randomUUID } from "node:crypto";
import { query } from "./db";
import { nextDeliveryTime } from "./window";
import { sendText, connectionStatus } from "./zapi";

/**
 * Fila de saída das notificações proativas.
 *
 * Existe porque o ImobPro passou a entregar a qualquer hora: os call-sites de
 * lá só checam a janela 7h–22h no caminho do Newton, que não tem fila. Aqui, a
 * mensagem fora da janela é AGENDADA, não descartada — antes disso, tudo que
 * nascia de madrugada no motor de deal-events era perdido em silêncio.
 */

export interface EnqueueParams {
  orgId: string;
  dedupeKey: string;
  audience: string;
  phone: string;
  recipientName: string;
  title: string;
  body: string;
  linkUrl: string | null;
  dealId: string | null;
  orgName: string;
}

export type EnqueueResult =
  | { status: "queued"; id: string; deliverAfter: Date }
  | { status: "duplicate"; id: string };

export async function enqueue(p: EnqueueParams): Promise<EnqueueResult> {
  const id = randomUUID();
  const deliverAfter = nextDeliveryTime();

  // `ON CONFLICT DO NOTHING` + RETURNING: a linha só volta quando FOI inserida
  // agora. Conflito devolve zero linhas, e aí a chave já existia — que é
  // exatamente a definição de duplicata que o ImobPro espera ver como 409.
  const rows = await query<{ id: string }>(
    `INSERT INTO outbox
       (id, org_id, dedupe_key, audience, phone, recipient_name,
        title, body, link_url, deal_id, org_name, deliver_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      id,
      p.orgId,
      p.dedupeKey,
      p.audience,
      p.phone,
      p.recipientName,
      p.title,
      p.body,
      p.linkUrl,
      p.dealId,
      p.orgName,
      deliverAfter,
    ]
  );

  if (rows.length === 0) {
    const existing = await query<{ id: string }>(
      `SELECT id FROM outbox WHERE dedupe_key = $1`,
      [p.dedupeKey]
    );
    return { status: "duplicate", id: existing[0]?.id ?? "" };
  }

  return { status: "queued", id, deliverAfter };
}

/**
 * Texto que vai pro WhatsApp.
 *
 * O ImobPro manda título, corpo e link SEPARADOS justamente para que a forma
 * final seja decidida aqui, onde se sabe qual é o transporte. Com Z-API não há
 * template nem limite de variáveis, então dá pra montar algo legível: negrito
 * no título (markdown do WhatsApp), assinatura da imobiliária, link inteiro.
 */
export function renderMessage(row: {
  title: string;
  body: string;
  link_url: string | null;
  org_name: string;
  recipient_name: string;
}): string {
  const first = row.recipient_name.trim().split(/\s+/)[0] ?? "";
  const hello = first ? `Oi, ${first}! ` : "";
  const parts = [`${hello}*${row.title}*`, row.body];
  if (row.link_url) parts.push(row.link_url);
  if (row.org_name) parts.push(`— ${row.org_name}`);
  return parts.filter(Boolean).join("\n\n");
}

export interface DispatchTotals {
  claimed: number;
  sent: number;
  failed: number;
  /**
   * Havia fila mas a instância estava desemparelhada — nada foi tentado.
   *
   * Campo próprio e não `failed`: a diferença é entre "a mensagem tem problema"
   * e "o CANAL está fora". Somar os dois faria uma queda de instância parecer
   * um lote de mensagens ruins, e é a queda que precisa acordar alguém.
   */
  blocked: number;
}

interface OutboxRow extends Record<string, unknown> {
  id: string;
  phone: string;
  title: string;
  body: string;
  link_url: string | null;
  org_name: string;
  recipient_name: string;
  attempts: number;
  /** O envio COMEÇOU numa tentativa anterior (ver migration 007). */
  send_started_at: string | Date | null;
}

/**
 * Máximo de tentativas antes de desistir. Erro de Z-API costuma ser de rede ou
 * rate limit (transitório) ou número inválido (permanente) — três tentativas
 * separam um do outro sem encher a fila de zumbi.
 */
const MAX_ATTEMPTS = 3;

/**
 * Quanto tempo uma linha pode ficar em `sending` antes de ser considerada
 * órfã. Folga larga sobre o `maxDuration` do cron (60s), pra nunca disputar
 * com uma execução ainda viva.
 */
const SENDING_ORPHAN_MINUTES = 10;

/**
 * Despacha o que está vencido. Chamado pelo cron.
 *
 * **O claim MUDA O ESTADO para `sending`, e é isso que impede o envio duplo.**
 * `FOR UPDATE SKIP LOCKED` sozinho não basta: ele segura o lock só enquanto o
 * statement roda, e como claim e envio são statements separados, entre um e
 * outro a linha voltaria a ficar `pending` e vencida — elegível de novo pra
 * segunda execução do cron. Medido: duas passadas concorrentes despachavam a
 * mesma linha (`attempts` chegava a 2).
 *
 * `sending` é transitório. Quem morrer entre o claim e o envio deixa a linha
 * presa nele — daí a recuperação por `last_attempt_at`, que devolve o órfão ao
 * conjunto reivindicável depois de `SENDING_ORPHAN_MINUTES`.
 */
export async function dispatchDue(limit = 50): Promise<DispatchTotals> {
  const totals: DispatchTotals = { claimed: 0, sent: 0, failed: 0, blocked: 0 };

  /**
   * ── A checagem que faltava ─────────────────────────────────────────────
   *
   * `send-text` numa instância DESEMPARELHADA responde 200 com um `messageId`
   * que nunca chega a lugar nenhum. Sem conferir o estado, a linha virava
   * `sent`, com id de provedor e sem erro — e o log dizia "4 enviadas, 0
   * falhas" enquanto ninguém recebia nada. Aconteceu em 2026-08-04, com quatro
   * mensagens reais.
   *
   * `connectionStatus()` já existia neste arquivo, com um comentário dizendo
   * que era "o ÚNICO jeito de saber se as mensagens estão mesmo saindo", e
   * nunca era chamado.
   *
   * ANTES do claim, de propósito: reivindicar incrementa `attempts`, e uma
   * instância fora do ar por vinte minutos queimaria as três tentativas de toda
   * a fila e marcaria como `failed` mensagens que não têm defeito nenhum.
   *
   * Só custa quando há o que enviar — a maioria das execuções não acha nada e
   * nem chega aqui.
   */
  const [{ due }] = await query<{ due: number }>(
    `SELECT count(*)::int AS due FROM outbox
      WHERE (status = 'pending' AND deliver_after <= now())
         OR (status = 'sending'
             AND last_attempt_at < now() - ($1 || ' minutes')::interval)`,
    [String(SENDING_ORPHAN_MINUTES)]
  );

  if (due > 0) {
    const status = await connectionStatus().catch((err) => {
      // Não conseguir PERGUNTAR não é o mesmo que estar desconectado. Seguir é
      // o comportamento antigo, que ao menos entrega quando está tudo bem.
      console.warn(
        "[outbox] não deu pra checar a instância:",
        err instanceof Error ? err.message : String(err)
      );
      return { connected: true, raw: null };
    });

    if (!status.connected) {
      totals.blocked = due;
      // Ruidoso de propósito: é a única linha que distingue "ninguém tinha o
      // que receber" de "o canal caiu e a fila está represada".
      console.error(
        `[outbox] INSTÂNCIA DESEMPARELHADA — ${due} mensagem(ns) represada(s), nada enviado. ` +
          `A fila não é perdida: volta a sair quando a instância reconectar. ` +
          `Estado: ${JSON.stringify(status.raw)}`
      );
      // Carimba o motivo nas linhas vencidas SEM tocar em status nem attempts:
      // quem for olhar a tabela precisa achar a explicação ali, não só no log.
      await query(
        `UPDATE outbox
            SET last_error = 'instancia z-api desemparelhada — nada foi enviado'
          WHERE status = 'pending' AND deliver_after <= now()`
      );
      return totals;
    }
  }

  const rows = await query<OutboxRow>(
    `UPDATE outbox
        SET status = 'sending', attempts = attempts + 1, last_attempt_at = now()
      WHERE id IN (
        SELECT id FROM outbox
         WHERE (status = 'pending' AND deliver_after <= now())
            OR (status = 'sending'
                AND last_attempt_at < now() - ($2 || ' minutes')::interval)
         ORDER BY deliver_after
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, phone, title, body, link_url, org_name, recipient_name,
                attempts, send_started_at`,
    [limit, String(SENDING_ORPHAN_MINUTES)]
  );
  totals.claimed = rows.length;

  for (const row of rows) {
    /**
     * Órfã COM envio iniciado: a execução anterior morreu entre o `send-text`
     * e o UPDATE final (falha de envio limpa o marcador). Reenviar duplicaria
     * a notificação — liquida como `sent` com a ressalva na linha; a
     * reconciliação de entrega (Fase 4) confirma o desfecho.
     */
    if (row.send_started_at != null) {
      await query(
        `UPDATE outbox
            SET status = 'sent', sent_at = now(),
                last_error = 'envio anterior provavelmente concluído — não reenviado'
          WHERE id = $1`,
        [row.id]
      );
      totals.sent += 1;
      continue;
    }

    try {
      // Marcador ANTES do send — é ele que a retomada de órfã consulta acima.
      await query(`UPDATE outbox SET send_started_at = now() WHERE id = $1`, [
        row.id,
      ]);
      const res = await sendText({ to: row.phone, body: renderMessage(row) });
      /**
       * O UPDATE final ganha um retry local: falhar AQUI (blip do Neon) com a
       * mensagem já entregue deixaria a linha órfã — e era o reenvio duplicado.
       * Duas tentativas curtas resolvem o blip; se ambas falharem, o marcador
       * acima garante que a retomada não reenvia.
       */
      const settle = () =>
        query(
          `UPDATE outbox
              SET status = 'sent', sent_at = now(), provider_message_id = $2, last_error = NULL
            WHERE id = $1`,
          [row.id, res.messageId ?? res.id ?? null]
        );
      await settle().catch(async () => {
        await new Promise((r) => setTimeout(r, 500));
        // Segunda falha NÃO sobe: subir cairia no catch de envio, que limpa o
        // marcador — e o reenvio duplicado voltaria. A linha fica `sending`
        // com o marcador, e a retomada de órfã a liquida sem reenviar.
        await settle().catch((e) =>
          console.warn(
            `[outbox] enviado mas não liquidado (${row.id}) — a retomada fecha:`,
            e instanceof Error ? e.message : String(e)
          )
        );
      });
      totals.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Esgotou as tentativas → `failed` (terminal, visível no painel). Ainda
      // tem crédito → volta pra `pending` com backoff, e o próximo cron pega.
      const exhausted = row.attempts >= MAX_ATTEMPTS;
      await query(
        `UPDATE outbox
            SET status = $2,
                last_error = $3,
                -- Envio FALHOU: limpa o marcador, a retentativa deve reenviar.
                send_started_at = NULL,
                deliver_after = CASE WHEN $2 = 'pending'
                                     THEN now() + ($4 || ' minutes')::interval
                                     ELSE deliver_after END
          WHERE id = $1`,
        [row.id, exhausted ? "failed" : "pending", message.slice(0, 500), String(row.attempts * 5)]
      );
      totals.failed += 1;
    }
  }

  return totals;
}
