/**
 * Custo do WhatsApp do Max no período: o total REAL da Meta
 * (`meta_cost_daily`) e o rateio por imobiliária e por template, a partir do
 * outbox.
 *
 * Rateio: cada template ENTREGUE e cobrável vale o custo unitário daquele dia
 * naquela categoria (custo ÷ volume cobrado, só `regular`). O que a Meta
 * cobrou e o rateio não explica é "sem imobiliária" — e a diferença de volume
 * é a conciliação: perto de zero, o rateio é confiável.
 *
 * Cobrável: a Meta cobra template ENTREGUE. `billable` vem do status (migration
 * 018); antes dele, todo template conta — o outbox só manda template com a
 * janela de 24h fechada, que é justamente quando a Meta cobra. A categoria é a
 * da cobrança (`pricing_category`), senão a do template hoje.
 */
import { query } from "../db";

export interface Valor {
  mensagens: number;
  custo: number;
}

export interface RelatorioCustos {
  de: string;
  ate: string;
  moeda: string;
  /** Último dia com dado da Meta (a Meta consolida com atraso). */
  atualizadoAte: string | null;
  /** Total real da Meta no período — `null` quando filtrado por imobiliária. */
  meta: { total: Valor; porCategoria: Array<Valor & { categoria: string }> } | null;
  rateio: {
    total: Valor;
    porOrg: Array<Valor & { orgId: string; orgName: string; porCategoria: Record<string, Valor> }>;
    porTemplate: Array<Valor & { template: string; categoria: string }>;
  };
  /** Enviados em dias que a Meta ainda não consolidou: contados, sem preço. */
  semPreco: { mensagens: number };
  /** O que a Meta cobrou e o rateio não explica — `null` com filtro de org. */
  semImobiliaria: Valor | null;
  conciliacao: { volumeMeta: number; volumeRateado: number; diferencaPct: number | null } | null;
}

const arred = (n: number) => Math.round(n * 1e6) / 1e6;

