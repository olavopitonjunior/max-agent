import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `listar_negocios` com `ordenar` e `naEtapaDesde` (par do ImobPro, docs/max.md
 * §12.2–12.3).
 *
 * O ponto que mais importa aqui é o fail-safe: um ImobPro ANTIGO ignora
 * `ordenar` em silêncio (o Zod dele não é estrito) e devolve a ordem "recentes".
 * Se o Max apresentasse essa lista como "os mais parados", a pessoa agiria sobre
 * a ordem errada — `atualizadoEm` é renovado por qualquer comentário e não diz
 * há quanto tempo o negócio está parado.
 */

vi.mock("@/lib/scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/scope")>()),
  consultarEscopo: vi.fn(),
}));

const { despacharLeituras } = await import("../despachante");
const { LISTAR_NEGOCIOS } = await import("../tools");
const { fenceToolResults } = await import("../prompt");
const { consultarEscopo } = await import("@/lib/scope");
const escopo = vi.mocked(consultarEscopo);

const gerente = { orgId: "org1", orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "Marcia" };
const AGORA = Date.parse("2026-11-10T12:00:00.000Z");
const ctx = {
  oferecidas: ["listar_negocios"],
  policy: ["deal.list"] as never,
  identity: gerente,
  fromPhone: "+5511999990000",
  referencias: null,
  turno: "m1",
  agora: AGORA,
};

const deal = (id: string, naEtapaDesde?: string) => ({
  id,
  etapa: "Documentação",
  pendencias: [],
  atualizadoEm: "2026-11-09T10:00:00.000Z",
  ...(naEtapaDesde ? { naEtapaDesde } : {}),
  titulo: `Negócio ${id}`,
});

const argsEnviados = (i = 0) => escopo.mock.calls[i][0].args;

beforeEach(() => vi.clearAllMocks());

describe("listar_negocios — declaração da tool", () => {
  const params = LISTAR_NEGOCIOS.def.parameters as { properties: Record<string, { type?: string; enum?: string[]; description?: string }>; additionalProperties: boolean };

  it("declara `ordenar` como enum recentes|mais_parados", () => {
    expect(params.properties.ordenar.enum).toEqual(["recentes", "mais_parados"]);
  });

  it("a descrição manda usar mais_parados para 'parados há mais tempo / sem andar / travados'", () => {
    const d = `${LISTAR_NEGOCIOS.def.description} ${params.properties.ordenar.description}`;
    expect(d).toContain("mais_parados");
    expect(d).toMatch(/parados há mais tempo/);
    expect(d).toMatch(/sem andar/);
    expect(d).toMatch(/travados/);
  });

  it("manda apresentar o tempo na etapa como 'há N dias na etapa'", () => {
    expect(LISTAR_NEGOCIOS.def.description).toMatch(/há N dias na etapa/);
    expect(LISTAR_NEGOCIOS.def.description).toMatch(/na_etapa_ha_dias/);
  });

  it("declara `mais` para continuar a página, e segue sem args extras", () => {
    expect(params.properties.mais.type).toBe("boolean");
    expect(params.additionalProperties).toBe(false);
  });
});

describe("selecionarTools — continuação de lista de negócios", () => {
  it("o 'mais' que herda o nome da tool oferece a listar_negocios; sem herança e sem tema, não", async () => {
    const { selecionarTools } = await import("../tools");
    const nomes = (texto: string) => selecionarTools({ policy: ["deal.list"], texto }).tools.map((t) => t.nome);
    expect(nomes("listar_negocios mais")).toContain("listar_negocios");
    expect(nomes("mais")).not.toContain("listar_negocios");
  });
});

