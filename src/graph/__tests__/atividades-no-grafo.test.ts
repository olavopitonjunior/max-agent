import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Atividades v2 (M1) no GRAFO: o toque no botão `atv:` e as tools de escrita. Mesmo padrão de
 * mocks do `fluxo-no-grafo.test.ts`. Nenhum desses turns chama o modelo de resposta no botão.
 */

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn(),
  reportUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));
vi.mock("@/lib/acao", async (orig) => ({ ...(await orig<typeof import("@/lib/acao")>()), executarAcao: vi.fn() }));
vi.mock("@/lib/scope", async (orig) => ({ ...(await orig<typeof import("@/lib/scope")>()), consultarEscopo: vi.fn() }));

const { buildGraph } = await import("../graph");
const { fetchProfile, searchKnowledge } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { executarAcao } = await import("@/lib/acao");
const { consultarEscopo } = await import("@/lib/scope");

const llm = complete as unknown as ReturnType<typeof vi.fn>;
const acao = executarAcao as unknown as ReturnType<typeof vi.fn>;
const leitura = consultarEscopo as unknown as ReturnType<typeof vi.fn>;

const usuario = { orgId: "org1", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };
const COM = { byRole: { "*": ["deal.list", "activity.list", "activity.write"] }, byRecipient: {}, brokerDefault: ["deal.list"] };
const SEM = { byRole: { "*": ["deal.list", "activity.list"] }, byRecipient: {}, brokerDefault: ["deal.list"] };
const uso = { model: "openai/gpt-5.4-nano", promptTokens: 10, completionTokens: 5, latencyMs: 5, success: true };

function run(text: string, state: Record<string, unknown> = {}, messageId = "m1", buttonPayload: string | null = null) {
  return buildGraph().compile().invoke({
    inbound: { messageId, fromPhone: "5511987654321", groupId: null, kind: "text" as const, text, mediaUrl: null,
      mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null, buttonPayload },
    identity: usuario, reply: null, halt: null, propostaDescartada: false, ...state,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: COM } as never);
  vi.mocked(searchKnowledge).mockResolvedValue([]);
});

describe("botão atv: no grafo", () => {
  it("NEGADO: sem activity.write, o toque não lê nem abre fluxo", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: SEM } as never);
    const toque = await run("Concluir", {}, "m1", "atv:atv_1:concluir");
    expect(leitura).not.toHaveBeenCalled();
    expect(acao).not.toHaveBeenCalled();
    expect(toque.fluxo ?? null).toBeNull();
    expect(toque.reply).toContain("não está liberado");
  });

  it("concluir: toque propõe, SIM escreve com a messageId do SIM; sem modelo", async () => {
    leitura.mockResolvedValue({ items: [{ id: "atv_1", titulo: "Ligar para o João" }], truncated: false });
    const toque = await run("Concluir", {}, "m-toque", "atv:atv_1:concluir");
    expect(leitura).toHaveBeenCalledWith(expect.objectContaining({ verb: "activity.get", args: { atividade_id: "atv_1" } }));
    expect(toque.fluxo).toMatchObject({ kind: "atividade", operacao: "concluir", etapa: "confirmacao" });
    expect(toque.reply).toContain("Confirma?");
    expect(acao).not.toHaveBeenCalled();

    acao.mockResolvedValue({ status: 200, body: { ok: true } });
    const fim = await run("sim", { fluxo: toque.fluxo }, "m-sim");
    expect(acao).toHaveBeenCalledWith(expect.objectContaining({ verb: "activity.complete", args: { atividade_id: "atv_1" }, idempotencyKey: "m-sim" }));
    expect(fim.reply).toContain("concluída");
    expect(llm).not.toHaveBeenCalled();
  });

  it("payload malformado e atividade inexistente: a mesma resposta neutra", async () => {
    leitura.mockResolvedValue({ items: [], truncated: false });
    const a = await run("Apagar", {}, "m1", "atv:atv_1:apagar");
    const b = await run("Concluir", {}, "m2", "atv:nao_existe:concluir");
    expect(a.reply).toBe("Essa atividade não está mais disponível.");
    expect(b.reply).toBe(a.reply);
    expect(acao).not.toHaveBeenCalled();
  });

  it("comentar: pede o texto, propõe e só então escreve", async () => {
    leitura.mockResolvedValue({ items: [{ id: "atv_1", titulo: "Ligar" }], truncated: false });
    const toque = await run("Comentar", {}, "m1", "atv:atv_1:comentar");
    expect(toque.fluxo).toMatchObject({ etapa: "texto" });
    const prop = await run("Sem resposta do cliente", { fluxo: toque.fluxo }, "m2");
    expect(prop.fluxo).toMatchObject({ etapa: "confirmacao" });
    expect(acao).not.toHaveBeenCalled();
    acao.mockResolvedValue({ status: 200, body: { ok: true } });
    await run("sim", { fluxo: prop.fluxo }, "m3");
    expect(acao).toHaveBeenCalledWith(expect.objectContaining({ verb: "activity.comment", idempotencyKey: "m3", args: { atividade_id: "atv_1", texto: "Sem resposta do cliente" } }));
  });
});

describe("tool concluir_atividade no grafo", () => {
  const referencias = { criadoEm: Date.now(), itens: [{ n: 1, tipo: "atividade", id: "atv_7", rotulo: "Enviar contrato" }] };

  it("NEGADO: sem activity.write a tool nem é oferecida e nada é escrito", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: SEM } as never);
    llm.mockResolvedValue({ text: "Não consigo concluir por aqui.", toolCalls: [{ name: "concluir_atividade", args: { numero: 1 } }], usage: uso });
    const s = await run("conclui a atividade 1", { referencias });
    expect(s.fluxo ?? null).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });

  it("o modelo propõe pelo número; o id vem do mapa e a escrita espera o SIM", async () => {
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "concluir_atividade", args: { numero: 1 } }], usage: uso });
    const s = await run("conclui a atividade 1", { referencias });
    expect(s.fluxo).toMatchObject({ kind: "atividade", operacao: "concluir", alvo: { id: "atv_7" } });
    expect(s.reply).toContain("Enviar contrato");
    expect(acao).not.toHaveBeenCalled();
  });

  it("número fora da lista: pede a lista de novo, sem fluxo", async () => {
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "concluir_atividade", args: { numero: 9 } }], usage: uso });
    const s = await run("conclui a atividade 9", { referencias });
    expect(s.fluxo ?? null).toBeNull();
    expect(s.reply).toContain("Não achei essa atividade");
  });
});
