import { describe, it, expect, beforeEach, vi } from "vitest";
import { casaComTermo, pedeLista, termoDaResposta, termoDeBusca } from "../localizar";
import { conduzirGestao, iniciarGestao, pedeGestao, type FluxoGestao } from "../gestao";
import { pedeAcaoForaDoMax, pedeCapacidades, textoDeCapacidades } from "../capacidades";
import type { ContextoDoTurno } from "../fluxos";

/**
 * Proposta pelo WhatsApp, decisão do Olavo de 09/10/2026: achar pelo nome em
 * TODAS as propostas, listar, excluir e duplicar; contrato e cobrança fora do
 * Max; o que o Max faz sai da política, não do modelo.
 */

describe("termoDeBusca — o que a pessoa citou", () => {
  it.each([
    ["Max, tranforme a proposta da Letícia em negócio e gere o link do formulário", "leticia"],
    ["Procure nas minhas propostas a da letícia.", "leticia"],
    ["exclui a proposta do João Silva", "joao silva"],
    ["duplica a PROP-2026-0007", "prop-2026-0007"],
    ["apaga a proposta da rua das Flores 1200", "rua flores 1200"],
    ["duplica a proposta pra corrigir", null],
    ["exclui a proposta de ontem", null],
    ["a da Ana, telefone 11 98765 4321", "ana"],
    ["Concluir. Pode criar o formulário desse negócio.", null],
    ["Liste as minhas propostas", null],
    ["O que vc pode fazer agora?", null],
    ["minhas propostas assinadas", null],
    ["exclui a proposta do cpf 123.456.789-09", null],
    ["duplica a da Ana, telefone 11987654321", "ana"],
  ])("%s → %s", (texto, esperado) => {
    expect(termoDeBusca(texto)).toBe(esperado);
  });

  it("casa sem acento e sem caixa, em código, título ou nome de signatário; todos os tokens", () => {
    const p = { id: "p", codigo: "PROP-2026-0001", titulo: "Apto 302 Rua das Flores", status: "rascunho", nomes: ["Letícia Souza"] };
    expect(casaComTermo(p, "leticia")).toBe(true);
    expect(casaComTermo(p, "flores 302")).toBe(true);
    expect(casaComTermo(p, "0001")).toBe(true);
    expect(casaComTermo(p, "leticia maria")).toBe(false);
  });

  it("palavra inteira: 'ana' não acha Mariana; '202' não acha todo código de 2026 (review 09/10)", () => {
    const mariana = { id: "p", codigo: "PROP-2026-0042", titulo: "Rua X", status: "rascunho", nomes: ["Mariana Souza"] };
    expect(casaComTermo(mariana, "ana")).toBe(false);
    expect(casaComTermo(mariana, "202")).toBe(false);
    expect(casaComTermo(mariana, "mari")).toBe(true);
    expect(casaComTermo(mariana, "042")).toBe(true);
  });

  it.each([
    ["Letícia", "leticia"],
    ["leticia souza", "leticia souza"],
    ["a da Ana", "ana"],
    ["faz uma proposta pro Carlos", null],
    ["sim", null],
    ["11987654321", null],
  ])("termoDaResposta na seleção: %s → %s", (t, esperado) => {
    expect(termoDaResposta(t)).toBe(esperado);
  });

  it.each(["Liste as minhas propostas", "quais são minhas propostas?", "mostra as propostas"])("pedeLista: %s", (t) => {
    expect(pedeLista(t)).toBe(true);
  });
});

describe("pedeGestao", () => {
  it.each([
    ["exclui a proposta da Letícia", "excluir"],
    ["Max, apaga a PROP-2026-0003", "excluir"],
    ["pode deletar essa proposta", "excluir"],
    ["duplica a proposta do João", "duplicar"],
    ["faz uma cópia da proposta da Maria", "duplicar"],
    ["como excluir uma proposta?", null],
    ["não exclua a proposta", null],
    ["exclui o rascunho do formulário", null],
    ["manda a proposta da Letícia", null],
    ["remove o fiador da proposta", null],
    ["apaga o telefone errado da proposta", null],
    ["me manda uma cópia da proposta assinada da Letícia", null],
    ["copia o endereço da proposta do João", null],
    ["a proposta do João foi excluída?", null],
    ["nunca exclua a proposta", null],
  ])("%s → %s", (t, esperado) => {
    expect(pedeGestao(t)).toBe(esperado);
  });
});

