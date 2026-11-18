import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Smoke em prod 18/11 (Max Fincasa): "Exclui a captação CAP-2026-0013" → o
 * modelo livre montou um card ("Confirma que você quer excluir a captação
 * *CAP-2026-0013* mesmo (definitivo)?") e, no SIM, respondeu "Captação
 * *CAP-2026-0013* excluída." Não há verbo de exclusão de captação: nada foi
 * gravado, a linha seguiu no banco. Duas camadas:
 *  1. o pedido de excluir/cancelar captação tem resposta fixa (fora do Max);
 *  2. sem escrita no turno, o texto livre não afirma exclusão nem encena o
 *     card de exclusão.
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
const { pedeAcaoForaDoMax, textoForaDoMax } = await import("../capacidades");
const { travarCriacaoFalsa, afirmaExclusao, encenaExclusao, TEXTO_NADA_EXCLUIDO } = await import("../compose");
const { pedeGestao } = await import("../gestao");
const { fetchProfile, searchKnowledge } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { executarAcao } = await import("@/lib/acao");

const llm = complete as unknown as ReturnType<typeof vi.fn>;
const acao = executarAcao as unknown as ReturnType<typeof vi.fn>;
const usuario = { orgId: "org1", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };
const POLITICA = { byRole: { "*": ["proposal.list", "proposal.create", "proposal.send", "proposal.delete", "captacao.list", "captacao.create"] }, byRecipient: {}, brokerDefault: [] };
const uso = { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true };
const SEM_ESCRITA = { houveLeitura: false, podeCriar: true, podeEnviar: true, houveEscrita: false };

function run(text: string, state: Record<string, unknown> = {}) {
  return buildGraph().compile().invoke({
    inbound: { messageId: "m1", fromPhone: "5511987654321", groupId: null, kind: "text" as const, text, mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null },
    identity: usuario, reply: null, halt: null, propostaDescartada: false, ...state,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: POLITICA } as never);
  vi.mocked(searchKnowledge).mockResolvedValue([]);
  llm.mockResolvedValue({ text: "Resposta do modelo.", toolCalls: [], usage: uso });
});

describe("pedido de excluir/cancelar captação: resposta fixa", () => {
  it.each([
    "Exclui a captação CAP-2026-0013",
    "exclui a CAP-2026-0013",
    "apaga a captação da Rua TESTE Smoke",
    "pode excluir essa captação",
    "deleta a captação CAP-2026-0013",
    "cancela a captação CAP-2026-0013",
    "remove a captação do Seu João",
  ])("%s → fora do Max", (t) => expect(pedeAcaoForaDoMax(t)).toBe("captacao_exclusao"));

  it.each([
    "a captação CAP-2026-0013 foi excluída?",
    "como excluo uma captação?",
    "não exclui a captação CAP-2026-0013",
    "exclui o proprietário da captação",
    "remove a exclusividade da captação",
    "exclui a proposta PROP-2026-0006",
    "quero fazer uma captação",
  ])("%s → não é exclusão de captação", (t) => expect(pedeAcaoForaDoMax(t)).not.toBe("captacao_exclusao"));

  it("a exclusão de proposta segue com a gestão", () => {
    expect(pedeGestao("exclui a proposta PROP-2026-0006")).toBe("excluir");
    expect(pedeGestao("exclui a captação CAP-2026-0013")).toBeNull();
  });

  it("texto honesto: não exclui, aponta a tela", () => {
    const t = textoForaDoMax("captacao_exclusao");
    expect(t).toMatch(/não excluo/i);
    expect(t).toMatch(/tela/);
    expect(t).not.toMatch(/excluída/i);
  });

  it("no grafo: não chama o modelo nem o servidor", async () => {
    const out = await run("Exclui a captação CAP-2026-0013");
    expect(out.reply).toBe(textoForaDoMax("captacao_exclusao"));
    expect(llm).not.toHaveBeenCalled();
    expect(acao).not.toHaveBeenCalled();
    expect(out.toolLog?.at(-1)?.outcome).toBe("fora_do_max_captacao_exclusao");
  });
});

describe("texto livre afirmando exclusão sem escrita no turno", () => {
  it.each([
    "Captação *CAP-2026-0013* excluída.",
    "Captação CAP-2026-0013 excluída com sucesso!",
    "Pronto, excluí a captação.",
    "Apaguei a proposta PROP-2026-0006.",
    "A captação foi excluída.",
    "Proposta removida.",
    "Vou excluir a captação agora.",
  ])("reconhece: %s", (t) => expect(afirmaExclusao(t)).toBe(true));

  it.each([
    "Ainda não excluí nada por aqui.",
    "Quer que eu exclua a proposta?",
    "Captação se exclui pela tela, no sistema.",
    "Para excluir, me diga o código da proposta.",
    "A captação foi excluída?",
    "Não consigo excluir captação por aqui.",
    "A exclusão de captação é feita pela imobiliária.",
    "Removi o filtro de data da lista.",
    "Cancelei a busca anterior, segue a nova lista.",
  ])("não pega explicação, pergunta ou negação: %s", (t) => expect(afirmaExclusao(t)).toBe(false));

  it.each([
    "Beleza. Confirma que você quer excluir a captação *CAP-2026-0013* mesmo (definitivo)?",
    "Tem certeza que quer apagar a captação CAP-2026-0013?",
    "Vou excluir a captação CAP-2026-0013. A exclusão é definitiva.",
  ])("encenação do card de exclusão: %s", (t) => expect(encenaExclusao(t)).toBe(true));

  it.each([
    "Quer que eu exclua a proposta?",
    "Captação se exclui pela tela, no sistema.",
    "Confirma o valor de R$ 800.000?",
  ])("não é encenação de exclusão: %s", (t) => expect(encenaExclusao(t)).toBe(false));

  it("trava: troca pelo texto honesto, mesmo quando o turno leu", () => {
    for (const ctx of [SEM_ESCRITA, { ...SEM_ESCRITA, houveLeitura: true }]) {
      expect(travarCriacaoFalsa("Captação *CAP-2026-0013* excluída.", ctx)).toEqual({ texto: TEXTO_NADA_EXCLUIDO, travou: true });
      expect(travarCriacaoFalsa("Beleza. Confirma que você quer excluir a captação *CAP-2026-0013* mesmo (definitivo)?", ctx))
        .toEqual({ texto: TEXTO_NADA_EXCLUIDO, travou: true });
    }
  });

  it("com escrita real no turno, não mexe", () => {
    const texto = "Proposta removida.";
    expect(travarCriacaoFalsa(texto, { ...SEM_ESCRITA, houveEscrita: true })).toEqual({ texto, travou: false });
  });

  it("o texto honesto não afirma exclusão", () => {
    expect(afirmaExclusao(TEXTO_NADA_EXCLUIDO)).toBe(false);
    expect(encenaExclusao(TEXTO_NADA_EXCLUIDO)).toBe(false);
    expect(TEXTO_NADA_EXCLUIDO).toMatch(/não excluí nada/i);
  });

  it("no grafo: o SIM solto que o modelo responde com 'excluída' vira texto honesto", async () => {
    llm.mockResolvedValue({ text: "Captação *CAP-2026-0013* excluída.", toolCalls: [], usage: uso });
    const out = await run("SIM");
    expect(out.reply).toBe(TEXTO_NADA_EXCLUIDO);
    expect(acao).not.toHaveBeenCalled();
  });
});
