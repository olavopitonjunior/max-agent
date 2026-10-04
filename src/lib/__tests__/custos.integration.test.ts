import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

/**
 * Custo do WhatsApp do Max: o `pricing` do status grava no outbox, o
 * `pricing_analytics` da Meta grava em `meta_cost_daily` (só o NOSSO número —
 * a WABA é compartilhada com a FINCasa) e o relatório rateia por imobiliária.
 *
 * Datas fixas em jan/2025: nada que outro arquivo de teste cria cai no período.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const { query } = await import("../db");
const { applyStatusCallback } = await import("../delivery");
const { syncCustosMeta, agregarPontos } = await import("../custos/meta-analytics");
const { relatorioCustos } = await import("../custos/relatorio");

const DIAS = ["2025-01-10", "2025-01-11", "2025-01-12"];
const MAX = "5511970850046";
const FINCASA = "551150281515";
let seq = 0;

async function enviada(o: {
  org: string;
  orgName?: string;
  dia: string;
  template?: string | null;
  entrega?: string | null;
  billable?: boolean | null;
  categoria?: string | null;
  mid?: string;
  /** Instantes ISO (UTC); padrão: meio-dia de `dia`, sem entrega registrada. */
  enviadaEm?: string;
  entregueEm?: string;
}): Promise<string> {
  seq += 1;
  const id = `custo-${seq}`;
  await query(
    `INSERT INTO outbox (id, org_id, dedupe_key, audience, phone, org_name, status, sent_at,
                         template_name, delivery_status, billable, pricing_category, provider_message_id,
                         delivered_at)
     VALUES ($1, $2, $3, 'platform_user', '5511900000077', $4, 'sent',
             COALESCE($11::timestamptz, ($5::date + time '12:00') AT TIME ZONE 'UTC'),
             $6, $7, $8, $9, $10, $12::timestamptz)`,
    [
      id,
      o.org,
      `dk-${id}`,
      o.orgName ?? o.org,
      o.dia,
      o.template === undefined ? "max_formulario_concluido" : o.template,
      o.entrega === undefined ? "delivered" : o.entrega,
      o.billable ?? null,
      o.categoria ?? null,
      o.mid ?? `wamid.${id}`,
      o.enviadaEm ?? null,
      o.entregueEm ?? null,
    ]
  );
  return id;
}

async function custoMeta(dia: string, categoria: string, volume: number, custo: number, tipo = "regular") {
  await query(
    `INSERT INTO meta_cost_daily (day, category, pricing_type, volume, cost, currency)
     VALUES ($1, $2, $3, $4, $5, 'USD')`,
    [dia, categoria, tipo, volume, custo]
  );
}

async function limpar() {
  await query(`DELETE FROM outbox WHERE id LIKE 'custo-%'`);
  await query(`DELETE FROM meta_cost_daily WHERE day BETWEEN '2025-01-01' AND '2025-01-31'`);
}

describe("agregarPontos", () => {
  it("só o número do Max, somado por dia/categoria/tipo, em minúsculas", () => {
    const t = Date.UTC(2025, 0, 10) / 1000;
    const linhas = agregarPontos(
      [
        { start: t, phone_number: "+55 11 97085-0046", pricing_category: "MARKETING", pricing_type: "REGULAR", volume: 2, cost: 0.12 },
        { start: t, phone_number: MAX, pricing_category: "MARKETING", pricing_type: "REGULAR", volume: 1, cost: 0.06 },
        { start: t, phone_number: FINCASA, pricing_category: "MARKETING", pricing_type: "REGULAR", volume: 50, cost: 3 },
        { start: t + 86_400, phone_number: MAX, pricing_category: "UTILITY", pricing_type: "REGULAR", volume: 4, cost: 0.04 },
      ],
      MAX
    );
    expect(linhas).toEqual([
      { day: "2025-01-10", category: "marketing", pricingType: "regular", volume: 3, cost: expect.closeTo(0.18, 6) },
      { day: "2025-01-11", category: "utility", pricingType: "regular", volume: 4, cost: 0.04 },
    ]);
  });
});