const acao = vi.fn();
const deps = { acao, extrairCampos: vi.fn(), extrairProposta: vi.fn() };
const ctx = (texto: string, extra: Partial<ContextoDoTurno> = {}): ContextoDoTurno => ({
  texto, messageId: "m1", agora: 1, policy: ["proposal.list", "proposal.create", "proposal.send", "proposal.delete"], ...extra,
});
const leticia = { id: "p1", codigo: "PROP-2026-0001", titulo: "Apto Letícia", status: "rascunho", estado: "Rascunho" };
const confirmando = (operacao: "excluir" | "duplicar"): FluxoGestao => ({
  kind: "gestao", operacao, etapa: "confirmacao", alvo: { id: "p1", codigo: "PROP-2026-0001" }, atualizadoEm: 1,
});
beforeEach(() => acao.mockReset());

describe("excluir", () => {
  it("sem a capability da política, nem consulta", async () => {
    const r = await iniciarGestao("excluir", ctx("exclui a proposta da Letícia", { policy: ["proposal.list"] }), deps);
    expect(r.fluxo).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });
  it("acha pelo nome, resume, e só exclui depois do SIM, com a messageId do SIM", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { items: [leticia], total: 1, busca: "leticia" } });
    const r = await iniciarGestao("excluir", ctx("exclui a proposta da Letícia"), deps);
    expect(r.reply).toContain("PROP-2026-0001");
    expect(r.reply).toContain("definitiva");
    expect(acao).toHaveBeenCalledTimes(1);
    acao.mockResolvedValueOnce({ status: 200, body: { ok: true } });
    const fim = await conduzirGestao(r.fluxo as FluxoGestao, ctx("sim", { messageId: "m2" }), deps);
    expect(acao).toHaveBeenLastCalledWith("proposal.delete", { proposta_id: "p1" }, "m2");
    expect(fim.reply).toBe("Proposta PROP-2026-0001 excluída.");
    expect(fim.fluxo).toBeNull();
  });
  it("sem termo, nunca escolhe a mais recente: lista para escolher", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { items: [leticia], total: 1 } });
    const r = await iniciarGestao("excluir", ctx("exclui essa proposta"), deps);
    expect(r.fluxo).toMatchObject({ etapa: "selecao" });
    expect(r.reply).toContain("1. PROP-2026-0001");
  });
  it("servidor antigo que ignora a busca não faz o Max escolher a proposta de outra pessoa", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { items: [leticia], total: 1 } });
    const r = await iniciarGestao("excluir", ctx("exclui a proposta da Maria"), deps);
    expect(r.fluxo).toMatchObject({ etapa: "selecao" });
    expect(r.fluxo).not.toHaveProperty("alvo");
  });
  it.each([
    ["ja_convertida", "já virou negócio"],
    ["ja_enviada", "só cancelada"],
    ["assinatura_ativa", "ClickSign"],
    ["estado_mudou", "mudou de situação"],
  ])("409 %s vira frase fixa, sem afirmar exclusão", async (codigo, trecho) => {
    acao.mockResolvedValueOnce({ status: 409, body: { error: codigo } });
    const r = await conduzirGestao(confirmando("excluir"), ctx("sim"), deps);
    expect(r.reply).toContain(trecho);
    expect(r.reply).not.toContain("excluída.");
  });
  it("resultado incerto guarda a chave; o retry usa a MESMA chave e 404 conta como já excluída", async () => {
    acao.mockResolvedValueOnce(null);
    const r = await conduzirGestao(confirmando("excluir"), ctx("sim", { messageId: "m2" }), deps);
    expect(r.fluxo).toMatchObject({ chave: { verbo: "proposal.delete", valor: "m2" } });
    acao.mockResolvedValueOnce({ status: 404, body: {} });
    const r2 = await conduzirGestao(r.fluxo as FluxoGestao, ctx("sim", { messageId: "m3" }), deps);
    expect(acao).toHaveBeenLastCalledWith("proposal.delete", { proposta_id: "p1" }, "m2");
    expect(r2.reply).toContain("não existe mais");
  });
  it("NÃO na confirmação não chama o servidor", async () => {
    const r = await conduzirGestao(confirmando("excluir"), ctx("não"), deps);
    expect(r.fluxo).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });
});

