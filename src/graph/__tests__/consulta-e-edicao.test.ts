import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Consulta de propostas e edição de proposta existente pelo nome (09/10/2026).
 * Teste com o modelo de produção: "procure a da letícia" dizia "encontrei 1"
 * com duas no sistema; "remove o fiador da proposta da X" e "muda o valor da
 * proposta da X" recebiam "não consigo alterar proposta"; "edita a cláusula do
 * contrato" caía no modelo.
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
const { pedeConsulta, responderConsulta } = await import("../consulta");
const { pedeEdicao, pedeGestao, termoDaEdicao } = await import("../gestao");
const { pedeAcaoForaDoMax } = await import("../capacidades");
const { fetchProfile, searchKnowledge } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { executarAcao } = await import("@/lib/acao");

const llm = complete as unknown as ReturnType<typeof vi.fn>;
const acao = executarAcao as unknown as ReturnType<typeof vi.fn>;
const usuario = { orgId: "org1", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };
const POLITICA = { byRole: { "*": ["proposal.list", "proposal.create", "proposal.send", "proposal.delete"] }, byRecipient: {}, brokerDefault: [] };
const uso = { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true };

const P = {
  moraes: { id: "p1", codigo: "PROP-2026-0011", titulo: "Apto 302 Rua das Flores", status: "assinada_proponente", estado: "Assinada pelo proponente", signatarios: [{ nome: "Letícia Moraes", status: "assinou" }] },
  andrade: { id: "p2", codigo: "PROP-2026-0012", titulo: "Casa Jardim Europa", status: "rascunho", estado: "Rascunho", signatarios: [{ nome: "Letícia Andrade", status: "pendente" }] },
  carlos: { id: "p3", codigo: "PROP-2026-0013", titulo: "Sala Centro", status: "enviada", estado: "Enviada", signatarios: [{ nome: "Carlos Pereira", status: "pendente" }] },
};

function run(text: string, state: Record<string, unknown> = {}, messageId = "m1") {
  return buildGraph().compile().invoke({
    inbound: { messageId, fromPhone: "5511987654321", groupId: null, kind: "text" as const, text, mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null },
    identity: usuario, reply: null, halt: null, propostaDescartada: false, ...state,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: POLITICA } as never);
  vi.mocked(searchKnowledge).mockResolvedValue([]);
  llm.mockResolvedValue({ text: "", toolCalls: [], usage: uso });
});

describe("pedeConsulta", () => {
  it.each([
    "liste as minhas propostas",
    "procure a proposta da letícia",
    "qual o status da proposta da rua das flores?",
    "como está a proposta do Carlos?",
    "tem alguma proposta da Mariana?",
    "quais propostas estão em rascunho?",
    "me mostra a PROP-2026-0013",
    "Max, status da PROP-2026-0013",
  ])("consulta: %s", (t) => expect(pedeConsulta(t)).toBe(true));
  it.each([
    "quero fazer uma proposta de venda",
    "faz uma proposta pro João",
    "o contrato da Letícia já foi enviado?",
    "posso excluir a proposta?",
    "não exclui a proposta PROP-2026-0013",
    "como funciona a proposta?",
    "oi",
    "Abre uma proposta pro João Silva",
  ])("não é consulta: %s", (t) => expect(pedeConsulta(t)).toBe(false));
});

