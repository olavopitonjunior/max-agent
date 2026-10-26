import { describe, it, expect, beforeEach, vi } from "vitest";
import { conduzirAssinatura, iniciarAssinatura, motivoDaFrase, pedeAssinatura, pedeTrocaDeSignatario, type FluxoAssinatura } from "../assinatura";
import { pedeGestao } from "../gestao";
import { textoDeCapacidades } from "../capacidades";
import { buscarPropostas } from "../localizar";
import { derivarInterativo } from "@/lib/interativo";
import { rebaixarFluxo, type ContextoDoTurno } from "../fluxos";

/**
 * Lembrar quem falta assinar e cancelar a assinatura da proposta pelo WhatsApp
 * (Passo 4, 25/10/2026). Os NEGADOS vêm primeiro: sem política, política
 * indisponível e identidade sem escrita nunca chegam ao servidor.
 */

const acao = vi.fn();
const deps = { acao, extrairCampos: vi.fn(), extrairProposta: vi.fn() };
const POLITICA = ["proposal.list", "proposal.create", "proposal.send"] as const;
const ctx = (texto: string, extra: Partial<ContextoDoTurno> = {}): ContextoDoTurno => ({
  texto, messageId: "m1", agora: 1, policy: [...POLITICA], ...extra,
});

const assinaturas = [
  { nome: "Letícia Andrade", status: "pendente", canal: "whatsapp" as const },
  { nome: "João Lima", status: "pendente", canal: "email" as const },
  { nome: "Maria Souza", status: "assinou", canal: "email" as const },
];
const leticia = {
  id: "p1", codigo: "PROP-2026-0031", titulo: "Rua X, 100", status: "enviada", estado: "Enviada",
  signatarios: [
    { nome: "Letícia Andrade", status: "pendente", canal: "whatsapp" },
    { nome: "João Lima", status: "pendente", canal: "email" },
    { nome: "Maria Souza", status: "assinou", canal: "email" },
  ],
};
const soLeticia = [{ nome: "Letícia Andrade", status: "pendente", canal: "whatsapp" }];
const lista = (...itens: unknown[]) => ({ status: 200, body: { items: itens, total: itens.length, busca: "leticia" } });
const alvo = { id: "p1", codigo: "PROP-2026-0031", titulo: "Rua X, 100", estado: "Enviada", status: "enviada", assinaturas };
const confirmando = (operacao: "lembrar" | "cancelar", extra: Partial<FluxoAssinatura> = {}): FluxoAssinatura => ({
  kind: "assinatura", operacao, etapa: "confirmacao", alvo, atualizadoEm: 1,
  ...(operacao === "cancelar" ? { motivo: "o cliente desistiu" } : {}), ...extra,
});
beforeEach(() => acao.mockReset());

describe("NEGADOS primeiro", () => {
  it.each(["lembrar", "cancelar"] as const)("%s: sem proposal.send na política, recusa sem chamar o servidor", async (op) => {
    const r = await iniciarAssinatura(op, ctx("cancela a proposta da Letícia", { policy: ["proposal.list", "proposal.create"] }), deps);
    expect(r.fluxo).toBeNull();
    expect(r.reply).toContain("não está liberado para você");
    expect(acao).not.toHaveBeenCalled();
  });
  it.each(["lembrar", "cancelar"] as const)("%s: sem proposal.list na política, recusa sem chamar o servidor", async (op) => {
    const r = await iniciarAssinatura(op, ctx("x", { policy: ["proposal.send"] }), deps);
    expect(r.fluxo).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });
  it.each(["lembrar", "cancelar"] as const)("%s: política indisponível não é recusa de permissão e não chama o servidor", async (op) => {
    const r = await iniciarAssinatura(op, ctx("x", { politicaIndisponivel: true }), deps);
    expect(r.fluxo).toBeNull();
    expect(r.reply).toContain("Não consegui validar sua permissão");
    expect(acao).not.toHaveBeenCalled();
  });
  it("política que some no meio do fluxo: o SIM não escreve", async () => {
    const r = await conduzirAssinatura(confirmando("cancelar"), ctx("sim", { policy: ["proposal.list"] }), deps);
    expect(r.fluxo).toMatchObject({ etapa: "resumo" });
    expect(acao).not.toHaveBeenCalled();
  });
  it("política indisponível no meio do fluxo: o SIM não escreve", async () => {
    const r = await conduzirAssinatura(confirmando("lembrar"), ctx("sim", { politicaIndisponivel: true }), deps);
    expect(r.fluxo).toMatchObject({ etapa: "resumo" });
    expect(acao).not.toHaveBeenCalled();
  });
  it("etapa resumo (fluxo interrompido): o SIM só reapresenta o resumo", async () => {
    const r = await conduzirAssinatura(confirmando("cancelar", { etapa: "resumo" }), ctx("sim"), deps);
    expect(acao).not.toHaveBeenCalled();
    expect(r).toMatchObject({ fluxo: { etapa: "confirmacao" } });
  });
  it("rebaixar: a confirmação volta ao resumo (interrupção do turn)", () => {
    expect(rebaixarFluxo(confirmando("cancelar"))).toMatchObject({ kind: "assinatura", etapa: "resumo" });
  });
});

