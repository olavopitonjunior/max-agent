import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  fetchProfile: vi.fn(), searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));
vi.mock("@/lib/acao", () => ({ executarAcao: vi.fn() }));

const { buildGraph } = await import("../graph");
const { fetchProfile } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { TOOL_EXTRAIR_PROPOSTA } = await import("../fluxos");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null,
    maxPolicy: { byRole: { "*": ["proposal.create"] }, byRecipient: {}, brokerDefault: [] } } as never);
});

it("fronteira do grafo preserva valor protegido e apartamento no rascunho", async () => {
  vi.mocked(complete).mockImplementation(async (params) => {
    const enviado = JSON.stringify(params.messages);
    expect(enviado).toContain("⟨VALOR_1⟩");
    expect(enviado).not.toContain("500.000");
    // O contrato da ferramenta permite ao modelo devolver o token sem inventar número.
    expect(TOOL_EXTRAIR_PROPOSTA.parameters.properties.valor.anyOf).toContainEqual({ type: "string", pattern: "^⟨VALOR_[0-9]+⟩$" });
    return { text: "", toolCalls: [{ name: "preencher_proposta", args: {
      imovel: { endereco: "Rua de Teste QA, 100", complemento: "apartamento 1", cidade: "São Paulo", uf: "SP" },
      valor: "⟨VALOR_1⟩", pagamento: { forma: "à vista" },
    } }], usage: { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, generationId: null } };
  });
  const resultado = await buildGraph().compile().invoke({
    inbound: { messageId: "qa-extracao", fromPhone: "5511900000000", groupId: null, kind: "text", text: "imóvel Rua de Teste QA, 100, apartamento 1, São Paulo/SP; valor R$ 500.000,00 à vista", mediaUrl: null, mimeType: null, timestampMs: null, senderName: "TESTE QA", replyToMessageId: null },
    identity: { orgId: "org-qa", orgName: "QA", kind: "user", userId: "qa", userName: "TESTE QA" },
    fluxo: { kind: "proposta", etapa: "coleta", natureza: "venda", dados: { proponente: { nome: "CLIENTE TESTE QA", telefone: "11900000000" } }, atualizadoEm: Date.now() },
    reply: null, halt: null, propostaDescartada: false,
  });
  expect(resultado.fluxo).toMatchObject({ dados: { valor: 500000, imovel: { endereco: "Rua de Teste QA, 100", complemento: "apartamento 1" }, pagamento: { forma: "à vista" } } });
  expect(resultado.reply).not.toContain("⟨VALOR");
  vi.mocked(complete).mockResolvedValueOnce({ text: "", toolCalls: [{ name: "preencher_proposta", args: { imovel: { complemento: "apartamento 2" } } }],
    usage: { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, generationId: null } });
  const corrigido = await buildGraph().compile().invoke({ ...resultado, reply: null, halt: null,
    inbound: { ...resultado.inbound, messageId: "qa-correcao", text: "troque para apartamento 2" } });
  expect(corrigido.fluxo).toMatchObject({ dados: { valor: 500000, imovel: { endereco: "Rua de Teste QA, 100", complemento: "apartamento 2" } } });
  expect(corrigido.reply).toContain("Rua de Teste QA, 100, apartamento 2");
  expect(corrigido.reply).not.toContain("apartamento 1");
  expect(corrigido.reply?.match(/apartamento 2/g)).toHaveLength(1);
});
