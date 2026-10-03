/**
 * Cálculo das métricas da régua final do Max (goals G1–G5 e guardrails de
 * 02/10/2026 — `~/.claude/plans/max-regua-final.md`). Separado de
 * `scripts/metricas-regua.ts` para ser testável contra o Postgres de teste;
 * o script só lê argumentos e imprime.
 *
 * ── Só leitura, de verdade ───────────────────────────────────────────────
 * Tudo roda dentro de UMA transação `READ ONLY` num client só, conferida por
 * `SHOW transaction_read_only` antes da primeira consulta e sempre desfeita
 * com ROLLBACK. Não `options=-c default_transaction_read_only`: o PgBouncer
 * do Neon recusa esse parâmetro de startup, e um `?options=` na própria URL
 * o sobrescreveria em silêncio (code review de 02/10).
 *
 * ── Janela madura ────────────────────────────────────────────────────────
 * Taxa com prazo ("OK em até 7 dias") só conta quem JÁ teve o prazo inteiro:
 * mensagem de ontem ainda não teve 7 dias e puxaria a taxa para baixo. O
 * denominador de cada uma dessas é "maduro" — e o script mostra o n.
 */

import { Pool, type PoolClient } from "pg";
import { CATALOGO } from "./templates/catalog";
import { graphBase } from "./meta";

export const KINDS_DA_REGUA = Object.keys(CATALOGO);
export const AMOSTRA_MINIMA = 20;

export interface Periodo {
  desde: Date;
  ate: Date;
  org: string | null;
}

/** O que as métricas precisam de uma conexão — o client da transação. */
export type Consulta = Pick<PoolClient, "query">;

/**
 * Abre a transação só-leitura, CONFERE que é só-leitura e entrega o client.
 * Termina sempre em ROLLBACK: não há o que confirmar.
 */
export async function somenteLeitura<T>(url: string, fn: (c: Consulta) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: url, max: 1 });
  const c = await pool.connect();
  try {
    await c.query("BEGIN TRANSACTION READ ONLY");
    const r = await c.query<{ transaction_read_only: string }>("SHOW transaction_read_only");
    if (r.rows[0]?.transaction_read_only !== "on") {
      throw new Error("a transação não é read-only — abortando sem consultar nada");
    }
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
    await pool.end();
  }
}

type Linha = Record<string, unknown>;

async function um<T extends Linha>(c: Consulta, sql: string, params: unknown[]): Promise<T> {
  const r = await c.query(sql, params);
  return (r.rows[0] ?? {}) as T;
}

const n = (v: unknown) => Number(v ?? 0);
const pct = (a: number, b: number) => (b > 0 ? a / b : null);

export interface Metrica {
  goal: string;
  nome: string;
  valor: number | string | null;
  meta: string;
  formato: "pct" | "num" | "horas" | "texto";
  ok: boolean | null;
  /** Tamanho do denominador (o "n" — maduro, quando a métrica tem prazo). */
  amostra: number | null;
  fonte: "max" | "contractmaker" | "meta";
}

export function m(
  goal: string,
  nome: string,
  valor: Metrica["valor"],
  formato: Metrica["formato"],
  meta: string,
  ok: boolean | null,
  amostra: number | null,
  fonte: Metrica["fonte"] = "max"
): Metrica {
  return { goal, nome, valor, formato, meta, ok, amostra, fonte };
}

/** `null` quando não há dado — "sem medida" não é "abaixo da meta". */
const atinge = (v: number | null, alvo: number, maiorMelhor = true) =>
  v == null ? null : maiorMelhor ? v >= alvo : v <= alvo;