describe("pedeAssinatura — detecção", () => {
  it.each([
    ["lembra quem falta assinar a proposta da Letícia", "lembrar"],
    ["manda um lembrete da proposta PROP-2026-0031", "lembrar"],
    ["cobra a assinatura da proposta do João", "lembrar"],
    ["reenvia o lembrete da proposta X", "lembrar"],
    ["Max, lembra quem não assinou a proposta da Letícia", "lembrar"],
    ["pode lembrar quem falta assinar a proposta do João?", "lembrar"],
    ["cancela a proposta da Letícia", "cancelar"],
    ["cancela a assinatura da proposta PROP-2026-0031", "cancelar"],
    ["pode cancelar a proposta X porque o cliente desistiu", "cancelar"],
    ["Max: cancela a proposta da Letícia", "cancelar"],
    ["cancelar a proposta da Letícia, o cliente não quer mais", "cancelar"],
  ])("%s → %s", (t, esperado) => {
    expect(pedeAssinatura(t)).toBe(esperado);
  });
  it.each([
    "a proposta foi cancelada?",
    "como cancelo?",
    "como cancelar a proposta?",
    "não cancela a proposta da Letícia",
    "nunca cancele a proposta",
    "cancelar",
    "cancela",
    "lembra de mim amanhã",
    "me lembra de ligar pro João",
    "me lembra de mandar a proposta do João amanhã",
    "lembra de mandar a proposta do João",
    "lembra que a proposta vence amanhã",
    "cria uma atividade para lembrar a proposta da Letícia",
    "cancela o contrato da Letícia",
    "cancela a reunião com o João",
    "manda a proposta da Letícia",
    "reenvia a proposta da Letícia",
    "exclui a proposta da Letícia",
    "quem falta assinar a proposta da Letícia?",
    "não lembra ninguém da proposta da Letícia",
    "lembrete da proposta é automático?",
  ])("não casa: %s", (t) => {
    expect(pedeAssinatura(t)).toBeNull();
  });
  it("'exclui a proposta' segue sendo gestão e 'cancela a proposta' vai para a assinatura (disjuntos)", () => {
    expect(pedeGestao("exclui a proposta da Letícia")).toBe("excluir");
    expect(pedeAssinatura("exclui a proposta da Letícia")).toBeNull();
    expect(pedeGestao("cancela a proposta da Letícia")).toBeNull();
    expect(pedeAssinatura("cancela a proposta da Letícia")).toBe("cancelar");
  });
  it("motivo da frase: porque/pois/motivo, 3 a 500 caracteres", () => {
    expect(motivoDaFrase("cancela a proposta X porque o cliente desistiu.")).toBe("o cliente desistiu");
    expect(motivoDaFrase("cancela a proposta X, pois a Ana vendeu para outro")).toBe("a Ana vendeu para outro");
    expect(motivoDaFrase("cancela a proposta X. Motivo: valor errado")).toBe("valor errado");
    expect(motivoDaFrase("cancela a proposta X porque ab")).toBeNull();
    expect(motivoDaFrase("cancela a proposta X")).toBeNull();
    expect(motivoDaFrase(`cancela a proposta X porque ${"a".repeat(501)}`)).toBeNull();
  });
});

describe("projeção: canal dos signatários", () => {
  it("só os três canais; outro valor ou ausência não vira canal", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { proposta: {
      id: "p", codigo: "PROP-2026-0001", status: "enviada",
      signatarios: [
        { nome: "A", status: "pendente", canal: "whatsapp" }, { nome: "B", status: "pendente", canal: "pombo" },
        { nome: "C", status: "assinou" }, { nome: "D", status: "pendente", canal: null }, { nome: "E", status: "pendente", canal: "sms" },
      ],
    } } });
    const r = await buscarPropostas(deps, "PROP-2026-0001");
    expect(r?.itens[0]?.assinaturas).toEqual([
      { nome: "A", status: "pendente", canal: "whatsapp" }, { nome: "B", status: "pendente" },
      { nome: "C", status: "assinou" }, { nome: "D", status: "pendente" }, { nome: "E", status: "pendente", canal: "sms" },
    ]);
  });
});

describe("seleção", () => {
  it("uma só que casa e está em estado útil: resumo com signatários, sem chamar o verbo de escrita", async () => {
    acao.mockResolvedValueOnce(lista(leticia));
    const r = await iniciarAssinatura("lembrar", ctx("lembra quem falta assinar a proposta da Letícia"), deps);
    expect(acao).toHaveBeenCalledTimes(1);
    expect(acao).toHaveBeenCalledWith("proposal.list", { busca: "leticia" });
    expect(r.fluxo).toMatchObject({ etapa: "confirmacao", alvo: { id: "p1" } });
    expect(r.reply).toBe(
      "Lembrar a assinatura da proposta PROP-2026-0031 (Rua X, 100)?\n" +
      "Vai para quem ainda não assinou, pelo canal de cada um:\n" +
      "• Letícia Andrade — pendente — WhatsApp\n" +
      "• João Lima — pendente — e-mail\n" +
      "Já assinaram: Maria Souza.\n\n" +
      "Responda SIM para confirmar ou NÃO para parar."
    );
  });
  it("código citado usa proposal.status", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { proposta: leticia } });
    const r = await iniciarAssinatura("lembrar", ctx("manda um lembrete da proposta PROP-2026-0031"), deps);
    expect(acao).toHaveBeenCalledWith("proposal.status", { codigo: "PROP-2026-0031" });
    expect(r.fluxo).toMatchObject({ etapa: "confirmacao" });
  });
  it("várias úteis: lista numerada 'Responda com o número.' que vira lista interativa", async () => {
    acao.mockResolvedValueOnce(lista(leticia, { ...leticia, id: "p2", codigo: "PROP-2026-0032", titulo: "Rua Y, 7" }));
    const r = await iniciarAssinatura("lembrar", ctx("lembra quem falta assinar a proposta da Letícia"), deps);
    expect(r.fluxo).toMatchObject({ etapa: "selecao" });
    expect(r.reply).toContain("1. PROP-2026-0031");
    expect(r.reply).toContain("2. PROP-2026-0032");
    expect(r.reply).toContain("Responda com o número.");
    expect(derivarInterativo(r.reply)).toMatchObject({ tipo: "lista", opcoes: [{ id: "op:1" }, { id: "op:2" }] });
  });
  it("escolher pelo número abre o resumo; número fora da lista pede de novo", async () => {
    acao.mockResolvedValueOnce(lista(leticia, { ...leticia, id: "p2", codigo: "PROP-2026-0032" }));
    const r = await iniciarAssinatura("lembrar", ctx("lembra quem falta assinar a proposta da Letícia"), deps);
    const fora = await conduzirAssinatura(r.fluxo as FluxoAssinatura, ctx("9"), deps);
    expect(fora.reply).toContain("Esse número não está na lista");
    const dois = await conduzirAssinatura(r.fluxo as FluxoAssinatura, ctx("2"), deps);
    expect(dois.fluxo).toMatchObject({ etapa: "confirmacao", alvo: { id: "p2" } });
    expect(acao).toHaveBeenCalledTimes(1);
  });
  it("lembrar: só entra quem está em estado de receber lembrete; a assinada/rascunho fica de fora", async () => {
    acao.mockResolvedValueOnce(lista({ ...leticia, id: "p0", codigo: "PROP-2026-0001", status: "rascunho", estado: "Rascunho" }, leticia));
    const r = await iniciarAssinatura("lembrar", ctx("lembra quem falta assinar a proposta da Letícia"), deps);
    expect(r.fluxo).toMatchObject({ etapa: "confirmacao", alvo: { id: "p1" } });
    expect(r.reply).toContain("só a PROP-2026-0031");
  });
  it("lembrar: nenhuma útil mas há casadas: diz o estado e NÃO abre SIM", async () => {
    acao.mockResolvedValueOnce(lista({ ...leticia, status: "assinada", estado: "Assinada" }));
    const r = await iniciarAssinatura("lembrar", ctx("lembra quem falta assinar a proposta da Letícia"), deps);
    expect(r.fluxo).toBeNull();
    expect(r.reply).toContain("tem assinatura em andamento para lembrar");
    expect(r.reply).toContain("PROP-2026-0031 — Rua X, 100 (Assinada)");
    expect(r.reply).not.toContain("Responda SIM");
  });
  it("cancelar: rascunho e falha de envio são canceláveis; assinada, convertida e cancelada não", async () => {
    acao.mockResolvedValueOnce(lista({ ...leticia, status: "rascunho", estado: "Rascunho", signatarios: soLeticia }));
    const rascunho = await iniciarAssinatura("cancelar", ctx("cancela a proposta da Letícia porque o cliente desistiu"), deps);
    expect(rascunho.fluxo).toMatchObject({ etapa: "confirmacao" });
    acao.mockResolvedValueOnce(lista({ ...leticia, status: "falha_envio", estado: "Falha no envio" }));
    const falha = await iniciarAssinatura("cancelar", ctx("cancela a proposta da Letícia porque o cliente desistiu"), deps);
    expect(falha.fluxo).toMatchObject({ etapa: "confirmacao" });
    for (const status of ["assinada", "convertida", "cancelada", "recusada", "expirada"]) {
      acao.mockResolvedValueOnce(lista({ ...leticia, status, estado: status }));
      const nao = await iniciarAssinatura("cancelar", ctx("cancela a proposta da Letícia"), deps);
      expect(nao.fluxo).toBeNull();
      expect(nao.reply).toContain("pode ser cancelada agora");
    }
  });
  it("nenhuma achada: pede o nome; servidor sem resposta: nada alterado", async () => {
    acao.mockResolvedValueOnce(lista());
    const nada = await iniciarAssinatura("lembrar", ctx("lembra quem falta assinar a proposta da Letícia"), deps);
    expect(nada.reply).toContain('Não achei proposta sua com "leticia"');
    acao.mockResolvedValueOnce(null);
    const semResposta = await iniciarAssinatura("cancelar", ctx("cancela a proposta da Letícia"), deps);
    expect(semResposta.fluxo).toBeNull();
    expect(semResposta.reply).toContain("Nada foi alterado");
  });
  it("sem termo, nunca escolhe a mais recente: lista para escolher", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { items: [leticia], total: 1 } });
    const r = await iniciarAssinatura("cancelar", ctx("cancela a proposta"), deps);
    expect(r.fluxo).toMatchObject({ etapa: "selecao" });
    expect(r.fluxo).not.toHaveProperty("alvo");
  });
  it("servidor antigo que ignora a busca não faz o Max escolher a proposta de OUTRA pessoa", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { items: [leticia], total: 1 } });
    const r = await iniciarAssinatura("lembrar", ctx("lembra quem falta assinar a proposta do Carlos"), deps);
    expect(r.reply).toContain('Não achei proposta sua com "carlos"');
    expect(r.fluxo).toMatchObject({ etapa: "selecao" });
    expect(r.fluxo).not.toHaveProperty("alvo");
  });
  it("a justificativa não entra na busca: 'porque a Ana desistiu' não procura a proposta da Ana", async () => {
    acao.mockResolvedValueOnce(lista(leticia));
    await iniciarAssinatura("cancelar", ctx("cancela a proposta da Letícia porque a Ana desistiu de comprar"), deps);
    expect(acao).toHaveBeenCalledWith("proposal.list", { busca: "leticia" });
  });
  it("outro assunto na seleção libera e encerra", async () => {
    const f: FluxoAssinatura = { kind: "assinatura", operacao: "lembrar", etapa: "selecao", atualizadoEm: 1, candidatos: [{ id: "p1", codigo: "PROP-2026-0031" }] };
    const r = await conduzirAssinatura(f, ctx("faz uma proposta pro Carlos"), deps);
    expect(r).toMatchObject({ liberar: true, fluxo: null });
    expect(acao).not.toHaveBeenCalled();
  });
});

