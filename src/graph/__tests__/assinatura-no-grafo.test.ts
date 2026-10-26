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

describe("trocar signatário no grafo (Passo 4c)", () => {
  const PEDIDO = "troca o e-mail da Letícia na proposta PROP-2026-0031";
  const leitura = (status: string, estado = status) => async ({ verb }: { verb: string }) => {
    if (verb === "proposal.status") return { status: 200, body: { proposta: { ...leticia, status, estado } } };
    if (verb === "proposal.list") return { status: 200, body: { items: [{ ...leticia, status, estado }], total: 1, busca: "leticia" } };
    throw new Error(`Ação inesperada: ${verb}`);
  };
  const verbos = () => acao.mock.calls.map(([p]) => p.verb as string);

  it("negado: sem proposal.send na política, nenhuma chamada de escrita e o fluxo assinatura não assume", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: politica(["proposal.list"]) } as never);
    acao.mockImplementation(leitura("enviada"));
    const s = await run(PEDIDO);
    expect(s.fluxo ?? null).not.toMatchObject({ kind: "assinatura" });
    expect(verbos()).not.toContain("proposal.cancel");
    expect(verbos()).not.toContain("proposal.remind");
    expect(verbos()).not.toContain("proposal.update");
    expect(JSON.stringify(s.messages.at(-1)?.content ?? "")).not.toContain("Cancelar envelope");
  });
  it("negado: comissionado não dispara", async () => {
    acao.mockImplementation(leitura("enviada"));
    const s = await run(PEDIDO, {}, "m1", comissionado);
    expect(s.fluxo ?? null).toBeNull();
    expect(JSON.stringify(s.messages.at(-1)?.content ?? "")).not.toContain("Cancelar envelope");
    expect(verbos().filter((v) => v !== "proposal.list" && v !== "proposal.status")).toEqual([]);
  });
  it("negado: 'não troca o e-mail da proposta X' não dispara", async () => {
    acao.mockImplementation(leitura("enviada"));
    const s = await run("não troca o e-mail da proposta PROP-2026-0031");
    expect(s.reply ?? "").not.toContain("Cancelar envelope");
    expect(s.fluxo ?? null).not.toMatchObject({ kind: "assinatura" });
    expect(acao).not.toHaveBeenCalled();
  });
  it("proposta enviada: texto fixo com os signatários, só leitura, sem modelo", async () => {
    acao.mockImplementation(leitura("enviada", "Enviada"));
    const s = await run(PEDIDO);
    expect(s.fluxo ?? null).toBeNull();
    expect(s.reply).toContain("A proposta PROP-2026-0031 (Rua X, 100) já foi enviada para assinatura.");
    expect(s.reply).toContain('1. Na tela da proposta, use "Cancelar envelope". A proposta volta para edição; ela não é cancelada.');
    expect(s.reply).toContain("Signatários:\n• Letícia Andrade — pendente — WhatsApp\n• Maria Souza — assinou — e-mail");
    expect(verbos()).toEqual(["proposal.status"]);
    expect(llm).not.toHaveBeenCalled();
  });
  it("pergunta 'dá pra mudar o telefone do assinante da proposta da Letícia?' dá o mesmo texto", async () => {
    acao.mockImplementation(leitura("enviada", "Enviada"));
    const s = await run("dá pra mudar o telefone do assinante da proposta da Letícia?");
    expect(s.reply).toContain("já foi enviada para assinatura");
    expect(s.reply).toContain("3. Peça para eu enviar de novo.");
    expect(verbos()).toEqual(["proposal.list"]);
    expect(llm).not.toHaveBeenCalled();
  });
  it("várias propostas: pede o número; a escolha pós-envio dá o texto fixo", async () => {
    acao.mockImplementation(async ({ verb }: { verb: string }) => {
      if (verb === "proposal.list") return { status: 200, body: { items: [leticia, { ...leticia, id: "p2", codigo: "PROP-2026-0032", titulo: "Rua Y, 7" }], total: 2, busca: "leticia" } };
      throw new Error(`Ação inesperada: ${verb}`);
    });
    const s1 = await run("troca o e-mail do assinante da proposta da Letícia");
    expect(s1.fluxo).toMatchObject({ kind: "assinatura", operacao: "trocar", etapa: "selecao" });
    expect(s1.reply).toContain("Responda com o número.");
    const s2 = await run("1", { fluxo: s1.fluxo }, "m2");
    expect(s2.fluxo ?? null).toBeNull();
    expect(s2.reply).toContain("já foi enviada para assinatura");
    expect(verbos().filter((v) => v !== "proposal.list")).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });
  it("rascunho: o fluxo assinatura NÃO assume; o pedido segue para a edição (gestão), sem cancelar/lembrar", async () => {
    acao.mockImplementation(leitura("rascunho", "Rascunho"));
    const s = await run(PEDIDO);
    expect(s.fluxo).not.toMatchObject({ kind: "assinatura" });
    expect(s.reply ?? "").not.toContain("Cancelar envelope");
    expect(s.fluxo).toMatchObject({ kind: "proposta" }); // a edição da proposta (gestão → proposal.update), como antes do 4c
    expect(llm).toHaveBeenCalled(); // o modelo (extração da edição) foi acionado: o caminho normal rodou
    expect(verbos()).not.toContain("proposal.cancel");
    expect(verbos()).not.toContain("proposal.remind");
  });
  it("cancelada: frase de terminal", async () => {
    acao.mockImplementation(leitura("cancelada", "Cancelada"));
    const s = await run(PEDIDO);
    expect(s.reply).toBe("A proposta PROP-2026-0031 (Rua X, 100) está cancelada; não há assinatura em andamento para corrigir.");
    expect(s.fluxo ?? null).toBeNull();
  });
  it("regressões: cancelar, lembrar e excluir seguem os seus caminhos", async () => {
    acao.mockImplementation(leitura("enviada", "Enviada"));
    const c = await run("cancela a proposta PROP-2026-0031");
    expect(c.fluxo).toMatchObject({ kind: "assinatura", operacao: "cancelar" });
    const l = await run("lembra quem falta assinar a proposta da Letícia");
    expect(l.fluxo).toMatchObject({ kind: "assinatura", operacao: "lembrar", etapa: "confirmacao" });
    acao.mockImplementation(leitura("rascunho", "Rascunho"));
    const e = await run("exclui a proposta da Letícia");
    expect(e.fluxo).not.toMatchObject({ kind: "assinatura" });
    expect(e.messages.at(-1)?.content).toMatch(/^Excluir proposta/);
  });
});
