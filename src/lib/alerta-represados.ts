import { query } from "./db";
import { reportAlert, type AlertaDeCanal } from "./cm";
import { log } from "./log";
import { IMOBPRO_ALERT_TIMEOUT_MS } from "./http";

/**
 * Alerta de avisos represados há mais de 24h (decisão do Olavo, 05/10/2026).
 *
 * Represado = `pending` com a marca `template_pendente`: a janela de 24h da
 * Meta está fechada e o template do tipo não está aprovado. Com 72h o aviso
 * expira (`outbox.ts`, `HORAS_PARA_EXPIRAR`). Entre 24h e 72h alguém precisa
 * saber — é o que este e-mail faz, no máximo uma vez por dia.
 *
 * A trava é `connection_state.represados_notified_at` (migration 019): claim
 * atômico ANTES do envio. Duas passadas do cron ao mesmo tempo não mandam dois
 * e-mails. Envio que falha RECUA a trava para "uma hora atrás do prazo" — a
 * retentativa vem em ~1h, não no minuto seguinte: um timeout pode ter
 * entregado o e-mail mesmo assim, e repetir a cada minuto mandaria um por
 * minuto enquanto o receptor estivesse lento.
 *
 * `prazoMs` é o tempo que ainda resta à function. Sem tempo para o timeout do
 * POST, nem tenta: morta no meio do fetch, ela deixaria a trava tomada por 24h
 * sem e-mail nenhum.
 *
 * Nunca lança: alerta quebrado não pode derrubar o despacho.
 */
export const HORAS_ENTRE_ALERTAS = 24;

/**
 * O corpo do alerta, num lugar só: a ORDEM das chaves é parte do contrato
 * HMAC com o ImobPro (vetor fixo em `hmac-parity.test.ts` dos dois repos).
 */
export function alertaDeRepresados(p: {
  at: Date;
  represadas: number;
  maisAntigo: Date;
  expirados: number;
}): AlertaDeCanal {
  return {
    evento: "avisos_represados",
    at: p.at.toISOString(),
    represadas: p.represadas,
    maisAntigo: p.maisAntigo.toISOString(),
    expirados: p.expirados,
    canal: "meta",
  };
}

export async function alertarRepresados(prazoMs = Infinity): Promise<boolean> {
  if (prazoMs < IMOBPRO_ALERT_TIMEOUT_MS + 5_000) return false;
  try {
    const [r] = await query<{ n: number; mais_antigo: Date | null }>(
      `SELECT count(*)::int AS n, min(created_at) AS mais_antigo
         FROM outbox
        WHERE status = 'pending'
          AND last_error LIKE 'template_pendente:%'
          AND created_at < now() - interval '24 hours'`
    );
    if (!r || r.n === 0 || !r.mais_antigo) return false;

    // `::text`: o Date do JS corta em milissegundos e a igualdade do recuo
    // nunca casaria com o microssegundo gravado.
    const claim = await query<{ meu: string }>(
      `UPDATE connection_state
          SET represados_notified_at = now()
        WHERE id
          AND (represados_notified_at IS NULL
               OR represados_notified_at < now() - ($1 || ' hours')::interval)
    RETURNING represados_notified_at::text AS meu`,
      [String(HORAS_ENTRE_ALERTAS)]
    );
    // Sem linha: ou já avisou nas últimas 24h, ou `connection_state` ainda não
    // foi semeada (a primeira observação do cron cria). Nos dois, nada a fazer.
    if (claim.length === 0) return false;

    const [exp] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox
        WHERE status = 'dropped' AND last_error LIKE 'expirado:%'
          AND last_attempt_at > now() - interval '7 days'`
    );

    const ok = await reportAlert(
      alertaDeRepresados({
        at: new Date(),
        represadas: r.n,
        maisAntigo: new Date(r.mais_antigo),
        expirados: exp?.n ?? 0,
      })
    );
    if (!ok) {
      // Só recua a trava que ESTA passada tomou (nunca a de uma mais nova).
      await query(
        `UPDATE connection_state
            SET represados_notified_at = now() - ($1 || ' hours')::interval + interval '1 hour'
          WHERE id AND represados_notified_at = $2::timestamptz`,
        [String(HORAS_ENTRE_ALERTAS), claim[0].meu]
      );
      console.warn("[alerta-represados] envio falhou — nova tentativa em ~1h");
      return false;
    }
    log.info("alerta.represados", { represadas: r.n });
    return true;
  } catch (err) {
    console.error(
      "[alerta-represados] falhou — tenta na próxima passada:",
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}
