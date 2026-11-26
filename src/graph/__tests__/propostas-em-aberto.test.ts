import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Prod 26/11 (Fincasa): "Quais são as minhas propostas em aberto?" (áudio) listou TODAS, inclusive "Cancelada"
 * e "Virou negócio". O `estado` do modelo ("em aberto") não é um status do servidor e era descartado em silêncio
 * (`limparArgs`), então a consulta saía sem filtro. "Em aberto/abertas/pendentes" são um GRUPO de estados não
 * finais: o código filtra, nunca o modelo.
 */

vi.mock("@/lib/scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/scope")>()),
  consultarEscopo: vi.fn(),
}));
vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));
vi.mock("@/lib/acao", () => ({ executarAcao: vi.fn() }));

const { despacharLeituras } = await import("../despachante");
const { LISTAR_PROPOSTAS } = await import("../tools");
const { consultarEscopo } = await import("@/lib/scope");
const escopo = vi.mocked(consultarEscopo);

const gerente = { orgId: "org1", orgName: "Fincasa", kind: "user" as const, userId: "u1", userName: "Olavo" };
const ctx = {
  oferecidas: ["listar_propostas"],
  policy: ["proposal.list"] as never,
  identity: gerente,
  fromPhone: "+5511999990000",
  referencias: null,
  turno: "m1",
  agora: 1_000,
};

const p = (id: string, status: string, estado: string) => ({ id, codigo: `PROP-${id}`, titulo: `Imóvel ${id}`, status, estado });
const TODAS = [
  p("1", "enviada", "Enviada"),
  p("2", "cancelada", "Cancelada"),
  p("3", "convertida", "Virou negócio"),
  p("4", "rascunho", "Rascunho"),
  p("5", "recusada_vendedor", "Recusada"),
  p("6", "expirada", "Expirada"),
  p("7", "visualizada", "Visualizada"),
];

beforeEach(() => {
  vi.clearAllMocks();
  escopo.mockResolvedValue({ items: TODAS, truncated: false });
});

const codigos = (r: Awaited<ReturnType<typeof despacharLeituras>>) =>
  (r.resultados[0]!.items as { codigo: string }[]).map((i) => i.codigo);

describe("listar_propostas: 'em aberto' filtra os estados não finais", () => {
  it.each(["em aberto", "em_aberto", "Em aberto", "abertas", "abertos", "aberta", "pendentes", "pendente", "em andamento"])(
    "estado %j: some cancelada, recusada, virou negócio e expirada",
    async (estado) => {
      const r = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_propostas", args: { estado } }] });
      expect(codigos(r)).toEqual(["PROP-1", "PROP-4", "PROP-7"]);
      // O servidor não conhece "em aberto": a consulta vai sem `estado` (nunca um filtro inventado).
      expect(escopo.mock.calls[0]![0].args).not.toHaveProperty("estado");
    }
  );

  it("estado real continua indo ao servidor", async () => {
    await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_propostas", args: { estado: "cancelada" } }] });
    expect(escopo.mock.calls[0]![0].args).toMatchObject({ estado: "cancelada" });
  });

  it("sem estado: lista tudo, como antes", async () => {
    const r = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_propostas", args: {} }] });
    expect(r.resultados[0]!.items).toHaveLength(5);
    expect(r.resultados[0]!.truncated).toBe(true);
  });

  it("o servidor avisou que há mais: o filtro local não apaga o aviso", async () => {
    escopo.mockResolvedValue({ items: TODAS, truncated: true });
    const r = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_propostas", args: { estado: "em aberto" } }] });
    expect(r.resultados[0]!.truncated).toBe(true);
  });

  it("nenhuma em aberto: lista vazia (não a lista inteira)", async () => {
    escopo.mockResolvedValue({ items: [p("2", "cancelada", "Cancelada"), p("3", "convertida", "Virou negócio")], truncated: false });
    const r = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_propostas", args: { estado: "em aberto" } }] });
    expect(r.resultados[0]!.items).toEqual([]);
  });

  it("consulta direta: 'abertas' e 'em aberto' tiram cancelada, recusada, virou negócio, expirada e arquivada", async () => {
    const { responderConsulta, pedeConsulta } = await import("../consulta");
    const lista = [...TODAS, p("8", "arquivada", "Arquivada")];
    const deps = { acao: vi.fn().mockResolvedValue({ status: 200, body: { items: lista, total: lista.length } }) } as never;
    for (const frase of ["Quais são as minhas propostas em aberto?", "quais são as minhas propostas abertas", "mostra as propostas abertas"]) {
      expect(pedeConsulta(frase), frase).toBe(true);
      const r = await responderConsulta(deps, frase);
      expect(r.reply, frase).toContain("PROP-1");
      expect(r.reply, frase).toContain("PROP-4");
      expect(r.reply, frase).toContain("PROP-7");
      for (const fora of ["PROP-2", "PROP-3", "PROP-5", "PROP-6", "PROP-8"]) expect(r.reply, `${frase} / ${fora}`).not.toContain(fora);
    }
  });

  it("a tool ensina o modelo a pedir 'em_aberto'", () => {
    const d = (LISTAR_PROPOSTAS.def.parameters as { properties: { estado: { description: string } } }).properties.estado.description;
    expect(d).toContain("em_aberto");
  });
});