d("pricing do status no outbox", () => {
  afterAll(limpar);

  it("grava cobrança e categoria; um status seguinte sem pricing não apaga", async () => {
    await limpar();
    await enviada({ org: "org-a", dia: DIAS[0], entrega: null, mid: "wamid.PRC1" });
    await applyStatusCallback({
      status: "delivered",
      messageIds: ["wamid.PRC1"],
      phone: null,
      momment: Date.now(),
      pricing: { billable: true, category: "marketing", type: "regular" },
    });
    await applyStatusCallback({ status: "read", messageIds: ["wamid.PRC1"], phone: null, momment: Date.now() });
    const [r] = await query<{ billable: boolean; pricing_category: string; pricing_type: string }>(
      `SELECT billable, pricing_category, pricing_type FROM outbox WHERE provider_message_id = 'wamid.PRC1'`
    );
    expect(r).toEqual({ billable: true, pricing_category: "marketing", pricing_type: "regular" });
  });
});

d("syncCustosMeta", () => {
  beforeEach(async () => {
    await limpar();
    vi.stubEnv("META_WABA_ID", "waba-teste");
    vi.stubEnv("META_PHONE_NUMBER_ID", "pnid-teste");
    vi.stubEnv("META_ACCESS_TOKEN", "tok");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  afterAll(limpar);

  function graph(pontos: unknown[], extra: Record<string, unknown> = {}) {
    return vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/pnid-teste?")) return new Response(JSON.stringify({ display_phone_number: "+55 11 97085-0046" }));
      if (u.includes("/waba-teste?")) {
        expect(decodeURIComponent(u)).toContain('dimensions(["PHONE","PRICING_CATEGORY","PRICING_TYPE"])');
        return new Response(
          JSON.stringify({ currency: "usd", pricing_analytics: { data: [{ data_points: pontos }], ...extra } })
        );
      }
      return new Response("{}", { status: 404 });
    });
  }

  it("grava só o número do Max; a releitura do dia SUBSTITUI, dia sem ponto fica", async () => {
    const t10 = Date.UTC(2025, 0, 10) / 1000;
    const t11 = t10 + 86_400;
    await custoMeta("2025-01-09", "marketing", 9, 0.9); // fora da janela relida
    vi.stubGlobal(
      "fetch",
      graph([
        { start: t10, phone_number: MAX, pricing_category: "MARKETING", pricing_type: "REGULAR", volume: 2, cost: 0.12 },
        { start: t10, phone_number: FINCASA, pricing_category: "MARKETING", pricing_type: "REGULAR", volume: 40, cost: 2.4 },
        { start: t11, phone_number: MAX, pricing_category: "UTILITY", pricing_type: "REGULAR", volume: 3, cost: 0.03 },
      ])
    );
    const r = await syncCustosMeta(new Date("2025-01-11T15:00:00Z"), 3);
    expect(r).toMatchObject({ numero: "…0046", moeda: "USD", linhas: 2, dias: ["2025-01-09", "2025-01-10", "2025-01-11"] });

    // Releitura: dia 10 consolidou com mais volume; dia 11 sumiu da resposta.
    vi.stubGlobal(
      "fetch",
      graph([{ start: t10, phone_number: MAX, pricing_category: "MARKETING", pricing_type: "REGULAR", volume: 3, cost: 0.18 }])
    );
    await syncCustosMeta(new Date("2025-01-11T16:00:00Z"), 3);
    const linhas = await query<{ day: string; category: string; volume: number; cost: string }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, category, volume, cost::text AS cost
         FROM meta_cost_daily WHERE day BETWEEN '2025-01-01' AND '2025-01-31' ORDER BY day`
    );
    expect(linhas).toEqual([
      { day: "2025-01-09", category: "marketing", volume: 9, cost: "0.900000" },
      { day: "2025-01-10", category: "marketing", volume: 3, cost: "0.180000" },
      { day: "2025-01-11", category: "utility", volume: 3, cost: "0.030000" },
    ]);
  });

  it("resposta paginada: recusa em vez de trocar o dia por um pedaço dele", async () => {
    await custoMeta("2025-01-10", "marketing", 9, 0.54);
    const t10 = Date.UTC(2025, 0, 10) / 1000;
    vi.stubGlobal(
      "fetch",
      graph(
        [{ start: t10, phone_number: MAX, pricing_category: "MARKETING", pricing_type: "REGULAR", volume: 1, cost: 0.06 }],
        { paging: { next: "https://graph.facebook.com/next" } }
      )
    );
    await expect(syncCustosMeta(new Date("2025-01-11T15:00:00Z"), 3)).rejects.toThrow(/paginado/);
    const [l] = await query<{ volume: number }>(`SELECT volume FROM meta_cost_daily WHERE day = '2025-01-10'`);
    expect(l.volume).toBe(9);
  });

  it("Meta respondeu, mas nada é do Max: não grava e avisa", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t10 = Date.UTC(2025, 0, 10) / 1000;
    vi.stubGlobal(
      "fetch",
      graph([{ start: t10, phone_number: FINCASA, pricing_category: "MARKETING", pricing_type: "REGULAR", volume: 7, cost: 0.4 }])
    );
    const r = await syncCustosMeta(new Date("2025-01-11T15:00:00Z"), 3);
    expect(r).toMatchObject({ linhas: 0, pontos: 1 });
    expect(aviso.mock.calls.flat().join(" ")).toMatch(/nenhum do Max \(finais: 1515\)/);
    aviso.mockRestore();
  });

  it("sem o número de exibição vindo da Meta, não grava nada", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}))));
    await expect(syncCustosMeta(new Date("2025-01-11T15:00:00Z"), 3)).rejects.toThrow(/número de exibição/);
    const [c] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM meta_cost_daily WHERE day BETWEEN '2025-01-01' AND '2025-01-31'`
    );
    expect(c.n).toBe(0);
  });
});

