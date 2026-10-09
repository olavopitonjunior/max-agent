import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Pergunta pelo andamento do contrato e negação de ação (eval 09/10): o
 * modelo confundia "o contrato já foi enviado?" com o envio da PROPOSTA e
 * respondia "não consigo excluir proposta" a "não exclui a proposta X".
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
const { perguntaDoContrato, negaAcao, pedeAcaoForaDoMax } = await import("../capacidades");
const { fetchProfile, searchKnowledge } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { executarAcao } = await import("@/lib/acao");

const llm = complete as unknown as ReturnType<typeof vi.fn>;
const acao = executarAcao as unknown as ReturnType<typeof vi.fn>;
const usuario = { orgId: "org1", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };
const POLITICA = { byRole: { "*": ["proposal.list", "proposal.create", "proposal.send", "proposal.delete"] }, byRecipient: {}, brokerDefault: [] };
const uso = { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true };

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

describe("perguntaDoContrato", () => {
  it.each([
    "o contrato da Letícia já foi enviado?",
    "o contrato já foi assinado?",
    "quem falta assinar o contrato da Letícia?",
    "qual o status do contrato do Carlos?",
    "como está o contrato da Letícia?",
    "contrato da Letícia já saiu?",
  ])("andamento: %s", (t) => {
    expect(perguntaDoContrato(t)).toBe(true);
    expect(pedeAcaoForaDoMax(t)).toBeNull();
  });
  it.each([
    "como funciona o contrato?",
    "o que vai no contrato de locação?",
    "manda o contrato pra assinatura",
    "a proposta da Letícia já foi assinada?",
    "o cliente quer um contrato de 30 meses",
  ])("não é andamento: %s", (t) => expect(perguntaDoContrato(t)).toBe(false));
});

describe("negaAcao", () => {
  it.each([
    ["não exclui a proposta PROP-2026-0013", "excluir"],
    ["ainda não envia a proposta da Letícia", "enviar"],
    ["não precisa duplicar", "duplicar"],
    ["não converte a proposta da Letícia ainda", "converter"],
    ["opa, não manda ainda", "enviar"],
    ["não envie o contrato", "enviar"],
  ])("%s → %s", (t, acao) => expect(negaAcao(t)).toBe(acao));
  it.each([
    "não exclui a proposta?",
    "exclui a proposta da Letícia",
    "não sei se a cliente vai mandar os documentos hoje à tarde",
    "não",
    "nao entendi",
  ])("não é negação de ação: %s", (t) => expect(negaAcao(t)).toBeNull());
});

describe("conferirDitado (eval 09/10: '11 98888-7777' virou '119888-7777')", async () => {
  const { conferirDitado } = await import("../fluxos");
  it("telefone com dígito a menos vira o que a pessoa escreveu", () => {
    expect(conferirDitado({ proponente: { telefone: "119888-7777" } }, "troca o telefone do comprador para 11 98888-7777"))
      .toEqual({ proponente: { telefone: "11 98888-7777" } });
  });
  it("valor que bate com o escrito (com ou sem 55, com ou sem máscara) fica", () => {
    expect(conferirDitado({ proponente: { telefone: "11988887777" } }, "o celular é +55 (11) 98888-7777"))
      .toEqual({ proponente: { telefone: "11988887777" } });
    expect(conferirDitado({ proponente: { email: "Leticia@X.com" } }, "e-mail leticia@x.com"))
      .toEqual({ proponente: { email: "Leticia@X.com" } });
  });
  it("inventado sem nada escrito: o campo sai", () => {
    expect(conferirDitado({ proponente: { nome: "Ana Lima", cpf: "12345678909" } }, "o nome é Ana Lima")).toEqual({ proponente: { nome: "Ana Lima" } });
  });
  it("dois números escritos e o extraído não bate com nenhum: sai (nunca chuta)", () => {
    expect(conferirDitado({ proponente: { telefone: "11 9999-0000" } }, "dela 11 98888-7777 e dele 21 97777-6666")).toEqual({});
  });
  it("CPF não vira telefone", () => {
    expect(conferirDitado({ proponente: { cpf: "123.456.789-09", telefone: "12345678909" } }, "cpf 123.456.789-09"))
      .toEqual({ proponente: { cpf: "123.456.789-09" } });
  });
});

describe("'tira a proposta' é exclusão (com resumo e SIM)", async () => {
  const { pedeGestao } = await import("../gestao");
  it.each(["tira a proposta da Letícia", "tirar a proposta PROP-2026-0013"])("%s", (t) => expect(pedeGestao(t)).toBe("excluir"));
  it("'tira o fiador da proposta' continua edição", () => expect(pedeGestao("tira o fiador da proposta da Letícia")).toBe("editar"));
});

describe("no grafo", () => {
  it("andamento do contrato: resposta do sistema, sem o modelo nem envio de proposta", async () => {
    const s = await run("o contrato da Letícia já foi enviado?");
    expect(s.reply).toContain("O andamento do contrato (envio e assinaturas) eu ainda não consulto por aqui");
    expect(s.reply).toContain("tela do negócio");
    expect(s.reply).not.toMatch(/enviar proposta/i);
    expect(llm).not.toHaveBeenCalled();
    expect(acao).not.toHaveBeenCalled();
  });

  it("andamento logo depois da conversão traz o link do negócio", async () => {
    const fluxo = { kind: "continuidade", etapa: "concluida", converter: true, resultado: "Proposta convertida.\nNegócio: https://app/deals/d1", atualizadoEm: Date.now() };
    const s = await run("o contrato já foi assinado?", { fluxo });
    expect(s.reply).toContain("na tela do negócio: https://app/deals/d1");
  });

  it("negação sem fluxo: nada foi alterado, nunca 'não consigo excluir'", async () => {
    const s = await run("não exclui a proposta PROP-2026-0013");
    expect(s.reply).toBe("Certo, não vou excluir nada. A proposta PROP-2026-0013 continua como está.");
    expect(llm).not.toHaveBeenCalled();
    expect(acao).not.toHaveBeenCalled();
  });

  it("'não converte a proposta da Letícia ainda' não abre a conversão", async () => {
    const s = await run("não converte a proposta da Letícia ainda");
    expect(s.reply).toContain("Certo, não vou converter nada");
    expect(s.fluxo ?? null).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });

  it("com fluxo aberto, o 'não' é a resposta ao resumo — quem trata é o fluxo", async () => {
    const fluxo = { kind: "gestao", operacao: "excluir", etapa: "confirmacao", alvo: { id: "p3", codigo: "PROP-2026-0013" }, atualizadoEm: Date.now() };
    const s = await run("não exclui não", { fluxo });
    expect(s.reply).toBe("Parei por aqui. Nada foi alterado.");
    expect(s.fluxo).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });

  it("na confirmação, só negar a MESMA ação cancela — 'não manda pro dono' não para a exclusão", async () => {
    const fluxo = { kind: "gestao", operacao: "excluir", etapa: "confirmacao", alvo: { id: "p3", codigo: "PROP-2026-0013" }, atualizadoEm: Date.now() };
    const s = await run("não manda nada pro proprietário", { fluxo });
    expect(s.reply).not.toBe("Parei por aqui. Nada foi alterado.");
    expect(acao).not.toHaveBeenCalled();
  });

  it("pergunta de processo sobre contrato segue para o atendimento", async () => {
    const s = await run("como funciona o contrato?");
    expect(llm).toHaveBeenCalled();
    expect(s.reply).not.toContain("eu ainda não consulto por aqui");
  });
});