describe("resumo com signatários", () => {
  it("canal desconhecido: omite o ' — canal'", () => {
    const f = confirmando("lembrar", { alvo: { ...alvo, assinaturas: [{ nome: "Ana", status: "pendente" }] } });
    return conduzirAssinatura({ ...f, etapa: "resumo" }, ctx("ok"), deps).then((r) => {
      expect(r.reply).toContain("• Ana — pendente\n");
      expect(r.reply).not.toContain("pendente —");
    });
  });
  it("lembrar sem NENHUM pendente na projeção: não pede SIM", async () => {
    acao.mockResolvedValueOnce(lista({ ...leticia, signatarios: [{ nome: "Maria Souza", status: "assinou", canal: "email" }] }));
    const r = await iniciarAssinatura("lembrar", ctx("lembra quem falta assinar a proposta da Maria"), deps);
    expect(r.fluxo).toBeNull();
    expect(r.reply).toBe("Todos já assinaram a proposta PROP-2026-0031; não há a quem lembrar.");
  });
  it("lista vazia de signatários: mostra '(sem signatários listados)' e segue", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { proposta: { ...leticia, signatarios: [] } } });
    const r = await iniciarAssinatura("lembrar", ctx("lembra quem falta assinar a proposta PROP-2026-0031"), deps);
    expect(r.fluxo).toMatchObject({ etapa: "confirmacao" });
    expect(r.reply).toContain("(sem signatários listados)");
  });
  it("a frase final é EXATAMENTE a que vira botões SIM/NÃO", async () => {
    acao.mockResolvedValueOnce(lista(leticia));
    const r = await iniciarAssinatura("lembrar", ctx("lembra quem falta assinar a proposta da Letícia"), deps);
    expect(r.reply.endsWith("Responda SIM para confirmar ou NÃO para parar.")).toBe(true);
    expect(derivarInterativo(r.reply)).toMatchObject({ tipo: "botoes", opcoes: [{ id: "op:SIM" }, { id: "op:NÃO" }] });
  });
});

