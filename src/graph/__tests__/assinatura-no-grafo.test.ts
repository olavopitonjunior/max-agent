import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Lembrar/cancelar assinatura no GRAFO (Passo 4, 25/10/2026): a detecção só
 * dispara para identidade que pode escrever, com política, e responde por
 * template (sem o modelo). Mesmo padrão de mocks do fluxo-no-grafo.test.ts.
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

const { buildGraph } = await import("../graph");
const { fetchProfile, searchKnowledge } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { executarAcao } = await import("@/lib/acao");

const llm = complete as unknown as ReturnType<typeof vi.fn>;
const acao = executarAcao as unknown as ReturnType<typeof vi.fn>;

const usuario = { orgId: "org1", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };
const comissionado = { orgId: "org1", orgName: "FINCasa", kind: "recipient" as const, recipientId: "r1", userName: "Corretor" };
const politica = (caps: string[]) => ({ byRole: { "*": caps }, byRecipient: { "*": caps }, brokerDefault: caps });
const COM = ["deal.list", "proposal.list", "proposal.create", "proposal.send"];
const uso = { model: "openai/gpt-5.4-nano", promptTokens: 10, completionTokens: 5, latencyMs: 5, success: true };
const leticia = {
  id: "p1", codigo: "PROP-2026-0031", titulo: "Rua X, 100", status: "enviada", estado: "Enviada",
  signatarios: [{ nome: "Letícia Andrade", status: "pendente", canal: "whatsapp" }, { nome: "Maria Souza", status: "assinou", canal: "email" }],
};

function run(text: string, state: Record<string, unknown> = {}, messageId = "m1", identity: object = usuario) {
  return buildGraph().compile().invoke({
    inbound: { messageId, fromPhone: "5511987654321", groupId: null, kind: "text" as const, text, mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null },
    identity: identity as never, reply: null, halt: null, propostaDescartada: false, ...state,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  acao.mockReset();
  llm.mockReset();
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: politica(COM) } as never);
  vi.mocked(searchKnowledge).mockResolvedValue([]);
  llm.mockResolvedValue({ text: "Não posso fazer isso.", toolCalls: [], usage: uso });
});

describe("assinatura no grafo", () => {
  it("negado: sem proposal.send na política, o pedido não chega ao servidor de escrita", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: politica(["proposal.list"]) } as never);
    acao.mockResolvedValue({ status: 200, body: { items: [leticia], total: 1, busca: "leticia" } });
    await run("cancela a proposta da Letícia porque o cliente desistiu");
    const verbos = acao.mock.calls.map(([p]) => p.verb);
    expect(verbos).not.toContain("proposal.cancel");
    expect(verbos).not.toContain("proposal.remind");
  });
  it("negado: identidade que não escreve (comissionado) não dispara a detecção", async () => {
    acao.mockResolvedValue({ status: 200, body: { items: [leticia], total: 1, busca: "leticia" } });
    const s = await run("cancela a proposta da Letícia porque o cliente desistiu", {}, "m1", comissionado);
    expect(s.fluxo ?? null).toBeNull();
    const verbos = acao.mock.calls.map(([p]) => p.verb);
    expect(verbos).not.toContain("proposal.cancel");
  });
  it("lembrar: detecta, mostra os signatários, e só o SIM chama proposal.remind com a messageId do SIM", async () => {
    acao.mockImplementation(async ({ verb }: { verb: string }) => {
      if (verb === "proposal.list") return { status: 200, body: { items: [leticia], total: 1, busca: "leticia" } };
      if (verb === "proposal.remind") return { status: 200, body: { enviados: ["Letícia Andrade"], pulados: [] } };
      throw new Error(`Ação inesperada: ${verb}`);
    });
    const s = await run("lembra quem falta assinar a proposta da Letícia");
    expect(s.fluxo).toMatchObject({ kind: "assinatura", operacao: "lembrar", etapa: "confirmacao" });
    expect(s.reply).toContain("• Letícia Andrade — pendente — WhatsApp");
    expect(s.reply).toContain("Responda SIM para confirmar ou NÃO para parar.");
    expect(acao.mock.calls.map(([p]) => p.verb)).toEqual(["proposal.list"]);
    const fim = await run("SIM", { fluxo: s.fluxo }, "m-sim");
    expect(fim.reply).toBe("Lembrete enviado para Letícia Andrade.");
    const remind = acao.mock.calls.map(([p]) => p).find((p) => p.verb === "proposal.remind");
    expect(remind).toMatchObject({ args: { proposta_id: "p1" }, idempotencyKey: "m-sim" });
    expect(llm).not.toHaveBeenCalled();
  });
  it("cancelar: pergunta o motivo, resume com os signatários e só o SIM chama proposal.cancel", async () => {
    acao.mockImplementation(async ({ verb }: { verb: string }) => {
      if (verb === "proposal.status") return { status: 200, body: { proposta: leticia } };
      if (verb === "proposal.cancel") return { status: 200, body: { proposta: { id: "p1", status: "cancelada" } } };
      throw new Error(`Ação inesperada: ${verb}`);
    });
    const s1 = await run("cancela a proposta PROP-2026-0031");
    expect(s1.fluxo).toMatchObject({ kind: "assinatura", etapa: "motivo" });
    expect(s1.reply).toContain("Qual o motivo do cancelamento?");
    const s2 = await run("o cliente desistiu da compra", { fluxo: s1.fluxo }, "m2");
    expect(s2.fluxo).toMatchObject({ etapa: "confirmacao", motivo: "o cliente desistiu da compra" });
    expect(acao.mock.calls.map(([p]) => p.verb)).not.toContain("proposal.cancel");
    const fim = await run("SIM", { fluxo: s2.fluxo }, "m3");
    expect(fim.reply).toBe("Proposta PROP-2026-0031 cancelada. A assinatura na ClickSign foi encerrada.");
    const cancel = acao.mock.calls.map(([p]) => p).find((p) => p.verb === "proposal.cancel");
    expect(cancel).toMatchObject({ args: { proposta_id: "p1", motivo: "o cliente desistiu da compra" }, idempotencyKey: "m3" });
  });
  it("'exclui a proposta' segue na gestão (excluir), não na assinatura", async () => {
    acao.mockResolvedValue({ status: 200, body: { items: [{ ...leticia, status: "rascunho" }], total: 1, busca: "leticia" } });
    const s = await run("exclui a proposta da Letícia");
    expect(s.fluxo).not.toMatchObject({ kind: "assinatura" });
    expect(s.messages.at(-1)?.content).toMatch(/^Excluir proposta/);
  });
  it("NÃO encerra sem chamar proposal.cancel", async () => {
    acao.mockResolvedValue({ status: 200, body: { items: [leticia], total: 1, busca: "leticia" } });
    const s = await run("cancela a proposta da Letícia porque o cliente desistiu");
    expect(s.fluxo).toMatchObject({ kind: "assinatura", etapa: "confirmacao" });
    acao.mockClear();
    const fim = await run("não", { fluxo: s.fluxo }, "m2");
    expect(fim.fluxo ?? null).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });
});
