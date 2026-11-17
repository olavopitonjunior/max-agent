import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Bug 1 (prod 16/11): "como estão as certidões do negócio TESTE assinatura 3?" → o modelo chamava
 * `listar_negocios {busca}` para achar o negócio pelo nome e, na volta seguinte, NÃO tinha mais ferramenta
 * nenhuma (só a volta 0 recebia a oferta): respondia "a partir da lista", sem consultar as certidões
 * ("quais documentos tem no negócio TESTE PORTAL?" respondeu "0" com 5 anexos).
 *
 * Correção estreita: depois que uma volta produziu uma lista de negócios/propostas NESTE turno, as voltas
 * seguintes reoferecem SÓ as leituras que consomem o número da lista e que já foram oferecidas na volta 0.
 * Escrita nunca volta. A trava (b) do despachante (só executa o que foi oferecido na volta 0) segue valendo.
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
vi.mock("@/lib/llm", () => ({
  complete: vi.fn(),
  DEFAULT_MODEL: "openai/gpt-5.4-nano",
}));

const { buildGraph } = await import("../graph");
const { complete } = await import("@/lib/llm");
const { fetchProfile } = await import("@/lib/cm");
const { consultarEscopo } = await import("@/lib/scope");
const { despacharLeituras } = await import("../despachante");

const llm = vi.mocked(complete);
const profile = vi.mocked(fetchProfile);
const escopo = vi.mocked(consultarEscopo);

const gerente = {
  orgId: "org1", orgName: "RE/MAX Trio", kind: "user" as const,
  userId: "u1", userName: "Marcia",
};

const inbound = (text: string) =>
  ({ fromPhone: "+5511999063228", text, messageId: `m_${Math.random()}`, orgId: "org1", receivedAt: new Date().toISOString() }) as never;

const uso = {
  model: "x", promptTokens: 10, completionTokens: 10, cacheReadTokens: 0,
  cacheWriteTokens: 0, costUsd: 0.001, generationId: null, latencyMs: 10, success: true,
};

async function run(text: string) {
  return buildGraph().compile().invoke({
    inbound: inbound(text), identity: gerente,
    reply: null, halt: null, draft: null, bloqueios: [], policy: [],
  } as never);
}

const nomesDasTools = (chamada: number) =>
  ((llm.mock.calls[chamada]?.[0].tools ?? []) as { name: string }[]).map((t) => t.name);

