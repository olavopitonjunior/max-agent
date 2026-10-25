import { db } from "./db";
import { KINDS_ATIVIDADE, templatesDoKind } from "./templates/catalog";

/**
 * Aviso NEUTRO de atividades pendentes (decisão do Olavo, 14/10/2026).
 *
 * Fora da janela de 24h da Meta, as atividades de uma pessoa não viram um
 * template por atividade: sai UM aviso ("Você tem atividades pendentes…", com
 * botão para o app) e as linhas seguintes do mesmo telefone, com a janela
 * ainda fechada, são omitidas (`dropped`, ver `outbox.ts`).
 *
 * Premissa (o Olavo pode vetar): se a pessoa não escrever de volta, o aviso
 * rearma 24h depois do ÚLTIMO aviso neutro. O botão abre o app web, não a
 * conversa — a janela não reabre sozinha, e sem o rearme a pessoa receberia um
 * único aviso no WhatsApp para sempre.
 */
export const HORAS_REARME_AVISO_NEUTRO = 24;

export interface EstadoDoAvisoNeutro {
  /** Instante do último aviso neutro vivo para este telefone (`sent_at`, ou o início do envio em curso); `null` = nunca. */
  ultimoAvisoEm: Date | null;
  /** `conversation_window.last_inbound_at` do telefone; `null` = a pessoa nunca escreveu. */
  ultimaEntradaEm: Date | null;
  agora: Date;
}

/**
 * Já houve aviso neutro DEPOIS de `max(última entrada, agora − 24h)`?
 *
 * Com a janela fechada, `última entrada ≤ agora − 24h` e o `max` se reduz ao
 * rearme de 24h; ele fica explícito porque é a regra como o Olavo a descreveu
 * ("depois que a janela fechou") e protege de um `last_inbound_at` no futuro
 * por relógio do provedor. Exatamente 24h depois já pode avisar de novo.
 */
export function jaAvisadoNestaJanela(e: EstadoDoAvisoNeutro): boolean {
  if (!e.ultimoAvisoEm) return false;
  const rearme = e.agora.getTime() - HORAS_REARME_AVISO_NEUTRO * 3_600_000;
  const corte = Math.max(rearme, e.ultimaEntradaEm?.getTime() ?? Number.NEGATIVE_INFINITY);
  return e.ultimoAvisoEm.getTime() > corte;
}

/**
 * Decide E RESERVA, de forma atômica por telefone, o direito de mandar o aviso
 * neutro. `true` = esta linha pode enviar (e já está marcada `send_started_at`
 * + `template_name`, que é o que a próxima chamada enxerga); `false` = o
 * telefone já foi avisado nesta janela.
 *
 * Por que lock: duas invocações sobrepostas do cron reivindicam linhas
 * DIFERENTES (`FOR UPDATE SKIP LOCKED`) e podem processar o mesmo telefone em
 * paralelo. No READ COMMITTED as duas leriam "nenhum aviso" e as duas enviariam
 * o template (pago em dobro). O `pg_advisory_xact_lock` serializa por telefone
 * e solta no COMMIT; a reserva é gravada ANTES do COMMIT, então quem pega o
 * lock depois já a enxerga. O lock não depende de linha nenhuma, por isso
 * funciona também para a primeira linha do telefone.
 *
 * Lança em falha de banco; o chamador trata como "não sei" e NÃO envia.
 */
export async function reservarAvisoNeutro(p: {
  rowId: string;
  phone: string;
  templateName: string;
}): Promise<boolean> {
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`atividades_pendentes:${p.phone}`]);
    // Qualquer versão do aviso conta como "já avisado" (v1 e v2 coexistem
    // durante a transição): senão o v2 aprovado mandaria um segundo aviso na
    // mesma janela a quem acabou de receber o v1.
    const nomes = [
      ...new Set([p.templateName, ...KINDS_ATIVIDADE.flatMap((k) => templatesDoKind(k).map((d) => d.name))]),
    ];
    const r = await c.query<{ ultimo_aviso: Date | null; ultima_entrada: Date | null; agora: Date }>(
      `SELECT (SELECT max(COALESCE(sent_at, send_started_at))
                 FROM outbox
                WHERE phone = $1 AND template_name = ANY($2::text[]) AND id <> $3
                  AND (status = 'sent' OR (status = 'sending' AND send_started_at IS NOT NULL))) AS ultimo_aviso,
              (SELECT last_inbound_at FROM conversation_window WHERE phone = $1) AS ultima_entrada,
              now() AS agora`,
      [p.phone, nomes, p.rowId]
    );
    const e = r.rows[0];
    const ja = jaAvisadoNestaJanela({
      ultimoAvisoEm: e.ultimo_aviso,
      ultimaEntradaEm: e.ultima_entrada,
      agora: e.agora,
    });
    if (!ja) {
      await c.query(`UPDATE outbox SET send_started_at = now(), template_name = $2 WHERE id = $1`, [
        p.rowId,
        p.templateName,
      ]);
    }
    await c.query("COMMIT");
    return !ja;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}