export async function metricasDoMax(c: Consulta, a: Periodo): Promise<{ metricas: Metrica[]; lembretes: Linha[] }> {
  // $1 desde, $2 até, $3 org. "Enviado" é `sent_at` preenchido: um `failed`
  // assíncrono da Meta muda o status DEPOIS do envio e mantém o sent_at — tirar
  // essas linhas do denominador inflaria a taxa (code review).
  const base = [a.desde, a.ate, a.org];
  const filtroOrg = `($3::text IS NULL OR org_id = $3)`;
  const noPeriodo = `created_at >= $1 AND created_at < $2 AND ${filtroOrg}`;
  const out: Metrica[] = [];

  // ── G1 Canal confiável ────────────────────────────────────────────────
  const g1 = await um(
    c,
    `SELECT count(*) FILTER (WHERE sent_at IS NOT NULL) AS enviados,
            count(*) FILTER (WHERE sent_at IS NOT NULL AND delivery_status IN ('delivered','read')) AS entregues,
            count(*) FILTER (WHERE error_code BETWEEN 132000 AND 132999
                                OR last_error LIKE 'template_invalido%') AS falha_template
       FROM outbox
      WHERE ${noPeriodo} AND kind = ANY($4)`,
    [...base, KINDS_DA_REGUA]
  );
  const taxaEntrega = pct(n(g1.entregues), n(g1.enviados));
  out.push(m("G1", "avisos da régua entregues/lidos", taxaEntrega, "pct", "≥ 90%", atinge(taxaEntrega, 0.9), n(g1.enviados)));
  out.push(m("G1", "falhas por template inválido (132xxx)", n(g1.falha_template), "num", "0", n(g1.falha_template) === 0, null));

  // Duplicado = a MESMA mensagem (telefone, tipo, negócio, corpo) saindo duas
  // vezes em 10 minutos. Ordem por (sent_at, id): o id é UUID aleatório e
  // não diz quem veio antes. O lado `b` fica preso ao período (+10 min) para
  // não varrer a tabela inteira em produção.
  const dup = await um(
    c,
    `SELECT count(DISTINCT a.id) AS grupos
       FROM outbox a
       JOIN outbox b ON b.phone = a.phone AND b.kind IS NOT DISTINCT FROM a.kind
                    AND b.deal_id IS NOT DISTINCT FROM a.deal_id AND b.body = a.body
                    AND b.sent_at IS NOT NULL
                    AND (b.sent_at, b.id) > (a.sent_at, a.id)
                    AND b.sent_at <= a.sent_at + interval '10 minutes'
                    AND b.created_at >= $1 AND b.created_at < $2::timestamptz + interval '10 minutes'
      WHERE a.sent_at IS NOT NULL AND a.created_at >= $1 AND a.created_at < $2
        AND ($3::text IS NULL OR a.org_id = $3)`,
    base
  );
  out.push(m("G1", "envios duplicados", n(dup.grupos), "num", "0", n(dup.grupos) === 0, null));

  // ── G2 Mensagem da imobiliária ───────────────────────────────────────
  // Só o que saiu por TEMPLATE pede OK. Maduro = enviado há 7 dias ou mais
  // (a validade do OK no `aceite.ts` também é 7 dias, então "OK em 7 dias"
  // é o mesmo que "teve OK").
  const g2 = await um(
    c,
    `SELECT count(*) AS maduras,
            count(*) FILTER (WHERE released_at <= sent_at + interval '7 days') AS aceitas,
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY extract(epoch FROM released_at - sent_at) / 3600
            ) FILTER (WHERE released_at IS NOT NULL) AS mediana_horas
       FROM outbox
      WHERE ${noPeriodo}
        AND kind IN ('manual_message','manual_message_parte')
        AND sent_at IS NOT NULL AND template_name IS NOT NULL
        AND sent_at < least($2::timestamptz, now()) - interval '7 days'`,
    base
  );
  const taxaOk = pct(n(g2.aceitas), n(g2.maduras));
  const mediana = g2.mediana_horas == null ? null : Number(g2.mediana_horas);
  out.push(m("G2", "mensagens com OK em até 7 dias", taxaOk, "pct", "≥ 60%", atinge(taxaOk, 0.6), n(g2.maduras)));
  out.push(m("G2", "mediana até o OK (de quem deu OK)", mediana, "horas", "≤ 24h", atinge(mediana, 24, false), null));

  // ── G3 Onboarding (lado do Max) ──────────────────────────────────────
  const g3 = await um(
    c,
    `SELECT count(*) FILTER (WHERE kind = 'welcome' AND sent_at IS NOT NULL) AS boas_vindas,
            count(*) FILTER (WHERE kind = 'welcome' AND status = 'failed') AS boas_vindas_falhas,
            count(*) FILTER (WHERE kind = 'onboarding_pending' AND sent_at IS NOT NULL) AS lembretes,
            count(*) FILTER (WHERE kind = 'support_handoff' AND sent_at IS NOT NULL) AS repasses
       FROM outbox
      WHERE ${noPeriodo}`,
    base
  );
  const semDestino = await um(
    c,
    `SELECT count(*) AS c FROM conversation_turn
      WHERE ${noPeriodo} AND error = 'duvida_sem_destino'`,
    base
  );
  out.push(m("G3", "boas-vindas enviadas", n(g3.boas_vindas), "num", "100% dos aprovados c/ telefone", null, null));
  out.push(m("G3", "boas-vindas que falharam", n(g3.boas_vindas_falhas), "num", "0", n(g3.boas_vindas_falhas) === 0, null));
  out.push(m("G3", "lembretes de configuração enviados", n(g3.lembretes), "num", "—", null, null));
  out.push(m("G3", "dúvidas repassadas ao Olavo", n(g3.repasses), "num", "—", null, null));
  out.push(m("G3", "dúvidas sem destino", n(semDestino.c), "num", "0", n(semDestino.c) === 0, null));

  // Lembretes MADUROS (7 dias completos), um por org — o contractmaker diz
  // se a org concluiu a configuração nesse prazo.
  const lembretes = (
    await c.query(
      `SELECT org_id, min(sent_at) AS sent_at FROM outbox
        WHERE ${noPeriodo} AND kind = 'onboarding_pending' AND sent_at IS NOT NULL
          AND sent_at < least($2::timestamptz, now()) - interval '7 days'
        GROUP BY org_id`,
      base
    )
  ).rows as Linha[];

  // ── G5 Conversa ──────────────────────────────────────────────────────
  // "Escreveu" é mensagem DIGITADA, fora de grupo: o toque no botão OK ou em
  // "Tenho uma dúvida" é resposta a template, não conversa (code review).
  const g5 = await um(
    c,
    `SELECT count(*) AS receberam,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM inbound_queue i
               WHERE i.from_phone = w.phone
                 AND i.button_payload IS NULL
                 AND i.group_id IS NULL
                 AND i.created_at > w.sent_at
                 AND i.created_at <= w.sent_at + interval '7 days')) AS escreveram
       FROM (SELECT phone, min(sent_at) AS sent_at FROM outbox
              WHERE ${noPeriodo} AND kind = 'welcome' AND sent_at IS NOT NULL
              GROUP BY phone) w
      WHERE w.sent_at < least($2::timestamptz, now()) - interval '7 days'`,
    base
  );
  const taxaConversa = pct(n(g5.escreveram), n(g5.receberam));
  out.push(m("G5", "quem recebeu as boas-vindas e escreveu em 7 dias", taxaConversa, "pct", "≥ 20%", atinge(taxaConversa, 0.2), n(g5.receberam)));

  // ── Guardrails ───────────────────────────────────────────────────────
  const rejeitados = await um(c, `SELECT count(*) AS c FROM wa_template WHERE status = 'REJECTED' AND name LIKE 'max\\_%'`, []);
  out.push(m("guardrail", "templates max_* rejeitados", n(rejeitados.c), "num", "0", n(rejeitados.c) === 0, null));
  // Template reclassificado pela Meta como MARKETING: custo maior, limite de
  // frequência por pessoa (131049) e opção de descadastro.
  const marketing = (
    await c.query(
      `SELECT w.name FROM wa_template w
        WHERE w.name LIKE 'max\\_%' AND w.category = 'MARKETING' AND w.status = 'APPROVED'
          -- A versão que o outbox usa (sem contar o pulo pontual de um
          -- template recusado numa linha): ele prefere uma aprovada não
          -- MARKETING e, entre MARKETING, a mais nova. Outra versão aprovada
          -- não MARKETING, ou uma mais nova aprovada, aposenta esta.
          AND NOT EXISTS (
                SELECT 1 FROM wa_template v
                 WHERE v.status = 'APPROVED'
                   AND v.name <> w.name
                   AND regexp_replace(v.name, '_v[0-9]+$', '') = regexp_replace(w.name, '_v[0-9]+$', '')
                   AND (v.category IS DISTINCT FROM 'MARKETING'
                        OR COALESCE(substring(v.name from '_v([0-9]+)$')::int, 1)
                         > COALESCE(substring(w.name from '_v([0-9]+)$')::int, 1)))
        ORDER BY 1`
    )
  ).rows as Linha[];
  out.push(
    m(
      "guardrail",
      "templates max_* classificados como MARKETING",
      marketing.length ? marketing.map((r) => r.name).join("; ") : "nenhum",
      "texto",
      "nenhum",
      marketing.length === 0,
      null
    )
  );
  // Qualquer status diferente de APPROVED deixa aquele tema mudo fora da janela.
  const naoAprovados = (
    await c.query(
      `SELECT t.name, coalesce(w.status, 'não submetido') AS status
         FROM unnest($1::text[]) AS t(name)
         LEFT JOIN wa_template w ON w.name = t.name
        WHERE w.status IS DISTINCT FROM 'APPROVED'
        ORDER BY 1`,
      [[...new Set(Object.values(CATALOGO).map((d) => d.name))]]
    )
  ).rows as Linha[];
  out.push(
    m(
      "guardrail",
      "templates do catálogo não aprovados",
      naoAprovados.length ? naoAprovados.map((r) => `${r.name} (${r.status})`).join("; ") : "nenhum",
      "texto",
      "nenhum",
      naoAprovados.length === 0,
      null
    )
  );
  // `kind` NULL entra (NOT (NULL = ANY) seria NULL e a linha sumiria); só o
  // que SAIU conta — tentativa que falhou herda `template_name` e não é paga.
  const foraPago = await um(
    c,
    `SELECT count(*) AS c FROM outbox
      WHERE ${noPeriodo} AND sent_at IS NOT NULL AND template_name IS NOT NULL
        AND (kind IS NULL OR NOT (kind = ANY($4)))`,
    [...base, KINDS_DA_REGUA]
  );
  out.push(m("guardrail", "avisos fora da régua pagos (por template)", n(foraPago.c), "num", "0", n(foraPago.c) === 0, null));
  const porOrg = (
    await c.query(
      `SELECT coalesce(nullif(org_name, ''), org_id) AS org, count(*) AS templates
         FROM outbox
        WHERE ${noPeriodo} AND sent_at IS NOT NULL AND template_name IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC`,
      base
    )
  ).rows as Linha[];
  out.push(
    m(
      "guardrail",
      "templates enviados por org (custo)",
      porOrg.length ? porOrg.map((r) => `${r.org}: ${r.templates}`).join("; ") : "nenhum",
      "texto",
      "visível",
      true,
      null
    )
  );

  return { metricas: out, lembretes };
}