beforeEach(() => {
  vi.clearAllMocks();
  llm.mockReset(); // descarta respostas `Once` que um teste vermelho deixou na fila
  vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ org1: ["queries"] }));
  vi.stubEnv("MAX_EXTENDED_QUERIES", "true");
  profile.mockResolvedValue({
    enabled: true, model: "x",
    maxPolicy: { byRole: { admin: ["deal.list", "certidao.status", "document.list", "form.create", "proposal.create"] } },
  } as never);
  escopo.mockImplementation((async (p: { verb: string }) => {
    if (p.verb === "deal.list") return { items: [{ id: "d1", titulo: "TESTE assinatura 3", etapa: "Documentação" }, { id: "d2", titulo: "TESTE PORTAL", etapa: "Documentação" }], truncated: false };
    if (p.verb === "certidao.status") return { items: [{ parte: "Fulano", situacao: "pendente" }], truncated: false };
    if (p.verb === "document.list") return { items: [{ nome: "Matrícula.pdf" }], truncated: false };
    return { items: [], truncated: false };
  }) as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("consulta por nome: a volta seguinte à lista ainda tem a leitura que consome o número", () => {
  it("listar_negocios {busca} → situacao_certidoes {numero:1} executa e a resposta vem do dado", async () => {
    llm
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "listar_negocios", args: { busca: "TESTE assinatura 3", limite: 10 } }], usage: uso } as never)
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "situacao_certidoes", args: { numero: 1 } }], usage: uso } as never)
      .mockResolvedValueOnce({ text: "1 certidão pendente.", toolCalls: [], usage: uso } as never);

    const r = await run("como estão as certidões do negócio TESTE assinatura 3?");

    // Volta 0 oferece a leitura; a volta 1 (depois da lista) TAMBÉM.
    expect(nomesDasTools(0)).toContain("situacao_certidoes");
    expect(nomesDasTools(1)).toContain("situacao_certidoes");
    const verbos = escopo.mock.calls.map((c) => (c[0] as { verb: string }).verb);
    expect(verbos).toEqual(["deal.list", "certidao.status"]);
    expect(r.toolRounds).toBe(2);
    expect(r.reply).toContain("1 certidão pendente");
  });

  it("o mesmo vale para documentos ('quais documentos tem no negócio TESTE PORTAL?')", async () => {
    llm
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "listar_negocios", args: { busca: "TESTE PORTAL" } }], usage: uso } as never)
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "listar_documentos", args: { numero: 1 } }], usage: uso } as never)
      .mockResolvedValueOnce({ text: "1 documento.", toolCalls: [], usage: uso } as never);

    await run("quais documentos tem no negócio TESTE PORTAL?");

    expect(nomesDasTools(1)).toContain("listar_documentos");
    expect(escopo.mock.calls.map((c) => (c[0] as { verb: string }).verb)).toEqual(["deal.list", "document.list"]);
  });

  it("só reoferece o que foi oferecido na volta 0, que consome número e é leitura: escrita e listas nunca voltam", async () => {
    llm
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "listar_negocios", args: { busca: "TESTE assinatura 3" } }], usage: uso } as never)
      .mockResolvedValueOnce({ text: "Certo.", toolCalls: [], usage: uso } as never);

    await run("a proposta e as certidões do negócio TESTE assinatura 3 estão ok?");

    const volta0 = nomesDasTools(0);
    expect(volta0).toContain("propor_criacao"); // a escrita ESTAVA na oferta da volta 0 (senão o teste não prova nada)
    const volta1 = nomesDasTools(1);
    expect(volta1).toContain("situacao_certidoes");
    expect(volta1).not.toContain("propor_criacao");
    expect(volta1).not.toContain("listar_negocios");
    for (const nome of volta1) expect(volta0).toContain(nome);
  });

  it("sem lista neste turno, a volta seguinte continua sem ferramentas (nada muda para quem não listou)", async () => {
    llm
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "situacao_certidoes", args: { numero: 1 } }], usage: uso } as never)
      .mockResolvedValueOnce({ text: "Preciso da lista antes.", toolCalls: [], usage: uso } as never);

    await run("como estão as certidões do negócio TESTE assinatura 3?");

    expect(nomesDasTools(1)).toEqual([]);
  });

  it("a trava (b) segue valendo: tool que NÃO foi oferecida na volta 0 não executa na volta 1", async () => {
    llm
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "listar_negocios", args: { busca: "TESTE assinatura 3" } }], usage: uso } as never)
      // "status_cobranca" não casa com a frase (sem cobrança/boleto...), logo não foi oferecida na volta 0.
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "status_cobranca", args: { numero: 1 } }], usage: uso } as never)
      .mockResolvedValueOnce({ text: "Não tenho essa consulta.", toolCalls: [], usage: uso } as never);

    await run("como estão as certidões do negócio TESTE assinatura 3?");

    expect(nomesDasTools(1)).not.toContain("status_cobranca");
    expect(escopo.mock.calls.map((c) => (c[0] as { verb: string }).verb)).toEqual(["deal.list"]);
  });

  it("volta 2 não reoferece nada: o turno termina com resposta em texto, nunca sem resposta (review #192)", async () => {
    llm
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "listar_negocios", args: { busca: "TESTE assinatura 3" } }], usage: uso } as never)
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "situacao_certidoes", args: { numero: 1 } }], usage: uso } as never)
      .mockResolvedValueOnce({ text: "1 certidão pendente.", toolCalls: [], usage: uso } as never);

    const r = await run("como estão as certidões do negócio TESTE assinatura 3?");

    // certidao.status não monta lista nova: sem o teto na volta 1, a leitura seguia oferecida até o
    // TOOL_MAX_ROUNDS e o turno acabava com reply null.
    expect(nomesDasTools(2)).toEqual([]);
    expect(r.reply).toContain("1 certidão pendente");
  });

  it("chamada repetida na volta 2 (sem oferta) não executa: certidao.status roda uma vez só", async () => {
    llm
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "listar_negocios", args: { busca: "TESTE assinatura 3" } }], usage: uso } as never)
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "situacao_certidoes", args: { numero: 1 } }], usage: uso } as never)
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "situacao_certidoes", args: { numero: 1 } }], usage: uso } as never)
      .mockResolvedValue({ text: "1 certidão pendente.", toolCalls: [], usage: uso } as never);

    await run("como estão as certidões do negócio TESTE assinatura 3?");

    expect(escopo.mock.calls.map((c) => (c[0] as { verb: string }).verb)).toEqual(["deal.list", "certidao.status"]);
  });

  it("trava (b) por volta: na volta 1, listar_negocios (oferecida só na volta 0) não executa (review #192)", async () => {
    llm
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "listar_negocios", args: { busca: "TESTE assinatura 3" } }], usage: uso } as never)
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "listar_negocios", args: { busca: "outro" } }], usage: uso } as never)
      .mockResolvedValue({ text: "Certo.", toolCalls: [], usage: uso } as never);

    await run("como estão as certidões do negócio TESTE assinatura 3?");

    expect(escopo.mock.calls.map((c) => (c[0] as { verb: string }).verb)).toEqual(["deal.list"]);
  });

  it("trava (b) por volta: escrita oferecida na volta 0 não abre cartão na volta 1", async () => {
    llm
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "listar_negocios", args: { busca: "TESTE assinatura 3" } }], usage: uso } as never)
      .mockResolvedValueOnce({ text: "", toolCalls: [
        { name: "listar_negocios", args: { busca: "outro" } },
        { name: "propor_criacao", args: { tipo: "proposta" } },
      ], usage: uso } as never)
      .mockResolvedValue({ text: "Certo.", toolCalls: [], usage: uso } as never);

    const r = await run("a proposta e as certidões do negócio TESTE assinatura 3 estão ok?");

    expect(nomesDasTools(0)).toContain("propor_criacao"); // estava oferecida na volta 0 (senão não prova nada)
    expect(escopo.mock.calls.map((c) => (c[0] as { verb: string }).verb)).toEqual(["deal.list"]);
    expect(r.pendingAction ?? null).toBeNull();
  });
});

