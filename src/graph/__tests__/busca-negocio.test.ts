import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * PR-busca-MA — `listar_negocios {busca}` (par do `deal.list` do contractmaker, `docs/max.md`).
 *
 * "Detalhe do negócio TESTE1" tem de funcionar em um turno: o modelo busca pelo nome, a lista numerada
 * alimenta o mapa de referências e o detalhe aponta pelo número. O id nunca passa pelo modelo.
 *
 * Negado antes do permitido (regra 3). O ponto frágil é o CM ANTIGO: ele descarta `busca` em silêncio e
 * devolve a lista inteira. Por isso o despachante filtra localmente (fail-closed) ANTES de numerar: item
 * que não casa nunca ganha número, então nunca pode ser detalhado por engano.
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

const { despacharLeituras } = await import("../despachante");
const { LISTAR_NEGOCIOS, REGISTRO_DE_TOOLS } = await import("../tools");
const { buildSystemPrompt } = await import("../prompt");
const { consultarEscopo } = await import("@/lib/scope");
const escopo = vi.mocked(consultarEscopo);

const gerente = { orgId: "org1", orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "Marcia" };
const corretor = { orgId: "org1", orgName: "RE/MAX Trio", kind: "broker" as const, splitRecipientId: "sr1", label: "Rui" };

const base = { fromPhone: "+5511999990000", turno: "t1", agora: 2_000, referencias: null };
const lista = { ...base, identity: gerente, oferecidas: ["listar_negocios"], policy: ["deal.list"] as never };

const DEALS = [
  { id: "D-ana", titulo: "Apto Rua das Flores", cliente: "Ana Souza", etapa: "Formulário" },
  { id: "D-joao", titulo: "Casa Vila Nova", cliente: "João Silva", etapa: "Em contrato" },
  { id: "D-t1", titulo: "TESTE1", cliente: "Fulano", etapa: "Formulário" },
  { id: "D-t2", titulo: "Cobertura TESTE1 bis", cliente: "Beltrano", etapa: "Assinado" },
];

/** O que um CM ANTIGO faz: ignora `busca` e devolve tudo. */
function cmAntigo(items: unknown[] = DEALS): void {
  escopo.mockResolvedValue({ items: structuredClone(items), truncated: false });
}

const idsNoMapa = (r: Awaited<ReturnType<typeof despacharLeituras>>): string[] => (r.referencias?.itens ?? []).map((i) => i.id);

beforeEach(() => {
  vi.clearAllMocks();
  escopo.mockReset();
});