describe("cancelar: motivo", () => {
  it("sem motivo na frase: pergunta o motivo antes do resumo, sem chamar o verbo", async () => {
    acao.mockResolvedValueOnce(lista(leticia));
    const r = await iniciarAssinatura("cancelar", ctx("cancela a proposta da Letícia"), deps);
    expect(r.fluxo).toMatchObject({ etapa: "motivo", alvo: { id: "p1" } });
    expect(r.reply).toContain("Qual o motivo do cancelamento? (vai no histórico da proposta)");
    expect(acao).toHaveBeenCalledTimes(1);
  });
  describe('"(N no total)" só conta quem poderia ser escolhido — smoke 26/10', () => {
    const rascunho = { id: "p2", codigo: "PROP-2026-0002", titulo: "João da Silva", status: "rascunho", estado: "Rascunho" };
    const convertida = { id: "p0", codigo: "PROP-2026-0001", titulo: "Letícia Gonçalves", status: "convertida", estado: "Virou negócio" };
    const outraRascunho = { ...rascunho, id: "p3", codigo: "PROP-2026-0003" };
    it("1 útil + 1 convertida (total 2): lista a útil e NÃO diz '2 no total'", async () => {
      acao.mockResolvedValueOnce({ status: 200, body: { items: [rascunho, convertida], total: 2 } });
      const r = await iniciarAssinatura("cancelar", ctx("cancela uma proposta"), deps);
      expect(r.reply).toContain("1. PROP-2026-0002 — João da Silva (Rascunho)");
      expect(r.reply).not.toContain("no total");
      expect(r.reply).not.toContain("Há mais");
    });
    it("a página do CM tem mais que o Max trouxe: avisa que há mais, sem número enganoso", async () => {
      acao.mockResolvedValueOnce({ status: 200, body: { items: [rascunho, outraRascunho], total: 9 } });
      const r = await iniciarAssinatura("cancelar", ctx("cancela uma proposta"), deps);
      expect(r.reply).toContain("Há mais propostas; se não estiver aqui, me diga o nome ou o código.");
      expect(r.reply).not.toContain("no total");
    });
    it("mais úteis do que as 5 listadas: diz quantas há no total", async () => {
      const sete = Array.from({ length: 7 }, (_, i) => ({ ...rascunho, id: `r${i}`, codigo: `PROP-2026-01${i}` }));
      acao.mockResolvedValueOnce({ status: 200, body: { items: [...sete, convertida], total: 8 } });
      const r = await iniciarAssinatura("cancelar", ctx("cancela uma proposta"), deps);
      expect(r.reply).toContain("(7 no total; se não estiver aqui, me diga o nome ou o código.)");
      expect(r.reply).not.toContain("5. PROP-2026-0014\n6.");
    });
  });
  it("motivo na frase: vai direto ao resumo, com o motivo e os signatários", async () => {
    acao.mockResolvedValueOnce(lista(leticia));
    const r = await iniciarAssinatura("cancelar", ctx("pode cancelar a proposta da Letícia porque o cliente desistiu"), deps);
    expect(r.fluxo).toMatchObject({ etapa: "confirmacao", motivo: "o cliente desistiu" });
    expect(r.reply).toBe(
      "Cancelar a proposta PROP-2026-0031 (Rua X, 100)? A assinatura em andamento será cancelada na ClickSign e ninguém mais conseguirá assinar. Motivo: o cliente desistiu.\n" +
      "Signatários:\n" +
      "• Letícia Andrade — pendente — WhatsApp\n" +
      "• João Lima — pendente — e-mail\n" +
      "• Maria Souza — assinou — e-mail\n\n" +
      "Responda SIM para confirmar ou NÃO para parar."
    );
  });
  it("rascunho: não fala em ClickSign no resumo nem no resultado", async () => {
    acao.mockResolvedValueOnce(lista({ ...leticia, status: "rascunho", estado: "Rascunho", signatarios: soLeticia }));
    const r = await iniciarAssinatura("cancelar", ctx("cancela a proposta da Letícia porque o cliente desistiu"), deps);
    expect(r.reply).not.toContain("ClickSign");
    acao.mockResolvedValueOnce({ status: 200, body: { proposta: { status: "cancelada" } } });
    const fim = await conduzirAssinatura(r.fluxo as FluxoAssinatura, ctx("sim", { messageId: "m2" }), deps);
    expect(fim.reply).toBe("Proposta PROP-2026-0031 cancelada.");
  });
  it("resposta curta (<3) pede o motivo de novo; motivo válido vai ao resumo", async () => {
    const f: FluxoAssinatura = { kind: "assinatura", operacao: "cancelar", etapa: "motivo", alvo, atualizadoEm: 1 };
    const curta = await conduzirAssinatura(f, ctx("ab"), deps);
    expect(curta.fluxo).toMatchObject({ etapa: "motivo" });
    expect(curta.reply).toContain("Preciso do motivo");
    const sim = await conduzirAssinatura(f, ctx("sim"), deps);
    expect(sim.fluxo).toMatchObject({ etapa: "motivo" });
    const longa = await conduzirAssinatura(f, ctx("a".repeat(501)), deps);
    expect(longa.reply).toContain("no máximo 500");
    const ok = await conduzirAssinatura(f, ctx("cliente desistiu da compra"), deps);
    expect(ok.fluxo).toMatchObject({ etapa: "confirmacao", motivo: "cliente desistiu da compra" });
    expect(acao).not.toHaveBeenCalled();
  });
  it("na etapa do motivo: NÃO e 'cancelar' sozinho encerram sem chamar o servidor", async () => {
    const f: FluxoAssinatura = { kind: "assinatura", operacao: "cancelar", etapa: "motivo", alvo, atualizadoEm: 1 };
    for (const t of ["não", "cancelar", "pare"]) {
      const r = await conduzirAssinatura(f, ctx(t), deps);
      expect(r.fluxo).toBeNull();
    }
    expect(acao).not.toHaveBeenCalled();
  });
  it("na etapa do motivo, uma pergunta não vira motivo: libera e o fluxo fica", async () => {
    const f: FluxoAssinatura = { kind: "assinatura", operacao: "cancelar", etapa: "motivo", alvo, atualizadoEm: 1 };
    const r = await conduzirAssinatura(f, ctx("que horas são?"), deps);
    expect(r).toMatchObject({ liberar: true, fluxo: { etapa: "motivo" } });
  });
  it("o motivo da frase sobrevive à escolha por número", async () => {
    acao.mockResolvedValueOnce(lista(leticia, { ...leticia, id: "p2", codigo: "PROP-2026-0032" }));
    const r = await iniciarAssinatura("cancelar", ctx("cancela a proposta da Letícia porque o cliente desistiu"), deps);
    expect(r.fluxo).toMatchObject({ etapa: "selecao", motivo: "o cliente desistiu" });
    const dois = await conduzirAssinatura(r.fluxo as FluxoAssinatura, ctx("2"), deps);
    expect(dois.fluxo).toMatchObject({ etapa: "confirmacao", motivo: "o cliente desistiu", alvo: { id: "p2" } });
  });
});