describe("seleção aberta (review 09/10)", () => {
  const selecao: FluxoGestao = { kind: "gestao", operacao: "excluir", etapa: "selecao", atualizadoEm: 1,
    candidatos: [{ id: "p1", codigo: "PROP-2026-0001" }] };
  it("'faz uma proposta pro Carlos' não vira busca para excluir: libera e encerra", async () => {
    const r = await conduzirGestao(selecao, ctx("faz uma proposta pro Carlos"), deps);
    expect(r).toMatchObject({ liberar: true, fluxo: null });
    expect(acao).not.toHaveBeenCalled();
  });
  it("resposta curta com o nome busca por ele", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { items: [leticia], total: 1, busca: "leticia" } });
    const r = await conduzirGestao(selecao, ctx("Letícia"), deps);
    expect(acao).toHaveBeenCalledWith("proposal.list", { busca: "leticia" });
    expect(r.reply).toContain('achada por "leticia"');
  });
  it("com escrita incerta, outro assunto libera o turno mas guarda a chave (W1)", async () => {
    const f: FluxoGestao = { ...confirmando("duplicar"), chave: { verbo: "proposal.duplicate", valor: "m2" } };
    const r = await conduzirGestao(f, ctx("bom dia, tudo bem?"), deps);
    expect(r).toMatchObject({ liberar: true, fluxo: { chave: { valor: "m2" } } });
  });
  it("NÃO com escrita incerta guarda a chave; o próximo SIM confere o MESMO pedido (W4)", async () => {
    const f: FluxoGestao = { ...confirmando("duplicar"), chave: { verbo: "proposal.duplicate", valor: "m2" } };
    const r = await conduzirGestao(f, ctx("não"), deps);
    expect(r.fluxo).toMatchObject({ chave: { valor: "m2" }, etapa: "resumo" });
  });
});

describe("duplicar", () => {
  it("cria o rascunho novo e deixa aberto para ajuste e envio", async () => {
    acao.mockResolvedValueOnce({ status: 201, body: { proposta: { id: "p2", codigo: "PROP-2026-0002", titulo: "Apto Letícia" }, origem: { codigo: "PROP-2026-0001" } } });
    const r = await conduzirGestao(confirmando("duplicar"), ctx("sim", { messageId: "m2" }), deps);
    expect(acao).toHaveBeenLastCalledWith("proposal.duplicate", { proposta_id: "p1" }, "m2");
    expect(r.reply).toContain("PROP-2026-0002");
    expect(r.reply).toContain("A original não mudou");
    expect(r.fluxo).toMatchObject({ kind: "proposta", etapa: "ajustes", propostaId: "p2" });
  });
  it("só precisa de proposal.create, não de proposal.delete", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { items: [leticia], total: 1, busca: "leticia" } });
    const r = await iniciarGestao("duplicar", ctx("duplica a proposta da Letícia", { policy: ["proposal.list", "proposal.create"] }), deps);
    expect(r.fluxo).toMatchObject({ etapa: "confirmacao" });
  });
});

describe("o que o Max faz e o que não faz", () => {
  it.each(["O que vc pode fazer agora?", "o que você faz?", "Max, como você pode me ajudar?", "quais suas funções"])("pedeCapacidades: %s", (t) => {
    expect(pedeCapacidades(t)).toBe(true);
  });
  it.each(["o que falta no negócio da Letícia?", "qual o status da proposta?", "o que pode atrasar a assinatura?", "o que fazer agora?", "o que faz a proposta ir pro proprietário?"])("não é pergunta de capacidade: %s", (t) => {
    expect(pedeCapacidades(t)).toBe(false);
  });
  it("lista só o que a política concede, nunca cobrança nem certidões como capacidade", () => {
    const todas = textoDeCapacidades(["proposal.list", "proposal.create", "proposal.send", "proposal.delete", "form.create", "deal.list"], true);
    expect(todas).toContain("excluir");
    expect(todas).toContain("duplicar");
    expect(todas).not.toMatch(/certid/i);
    expect(todas).toContain("Contrato e cobrança são pela tela do negócio");
    const leitura = textoDeCapacidades(["proposal.list", "deal.list"], true);
    expect(leitura).not.toContain("excluir");
    expect(leitura).not.toContain("enviar");
    const semEscrita = textoDeCapacidades(["proposal.create", "proposal.delete"], false);
    expect(semEscrita).not.toContain("excluir");
  });
  it.each([
    ["manda o contrato pra assinatura", "contrato"],
    ["gera o contrato do negócio da Letícia", "contrato"],
    ["edita o contrato", "contrato"],
    ["cria a cobrança da comissão", "cobranca"],
    ["como funciona a assinatura do contrato?", null],
    ["manda a proposta pra assinatura", null],
    ["o seguro fiança cobre o aluguel?", null],
    ["a imobiliária cobra taxa de visita", null],
    ["o contrato do João já foi enviado?", null],
    ["faz uma proposta de locação, contrato de 30 meses", null],
    ["não quero gerar contrato agora, só a proposta", null],
    ["gera o boleto da comissão", "cobranca"],
  ])("pedeAcaoForaDoMax: %s → %s", (t, esperado) => {
    expect(pedeAcaoForaDoMax(t)).toBe(esperado);
  });
});