describe("despacharLeituras — ordenar e paginação do deal.list", () => {
  it("repassa ordenar=mais_parados ao servidor", async () => {
    escopo.mockResolvedValue({ items: [deal("d1", "2026-10-01T00:00:00.000Z")], truncated: false });
    await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: { ordenar: "mais_parados" } }] });
    expect(escopo.mock.calls[0][0]).toMatchObject({ verb: "deal.list" });
    expect(argsEnviados()).toMatchObject({ ordenar: "mais_parados" });
  });

  it("ordenar fora do enum não vai ao servidor (cai na ordem padrão)", async () => {
    escopo.mockResolvedValue({ items: [deal("d1")], truncated: false });
    await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: { ordenar: "por_valor" } }] });
    expect(argsEnviados()).not.toHaveProperty("ordenar");
  });

  it("sem ordenar, nada muda: não manda a chave", async () => {
    escopo.mockResolvedValue({ items: [deal("d1")], truncated: false });
    const r = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: {} }] });
    expect(argsEnviados()).not.toHaveProperty("ordenar");
    expect(r.resultados[0]).not.toHaveProperty("ordenacao");
  });

  it("o nextCursor do servidor vira continuação e `mais:true` o reenvia, mantendo estado e ordenar", async () => {
    escopo.mockResolvedValueOnce({
      items: [deal("d1", "2026-10-01T00:00:00.000Z")],
      truncated: true,
      nextCursor: "cursor-do-servidor",
    });
    const p1 = await despacharLeituras({
      ...ctx,
      chamadas: [{ name: "listar_negocios", args: { estado: "Documentação", ordenar: "mais_parados" } }],
    });
    expect(p1.resultados[0]).toMatchObject({ hasMore: true });
    expect(JSON.stringify(p1.resultados)).not.toContain("cursor-do-servidor");

    escopo.mockResolvedValueOnce({ items: [deal("d2", "2026-10-05T00:00:00.000Z")], truncated: false });
    // O modelo tenta trocar a ordem e forjar um cursor na continuação: nenhum dos dois vale.
    const p2 = await despacharLeituras({
      ...ctx,
      referencias: p1.referencias,
      chamadas: [{ name: "listar_negocios", args: { mais: true, ordenar: "recentes", cursor: "forjado" } }],
    });
    expect(argsEnviados(1)).toMatchObject({ estado: "Documentação", ordenar: "mais_parados", cursor: "cursor-do-servidor" });
    expect(p2.resultados[0]).toMatchObject({ hasMore: false });
  });

  it("mais_parados força a página no tamanho que o Max mostra (senão o cursor pularia itens)", async () => {
    escopo.mockResolvedValue({ items: [deal("d1", "2026-10-01T00:00:00.000Z")], truncated: false });
    await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: { ordenar: "mais_parados", limite: 10 } }] });
    expect(argsEnviados()).toMatchObject({ ordenar: "mais_parados", limite: 5 });
  });

  it("a lista na ordem padrão NÃO muda: sem limite forçado, sem continuação, `mais` ignorado", async () => {
    escopo.mockResolvedValue({ items: [deal("d1")], truncated: true, nextCursor: "c-padrao" });
    const r = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: { mais: true } }] });
    expect(argsEnviados()).toEqual({});
    expect(r.resultados[0]).not.toHaveProperty("hasMore");
    expect(r.referencias?.continuacao).toBeUndefined();
  });

  it("mais_parados + `mais:true` sem continuação vigente é recusado e não consulta", async () => {
    const r = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: { mais: true, ordenar: "mais_parados" } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0]).toMatchObject({ items: null, hasMore: false });
    expect(r.trilha[0].outcome).toBe("continuacao_invalida");
  });

  it("o pedido interno `opcoes_etapas` continua chegando ao servidor", async () => {
    escopo.mockResolvedValue({ items: [], truncated: false, clarification: { field: "estado", options: ["Formulário"] } });
    await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: { opcoes_etapas: true } }] });
    expect(argsEnviados()).toMatchObject({ opcoes_etapas: true });
  });
});

describe("despacharLeituras — naEtapaDesde vira dias na etapa", () => {
  it("calcula na_etapa_ha_dias no código (o modelo não faz conta de data)", async () => {
    escopo.mockResolvedValue({
      items: [deal("d1", "2026-10-31T12:00:00.000Z"), deal("d2", "2026-11-10T11:00:00.000Z")],
      truncated: false,
    });
    const r = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: { ordenar: "mais_parados" } }] });
    const itens = r.resultados[0].items as { n: number; na_etapa_ha_dias?: number }[];
    expect(itens.map((i) => i.na_etapa_ha_dias)).toEqual([10, 0]);
  });

  it("data inválida ou no futuro não vira número", async () => {
    escopo.mockResolvedValue({
      items: [deal("d1", "lixo"), deal("d2", "2027-01-01T00:00:00.000Z")],
      truncated: false,
    });
    const r = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: {} }] });
    for (const it of r.resultados[0].items as Record<string, unknown>[]) expect(it).not.toHaveProperty("na_etapa_ha_dias");
  });
});