describe("filtro local — CM antigo que ignora `busca` (fail-closed)", () => {
  it("só os itens que casam são numerados; os outros nunca entram no mapa", async () => {
    cmAntigo();
    const r = await despacharLeituras({ ...lista, chamadas: [{ name: "listar_negocios", args: { busca: "joão" } }] });
    expect(idsNoMapa(r)).toEqual(["D-joao"]);
    expect(r.resultados[0].items).toEqual([expect.objectContaining({ n: 1, titulo: "Casa Vila Nova" })]);
    expect(JSON.stringify(r.resultados)).not.toContain("D-ana");
    expect(JSON.stringify(r.resultados)).not.toContain("Ana Souza");
  });

  it("casa por `titulo` OU por `cliente`", async () => {
    cmAntigo();
    const porCliente = await despacharLeituras({ ...lista, chamadas: [{ name: "listar_negocios", args: { busca: "ana souza" } }] });
    expect(idsNoMapa(porCliente)).toEqual(["D-ana"]);
    const porTitulo = await despacharLeituras({ ...lista, chamadas: [{ name: "listar_negocios", args: { busca: "vila nova" } }] });
    expect(idsNoMapa(porTitulo)).toEqual(["D-joao"]);
  });

  it("sem acento e sem maiúscula: 'joao silva' encontra 'João Silva' e 'TESTE1' encontra 'teste1'", async () => {
    cmAntigo();
    const a = await despacharLeituras({ ...lista, chamadas: [{ name: "listar_negocios", args: { busca: "joao silva" } }] });
    expect(idsNoMapa(a)).toEqual(["D-joao"]);
    const b = await despacharLeituras({ ...lista, chamadas: [{ name: "listar_negocios", args: { busca: "  JOÃO   SILVA " } }] });
    expect(idsNoMapa(b)).toEqual(["D-joao"]);
    cmAntigo([{ id: "D-x", titulo: "teste1", cliente: "Zé" }, { id: "D-y", titulo: "Outro", cliente: "Zé" }]);
    const c = await despacharLeituras({ ...lista, chamadas: [{ name: "listar_negocios", args: { busca: "TESTE1" } }] });
    expect(idsNoMapa(c)).toEqual(["D-x"]);
  });

  it("nenhum casa: lista vazia e mapa vazio, sem reaproveitar a lista de antes", async () => {
    cmAntigo();
    const anterior = { criadoEm: 1_000, turno: "t0", itens: [{ n: 1, tipo: "negocio" as const, id: "D-velho", rotulo: "Velho" }] };
    const r = await despacharLeituras({ ...lista, referencias: anterior, chamadas: [{ name: "listar_negocios", args: { busca: "inexistente" } }] });
    expect(r.resultados[0].items).toEqual([]);
    expect(r.referencias?.itens).toEqual([]);
    expect(r.trilha[0].outcome).toBe("ok");
  });

  it("2 ou mais casam: lista numerada, e nada é escolhido sozinho", async () => {
    cmAntigo();
    const r = await despacharLeituras({ ...lista, chamadas: [{ name: "listar_negocios", args: { busca: "teste1" } }] });
    expect(idsNoMapa(r)).toEqual(["D-t1", "D-t2"]);
    expect(r.resultados[0].items).toEqual([
      expect.objectContaining({ n: 1, titulo: "TESTE1" }),
      expect.objectContaining({ n: 2, titulo: "Cobertura TESTE1 bis" }),
    ]);
    // Só a consulta da lista: nenhum detalhe foi disparado.
    expect(escopo).toHaveBeenCalledTimes(1);
  });

  it("sem `busca` a lista segue inteira (comportamento de sempre)", async () => {
    cmAntigo();
    const r = await despacharLeituras({ ...lista, chamadas: [{ name: "listar_negocios", args: {} }] });
    expect(idsNoMapa(r)).toEqual(["D-ana", "D-joao", "D-t1", "D-t2"]);
  });

  it("`busca` vazia ou só espaços não filtra", async () => {
    cmAntigo();
    const r = await despacharLeituras({ ...lista, chamadas: [{ name: "listar_negocios", args: { busca: "   " } }] });
    expect(idsNoMapa(r)).toEqual(["D-ana", "D-joao", "D-t1", "D-t2"]);
    expect(escopo.mock.calls[0][0].args).not.toHaveProperty("busca");
  });

  it("item sem `titulo` nem `cliente` string não casa", async () => {
    cmAntigo([{ id: "D-a", etapa: "X" }, { id: "D-b", titulo: 7, cliente: null }, { id: "D-c", titulo: "TESTE1" }]);
    const r = await despacharLeituras({ ...lista, chamadas: [{ name: "listar_negocios", args: { busca: "teste1" } }] });
    expect(idsNoMapa(r)).toEqual(["D-c"]);
  });
});

describe("o que vai ao CM", () => {
  it("`busca` com mais de 80 caracteres é cortada em 80 antes do envio", async () => {
    cmAntigo();
    await despacharLeituras({ ...lista, chamadas: [{ name: "listar_negocios", args: { busca: "x".repeat(200) } }] });
    const enviada = escopo.mock.calls[0][0].args?.busca as string;
    expect(enviada).toHaveLength(80);
  });

  it("o termo vai aparado ao CM", async () => {
    cmAntigo();
    await despacharLeituras({ ...lista, chamadas: [{ name: "listar_negocios", args: { busca: "  TESTE1  " } }] });
    expect(escopo.mock.calls[0][0].args?.busca).toBe("TESTE1");
  });

  it("BROKER com `busca`: NENHUMA chamada ao CM; lista vazia, marcada como busca indisponível, mapa vazio", async () => {
    escopo.mockResolvedValue({
      items: [{ id: "D1", etapa: "Documentação", referencia: "Negócio #AAAAAA" }],
      truncated: false,
    });
    const r = await despacharLeituras({
      ...lista, identity: corretor, chamadas: [{ name: "listar_negocios", args: { busca: "TESTE1" } }],
    });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados).toEqual([expect.objectContaining({ tool: "listar_negocios", items: [], truncated: false, buscaIndisponivel: true })]);
    expect(idsNoMapa(r)).toEqual([]);
    expect(r.trilha).toEqual([expect.objectContaining({ name: "listar_negocios", outcome: "busca_indisponivel" })]);
  });

  it("BROKER com `busca` só de espaços: sem busca, a lista dele segue normal", async () => {
    escopo.mockResolvedValue({
      items: [{ id: "D1", etapa: "Documentação", referencia: "Negócio #AAAAAA" }],
      truncated: false,
    });
    const r = await despacharLeituras({
      ...lista, identity: corretor, chamadas: [{ name: "listar_negocios", args: { busca: "   " } }],
    });
    expect(escopo).toHaveBeenCalledTimes(1);
    expect(escopo.mock.calls[0][0].args).not.toHaveProperty("busca");
    expect(r.resultados[0]).not.toHaveProperty("buscaIndisponivel");
    expect(idsNoMapa(r)).toEqual(["D1"]);
  });
});