describe("SIM chama o servidor", () => {
  it("lembrar: proposal.remind com { proposta_id } e a messageId do SIM; nunca antes", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { enviados: ["Letícia Andrade", "João Lima"], pulados: [] } });
    const r = await conduzirAssinatura(confirmando("lembrar"), ctx("sim", { messageId: "m2" }), deps);
    expect(acao).toHaveBeenCalledTimes(1);
    expect(acao).toHaveBeenCalledWith("proposal.remind", { proposta_id: "p1" }, "m2");
    expect(r.reply).toBe("Lembrete enviado para Letícia Andrade e João Lima.");
    expect(r.fluxo).toBeNull();
  });
  it("lembrar com pulados: diz quem não foi lembrado e por quê", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { enviados: ["Letícia Andrade"], pulados: [{ nome: "Maria", motivo: "já lembrado há menos de 1h" }, { nome: null, motivo: "sem vínculo" }] } });
    const r = await conduzirAssinatura(confirmando("lembrar"), ctx("sim", { messageId: "m2" }), deps);
    expect(r.reply).toBe("Lembrete enviado para Letícia Andrade.\nNão lembrei: Maria (já lembrado há menos de 1h), um signatário (sem vínculo).");
  });
  it("cancelar: proposal.cancel com { proposta_id, motivo } e a messageId do SIM", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { proposta: { id: "p1", status: "cancelada" } } });
    const r = await conduzirAssinatura(confirmando("cancelar"), ctx("sim", { messageId: "m9" }), deps);
    expect(acao).toHaveBeenCalledWith("proposal.cancel", { proposta_id: "p1", motivo: "o cliente desistiu" }, "m9");
    expect(r.reply).toBe("Proposta PROP-2026-0031 cancelada. A assinatura na ClickSign foi encerrada.");
    expect(r.fluxo).toBeNull();
  });
  it("corpo REAL do CM (projetarPropostaCriada: `estado` é o rótulo, sem `status`) confirma o cancelamento — smoke 26/10", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { proposta: { id: "p1", codigo: "PROP-2026-0002", titulo: "Proposta — João da Silva", estado: "Cancelada" } } });
    const r = await conduzirAssinatura(confirmando("cancelar"), ctx("sim", { messageId: "m9" }), deps);
    expect(r.reply).toBe("Proposta PROP-2026-0031 cancelada. A assinatura na ClickSign foi encerrada.");
    expect(r.evento).toBe("proposta_cancelada");
    expect(r.fluxo).toBeNull();
  });
  it("`estado` de outra coisa (ex.: 'Enviada') não afirma o cancelamento", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { proposta: { id: "p1", estado: "Enviada" } } });
    const r = await conduzirAssinatura(confirmando("cancelar"), ctx("sim"), deps);
    expect(r.evento).toBe("assinatura_cancelar_nao_confirmado");
  });
  it("200 que não diz 'cancelada' não afirma o cancelamento", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { proposta: { status: "enviada" } } });
    const r = await conduzirAssinatura(confirmando("cancelar"), ctx("sim"), deps);
    expect(r.reply).not.toContain("cancelada.");
    expect(r.reply).toContain("não confirmou");
  });
  it.each([[{}], [{ proposta: {} }], [{ proposta: { id: "p1" } }]])("200 sem status no corpo (%j) não afirma o cancelamento", async (body) => {
    acao.mockResolvedValueOnce({ status: 200, body });
    const r = await conduzirAssinatura(confirmando("cancelar"), ctx("sim"), deps);
    expect(r.reply).not.toContain("cancelada.");
    expect(r.reply).toContain("não confirmou");
  });
  it.each(["não precisa lembrar", "não lembra ninguém", "nao quero que voce lembre"])("'%s' na confirmação do lembrete é NÃO, sem chamar o servidor", async (texto) => {
    const r = await conduzirAssinatura(confirmando("lembrar"), ctx(texto), deps);
    expect(r.reply).toBe("Parei por aqui. Nada foi enviado.");
    expect(r.fluxo).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });
  it("200 do lembrete sem ninguém lembrado não afirma envio", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { enviados: [], pulados: [] } });
    const r = await conduzirAssinatura(confirmando("lembrar"), ctx("sim"), deps);
    expect(r.reply).not.toContain("Lembrete enviado");
  });
  it("sem SIM (outra frase afirmativa fora do vocabulário) o servidor não é chamado", async () => {
    const r = await conduzirAssinatura(confirmando("cancelar"), ctx("talvez"), deps);
    expect(r).toMatchObject({ liberar: true });
    expect(acao).not.toHaveBeenCalled();
  });
});

describe("resultado incerto", () => {
  it.each([
    ["lembrar", "proposal.remind", { proposta_id: "p1" }],
    ["cancelar", "proposal.cancel", { proposta_id: "p1", motivo: "o cliente desistiu" }],
  ] as const)("%s: null mantém a chave; o próximo SIM reusa a MESMA chave e os mesmos args", async (op, verbo, args) => {
    acao.mockResolvedValueOnce(null);
    const r = await conduzirAssinatura(confirmando(op), ctx("sim", { messageId: "m2" }), deps);
    expect(r.reply).toBe("Ainda não confirmei o resultado. Responda SIM para verificar o mesmo pedido, sem repeti-lo.");
    expect(r.fluxo).toMatchObject({ etapa: "confirmacao", chave: { verbo, valor: "m2" } });
    acao.mockResolvedValueOnce({ status: 200, body: op === "lembrar" ? { enviados: ["Letícia Andrade"], pulados: [] } : { proposta: { status: "cancelada" } } });
    const fim = await conduzirAssinatura(r.fluxo as FluxoAssinatura, ctx("sim", { messageId: "m3" }), deps);
    expect(acao).toHaveBeenLastCalledWith(verbo, args, "m2");
    expect(fim.fluxo).toBeNull();
  });
  it("409 em_andamento é incerto, igual a null", async () => {
    acao.mockResolvedValueOnce({ status: 409, body: { error: "em_andamento" } });
    const r = await conduzirAssinatura(confirmando("lembrar"), ctx("sim", { messageId: "m2" }), deps);
    expect(r.reply).toContain("Ainda não confirmei");
    expect(r.fluxo).toMatchObject({ chave: { valor: "m2" } });
  });
  it("NÃO com escrita incerta guarda a chave; o próximo SIM confere o MESMO pedido", async () => {
    const f = confirmando("cancelar", { chave: { verbo: "proposal.cancel", valor: "m2" } });
    const r = await conduzirAssinatura(f, ctx("não"), deps);
    expect(r.fluxo).toMatchObject({ chave: { valor: "m2" }, etapa: "resumo" });
    expect(acao).not.toHaveBeenCalled();
  });
  it("outro assunto com escrita incerta libera o turno e guarda a chave", async () => {
    const f = confirmando("cancelar", { chave: { verbo: "proposal.cancel", valor: "m2" } });
    const r = await conduzirAssinatura(f, ctx("bom dia, tudo bem?"), deps);
    expect(r).toMatchObject({ liberar: true, fluxo: { chave: { valor: "m2" } } });
  });
  it("outro pedido de assinatura com escrita em aberto NÃO recomeça (a chave manda)", async () => {
    const f = confirmando("cancelar", { chave: { verbo: "proposal.cancel", valor: "m2" } });
    const r = await conduzirAssinatura(f, ctx("cancela a proposta da Maria"), deps);
    expect(acao).not.toHaveBeenCalled();
    expect(r).toMatchObject({ liberar: true, fluxo: { chave: { valor: "m2" } } });
  });
});