describe("pedeEdicao / termoDaEdicao", () => {
  it.each([
    ["muda o valor da proposta da Letícia Andrade para 480 mil", "leticia andrade"],
    ["remove o fiador da proposta da Letícia Andrade", "leticia andrade"],
    ["corrige o e-mail do comprador na proposta PROP-2026-0014 para r@x.com", "prop-2026-0014"],
    ["na proposta do Carlos, troca o telefone para 11 98888-7777", "carlos"],
    ["pode mudar o valor da proposta da Letícia para 470 mil?", "leticia"],
    ["edita a proposta da rua das flores", "rua flores"],
  ])("edição: %s → %s", (t, termo) => {
    expect(pedeEdicao(t)).toBe(true);
    expect(pedeGestao(t)).toBe("editar");
    expect(termoDaEdicao(t)).toBe(termo);
  });
  it.each([
    "exclui a proposta da Letícia",
    "tira a proposta da Letícia",
    "não muda o valor da proposta da Letícia",
    "posso mudar o valor da proposta?",
    "como altero a proposta da Letícia?",
    "muda o valor para 500 mil",
    "muda o prazo do contrato da Letícia",
    "adiciona uma proposta do João Silva no valor de 300 mil",
    "inclui uma proposta da Maria Souza, venda, 500 mil",
  ])("não é edição: %s", (t) => expect(pedeEdicao(t)).toBe(false));
  it("excluir e duplicar continuam antes da edição", () => {
    expect(pedeGestao("exclui a proposta da Letícia")).toBe("excluir");
    expect(pedeGestao("duplica a proposta da Letícia")).toBe("duplicar");
  });
});

describe("contrato: parte do contrato e minuta são recusa fixa", () => {
  it.each([
    "edita a cláusula do contrato",
    "muda o prazo do contrato da Letícia para 36 meses",
    "altera o valor do contrato",
    "gera a minuta",
    "corrige a minuta do contrato da Letícia",
    "corrige o contrato",
    "manda o contrato pra assinatura",
  ])("recusa: %s", (t) => expect(pedeAcaoForaDoMax(t)).toBe("contrato"));
  it.each([
    "o contrato já foi enviado?",
    "muda o valor da proposta da Letícia",
    "não muda o contrato",
  ])("não recusa: %s", (t) => expect(pedeAcaoForaDoMax(t)).toBeNull());
});

describe("responderConsulta", () => {
  const deps = (items: unknown[], extra: Record<string, unknown> = {}) => ({
    acao: vi.fn(async (verb: string, args: Record<string, unknown>) =>
      verb === "proposal.status"
        ? { status: 200, body: { proposta: items[0] } }
        : { status: 200, body: { items, total: items.length, ...(args.busca ? { busca: args.busca } : {}), ...extra } }),
    extrairProposta: vi.fn(), extrairCampos: vi.fn(),
  });
  it("duas casam: as duas, com código e situação, e nenhuma outra", async () => {
    const d = deps([P.moraes, P.andrade]);
    const r = await responderConsulta(d, "procure a proposta da letícia");
    expect(d.acao).toHaveBeenCalledWith("proposal.list", { busca: "leticia" });
    expect(r.reply).toContain("Achei 2 propostas com \"leticia\"");
    expect(r.reply).toContain("• PROP-2026-0011 — Apto 302 Rua das Flores — Assinada pelo proponente");
    expect(r.reply).toContain("• PROP-2026-0012");
  });
  it("uma: o detalhe com as assinaturas", async () => {
    const r = await responderConsulta(deps([P.carlos]), "como está a proposta do Carlos?");
    expect(r.reply).toBe("PROP-2026-0013 — Sala Centro: Enviada.\nAssinaturas: Carlos Pereira (pendente).");
  });
  it("ninguém: diz que não achou, sem listar as de outras pessoas", async () => {
    const r = await responderConsulta(deps([]), "tem alguma proposta da Mariana?");
    expect(r.reply).toContain("Não achei proposta sua com \"mariana\"");
    expect(r.reply).not.toContain("PROP-2026");
  });
  it("estado: filtra aqui; com mais propostas no servidor, diz que olhou só as recentes", async () => {
    const r = await responderConsulta(deps([P.moraes, P.andrade, P.carlos], { total: 25 }), "quais propostas estão em rascunho?");
    expect(r.reply).toContain("Entre as suas 3 propostas mais recentes, 1 está em rascunho");
    expect(r.reply).toContain("PROP-2026-0012");
    expect(r.reply).not.toContain("PROP-2026-0011");
  });
  it("lista sem termo: mostra quantas de quantas e como achar outra", async () => {
    const r = await responderConsulta(deps([P.moraes, P.andrade], { total: 14 }), "liste as minhas propostas");
    expect(r.reply).toContain("Suas propostas mais recentes (2 de 14):");
    expect(r.reply).toContain("Para achar outra");
  });
});