describe("um turno: buscar pelo nome e detalhar pelo número", () => {
  it("listar_negocios {busca} e depois detalhar_negocio {numero:1} resolve o id certo", async () => {
    cmAntigo();
    const comTudo = { ...lista, oferecidas: ["listar_negocios", "detalhar_negocio"], policy: ["deal.list", "deal.detail"] as never };
    const primeira = await despacharLeituras({ ...comTudo, chamadas: [{ name: "listar_negocios", args: { busca: "joao silva" } }] });
    expect(idsNoMapa(primeira)).toEqual(["D-joao"]);

    escopo.mockReset();
    escopo.mockResolvedValue({ items: [{ id: "D-joao", etapa: "Em contrato", pendencias: [] }], truncated: false });
    const segunda = await despacharLeituras({
      ...comTudo, referencias: primeira.referencias, chamadas: [{ name: "detalhar_negocio", args: { numero: 1 } }],
    });
    expect(escopo).toHaveBeenCalledTimes(1);
    expect(escopo.mock.calls[0][0].verb).toBe("deal.detail");
    expect(escopo.mock.calls[0][0].args).toEqual({ negocio_id: "D-joao" });
    expect(segunda.trilha[0].outcome).toBe("ok");
  });

  it("depois de uma busca sem resultado, o número 1 não aponta para a lista de antes", async () => {
    cmAntigo();
    const comTudo = { ...lista, oferecidas: ["listar_negocios", "detalhar_negocio"], policy: ["deal.list", "deal.detail"] as never };
    const anterior = { criadoEm: 1_000, turno: "t0", itens: [{ n: 1, tipo: "negocio" as const, id: "D-velho", rotulo: "Velho" }] };
    const vazia = await despacharLeituras({ ...comTudo, referencias: anterior, chamadas: [{ name: "listar_negocios", args: { busca: "inexistente" } }] });
    escopo.mockReset();
    const detalhe = await despacharLeituras({
      ...comTudo, referencias: vazia.referencias, chamadas: [{ name: "detalhar_negocio", args: { numero: 1 } }],
    });
    expect(escopo).not.toHaveBeenCalled();
    expect(detalhe.trilha[0].outcome).toBe("referencia_invalida");
  });
});

describe("schema e prompt", () => {
  it("`listar_negocios` aceita `busca` com maxLength 80 e diz quando usar", () => {
    const props = (LISTAR_NEGOCIOS.def.parameters as { properties: Record<string, { type?: string; maxLength?: number; description?: string }> }).properties;
    expect(props.busca).toBeDefined();
    expect(props.busca.type).toBe("string");
    expect(props.busca.maxLength).toBe(80);
    expect(props.busca.description).toMatch(/nome/i);
    expect(props.busca.description).toMatch(/n[uú]mero da lista/i);
    expect(REGISTRO_DE_TOOLS.some((e) => e.nome === "listar_negocios")).toBe(true);
  });

  it("o prompt manda buscar pelo nome antes de pedir o número", () => {
    const system = buildSystemPrompt({ orgName: "RE/MAX Trio", hits: [] } as never);
    expect(system).toContain("Se o corretor citar o negócio pelo nome, chame listar_negocios com busca antes");
  });
});