describe("recusas → frase fixa, nunca 'enviado'/'cancelada'", () => {
  const ok = (r: { reply?: string }) => {
    expect(r.reply).not.toMatch(/Lembrete enviado|Proposta \S+ cancelada\./);
  };
  it.each([
    [403, { error: "Forbidden" }, "Sua permissão no sistema não permite lembrar"],
    [403, { error: "Forbidden", reason: "politica_nao_concede" }, "não está liberado para você"],
    [403, { error: "MODULE_DISABLED" }, "Propostas estão desligadas"],
    [404, { error: "Not Found" }, "Não encontrei a proposta PROP-2026-0031"],
    [409, { error: "estado_sem_lembrete", estado: "Assinada" }, "está assinada: não há assinatura em andamento"],
    [409, { error: "ninguem_pendente" }, "Não há ninguém pendente"],
    [422, { error: "aceite_sem_lembrete" }, "aceite por WhatsApp, que não tem lembrete"],
    [500, { error: "x" }, "O sistema não confirmou o lembrete"],
  ])("lembrar %i %j", async (status, body, trecho) => {
    acao.mockResolvedValueOnce({ status, body });
    const r = await conduzirAssinatura(confirmando("lembrar"), ctx("sim"), deps);
    expect(r.reply).toContain(trecho);
    expect(r.reply).toContain("Nada foi enviado");
    expect(r.fluxo).toBeNull();
    ok(r);
  });
  it.each([409, 429, 502])("lembrete_recusado %i: mostra os motivos por nome", async (status) => {
    acao.mockResolvedValueOnce({ status, body: { error: "lembrete_recusado", pulados: [{ nome: "Letícia Andrade", motivo: "já lembrado há menos de 1h" }, { nome: "João Lima", motivo: "limite de 5 lembretes atingido" }] } });
    const r = await conduzirAssinatura(confirmando("lembrar"), ctx("sim"), deps);
    expect(r.reply).toBe(
      "Não consegui lembrar ninguém na proposta PROP-2026-0031:\n• Letícia Andrade (já lembrado há menos de 1h)\n• João Lima (limite de 5 lembretes atingido)\nNada foi enviado."
    );
    expect(r.fluxo).toBeNull();
  });
  it("motivo vindo do servidor entra em uma linha e com teto", async () => {
    acao.mockResolvedValueOnce({ status: 429, body: { error: "lembrete_recusado", pulados: [{ nome: "A\nB", motivo: `x\n\ny${"z".repeat(300)}` }] } });
    const r = await conduzirAssinatura(confirmando("lembrar"), ctx("sim"), deps);
    expect((r.reply ?? "").split("\n")).toHaveLength(3);
    expect((r.reply ?? "").length).toBeLessThan(400);
  });
  it.each([
    [403, { error: "Forbidden" }, "Sua permissão no sistema não permite cancelar"],
    [403, { error: "Forbidden", reason: "politica_nao_concede" }, "Cancelar proposta pelo"],
    [403, { error: "MODULE_DISABLED" }, "Propostas estão desligadas"],
    [404, { error: "Not Found" }, "Não encontrei a proposta PROP-2026-0031"],
    [409, { error: "estado_nao_cancelavel", estado: "Convertida" }, "está convertida e não pode mais ser cancelada"],
    [409, { error: "cancelamento_recusado" }, "A ClickSign não confirmou o cancelamento da assinatura da proposta PROP-2026-0031. Confira o status na tela de propostas antes de tentar de novo."],
    [502, { error: "cancelamento_falhou" }, "Não consegui confirmar o cancelamento da proposta PROP-2026-0031. Confira o status"],
    [400, { error: "Bad Request" }, "O sistema não confirmou o cancelamento"],
  ])("cancelar %i %j", async (status, body, trecho) => {
    acao.mockResolvedValueOnce({ status, body });
    const r = await conduzirAssinatura(confirmando("cancelar"), ctx("sim"), deps);
    expect(r.reply).toContain(trecho);
    expect(r.fluxo).toBeNull();
    ok(r);
  });
});

describe("NÃO / negação encerra sem chamar o servidor", () => {
  it.each(["lembrar", "cancelar"] as const)("%s: NÃO", async (op) => {
    const r = await conduzirAssinatura(confirmando(op), ctx("não"), deps);
    expect(r.fluxo).toBeNull();
    expect(r.reply).toContain("Parei por aqui");
    expect(acao).not.toHaveBeenCalled();
  });
  it("'cancelar' sozinho dentro do fluxo de CANCELAR é o NÃO", async () => {
    const r = await conduzirAssinatura(confirmando("cancelar"), ctx("cancelar"), deps);
    expect(r.fluxo).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });
  it("'não cancela' dentro do fluxo de cancelar é o NÃO", async () => {
    const r = await conduzirAssinatura(confirmando("cancelar"), ctx("não cancela não"), deps);
    expect(r.fluxo).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });
  it("'não manda' dentro do fluxo de lembrar é o NÃO", async () => {
    const r = await conduzirAssinatura(confirmando("lembrar"), ctx("não manda não"), deps);
    expect(r.fluxo).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });
  it("o resumo vira botões SIM/NÃO e o toque volta como o texto digitado", () => {
    const i = derivarInterativo("Cancelar a proposta X?\n\nResponda SIM para confirmar ou NÃO para parar.");
    expect(i).toMatchObject({ tipo: "botoes", opcoes: [{ id: "op:SIM", titulo: "SIM" }, { id: "op:NÃO", titulo: "NÃO" }] });
  });
});

describe("o que o Max anuncia", () => {
  it("lembrar e cancelar só com proposal.send e identidade de escrita", () => {
    expect(textoDeCapacidades(["proposal.list", "proposal.send"], true)).toContain("lembrar quem falta assinar, cancelar proposta enviada");
    expect(textoDeCapacidades(["proposal.list", "proposal.create"], true)).not.toContain("lembrar quem falta assinar");
    expect(textoDeCapacidades(["proposal.list", "proposal.send"], false)).not.toContain("lembrar quem falta assinar");
  });
});

