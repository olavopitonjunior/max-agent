import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Enviar ao proprietário / encerrar no GRAFO (plano de 14/11/2026): a detecção só
 * dispara para identidade que escreve, com política, e a resposta curta
 * "encerrar"/"enviar" só vale logo depois do aviso do proponente. Tudo por template.
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
const aguardando = {
  id: "p1", codigo: "PROP-2026-0031", titulo: "Rua X, 100", status: "assinada_proponente", estado: "Assinada pelo proponente",
  signatarios: [{ nome: "Maria Souza", status: "assinou", canal: "email" }],
};
const AVISO = "Olá, Carlos! O proponente assinou a proposta PROP-2026-0031 Rua X, 100. A assinatura está registrada.";

function run(text: string, state: Record<string, unknown> = {}, messageId = "m1", identity: object = usuario) {
  return buildGraph().compile().invoke({
    inbound: { messageId, fromPhone: "5511987654321", groupId: null, kind: "text" as const, text, mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null },
    identity: identity as never, reply: null, halt: null, propostaDescartada: false, ...state,
  });
}
const verbos = () => acao.mock.calls.map(([p]) => p.verb as string);
const lendo = async ({ verb }: { verb: string }) => {
  if (verb === "proposal.status") return { status: 200, body: { proposta: aguardando } };
  if (verb === "proposal.list") return { status: 200, body: { items: [aguardando], total: 1, busca: "x" } };
  if (verb === "proposal.send_owner") return { status: 200, body: { ok: true, esteira: "a", avisos: [] } };
  if (verb === "proposal.complete") return { status: 200, body: { ok: true, status: "encerrada" } };
  throw new Error(`Ação inesperada: ${verb}`);
};

beforeEach(() => {
  vi.clearAllMocks();
  acao.mockReset();
  llm.mockReset();
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: politica(COM) } as never);
  vi.mocked(searchKnowledge).mockResolvedValue([]);
  llm.mockResolvedValue({ text: "Não posso fazer isso.", toolCalls: [], usage: uso });
});

describe("proprietário no grafo: negados", () => {
  it("'encerrar' solto, sem aviso pendente, nunca chama proposal.complete", async () => {
    acao.mockImplementation(lendo);
    await run("encerrar");
    expect(verbos()).not.toContain("proposal.complete");
    expect(verbos()).not.toContain("proposal.send_owner");
  });
  it("'enviar' solto, sem aviso pendente, nunca chama proposal.send_owner", async () => {
    acao.mockImplementation(lendo);
    await run("enviar");
    expect(verbos()).not.toContain("proposal.send_owner");
  });
  it("resposta ao aviso exige proposal.send na política: sem ele, nada é escrito", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: politica(["proposal.list"]) } as never);
    acao.mockImplementation(lendo);
    await run("encerrar", { messages: [{ role: "assistant", content: AVISO }] });
    expect(verbos()).not.toContain("proposal.complete");
    expect(verbos()).not.toContain("proposal.send_owner");
  });
  it("identidade que não escreve (comissionado) não dispara o fluxo", async () => {
    acao.mockImplementation(lendo);
    const s = await run("encerrar", { messages: [{ role: "assistant", content: AVISO }] }, "m1", comissionado);
    expect(s.fluxo ?? null).toBeNull();
    expect(verbos()).not.toContain("proposal.complete");
  });
  it("sem SIM, o aviso + 'encerrar' só abre o resumo (nenhuma escrita)", async () => {
    acao.mockImplementation(lendo);
    const s = await run("encerrar", { messages: [{ role: "assistant", content: AVISO }] });
    expect(s.fluxo).toMatchObject({ kind: "assinatura", operacao: "encerrar", etapa: "confirmacao" });
    expect(s.reply).toContain("Encerrar a proposta PROP-2026-0031");
    expect(verbos()).not.toContain("proposal.complete");
  });
});

describe("proprietário no grafo: fluxo completo", () => {
  it("enviar: pedido explícito, resumo, e só o SIM chama proposal.send_owner com a messageId do SIM", async () => {
    acao.mockImplementation(lendo);
    const s = await run("envia a proposta PROP-2026-0031 pro proprietário");
    expect(s.fluxo).toMatchObject({ kind: "assinatura", operacao: "enviar_proprietario", etapa: "confirmacao" });
    expect(s.reply).toContain("R$ 1,50 por assinante");
    expect(verbos()).not.toContain("proposal.send_owner");
    const fim = await run("SIM", { fluxo: s.fluxo }, "m-sim");
    expect(acao).toHaveBeenCalledWith(expect.objectContaining({ verb: "proposal.send_owner", args: { proposta_id: "p1" }, idempotencyKey: "m-sim" }));
    expect(fim.reply).toBe("Enviei a proposta PROP-2026-0031 para o proprietário assinar.");
    expect(fim.fluxo ?? null).toBeNull();
  });
  it("encerrar como resposta ao aviso: resumo, SIM, proposal.complete", async () => {
    acao.mockImplementation(lendo);
    const s = await run("Encerrar", { messages: [{ role: "assistant", content: AVISO }] });
    expect(s.fluxo).toMatchObject({ operacao: "encerrar", etapa: "confirmacao" });
    const fim = await run("sim", { fluxo: s.fluxo }, "m-sim");
    expect(acao).toHaveBeenCalledWith(expect.objectContaining({ verb: "proposal.complete", args: { proposta_id: "p1" }, idempotencyKey: "m-sim" }));
    expect(fim.reply).toBe("Proposta PROP-2026-0031 encerrada sem o proprietário. Ele não vai assinar.");
  });
});