describe("despacharLeituras — fail-safe contra um ImobPro que ignora ordenar", () => {
  it("ordem honrada (naEtapaDesde em todos, crescente): marca a ordenação como disponível", async () => {
    escopo.mockResolvedValue({
      items: [deal("d1", "2026-09-01T00:00:00.000Z"), deal("d2", "2026-10-01T00:00:00.000Z"), deal("d3", "2026-10-01T00:00:00.000Z")],
      truncated: false,
    });
    const r = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: { ordenar: "mais_parados" } }] });
    expect(r.resultados[0].ordenacao).toBe("mais_parados");
  });

  it("CM antigo: itens SEM naEtapaDesde → ordenação indisponível, dita no resultado", async () => {
    escopo.mockResolvedValue({ items: [deal("d1"), deal("d2")], truncated: false });
    const r = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: { ordenar: "mais_parados" } }] });
    expect(r.resultados[0].ordenacao).toBe("indisponivel");
    expect(r.resultados[0].items).toHaveLength(2);
    expect(r.trilha[0].outcome).toBe("ok");
  });

  it("basta UM item sem naEtapaDesde para não afirmar a ordem", async () => {
    escopo.mockResolvedValue({ items: [deal("d1", "2026-09-01T00:00:00.000Z"), deal("d2")], truncated: false });
    const r = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: { ordenar: "mais_parados" } }] });
    expect(r.resultados[0].ordenacao).toBe("indisponivel");
  });

  it("CM intermediário (devolve naEtapaDesde mas ignorou ordenar): ordem não crescente → indisponível", async () => {
    escopo.mockResolvedValue({
      items: [deal("d1", "2026-10-20T00:00:00.000Z"), deal("d2", "2026-09-01T00:00:00.000Z")],
      truncated: false,
    });
    const r = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: { ordenar: "mais_parados" } }] });
    expect(r.resultados[0].ordenacao).toBe("indisponivel");
  });

  it("lista vazia com mais_parados não afirma nada sobre a ordem", async () => {
    escopo.mockResolvedValue({ items: [], truncated: false });
    const r = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: { ordenar: "mais_parados" } }] });
    expect(r.resultados[0]).not.toHaveProperty("ordenacao");
  });

  it("sem pedir ordenar, item sem naEtapaDesde é normal (sem aviso)", async () => {
    escopo.mockResolvedValue({ items: [deal("d1"), deal("d2")], truncated: false });
    const r = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: {} }] });
    expect(r.resultados[0]).not.toHaveProperty("ordenacao");
  });

  it("a continuação (mais:true) de uma lista mais_parados também é conferida", async () => {
    escopo.mockResolvedValueOnce({ items: [deal("d1", "2026-09-01T00:00:00.000Z")], truncated: true, nextCursor: "c1" });
    const p1 = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: { ordenar: "mais_parados" } }] });
    escopo.mockResolvedValueOnce({ items: [deal("d2")], truncated: false });
    const p2 = await despacharLeituras({ ...ctx, referencias: p1.referencias, chamadas: [{ name: "listar_negocios", args: { mais: true } }] });
    expect(p2.resultados[0].ordenacao).toBe("indisponivel");
  });
});

describe("fenceToolResults — o que o modelo lê sobre a ordem", () => {
  const base = { tool: "listar_negocios", items: [{ n: 1, titulo: "Negócio d1" }], truncated: false };

  it("ordenação indisponível: proíbe afirmar 'mais parados' e manda dizer que não dá para ordenar", () => {
    const txt = fenceToolResults([{ ...base, ordenacao: "indisponivel" }]);
    expect(txt).toMatch(/ordena[cç][aã]o por tempo parado N[AÃ]O est[aá] dispon[ií]vel/i);
    expect(txt).toMatch(/N[AÃ]O afirme que/);
    expect(txt).not.toMatch(/do mais parado/);
  });

  it("ordenação honrada: declara a ordem e o campo na_etapa_ha_dias", () => {
    const txt = fenceToolResults([{ ...base, ordenacao: "mais_parados" }]);
    expect(txt).toMatch(/do mais parado ao menos parado/);
    expect(txt).toContain("na_etapa_ha_dias");
    expect(txt).not.toMatch(/N[AÃ]O est[aá] dispon[ií]vel/);
  });

  it("sem `ordenacao`, o texto é o de sempre", () => {
    const txt = fenceToolResults([base]);
    expect(txt).not.toMatch(/mais parado/);
    expect(txt).not.toMatch(/dispon[ií]vel/);
  });
});