// ─── Trocar o contato de quem assina (Passo 4c, 26/10/2026) ─────────────────

const POS_ENVIO = [
  "A proposta PROP-2026-0031 (Rua X, 100) já foi enviada para assinatura. Depois do envio não dá para trocar o contato de quem assina no mesmo envio, nem pela tela.",
  "O caminho:",
  '1. Na tela da proposta, use "Cancelar envelope". A proposta volta para edição; ela não é cancelada.',
  "2. Me diga o contato certo que eu corrijo.",
  "3. Peça para eu enviar de novo.",
].join("\n");
const SIGNATARIOS = "\nSignatários:\n• Letícia Andrade — pendente — WhatsApp\n• João Lima — pendente — e-mail\n• Maria Souza — assinou — e-mail";
const PEDIDO_TROCA = "troca o e-mail da Letícia na proposta PROP-2026-0031";
const so = (status: string, estado = status) => ({ status: 200, body: { proposta: { ...leticia, status, estado } } });

describe("trocar signatário: NEGADOS primeiro", () => {
  it("sem proposal.send na política: não lê nem escreve nada; o pedido segue o caminho normal", async () => {
    const r = await iniciarAssinatura("trocar", ctx(PEDIDO_TROCA, { policy: ["proposal.list", "proposal.create"] }), deps);
    expect(r).toMatchObject({ liberar: true, fluxo: null });
    expect(acao).not.toHaveBeenCalled();
  });
  it("sem proposal.list, ou política indisponível: idem", async () => {
    const a = await iniciarAssinatura("trocar", ctx(PEDIDO_TROCA, { policy: ["proposal.send"] }), deps);
    const b = await iniciarAssinatura("trocar", ctx(PEDIDO_TROCA, { politicaIndisponivel: true }), deps);
    expect(a).toMatchObject({ liberar: true });
    expect(b).toMatchObject({ liberar: true });
    expect(acao).not.toHaveBeenCalled();
  });
  it.each([
    "não troca o e-mail da proposta PROP-2026-0031",
    "nunca mude o telefone da Letícia na proposta PROP-2026-0031",
    "não precisa trocar o e-mail do assinante da proposta da Letícia",
    "não altera o contato da proposta da Letícia",
  ])("negação não dispara: %s", (t) => {
    expect(pedeTrocaDeSignatario(t)).toBe(false);
    expect(pedeAssinatura(t)).toBeNull();
  });
  it("nunca chama verbo de escrita, em nenhum desfecho", async () => {
    for (const status of ["enviada", "rascunho", "cancelada"]) {
      acao.mockResolvedValueOnce(so(status));
      await iniciarAssinatura("trocar", ctx(PEDIDO_TROCA), deps);
    }
    const verbos = acao.mock.calls.map(([v]) => v);
    expect(verbos.every((v) => v === "proposal.status" || v === "proposal.list")).toBe(true);
  });
});

describe("pedeAssinatura — trocar signatário", () => {
  it.each([
    "troca o e-mail da Letícia na proposta PROP-2026-0031",
    "muda o telefone do assinante da proposta da Letícia",
    "corrige o whatsapp do João na proposta PROP-2026-0031",
    "altera o número da Maria na proposta da Letícia",
    "Max, atualiza o e-mail do signatário da proposta PROP-2026-0031",
    "quero mudar o contato do assinante da proposta da Letícia",
    "pode trocar o e-mail da Letícia na proposta PROP-2026-0031?",
    "dá pra mudar o telefone do assinante da proposta da Letícia?",
    "da pra trocar o e-mail do assinante da proposta PROP-2026-0031?",
    "tem como corrigir o celular da Letícia na proposta dela?",
    "como eu troco o e-mail do assinante da proposta PROP-2026-0031?",
    "como altero o canal de assinatura da proposta da Letícia?",
    "na proposta PROP-2026-0031, troca o e-mail da Letícia",
    "troca o e-mail da Letícia na proposta PROP-2026-0031 porque ela mudou",
  ])("%s → trocar", (t) => {
    expect(pedeAssinatura(t)).toBe("trocar");
  });
  it.each([
    "troca o valor da proposta da Letícia para 480 mil",
    "muda a data de vencimento da proposta PROP-2026-0031",
    "troca o e-mail da Letícia",
    "o e-mail do assinante da proposta está certo?",
    "a proposta da Letícia mudou de e-mail?",
    "qual o e-mail do assinante da proposta PROP-2026-0031?",
    "exclui a proposta da Letícia",
    "manda a proposta da Letícia",
    "troca de e-mail o assinante",
  ])("não casa: %s", (t) => {
    expect(pedeAssinatura(t)).toBeNull();
  });
  it("cancelar e lembrar seguem com prioridade; excluir segue na gestão", () => {
    expect(pedeAssinatura("cancela a proposta da Letícia")).toBe("cancelar");
    expect(pedeAssinatura("cancela a proposta da Letícia, o cliente não mudou de ideia")).toBe("cancelar");
    expect(pedeAssinatura("cancela a proposta PROP-2026-0031 e troca o e-mail do assinante")).toBe("cancelar");
    expect(pedeAssinatura("lembra quem falta assinar a proposta da Letícia")).toBe("lembrar");
    expect(pedeAssinatura("exclui a proposta da Letícia")).toBeNull();
    expect(pedeGestao("exclui a proposta da Letícia")).toBe("excluir");
  });
});

