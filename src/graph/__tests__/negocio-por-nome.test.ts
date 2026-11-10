import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Negócio citado pelo NOME (produção, 10/11/2026, Max Fincasa e Newton):
 *  - "pendências do negócio TESTE assinatura 4" chamou `pendencias_do_negocio`
 *    sem id e o modelo respondeu "sem_permissao";
 *  - "status do contrato do TESTE assinatura 2" listou 5 negócios e perguntou;
 *  - "status do contrato do negócio TESTE1" virou `situacao_contrato{numero:1}`
 *    (o "1" de TESTE1 lido como item de lista) e a resposta foi "tente mais
 *    tarde" para uma falha que nunca é transitória.
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

const { nomeDeNegocioCitado, casarNegociosPorTitulo } = await import("../negocio-por-nome");
const { despacharLeituras } = await import("../despachante");
const { fenceToolResults } = await import("../prompt");
const { consultarEscopo } = await import("@/lib/scope");
const escopo = vi.mocked(consultarEscopo);

const gerente = { orgId: "org1", orgName: "Fincasa", kind: "user" as const, userId: "u1", userName: "Olavo" };

const CARTEIRA = [
  { id: "cd1", titulo: "TESTE assinatura 1 - à vista", etapa: "Formulário" },
  { id: "cd2", titulo: "TESTE assinatura 2 - à vista, casal com cônjuge", etapa: "Formulário" },
  { id: "cd4", titulo: "TESTE assinatura 4", etapa: "Assinatura" },
  { id: "cd40", titulo: "TESTE assinatura 40", etapa: "Assinatura" },
  { id: "cd9", titulo: "TESTE1", etapa: "Docs" },
];

const base = {
  oferecidas: ["pendencias_do_negocio", "situacao_contrato", "detalhar_negocio", "listar_negocios"],
  policy: ["deal.list", "deal.pending", "contract.status", "deal.detail"] as never,
  identity: gerente,
  fromPhone: "+5511999990000",
  referencias: null,
  turno: "m1",
  agora: 1_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MAX_EXTENDED_QUERIES = "true";
});

describe("nomeDeNegocioCitado", () => {
  it.each([
    ["quais as pendências do negócio TESTE assinatura 4?", "TESTE assinatura 4", true],
    ["qual o status do contrato do TESTE assinatura 2?", "TESTE assinatura 2", true],
    ["qual o status do contrato do negócio TESTE1?", "TESTE1", true],
    ["quero mandar o formulário de negócio para o comprador do TESTE assinatura 1", "TESTE assinatura 1", true],
    ["pendências do João Silva", "João Silva", false],
  ])("%s", (texto, frase, explicita) => {
    expect(nomeDeNegocioCitado(texto)).toEqual({ frase, explicita });
  });

  it.each([
    "quais as pendências do negócio?",
    "abre o negócio 3",
    "pendências da semana",
    "status do contrato",
    "quais negócios estão parados?",
  ])("sem nome de negócio: %s", (texto) => {
    expect(nomeDeNegocioCitado(texto)?.explicita ?? false).toBe(false);
    expect(nomeDeNegocioCitado(texto)?.frase ?? null).toBeNull();
  });

  it("minúsculas sem dígito não são 'nome explícito'", () => {
    expect(nomeDeNegocioCitado("pendências do negócio mais antigo")?.explicita).toBe(false);
  });
});

describe("casarNegociosPorTitulo", () => {
  it("prefixo em fronteira de palavra: 'TESTE assinatura 4' não casa o 40", () => {
    expect(casarNegociosPorTitulo("TESTE assinatura 4", CARTEIRA).map((n) => n.id)).toEqual(["cd4"]);
  });
  it("título completo mais longo que a frase", () => {
    expect(casarNegociosPorTitulo("teste assinatura 2", CARTEIRA).map((n) => n.id)).toEqual(["cd2"]);
  });
  it("TESTE1 casa só o negócio TESTE1", () => {
    expect(casarNegociosPorTitulo("TESTE1", CARTEIRA).map((n) => n.id)).toEqual(["cd9"]);
  });
  it("sem casamento: vazio", () => {
    expect(casarNegociosPorTitulo("Maria Souza", CARTEIRA)).toEqual([]);
  });
  it("item sem id ou título não entra", () => {
    expect(casarNegociosPorTitulo("x1", [{ titulo: "x1" }, { id: "a" }, null])).toEqual([]);
  });
});

