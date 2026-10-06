import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * G2 — referências numeradas pelo CÓDIGO.
 *
 * O que se tranca: o modelo nunca vê id; o número só vale se estiver no mapa
 * vigente (e dentro do prazo); lista mostra no máximo 5; duas listas no mesmo
 * turn não dão dois donos ao mesmo número.
 */

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
}));
vi.mock("@/lib/scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/scope")>()),
  consultarEscopo: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));

const {
  numerarLista,
  resolverReferencia,
  renderizarLista,
  ITENS_POR_LISTA,
  REFERENCIA_TTL_MS,
} = await import("../referencias");
const { buildGraph } = await import("../graph");
const { complete } = await import("@/lib/llm");
const { fetchProfile } = await import("@/lib/cm");
const { consultarEscopo } = await import("@/lib/scope");
const llm = vi.mocked(complete);
const profile = vi.mocked(fetchProfile);
const escopo = vi.mocked(consultarEscopo);

const deal = (i: number) => ({ id: `cdeal0000000000000000000${i}`, titulo: `Rua ${i}`, etapa: "Docs" });

describe("numerarLista", () => {
  it("numera 1..N, tira o id e guarda número → id", () => {
    const r = numerarLista({ items: [deal(1), deal(2)], tipo: "negocio", anterior: null, turno: "t1", agora: 0 });
    expect(r.paraOModelo).toEqual([
      { n: 1, titulo: "Rua 1", etapa: "Docs" },
      { n: 2, titulo: "Rua 2", etapa: "Docs" },
    ]);
    expect(r.mapa.itens).toEqual([
      { n: 1, tipo: "negocio", id: deal(1).id, rotulo: "Rua 1" },
      { n: 2, tipo: "negocio", id: deal(2).id, rotulo: "Rua 2" },
    ]);
  });

  it(`mostra no máximo ${ITENS_POR_LISTA} e conta o que cortou`, () => {
    const items = Array.from({ length: 8 }, (_, i) => deal(i + 1));
    const r = numerarLista({ items, tipo: "negocio", anterior: null, turno: "t1", agora: 0 });
    expect(r.paraOModelo).toHaveLength(5);
    expect(r.mapa.itens).toHaveLength(5);
    expect(r.cortados).toBe(3);
  });

  it("segunda lista no MESMO turn continua a numeração", () => {
    const a = numerarLista({ items: [deal(1)], tipo: "negocio", anterior: null, turno: "t1", agora: 0 });
    const b = numerarLista({
      items: [{ id: "cprop0000000000000000000001", codigo: "P-7", estado: "enviada" }],
      tipo: "proposta",
      anterior: a.mapa,
      turno: "t1",
      agora: 5,
    });
    expect(b.paraOModelo[0].n).toBe(2);
    expect(b.mapa.itens.map((i) => [i.n, i.tipo, i.rotulo])).toEqual([
      [1, "negocio", "Rua 1"],
      [2, "proposta", "P-7"],
    ]);
  });

  it("lista de OUTRO turn reinicia em 1 e substitui o mapa", () => {
    const a = numerarLista({ items: [deal(1), deal(2)], tipo: "negocio", anterior: null, turno: "t1", agora: 0 });
    const b = numerarLista({ items: [deal(9)], tipo: "negocio", anterior: a.mapa, turno: "t2", agora: 10 });
    expect(b.mapa.itens).toEqual([{ n: 1, tipo: "negocio", id: deal(9).id, rotulo: "Rua 9" }]);
    expect(b.mapa.criadoEm).toBe(10);
  });

  it("item sem id não ganha número (número que não aponta pra nada é invenção)", () => {
    const r = numerarLista({
      items: [{ titulo: "sem id" }, deal(1), null, "x"],
      tipo: "negocio",
      anterior: null,
      turno: "t1",
      agora: 0,
    });
    expect(r.mapa.itens.map((i) => i.id)).toEqual([deal(1).id]);
  });

  it("corretor comissionado: o rótulo é a referência (sem título/endereço)", () => {
    const r = numerarLista({
      items: [{ id: "c1x", referencia: "NEG-4F2A", etapa: "Docs" }],
      tipo: "negocio",
      anterior: null,
      turno: "t",
      agora: 0,
    });
    expect(r.mapa.itens[0].rotulo).toBe("NEG-4F2A");
  });
});