describe("busca por nome ambígua: no máximo 3 opções", () => {
  it("4 negócios casam com a busca: o modelo recebe 3, numerados 1..3, e a lista vem marcada como cortada", async () => {
    escopo.mockResolvedValueOnce({
      items: [1, 2, 3, 4].map((i) => ({ id: `d${i}`, titulo: `TESTE assinatura ${i}`, etapa: "Documentação" })),
      truncated: false,
    } as never);
    const r = await despacharLeituras({
      chamadas: [{ name: "listar_negocios", args: { busca: "TESTE assinatura" } }],
      fromPhone: "+5511999063228", identity: gerente, turno: "t1", agora: 2_000,
      oferecidas: ["listar_negocios"], policy: ["deal.list"] as never, referencias: null,
    } as never);
    const res = r.resultados[0];
    expect(res.items).toHaveLength(3);
    expect((res.items as { n: number }[]).map((i) => i.n)).toEqual([1, 2, 3]);
    expect(res.truncated).toBe(true);
  });

  it("1 negócio só: volta inteiro, sem corte", async () => {
    escopo.mockResolvedValueOnce({ items: [{ id: "d1", titulo: "TESTE PORTAL", etapa: "Documentação" }], truncated: false } as never);
    const r = await despacharLeituras({
      chamadas: [{ name: "listar_negocios", args: { busca: "TESTE PORTAL" } }],
      fromPhone: "+5511999063228", identity: gerente, turno: "t1", agora: 2_000,
      oferecidas: ["listar_negocios"], policy: ["deal.list"] as never, referencias: null,
    } as never);
    expect(r.resultados[0].items).toHaveLength(1);
    expect(r.resultados[0].truncated).toBe(false);
  });
});