describe("consulta e edição no grafo", () => {
  const servidor = (props: (typeof P)[keyof typeof P][]) =>
    acao.mockImplementation(async ({ verb, args }: { verb: string; args: Record<string, unknown> }) => {
      if (verb === "proposal.list") {
        const b = String(args.busca ?? "");
        const items = b ? props.filter((p) => b.split(" ").every((w) => JSON.stringify(p).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().includes(w))) : props;
        return { status: 200, body: { items, total: items.length, ...(b ? { busca: b } : {}) } };
      }
      if (verb === "proposal.update") return { status: 200, body: { proposta: { id: args.proposta_id } } };
      throw new Error(`inesperado ${verb}`);
    });

  it("'procure a proposta da letícia' responde pelo sistema, sem o modelo", async () => {
    servidor([P.moraes, P.andrade, P.carlos]);
    const s = await run("procure a proposta da letícia");
    expect(s.reply).toContain("PROP-2026-0011");
    expect(s.reply).toContain("PROP-2026-0012");
    expect(s.reply).not.toContain("PROP-2026-0013");
    expect(llm).not.toHaveBeenCalled();
  });

  it("'muda o valor da proposta da Letícia para 480 mil': escolhe a ÚNICA editável, resumo parcial, SIM → PATCH só do valor", async () => {
    servidor([P.moraes, P.andrade]);
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "preencher_proposta", args: { proponente: { nome: "Letícia" }, valor: 480000 } }], usage: uso });
    const s = await run("muda o valor da proposta da Letícia para 480 mil");
    // As outras que casam ficam ditas, e o resumo traz título e cliente (review 09/10).
    expect(s.reply).toContain('Achei 2 propostas com "leticia"; só a PROP-2026-0012 ainda pode ser ajustada.');
    expect(s.reply).toContain("Vou ajustar na proposta PROP-2026-0012 — Casa Jardim Europa (Letícia Andrade):");
    expect(s.reply).toContain("Valor: R$");
    expect(s.reply).not.toContain("Nome do proponente");
    expect(s.fluxo).toMatchObject({ kind: "proposta", etapa: "revisao_ajuste", propostaId: "p2" });
    expect(acao.mock.calls.map(([p]) => p.verb)).toEqual(["proposal.list"]);
    const fim = await run("SIM", { fluxo: s.fluxo }, "sim1");
    const update = acao.mock.calls.find(([p]) => p.verb === "proposal.update")![0];
    expect(update.args).toEqual({ proposta_id: "p2", valor: 480000 });
    expect(update.idempotencyKey).toBe("sim1");
    expect(fim.reply).toContain("Atualizei o rascunho PROP-2026-0012");
  });

  it("proposta enviada não é editável: diz o estado e oferece duplicar, sem escrever", async () => {
    servidor([P.carlos]);
    const s = await run("muda o valor da proposta do Carlos para 300 mil");
    expect(s.reply).toContain("PROP-2026-0013");
    expect(s.reply).toContain("está enviada: só proposta ainda não enviada pode ser ajustada");
    expect(s.reply).toContain("duplica a proposta PROP-2026-0013");
    expect(acao.mock.calls.map(([p]) => p.verb)).toEqual(["proposal.list"]);
  });

  it("'edita a proposta da Letícia Andrade' sem dizer o quê: pergunta o que mudar e diz o que dá", async () => {
    servidor([P.andrade]);
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "preencher_proposta", args: {} }], usage: uso });
    const s = await run("edita a proposta da Letícia Andrade");
    expect(s.reply).toContain("O que você quer mudar na proposta PROP-2026-0012");
    expect(s.fluxo).toMatchObject({ kind: "proposta", etapa: "ajustes", propostaId: "p2" });
    expect((s.fluxo as { referencia?: string }).referencia).toBeUndefined();
  });

  it("'remove o fiador da proposta da Letícia Andrade': caminho da tela, nunca exclusão nem 'não edito proposta'", async () => {
    servidor([P.andrade]);
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "preencher_proposta", args: { canal: "whatsapp" } }], usage: uso });
    const s = await run("remove o fiador da proposta da Letícia Andrade");
    expect(s.reply).toContain("Fiador não dá para ajustar pelo WhatsApp");
    expect(acao.mock.calls.map(([p]) => p.verb)).toEqual(["proposal.list"]);
  });

  it("review 09/10 #2: 'corrige o e-mail … e manda pra assinatura' mostra o ajuste antes — nunca envia a versão velha", async () => {
    servidor([P.andrade]);
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "preencher_proposta", args: { proponente: { email: "leticia@x.com" } } }], usage: uso });
    const s = await run("corrige o e-mail da proposta da Letícia Andrade para leticia@x.com e manda pra assinatura");
    expect(s.reply).toContain("E-mail do proponente: leticia@x.com");
    expect(s.fluxo).toMatchObject({ kind: "proposta", etapa: "revisao_ajuste" });
    expect(acao.mock.calls.map(([p]) => p.verb)).toEqual(["proposal.list"]);
  });

  it("review 09/10 #3: com um rascunho aberto para ajuste, a edição de OUTRA proposta busca a citada", async () => {
    servidor([P.andrade, P.carlos]);
    const aberto = { kind: "proposta", etapa: "ajustes", dados: {}, propostaId: "p2", codigo: "PROP-2026-0012", atualizadoEm: Date.now() };
    const s = await run("muda o valor da proposta do Carlos para 300 mil", { fluxo: aberto });
    expect(s.reply).toContain("PROP-2026-0013");
    expect(s.reply).toContain("só proposta ainda não enviada pode ser ajustada");
    expect(acao.mock.calls.map(([p]) => p.verb)).toEqual(["proposal.list"]);
  });

  it("review 09/10 #9: com um rascunho aberto, 'procure a proposta da letícia' ainda é a consulta do sistema", async () => {
    servidor([P.moraes, P.andrade]);
    const aberto = { kind: "proposta", etapa: "ajustes", dados: {}, propostaId: "p2", codigo: "PROP-2026-0012", atualizadoEm: Date.now() };
    const s = await run("procure a proposta da letícia", { fluxo: aberto });
    expect(s.reply).toContain("PROP-2026-0011");
    expect(llm).not.toHaveBeenCalled();
  });

  it("review 09/10 #1/#10: CPF pendente + e-mail → o PATCH leva o que o resumo mostrou; depois os dados zeram", async () => {
    servidor([P.andrade]);
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "preencher_proposta", args: { proponente: { email: "l@x.com" } } }], usage: uso });
    const aberto = { kind: "proposta", etapa: "ajustes", dados: {}, propostaId: "p2", codigo: "PROP-2026-0012", pendenciaCpf: true, atualizadoEm: Date.now() };
    const s = await run("o e-mail dela é l@x.com", { fluxo: aberto });
    expect(s.reply).toContain("E-mail do proponente: l@x.com");
    const fim = await run("SIM", { fluxo: s.fluxo }, "sim2");
    const update = acao.mock.calls.find(([p]) => p.verb === "proposal.update")![0];
    expect(update.args).toEqual({ proposta_id: "p2", proponente: { email: "l@x.com" } });
    // O CPF continua pendente (não veio) e o ajuste aplicado não é reenviado depois.
    expect(fim.fluxo).toMatchObject({ dados: {}, pendenciaCpf: true });
  });

  it("review 09/10 #6: 'a proposta do Carlos já foi assinada?' mostra a situação real, não 'não achei'", async () => {
    servidor([P.carlos]);
    const s = await run("a proposta do Carlos já foi assinada?");
    expect(s.reply).toContain("PROP-2026-0013 — Sala Centro: Enviada.");
  });

  it("'edita a cláusula do contrato' é recusa fixa, sem o modelo", async () => {
    const s = await run("edita a cláusula do contrato");
    expect(s.reply).toContain("Contrato eu não gero, não edito");
    expect(llm).not.toHaveBeenCalled();
  });
});