/** `de` e `ate` são dias UTC inclusivos (YYYY-MM-DD). */
export async function relatorioCustos(p: { de: string; ate: string; orgId?: string | null }): Promise<RelatorioCustos> {
  const orgId = p.orgId ?? null;

  // Volume e custo unitário: só `regular` (o cobrado). O total em dinheiro
  // leva TODOS os tipos — se a Meta passar a cobrar outro, ele não some.
  const meta = await query<{ day: string; category: string; volume: number; cost: string; cost_all: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, category,
            COALESCE(SUM(volume) FILTER (WHERE pricing_type = 'regular'), 0)::int AS volume,
            COALESCE(SUM(cost) FILTER (WHERE pricing_type = 'regular'), 0)::text AS cost,
            SUM(cost)::text AS cost_all
       FROM meta_cost_daily
      WHERE day BETWEEN $1::date AND $2::date
      GROUP BY day, category`,
    [p.de, p.ate]
  );
  const [ultimo] = await query<{ day: string | null; currency: string | null }>(
    `SELECT to_char(MAX(day), 'YYYY-MM-DD') AS day,
            (SELECT currency FROM meta_cost_daily WHERE currency <> '' ORDER BY day DESC LIMIT 1) AS currency
       FROM meta_cost_daily`
  );

  const nossas = await query<{
    day: string;
    org_id: string;
    org_name: string;
    template: string;
    categoria: string;
    n: number;
  }>(
    // Dia da ENTREGA (a Meta cobra na entrega), em UTC como o analytics. O
    // filtro de período vai pelo envio com 1 dia de folga (usa o índice).
    `SELECT to_char((COALESCE(o.delivered_at, o.sent_at) AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
            o.org_id,
            MAX(o.org_name) AS org_name,
            o.template_name AS template,
            COALESCE(o.pricing_category, lower(w.category), 'utility') AS categoria,
            COUNT(*)::int AS n
       FROM outbox o
       LEFT JOIN wa_template w ON w.name = o.template_name
      WHERE o.template_name IS NOT NULL
        AND o.status = 'sent'
        AND o.delivery_status IN ('delivered', 'read')
        AND o.billable IS NOT FALSE
        AND COALESCE(o.pricing_type, 'regular') = 'regular'
        AND o.sent_at >= (($1::date - 1)::timestamp AT TIME ZONE 'UTC')
        AND o.sent_at <  (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
        AND (COALESCE(o.delivered_at, o.sent_at) AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR o.org_id = $3)
      GROUP BY 1, 2, 4, 5`,
    [p.de, p.ate, orgId]
  );

  // Custo unitário por (dia, categoria).
  const unit = new Map<string, number>();
  const metaPorCat = new Map<string, Valor>();
  const metaTotal: Valor = { mensagens: 0, custo: 0 };
  for (const m of meta) {
    const custoTotal = Number(m.cost_all);
    if (m.volume > 0) unit.set(`${m.day}|${m.category}`, Number(m.cost) / m.volume);
    const c = metaPorCat.get(m.category) ?? { mensagens: 0, custo: 0 };
    c.mensagens += m.volume;
    c.custo += custoTotal;
    metaPorCat.set(m.category, c);
    metaTotal.mensagens += m.volume;
    metaTotal.custo += custoTotal;
  }

  const porOrg = new Map<string, Valor & { orgId: string; orgName: string; porCategoria: Record<string, Valor> }>();
  const porTemplate = new Map<string, Valor & { template: string; categoria: string }>();
  const total: Valor = { mensagens: 0, custo: 0 };
  let semPreco = 0;
  let volumeRateado = 0;

  for (const r of nossas) {
    // Sem preço da Meta para (dia, categoria) — o dia não consolidou, ou só
    // outra categoria consolidou: conta, mas não vira custo zero.
    const u = unit.get(`${r.day}|${r.categoria}`);
    if (u === undefined) {
      semPreco += r.n;
      continue;
    }
    const custo = r.n * u;
    volumeRateado += r.n;
    total.mensagens += r.n;
    total.custo += custo;

    const o = porOrg.get(r.org_id) ?? { orgId: r.org_id, orgName: r.org_name, mensagens: 0, custo: 0, porCategoria: {} };
    o.mensagens += r.n;
    o.custo += custo;
    const oc = o.porCategoria[r.categoria] ?? { mensagens: 0, custo: 0 };
    oc.mensagens += r.n;
    oc.custo += custo;
    o.porCategoria[r.categoria] = oc;
    porOrg.set(r.org_id, o);

    const tk = `${r.template}|${r.categoria}`;
    const t = porTemplate.get(tk) ?? { template: r.template, categoria: r.categoria, mensagens: 0, custo: 0 };
    t.mensagens += r.n;
    t.custo += custo;
    porTemplate.set(tk, t);
  }

  const v = (x: Valor): Valor => ({ mensagens: x.mensagens, custo: arred(x.custo) });
  const global = orgId === null;
  return {
    de: p.de,
    ate: p.ate,
    moeda: ultimo?.currency ?? "",
    atualizadoAte: ultimo?.day ?? null,
    meta: global
      ? {
          total: v(metaTotal),
          porCategoria: [...metaPorCat.entries()]
            .map(([categoria, x]) => ({ categoria, ...v(x) }))
            .sort((a, b) => b.custo - a.custo),
        }
      : null,
    rateio: {
      total: v(total),
      porOrg: [...porOrg.values()]
        .map((o) => ({
          ...o,
          custo: arred(o.custo),
          porCategoria: Object.fromEntries(Object.entries(o.porCategoria).map(([k, x]) => [k, v(x)])),
        }))
        .sort((a, b) => b.custo - a.custo || b.mensagens - a.mensagens),
      porTemplate: [...porTemplate.values()]
        .map((t) => ({ ...t, custo: arred(t.custo) }))
        .sort((a, b) => b.custo - a.custo || b.mensagens - a.mensagens),
    },
    semPreco: { mensagens: semPreco },
    semImobiliaria: global
      ? { mensagens: metaTotal.mensagens - volumeRateado, custo: arred(metaTotal.custo - total.custo) }
      : null,
    conciliacao: global
      ? {
          volumeMeta: metaTotal.mensagens,
          volumeRateado,
          diferencaPct:
            metaTotal.mensagens > 0
              ? Math.round(((metaTotal.mensagens - volumeRateado) / metaTotal.mensagens) * 10000) / 100
              : null,
        }
      : null,
  };
}