describe("resolverReferencia — recusa no código", () => {
  const mapa = numerarLista({
    items: [deal(1), deal(2), deal(3)],
    tipo: "negocio",
    anterior: null,
    turno: "t1",
    agora: 1_000,
  }).mapa;

  it("número no mapa vigente → o item, com o id real", () => {
    const r = resolverReferencia(mapa, 2, { agora: 2_000 });
    expect(r).toEqual({ ok: true, item: { n: 2, tipo: "negocio", id: deal(2).id, rotulo: "Rua 2" } });
    expect(resolverReferencia(mapa, " 3 ", { agora: 2_000 }).ok).toBe(true);
  });

  it.each([
    [4, "fora_da_lista"],
    [0, "fora_da_lista"],
    [-1, "fora_da_lista"],
    [1.5, "fora_da_lista"],
    ["2a", "fora_da_lista"],
    [deal(2).id, "fora_da_lista"],
    [null, "fora_da_lista"],
  ])("referência inventada %s → %s", (n, motivo) => {
    expect(resolverReferencia(mapa, n, { agora: 2_000 })).toEqual({ ok: false, motivo });
  });

  it("sem lista → sem_lista", () => {
    expect(resolverReferencia(null, 1)).toEqual({ ok: false, motivo: "sem_lista" });
  });

  it("depois do TTL → expirada, mesmo com o número certo", () => {
    expect(resolverReferencia(mapa, 1, { agora: 1_000 + REFERENCIA_TTL_MS + 1 })).toEqual({
      ok: false,
      motivo: "expirada",
    });
    // Na borda ainda vale.
    expect(resolverReferencia(mapa, 1, { agora: 1_000 + REFERENCIA_TTL_MS }).ok).toBe(true);
  });

  it("número de negócio usado como proposta → tipo_errado", () => {
    expect(resolverReferencia(mapa, 1, { agora: 2_000, tipo: "proposta" })).toEqual({
      ok: false,
      motivo: "tipo_errado",
    });
  });
});

describe("renderizarLista", () => {
  it("uma linha por item, só número e rótulo", () => {
    const mapa = numerarLista({ items: [deal(1), deal(2)], tipo: "negocio", anterior: null, turno: "t", agora: 0 }).mapa;
    expect(renderizarLista(mapa.itens)).toBe("1. Rua 1\n2. Rua 2");
  });
});

// ── No grafo ───────────────────────────────────────────────────────────────

describe("no grafo: o modelo vê número, o estado guarda o id", () => {
  const gerente = { orgId: "org1", orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "M" };
  const uso = { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true };

  beforeEach(() => {
    vi.clearAllMocks();
    profile.mockResolvedValue({ enabled: true, model: "x", maxPolicy: { byRole: { admin: ["deal.list"] } } } as never);
    escopo.mockResolvedValue({ items: Array.from({ length: 7 }, (_, i) => deal(i + 1)), truncated: false });
    llm
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "listar_negocios", args: {} }], usage: uso } as never)
      .mockResolvedValueOnce({ text: "Você tem estes.", toolCalls: [], usage: uso } as never);
  });

  it("o prompt da segunda volta não tem id; o estado tem o mapa; corte de 5 se declara", async () => {
    const r = await buildGraph().compile().invoke({
      inbound: { fromPhone: "+5511999990000", text: "como estão meus negócios?", messageId: "m1" },
      identity: gerente,
      reply: null, halt: null, draft: null, bloqueios: [], policy: [],
    } as never);

    const system = llm.mock.calls[1][0].system as string;
    expect(system).not.toContain("cdeal");
    expect(system).toContain('"n": 1');
    expect(system).not.toContain('"n": 6');
    expect(system).toContain('truncado="true"');
    expect(r.referencias?.itens).toHaveLength(5);
    expect(r.referencias?.itens[0].id).toBe(deal(1).id);
  });
});
