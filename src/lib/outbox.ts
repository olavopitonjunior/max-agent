import { randomUUID } from "node:crypto";
import { query } from "./db";
import { nextDeliveryTime } from "./window";
import { sendText } from "./zapi";

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
}

/**
 * Máximo de tentativas antes de desistir. Erro de Z-API costuma ser de rede ou
 * rate limit (transitório) ou número inválido (permanente) — três tentativas
 * separam um do outro sem encher a fila de zumbi.
 */
const MAX_ATTEMPTS = 3;

/**
 * Despacha o que está vencido. Chamado pelo cron.
 *
 * O claim é atômico (`UPDATE ... RETURNING` com `FOR UPDATE SKIP LOCKED`):
 * duas execuções sobrepostas do cron — que a Vercel pode disparar — não
 * mandam a mesma mensagem duas vezes.
 */
export async function dispatchDue(limit = 50): Promise<DispatchTotals> {
  const totals: DispatchTotals = { claimed: 0, sent: 0, failed: 0 };

  const rows = await query<OutboxRow>(
    `UPDATE outbox SET attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM outbox
         WHERE status = 'pending' AND deliver_after <= now()
         ORDER BY deliver_after
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, phone, title, body, link_url, org_name, recipient_name, attempts`,
    [limit]
  );
  totals.claimed = rows.length;

  for (const row of rows) {
    try {
      const res = await sendText({ to: row.phone, body: renderMessage(row) });
      await query(
        `UPDATE outbox
            SET status = 'sent', sent_at = now(), provider_message_id = $2, last_error = NULL
          WHERE id = $1`,
        [row.id, res.messageId ?? res.id ?? null]
      );
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