describe("despacharLeituras com o negócio citado pelo nome", () => {
  it("pendências do negócio X (carteira): responde com a linha do negócio citado, sem id para o modelo", async () => {
    escopo.mockResolvedValueOnce({ items: CARTEIRA, truncated: false });
    const r = await despacharLeituras({
      ...base,
      texto: "quais as pendências do negócio TESTE assinatura 4?",
      chamadas: [{ name: "pendencias_do_negocio", args: { limite: 10 } }],
    });
    expect(escopo).toHaveBeenCalledTimes(1);
    expect(escopo.mock.calls[0][0].verb).toBe("deal.list");
    expect(r.trilha[0].outcome).toBe("ok");
    expect(r.resultados[0].items).toEqual([{ n: 1, titulo: "TESTE assinatura 4", etapa: "Assinatura" }]);
    expect(JSON.stringify(r.resultados)).not.toContain("cd4");
  });

  it("pendências do negócio X (resumo): resolve o id pelo título e o manda como dealId", async () => {
    escopo.mockResolvedValueOnce({ items: CARTEIRA, truncated: false });
    escopo.mockResolvedValueOnce({ items: [{ formularios: { total: 1 } }], truncated: false });
    const r = await despacharLeituras({
      ...base,
      oferecidas: ["minhas_pendencias"],
      policy: ["deal.list", "deal.pending", "pending.summary"] as never,
      texto: "quais as pendências do negócio TESTE assinatura 4?",
      chamadas: [{ name: "minhas_pendencias", args: {} }],
    });
    expect(escopo.mock.calls[0][0].verb).toBe("deal.list");
    expect(escopo.mock.calls[1][0].verb).toBe("pending.summary");
    expect(escopo.mock.calls[1][0].args).toMatchObject({ dealId: "cd4" });
    expect(JSON.stringify(r.resultados)).not.toContain("cd4");
  });

  it("status do contrato do X: usa o negócio achado, não o número que o modelo chutou", async () => {
    escopo.mockResolvedValueOnce({ items: CARTEIRA, truncated: false });
    escopo.mockResolvedValueOnce({ items: [{ id: "k", estado: "em_assinatura" }], truncated: false });
    const r = await despacharLeituras({
      ...base,
      texto: "qual o status do contrato do TESTE assinatura 2?",
      // o modelo leu o "2" do título como item 2 de uma lista que não existe
      chamadas: [{ name: "situacao_contrato", args: { numero: 2 } }],
    });
    expect(escopo.mock.calls[1][0].verb).toBe("contract.status");
    expect(escopo.mock.calls[1][0].args).toMatchObject({ negocio_id: "cd2" });
    expect(r.trilha[0].outcome).toBe("ok");
  });

  it("nome que termina em dígito não é índice: 'TESTE1' acha o TESTE1, não o item 1 de uma lista vigente", async () => {
    escopo.mockResolvedValueOnce({ items: CARTEIRA, truncated: false });
    escopo.mockResolvedValueOnce({ items: [{ id: "k", estado: "rascunho" }], truncated: false });
    const listaVigente = {
      criadoEm: 900,
      turno: "m0",
      itens: [{ n: 1, tipo: "negocio" as const, id: "OUTRO-NEGOCIO", rotulo: "Outro" }],
    };
    await despacharLeituras({
      ...base,
      referencias: listaVigente,
      texto: "qual o status do contrato do negócio TESTE1?",
      chamadas: [{ name: "situacao_contrato", args: { numero: 1 } }],
    });
    expect(escopo.mock.calls[1][0].args).toMatchObject({ negocio_id: "cd9" });
  });

  it("nome explícito sem casamento: NÃO consulta nada e diz que não achou (nunca 'tente mais tarde')", async () => {
    escopo.mockResolvedValueOnce({ items: CARTEIRA, truncated: false });
    const r = await despacharLeituras({
      ...base,
      texto: "qual o status do contrato do negócio TESTE99?",
      chamadas: [{ name: "situacao_contrato", args: { numero: 1 } }],
    });
    expect(escopo).toHaveBeenCalledTimes(1); // só a listagem
    expect(r.resultados[0]).toMatchObject({ items: null, motivo: "negocio_nao_encontrado" });
    expect(r.trilha[0].outcome).toBe("negocio_nao_encontrado");
    const cerca = fenceToolResults(r.resultados);
    expect(cerca).toContain("nao_encontrado");
    expect(cerca).toContain("NÃO ofereça tentar de novo");
    expect(cerca).not.toContain("falhou=");
  });

  it("vários negócios com o nome: devolve os candidatos numerados para perguntar qual", async () => {
    escopo.mockResolvedValueOnce({
      items: [
        { id: "a", titulo: "Maria Souza - Rua A" },
        { id: "b", titulo: "Maria Souza - Rua B" },
      ],
      truncated: false,
    });
    const r = await despacharLeituras({
      ...base,
      texto: "pendências do negócio Maria Souza",
      chamadas: [{ name: "pendencias_do_negocio", args: {} }],
    });
    expect(escopo).toHaveBeenCalledTimes(1);
    expect(r.resultados[0].desambiguar).toBe(true);
    expect(r.resultados[0].items).toEqual([
      { n: 1, titulo: "Maria Souza - Rua A" },
      { n: 2, titulo: "Maria Souza - Rua B" },
    ]);
    expect(r.referencias?.itens.map((i) => i.id)).toEqual(["a", "b"]);
    expect(r.trilha[0].outcome).toBe("negocio_ambiguo");
  });

  it("sem a capability deal.list o nome não é resolvido (caminho antigo)", async () => {
    escopo.mockResolvedValueOnce({ items: [{ formularios: { total: 0 } }], truncated: false });
    await despacharLeituras({
      ...base,
      policy: ["deal.pending"] as never,
      texto: "pendências do negócio TESTE assinatura 4",
      chamadas: [{ name: "pendencias_do_negocio", args: {} }],
    });
    expect(escopo).toHaveBeenCalledTimes(1);
    expect(escopo.mock.calls[0][0].verb).toBe("deal.pending");
  });

  it("listagem indisponível: segue o caminho antigo, sem fingir 'não achei'", async () => {
    escopo.mockResolvedValueOnce(null);
    escopo.mockResolvedValueOnce({ items: [{ formularios: { total: 0 } }], truncated: false });
    const r = await despacharLeituras({
      ...base,
      texto: "pendências do negócio TESTE assinatura 4",
      chamadas: [{ name: "pendencias_do_negocio", args: {} }],
    });
    expect(r.resultados[0].motivo).toBeUndefined();
  });

  it("pergunta sem nome de negócio não faz a listagem extra", async () => {
    escopo.mockResolvedValueOnce({ items: [{ formularios: { total: 0 } }], truncated: false });
    await despacharLeituras({
      ...base,
      texto: "quais as pendências da semana?",
      chamadas: [{ name: "pendencias_do_negocio", args: {} }],
    });
    expect(escopo).toHaveBeenCalledTimes(1);
  });
});

describe("referencia_invalida é honesta", () => {
  it("número sem lista: motivo referencia_invalida e a cerca não oferece tentar de novo", async () => {
    const r = await despacharLeituras({
      ...base,
      texto: "status do contrato do 7",
      chamadas: [{ name: "situacao_contrato", args: { numero: 7 } }],
    });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0]).toMatchObject({ items: null, motivo: "referencia_invalida" });
    const cerca = fenceToolResults(r.resultados);
    expect(cerca).toContain("NÃO ofereça tentar de novo");
    expect(cerca).toContain("NOME COMPLETO");
    expect(cerca).not.toContain("ofereça tentar de novo.");
  });

  it("falha real de consulta continua pedindo para tentar de novo", () => {
    const cerca = fenceToolResults([{ tool: "listar_negocios", items: null, truncated: false }]);
    expect(cerca).toContain("ofereça tentar de novo");
  });
});