describe("trocar signatário — depois do envio", () => {
  it.each(["enviada", "entregue", "visualizada", "assinada_proponente", "aguardando_vendedor"])("%s: resposta fixa com os signatários, só leitura", async (status) => {
    acao.mockResolvedValueOnce(so(status));
    const r = await iniciarAssinatura("trocar", ctx(PEDIDO_TROCA), deps);
    expect(r).toEqual({ fluxo: null, reply: POS_ENVIO + SIGNATARIOS, evento: "assinatura_troca_pos_envio" });
    expect(acao).toHaveBeenCalledTimes(1);
    expect(acao).toHaveBeenCalledWith("proposal.status", { codigo: "PROP-2026-0031" });
  });
  it("sem signatários na projeção: omite a lista", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { proposta: { ...leticia, signatarios: [] } } });
    const r = await iniciarAssinatura("trocar", ctx(PEDIDO_TROCA), deps);
    expect(r.reply).toBe(POS_ENVIO);
  });
  it("pergunta 'dá pra mudar…?' acha pelo nome e dá a mesma orientação", async () => {
    acao.mockResolvedValueOnce(lista(leticia));
    const r = await iniciarAssinatura("trocar", ctx("dá pra mudar o telefone do assinante da proposta da Letícia?"), deps);
    expect(acao).toHaveBeenCalledWith("proposal.list", { busca: "leticia" });
    expect(r.reply).toBe(POS_ENVIO + SIGNATARIOS);
  });
  it("não oferece cancelar a proposta", async () => {
    acao.mockResolvedValueOnce(so("enviada"));
    const r = await iniciarAssinatura("trocar", ctx(PEDIDO_TROCA), deps);
    expect(r.reply).not.toMatch(/cancelar a proposta|proposal\.cancel|Responda SIM/i);
  });
  it("várias propostas: pede o número (sem assumir a mais recente); o número pós-envio dá o texto fixo", async () => {
    acao.mockResolvedValueOnce(lista(leticia, { ...leticia, id: "p2", codigo: "PROP-2026-0032", titulo: "Rua Y, 7", status: "rascunho", estado: "Rascunho" }));
    const r = await iniciarAssinatura("trocar", ctx("troca o e-mail do assinante da proposta da Letícia"), deps);
    expect(r.fluxo).toMatchObject({ kind: "assinatura", operacao: "trocar", etapa: "selecao" });
    expect(r.reply).toContain("1. PROP-2026-0031");
    expect(r.reply).toContain("2. PROP-2026-0032");
    expect(r.reply).toContain("Responda com o número.");
    const fora = await conduzirAssinatura(r.fluxo as FluxoAssinatura, ctx("9"), deps);
    expect(fora.reply).toContain("Esse número não está na lista");
    const um = await conduzirAssinatura(r.fluxo as FluxoAssinatura, ctx("1"), deps);
    expect(um).toEqual({ fluxo: null, reply: POS_ENVIO + SIGNATARIOS, evento: "assinatura_troca_pos_envio" });
    expect(acao).toHaveBeenCalledTimes(1);
  });
  it("lista: a escolhida ainda não enviada diz que dá para corrigir agora", async () => {
    acao.mockResolvedValueOnce(lista(leticia, { ...leticia, id: "p2", codigo: "PROP-2026-0032", titulo: "Rua Y, 7", status: "rascunho", estado: "Rascunho" }));
    const r = await iniciarAssinatura("trocar", ctx("troca o e-mail do assinante da proposta da Letícia"), deps);
    const dois = await conduzirAssinatura(r.fluxo as FluxoAssinatura, ctx("2"), deps);
    expect(dois).toMatchObject({ fluxo: null, evento: "assinatura_troca_pre_envio" });
    expect(dois.reply).toBe(
      "A proposta PROP-2026-0032 (Rua Y, 7) ainda não foi enviada: dá para corrigir o contato agora. Me diga o dado novo " +
      "(por exemplo: troca o e-mail da Ana na proposta PROP-2026-0032 para ana@exemplo.com)."
    );
  });
  it("lista: a escolhida terminal diz o estado", async () => {
    acao.mockResolvedValueOnce(lista(leticia, { ...leticia, id: "p2", codigo: "PROP-2026-0032", status: "cancelada", estado: "Cancelada" }));
    const r = await iniciarAssinatura("trocar", ctx("troca o e-mail do assinante da proposta da Letícia"), deps);
    const dois = await conduzirAssinatura(r.fluxo as FluxoAssinatura, ctx("2"), deps);
    expect(dois.reply).toBe("A proposta PROP-2026-0032 (Rua X, 100) está cancelada; não há assinatura em andamento para corrigir.");
  });
  it("'não' / outro assunto na seleção encerram sem chamar o servidor", async () => {
    const f: FluxoAssinatura = { kind: "assinatura", operacao: "trocar", etapa: "selecao", atualizadoEm: 1, candidatos: [{ id: "p1", codigo: "PROP-2026-0031", status: "enviada" }] };
    const nao = await conduzirAssinatura(f, ctx("não"), deps);
    expect(nao).toMatchObject({ fluxo: null, reply: "Parei por aqui. Nada foi alterado." });
    const outro = await conduzirAssinatura(f, ctx("faz uma proposta pro Carlos"), deps);
    expect(outro).toMatchObject({ liberar: true, fluxo: null });
    expect(acao).not.toHaveBeenCalled();
  });
});

describe("trocar signatário — antes do envio e terminais", () => {
  it.each(["rascunho", "aguardando_aprovacao", "falha_envio"])("%s: não é deste fluxo (liberar), para seguir o caminho normal", async (status) => {
    acao.mockResolvedValueOnce(so(status));
    const r = await iniciarAssinatura("trocar", ctx(PEDIDO_TROCA), deps);
    expect(r).toMatchObject({ liberar: true, fluxo: null });
    expect(acao).toHaveBeenCalledTimes(1);
  });
  it("várias achadas e nenhuma enviada: também segue o caminho normal", async () => {
    acao.mockResolvedValueOnce(lista({ ...leticia, status: "rascunho" }, { ...leticia, id: "p2", codigo: "PROP-2026-0032", status: "falha_envio" }));
    const r = await iniciarAssinatura("trocar", ctx("troca o e-mail do assinante da proposta da Letícia"), deps);
    expect(r).toMatchObject({ liberar: true, fluxo: null });
  });
  it("nada achado, ou leitura sem resposta: segue o caminho normal", async () => {
    acao.mockResolvedValueOnce(lista());
    expect(await iniciarAssinatura("trocar", ctx("troca o e-mail do assinante da proposta da Letícia"), deps)).toMatchObject({ liberar: true });
    acao.mockResolvedValueOnce(null);
    expect(await iniciarAssinatura("trocar", ctx(PEDIDO_TROCA), deps)).toMatchObject({ liberar: true });
  });
  it.each(["convertida", "recusada_proponente", "recusada_vendedor", "expirada", "cancelada", "completa"])("%s: frase de terminal", async (status) => {
    acao.mockResolvedValueOnce(so(status, status.replace("_", " ")));
    const r = await iniciarAssinatura("trocar", ctx(PEDIDO_TROCA), deps);
    expect(r).toEqual({
      fluxo: null, evento: "assinatura_troca_terminal",
      reply: `A proposta PROP-2026-0031 (Rua X, 100) está ${status.replace("_", " ")}; não há assinatura em andamento para corrigir.`,
    });
  });
  it("status que este Max não conhece: não afirma nada, segue o caminho normal", async () => {
    acao.mockResolvedValueOnce(so("em_analise_juridica", "Em análise"));
    expect(await iniciarAssinatura("trocar", ctx(PEDIDO_TROCA), deps)).toMatchObject({ liberar: true });
  });
});
