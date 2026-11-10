import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Produção 10/11/2026: "quero mandar o formulário de negócio para o comprador
 * do TESTE assinatura 1" abriu um fluxo NOVO ("Que nome dou a esse negócio?")
 * em vez de reconhecer o negócio que já existia.
 */

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn(),
  reportUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));
vi.mock("@/lib/acao", () => ({ executarAcao: vi.fn() }));
vi.mock("@/lib/scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/scope")>()),
  consultarEscopo: vi.fn(),
}));

const { buildGraph } = await import("../graph");
const { fetchProfile, searchKnowledge } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { consultarEscopo } = await import("@/lib/scope");
const { executarAcao } = await import("@/lib/acao");

const llm = complete as unknown as ReturnType<typeof vi.fn>;
const escopo = vi.mocked(consultarEscopo);

const usuario = { orgId: "org1", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };
const POLITICA = {
  byRole: { "*": ["deal.list", "deal.pending", "proposal.list", "form.create", "proposal.create"] },
  byRecipient: {},
  brokerDefault: ["deal.list", "deal.pending"],
};
const uso = { model: "openai/gpt-5.4-nano", promptTokens: 10, completionTokens: 5, latencyMs: 5, success: true };

function run(text: string) {
  return buildGraph()
    .compile()
    .invoke({
      inbound: {
        messageId: "m1",
        fromPhone: "5511987654321",
        groupId: null,
        kind: "text" as const,
        text,
        mediaUrl: null,
        mimeType: null,
        timestampMs: null,
        senderName: "Olavo",
        replyToMessageId: null,
      },
      identity: usuario,
      reply: null,
      halt: null,
      propostaDescartada: false,
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: POLITICA } as never);
  vi.mocked(searchKnowledge).mockResolvedValue([]);
  vi.mocked(executarAcao).mockResolvedValue({ status: 200, body: { campos: [] } } as never);
  llm.mockResolvedValue({ text: "", toolCalls: [{ name: "propor_criacao", args: { tipo: "venda" } }], usage: uso });
});

describe("formulário para o comprador de um negócio que já existe", () => {
  it("reconhece o negócio pelo título e NÃO abre fluxo novo", async () => {
    escopo.mockResolvedValue({
      items: [
        { id: "cd1", titulo: "TESTE assinatura 1 - à vista", etapa: "Formulário" },
        { id: "cd2", titulo: "TESTE assinatura 2", etapa: "Formulário" },
      ],
      truncated: false,
    });
    const s = await run("quero mandar o formulário de negócio para o comprador do TESTE assinatura 1");
    expect(s.reply).toContain("Esse negócio já existe");
    expect(s.reply).toContain("TESTE assinatura 1 - à vista");
    expect(s.reply).not.toContain("Que nome dou");
    expect(s.fluxo ?? null).toBeNull();
    expect(s.pendingAction ?? null).toBeNull();
    expect(vi.mocked(executarAcao)).not.toHaveBeenCalled();
  });

  it("sem negócio com esse nome o pedido segue como criação (cliente novo)", async () => {
    escopo.mockResolvedValue({ items: [{ id: "cd2", titulo: "Outro", etapa: "Formulário" }], truncated: false });
    const s = await run("quero mandar o formulário de negócio para o comprador do Carlos Novo");
    expect(s.reply).not.toContain("já existe");
    expect(escopo).toHaveBeenCalled();
    expect(s.reply).toBeTruthy();
  });

  it("negócio de uma palavra contido no nome novo NÃO bloqueia a criação ('Maria Silva' x negócio 'Maria')", async () => {
    escopo.mockResolvedValue({ items: [{ id: "m", titulo: "Maria", etapa: "Formulário" }], truncated: false });
    const s = await run("quero mandar o formulário de negócio para o comprador do Maria Silva");
    expect(s.reply).not.toContain("já existe");
  });

  it("negócio 'Maria Silva' existente não barra a criação de 'Maria Silva Santos' (título contido na frase)", async () => {
    escopo.mockResolvedValue({ items: [{ id: "ms", titulo: "Maria Silva", etapa: "Formulário" }], truncated: false });
    const s = await run("quero mandar o formulário de negócio para o comprador do Maria Silva Santos");
    expect(s.reply).not.toContain("já existe");
  });
});