d("relatorioCustos — rateio por imobiliária", () => {
  beforeEach(limpar);
  afterAll(limpar);

  it("rateia pelo custo unitário do dia, separa sem preço e sem imobiliária, e concilia o volume", async () => {
    // Meta, dia 10: 3 marketing por 0,18 (0,06 cada) e 2 utility por 0,02.
    await custoMeta("2025-01-10", "marketing", 3, 0.18);
    await custoMeta("2025-01-10", "utility", 2, 0.02);
    await custoMeta("2025-01-10", "service", 5, 0, "free_customer_service");

    await enviada({ org: "org-a", orgName: "Ativa", dia: DIAS[0], categoria: "marketing", template: "max_formulario_pendente" });
    await enviada({ org: "org-a", orgName: "Ativa", dia: DIAS[0], categoria: "marketing", template: "max_formulario_pendente" });
    await enviada({ org: "org-b", orgName: "Trio", dia: DIAS[0], categoria: "utility" });
    // Não contam: não entregue, cobrança negada pela Meta, texto livre.
    await enviada({ org: "org-a", dia: DIAS[0], entrega: "sent" });
    await enviada({ org: "org-a", dia: DIAS[0], billable: false });
    await enviada({ org: "org-a", dia: DIAS[0], template: null });
    // Dia 11: a Meta ainda não consolidou.
    await enviada({ org: "org-b", orgName: "Trio", dia: DIAS[1], categoria: "utility" });

    const r = await relatorioCustos({ de: DIAS[0], ate: DIAS[2] });
    expect(r.moeda).toBe("USD");
    expect(r.meta?.total).toEqual({ mensagens: 5, custo: 0.2 });
    expect(r.rateio.total).toEqual({ mensagens: 3, custo: 0.13 });
    expect(r.rateio.porOrg.map((o) => [o.orgName, o.mensagens, o.custo])).toEqual([
      ["Ativa", 2, 0.12],
      ["Trio", 1, 0.01],
    ]);
    expect(r.rateio.porTemplate[0]).toEqual({
      template: "max_formulario_pendente",
      categoria: "marketing",
      mensagens: 2,
      custo: 0.12,
    });
    expect(r.semPreco).toEqual({ mensagens: 1 });
    expect(r.semImobiliaria).toEqual({ mensagens: 2, custo: 0.07 });
    expect(r.conciliacao).toEqual({ volumeMeta: 5, volumeRateado: 3, diferencaPct: 40 });
  });

  it("filtrado por imobiliária: só ela, sem o total da Meta nem o sem-imobiliária", async () => {
    await custoMeta("2025-01-10", "marketing", 2, 0.12);
    await enviada({ org: "org-a", dia: DIAS[0], categoria: "marketing" });
    await enviada({ org: "org-b", dia: DIAS[0], categoria: "marketing" });
    const r = await relatorioCustos({ de: DIAS[0], ate: DIAS[0], orgId: "org-b" });
    expect(r.meta).toBeNull();
    expect(r.semImobiliaria).toBeNull();
    expect(r.conciliacao).toBeNull();
    expect(r.rateio.porOrg.map((o) => o.orgId)).toEqual(["org-b"]);
    expect(r.rateio.total).toEqual({ mensagens: 1, custo: 0.06 });
  });

  it("sem pricing gravado, a categoria vem do template (como a Meta classifica hoje)", async () => {
    await custoMeta("2025-01-10", "marketing", 1, 0.06);
    await query(
      `INSERT INTO wa_template (name, lang, status, category) VALUES ('max_teste_custo', 'pt_BR', 'APPROVED', 'MARKETING')
       ON CONFLICT (name) DO UPDATE SET category = 'MARKETING'`
    );
    try {
      await enviada({ org: "org-a", dia: DIAS[0], template: "max_teste_custo" });
      const r = await relatorioCustos({ de: DIAS[0], ate: DIAS[0] });
      expect(r.rateio.porTemplate).toEqual([{ template: "max_teste_custo", categoria: "marketing", mensagens: 1, custo: 0.06 }]);
    } finally {
      await query(`DELETE FROM wa_template WHERE name = 'max_teste_custo'`);
    }
  });

  it("categoria sem preço no dia (só outra consolidou) fica sem preço, não custo zero", async () => {
    await custoMeta("2025-01-12", "marketing", 1, 0.06);
    await enviada({ org: "org-a", dia: DIAS[2], categoria: "marketing" });
    await enviada({ org: "org-a", dia: DIAS[2], categoria: "utility" });
    const r = await relatorioCustos({ de: DIAS[2], ate: DIAS[2] });
    expect(r.rateio.total).toEqual({ mensagens: 1, custo: 0.06 });
    expect(r.semPreco).toEqual({ mensagens: 1 });
  });

  it("o dia é o da ENTREGA (a Meta cobra na entrega), não o do envio", async () => {
    await custoMeta("2025-01-11", "marketing", 1, 0.06);
    await enviada({
      org: "org-a",
      dia: DIAS[0],
      categoria: "marketing",
      enviadaEm: "2025-01-10T23:59:00Z",
      entregueEm: "2025-01-11T00:01:00Z",
    });
    const r11 = await relatorioCustos({ de: DIAS[1], ate: DIAS[1] });
    expect(r11.rateio.total).toEqual({ mensagens: 1, custo: 0.06 });
    const r10 = await relatorioCustos({ de: DIAS[0], ate: DIAS[0] });
    expect(r10.rateio.total.mensagens).toBe(0);
  });

  it("total da Meta leva custo de qualquer tipo; volume e unitário só o cobrado", async () => {
    await custoMeta("2025-01-10", "marketing", 2, 0.12);
    await custoMeta("2025-01-10", "marketing", 1, 0.05, "free_entry_point");
    const r = await relatorioCustos({ de: DIAS[0], ate: DIAS[0] });
    expect(r.meta?.total).toEqual({ mensagens: 2, custo: 0.17 });
  });
});

d("131047 zera a cobrança da tentativa anterior", () => {
  afterAll(limpar);

  it("a linha volta para a fila sem o pricing do texto livre recusado", async () => {
    await limpar();
    const { applyFalhaDeEnvio } = await import("../delivery");
    await enviada({ org: "org-a", dia: DIAS[0], template: null, entrega: "sent", billable: false, categoria: "service", mid: "wamid.R47" });
    await applyFalhaDeEnvio({ messageId: "wamid.R47", code: 131047, title: "Re-engagement message" });
    const [r] = await query<{ status: string; billable: boolean | null; pricing_category: string | null }>(
      `SELECT status, billable, pricing_category FROM outbox WHERE dedupe_key LIKE 'dk-custo-%' ORDER BY id DESC LIMIT 1`
    );
    expect(r).toEqual({ status: "pending", billable: null, pricing_category: null });
  });
});