/**
 * O lado do contractmaker. As colunas `DateTime` do Prisma são `timestamp`
 * SEM fuso, gravadas em UTC: o parâmetro `timestamptz` é convertido para
 * UTC antes de comparar — sem isso o período escorregava 3h (code review).
 */
export async function metricasDoContractmaker(c: Consulta, a: Periodo, lembretes: Linha[]): Promise<Metrica[]> {
  const out: Metrica[] = [];
  const base = [a.desde, a.ate, a.org];
  const desde = `($1::timestamptz AT TIME ZONE 'UTC')`;
  const ate = `($2::timestamptz AT TIME ZONE 'UTC')`;
  const agora = `(now() AT TIME ZONE 'UTC')`;

  // G3: tenant aprovado no período (há 2 dias ou mais) que concluiu a
  // configuração em até 2 dias.
  const onb = await um(
    c,
    `SELECT count(*) AS aprovados,
            count(*) FILTER (WHERE o."onboardingCompletedAt" <= t."decidedAt" + interval '2 days') AS em_2_dias
       FROM "TenantSignupRequest" t JOIN "Organization" o ON o.id = t."orgId"
      WHERE t.status = 'approved' AND t."decidedAt" >= ${desde} AND t."decidedAt" < ${ate}
        AND t."decidedAt" < least(${ate}, ${agora}) - interval '2 days'
        AND ($3::text IS NULL OR t."orgId" = $3)`,
    base
  );
  const taxa2d = pct(n(onb.em_2_dias), n(onb.aprovados));
  out.push(m("G3", "tenants que concluíram a configuração em até 2 dias", taxa2d, "pct", "≥ 50%", atinge(taxa2d, 0.5), n(onb.aprovados), "contractmaker"));

  // G3: dos lembrados (maduros, vindos do banco do Max), quantos concluíram
  // até 7 dias DEPOIS do lembrete.
  if (lembretes.length > 0) {
    const r = await um(
      c,
      `SELECT count(*) AS concluiram FROM "Organization" o
         JOIN unnest($1::text[], $2::timestamptz[]) AS l(org_id, sent_at) ON l.org_id = o.id
        WHERE o."onboardingCompletedAt" > (l.sent_at AT TIME ZONE 'UTC')
          AND o."onboardingCompletedAt" <= (l.sent_at AT TIME ZONE 'UTC') + interval '7 days'`,
      [lembretes.map((l) => String(l.org_id)), lembretes.map((l) => l.sent_at)]
    );
    const taxa = pct(n(r.concluiram), lembretes.length);
    out.push(m("G3", "lembrados que concluíram em até 7 dias", taxa, "pct", "≥ 25%", atinge(taxa, 0.25), lembretes.length, "contractmaker"));
  } else {
    out.push(m("G3", "lembrados que concluíram em até 7 dias", null, "pct", "≥ 25%", null, 0, "contractmaker"));
  }

  // G4: pesquisa enviada pelo WhatsApp no período (há 7 dias ou mais),
  // respondida.
  const pesq = await um(
    c,
    `SELECT count(*) AS enviadas,
            count(*) FILTER (WHERE "respondedAt" IS NOT NULL) AS respondidas
       FROM "SurveyInvite"
      WHERE "createdAt" >= ${desde} AND "createdAt" < ${ate}
        AND ($3::text IS NULL OR "orgId" = $3)
        AND channel = 'whatsapp' AND "sentAt" IS NOT NULL
        AND "sentAt" < least(${ate}, ${agora}) - interval '7 days'`,
    base
  );
  const taxaPesq = pct(n(pesq.respondidas), n(pesq.enviadas));
  out.push(m("G4", "pesquisas respondidas (WhatsApp)", taxaPesq, "pct", "≥ 30%", atinge(taxaPesq, 0.3), n(pesq.enviadas), "contractmaker"));
  return out;
}

export async function qualidadeDoNumero(): Promise<Metrica> {
  const nome = "quality rating do número";
  const token = process.env.META_ACCESS_TOKEN;
  const numero = process.env.META_PHONE_NUMBER_ID;
  if (!token || !numero) {
    return m("G1", nome, "n/d (sem META_ACCESS_TOKEN/META_PHONE_NUMBER_ID)", "texto", "GREEN", null, null, "meta");
  }
  try {
    const res = await fetch(`${graphBase()}/${numero}?fields=quality_rating`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const corpo = (await res.json()) as { quality_rating?: string; error?: { message?: string } };
    if (!res.ok) {
      return m("G1", nome, `n/d (${corpo.error?.message ?? `HTTP ${res.status}`})`, "texto", "GREEN", null, null, "meta");
    }
    const q = corpo.quality_rating ?? null;
    return m("G1", nome, q, "texto", "GREEN", q == null ? null : q === "GREEN", null, "meta");
  } catch (err) {
    return m("G1", nome, `n/d (${err instanceof Error ? err.message : String(err)})`, "texto", "GREEN", null, null, "meta");
  }
}
