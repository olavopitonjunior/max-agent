/**
 * O espelho local do status de aprovação de cada template na Meta
 * (`wa_template`, migration 016) — o `dispatchDue` decide sem chamar a Graph
 * API a cada linha da fila.
 *
 * Fail-closed por construção: template ausente da tabela, ou com qualquer
 * status diferente de `APPROVED` (`PENDING`, `REJECTED`, `PAUSED`…), NÃO é
 * usado. É o mesmo texto que a migration já documenta.
 */

import { query } from "../db";
import { log } from "../log";

export async function templateAprovado(name: string): Promise<boolean> {
  const rows = await query<{ status: string }>(`SELECT status FROM wa_template WHERE name = $1`, [name]);
  return rows[0]?.status === "APPROVED";
}

/**
 * Aplica o que o webhook `message_template_status_update` da Meta informou.
 * `UPSERT`: o primeiro evento de um template ainda não submetido por este
 * serviço (submissão manual no Business Manager, por exemplo) cria a linha —
 * o dispatch não pode continuar fail-closed por falta de registro que a
 * própria Meta já confirmou.
 */
export async function applyTemplateStatusUpdate(u: {
  name: string;
  lang: string;
  status: string;
  metaId: string | null;
  reason: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO wa_template (name, lang, status, meta_id, rejected_reason, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (name) DO UPDATE
        SET lang = EXCLUDED.lang,
            status = EXCLUDED.status,
            meta_id = COALESCE(EXCLUDED.meta_id, wa_template.meta_id),
            rejected_reason = EXCLUDED.rejected_reason,
            updated_at = now()`,
    [u.name, u.lang, u.status, u.metaId, u.status === "REJECTED" ? u.reason : null]
  );
  log.info("templates.status_atualizado", { name: u.name, status: u.status, reason: u.reason });
}
