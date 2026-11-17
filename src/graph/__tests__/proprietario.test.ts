import { describe, it, expect, beforeEach, vi } from "vitest";
import { conduzirAssinatura, iniciarAssinatura, vendedorDaFrase, type FluxoAssinatura } from "../assinatura";
import { pedeProprietario, respostaAoAviso, sugestaoPendente } from "../proprietario";
import { rebaixarFluxo, type ContextoDoTurno } from "../fluxos";

/**
 * Enviar ao proprietário / encerrar depois que o proponente assinou
 * (plano de 14/11/2026; servidor: docs/max.md §18.7 do contractmaker).
 * Os NEGADOS vêm primeiro: sem confirmação, sem política, sem aviso pendente,
 * nada chega ao servidor e nenhum verbo nasce.
 */

const acao = vi.fn();
const deps = { acao, extrairCampos: vi.fn(), extrairProposta: vi.fn() };
const POLITICA = ["proposal.list", "proposal.create", "proposal.send"] as const;
const ctx = (texto: string, extra: Partial<ContextoDoTurno> = {}): ContextoDoTurno => ({
  texto, messageId: "m1", agora: 1, policy: [...POLITICA], ...extra,
});
const aguardando = {
  id: "p1", codigo: "PROP-2026-0031", titulo: "Rua X, 100", status: "assinada_proponente", estado: "Assinada pelo proponente",
  signatarios: [{ nome: "Maria Souza", status: "assinou", canal: "email" }],
};
const alvo = { id: "p1", codigo: "PROP-2026-0031", titulo: "Rua X, 100", estado: "Assinada pelo proponente", status: "assinada_proponente" };
const confirmando = (operacao: "enviar_proprietario" | "encerrar", extra: Partial<FluxoAssinatura> = {}): FluxoAssinatura => ({
  kind: "assinatura", operacao, etapa: "confirmacao", alvo, atualizadoEm: 1, ...extra,
});
beforeEach(() => acao.mockReset());

const AVISO = "Olá, Carlos! O proponente assinou a proposta PROP-2026-0031 Rua X, 100, da RE/MAX Trio. A assinatura está registrada; consulte os próximos passos pelo botão abaixo.";
const AVISO_COM_OPCOES = "O proponente assinou a PROP-2026-0031. Decida: enviar ao proprietário ou encerrar aqui.";

describe("NEGADOS primeiro: detecção", () => {
  it.each([
    "encerrar",
    "encerra",
    "enviar",
    "manda",
    "sim",
    "ok",
    "pode mandar",
    "não encerra a proposta PROP-2026-0031 sem o proprietário",
    "não envia a proposta PROP-2026-0031 pro proprietário",
    "nunca encerra a PROP-2026-0031 sem o proprietário",
    "dá pra enviar a proposta PROP-2026-0031 ao proprietário?",
    "o que acontece se eu encerrar a proposta PROP-2026-0031 sem o proprietário?",
    "manda um lembrete pro vendedor da proposta PROP-2026-0031",
    "envia o contrato pro proprietário",
    "encerra o contrato sem o proprietário",
    "envia a proposta da Ana",
    "encerra a proposta da Ana",
  ])("pedeProprietario(%j) não vira verbo", (texto) => {
    expect(pedeProprietario(texto)).toBeNull();
  });

  it("respostaAoAviso: sem aviso pendente, nada vira verbo (encerrar é irreversível)", () => {
    for (const t of ["encerrar", "enviar", "encerra aqui", "envia ao proprietário"]) expect(respostaAoAviso(t, null)).toBeNull();
  });

  it("respostaAoAviso: com aviso pendente, 'sim', 'ok', 'manda' e perguntas NÃO escolhem nada", () => {
    const s = { codigo: "PROP-2026-0031" };
    for (const t of ["sim", "SIM", "ok", "manda", "pode", "não encerra", "não envia", "encerrar?", "o que é encerrar?", "enviar a quem?", "talvez"]) {
      expect(respostaAoAviso(t, s)).toBeNull();
    }
  });

  it("sugestaoPendente: reconhece o aviso que o outbox realmente semeia (título + corpo do CM + pergunta fixa)", () => {
    const semeado = [
      "Oi, Carlos! *Proponente assinou — sua vez*",
      "O proponente assinou. Decida: enviar a 2ª via ao proprietário ou concluir sem enviar. https://app.test/pipeline/propostas/cmx1",
      "Proposta PROP-2026-0031: Responda ENVIAR para mandar ao proprietário ou ENCERRAR para concluir.",
      "_RE/MAX Trio_",
    ].join("\n\n");
    expect(sugestaoPendente([{ role: "assistant", content: semeado }])).toEqual({ codigo: "PROP-2026-0031" });
  });

  it("sugestaoPendente: com outro código no texto, vale o da pergunta fixa", () => {
    const semeado = "Oi! *Proponente assinou* Antes houve a PROP-2026-0001. Proposta PROP-2026-0031: Responda ENVIAR para mandar ao proprietário ou ENCERRAR para concluir.";
    expect(sugestaoPendente([{ role: "assistant", content: semeado }])).toEqual({ codigo: "PROP-2026-0031" });
  });

  it("sugestaoPendente: o corpo do CM sem código nem pergunta (CM antigo) não vira sugestão", () => {
    const antigo = "Oi, Carlos! *Proponente assinou — sua vez*\n\nO proponente assinou. Decida: enviar a 2ª via ao proprietário ou concluir sem enviar. https://app.test/pipeline/propostas/cmx1";
    expect(sugestaoPendente([{ role: "assistant", content: antigo }])).toBeNull();
  });

  it("sugestaoPendente: só a ÚLTIMA fala do assistente conta", () => {
    expect(sugestaoPendente([{ role: "assistant", content: AVISO }, { role: "user", content: "e a Ana?" }, { role: "assistant", content: "A da Ana está enviada." }])).toBeNull();
    expect(sugestaoPendente([])).toBeNull();
    expect(sugestaoPendente(undefined)).toBeNull();
  });

  it("sugestaoPendente: assistente sem código da proposta, ou aviso de outro fato, não é sugestão", () => {
    expect(sugestaoPendente([{ role: "assistant", content: "O proponente assinou." }])).toBeNull();
    expect(sugestaoPendente([{ role: "assistant", content: "A proposta PROP-2026-0031 foi enviada para assinatura." }])).toBeNull();
    expect(sugestaoPendente([{ role: "user", content: AVISO }])).toBeNull();
  });
});

describe("detecção: o que vale", () => {
  it.each([
    ["envia a proposta PROP-2026-0031 pro proprietário", "enviar_proprietario"],
    ["Max, manda a proposta da Letícia para o proprietário", "enviar_proprietario"],
    ["pode enviar a proposta PROP-2026-0031 ao vendedor?", "enviar_proprietario"],
    ["encaminha a prop-2026-31 para o locador", "enviar_proprietario"],
    ["encerra a proposta PROP-2026-0031 sem o proprietário", "encerrar"],
    ["encerrar a proposta da Letícia sem o vendedor", "encerrar"],
  ])("pedeProprietario(%j) = %s", (texto, esperado) => {
    expect(pedeProprietario(texto)).toBe(esperado);
  });

  it("sugestaoPendente reconhece o aviso do WhatsApp e a versão com as duas opções", () => {
    expect(sugestaoPendente([{ role: "assistant", content: AVISO }])).toEqual({ codigo: "PROP-2026-0031" });
    expect(sugestaoPendente([{ role: "assistant", content: AVISO_COM_OPCOES }])).toEqual({ codigo: "PROP-2026-0031" });
  });

  it.each([
    ["enviar", "enviar_proprietario"],
    ["Enviar ao proprietário", "enviar_proprietario"],
    ["*enviar*", "enviar_proprietario"],
    ["Max, pode enviar pro vendedor", "enviar_proprietario"],
    ["manda pro proprietário", "enviar_proprietario"],
    ["encerrar", "encerrar"],
    ["Encerra aqui", "encerrar"],
    ["pode encerrar sem o proprietário", "encerrar"],
  ])("respostaAoAviso(%j) = %s", (texto, esperado) => {
    expect(respostaAoAviso(texto, { codigo: "PROP-2026-0031" })).toBe(esperado);
  });
});

describe("NEGADOS primeiro: fluxo", () => {
  it.each(["enviar_proprietario", "encerrar"] as const)("%s: sem proposal.send na política, recusa sem chamar o servidor", async (op) => {
    const r = await iniciarAssinatura(op, ctx("x", { policy: ["proposal.list", "proposal.create"] }), deps);
    expect(r.fluxo).toBeNull();
    expect(r.reply).toContain("não está liberado para você");
    expect(acao).not.toHaveBeenCalled();
  });
  it.each(["enviar_proprietario", "encerrar"] as const)("%s: sem proposal.list na política, recusa sem chamar o servidor", async (op) => {
    const r = await iniciarAssinatura(op, ctx("x", { policy: ["proposal.send"] }), deps);
    expect(r.fluxo).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });
  it.each(["enviar_proprietario", "encerrar"] as const)("%s: política indisponível não é recusa de permissão e não chama o servidor", async (op) => {
    const r = await iniciarAssinatura(op, ctx("x", { politicaIndisponivel: true }), deps);
    expect(r.fluxo).toBeNull();
    expect(r.reply).toContain("Não consegui validar sua permissão");
    expect(acao).not.toHaveBeenCalled();
  });
  it.each(["enviar_proprietario", "encerrar"] as const)("%s: achar a proposta só LÊ e abre o resumo; nada é escrito sem o SIM", async (op) => {
    acao.mockResolvedValue({ status: 200, body: { proposta: aguardando } });
    const r = await iniciarAssinatura(op, ctx("x"), deps, "PROP-2026-0031");
    expect(r.fluxo).toMatchObject({ kind: "assinatura", operacao: op, etapa: "confirmacao" });
    expect(r.reply).toContain("Responda SIM para confirmar ou NÃO para parar.");
    expect(acao.mock.calls.map(([v]) => v)).toEqual(["proposal.status"]);
    expect(acao).toHaveBeenCalledWith("proposal.status", { codigo: "PROP-2026-0031" });
  });
  it.each(["enviar_proprietario", "encerrar"] as const)("%s: política que some no meio do fluxo, o SIM não escreve", async (op) => {
    const r = await conduzirAssinatura(confirmando(op), ctx("sim", { policy: ["proposal.list"] }), deps);
    expect(r.fluxo).toMatchObject({ etapa: "resumo" });
    expect(acao).not.toHaveBeenCalled();
  });
  it.each(["enviar_proprietario", "encerrar"] as const)("%s: etapa resumo (fluxo interrompido), o SIM só reapresenta", async (op) => {
    const r = await conduzirAssinatura(confirmando(op, { etapa: "resumo" }), ctx("sim"), deps);
    expect(acao).not.toHaveBeenCalled();
    expect(r).toMatchObject({ fluxo: { etapa: "confirmacao" } });
  });
  it.each(["enviar_proprietario", "encerrar"] as const)("%s: NÃO para sem chamar o servidor", async (op) => {
    const r = await conduzirAssinatura(confirmando(op), ctx("não"), deps);
    expect(r.fluxo).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });
  it("'não encerra' dentro do fluxo de enviar também para", async () => {
    const r = await conduzirAssinatura(confirmando("enviar_proprietario"), ctx("não encerra, não"), deps);
    expect(r.fluxo).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });
  it("só entra no resumo a proposta que aguarda decisão: enviada/aguardando_vendedor/completa ficam de fora", async () => {
    acao.mockResolvedValue({ status: 200, body: { proposta: { ...aguardando, status: "aguardando_vendedor" } } });
    const r = await iniciarAssinatura("encerrar", ctx("x"), deps, "PROP-2026-0031");
    expect(r.fluxo).toBeNull();
    expect(r.reply).toContain("aguardando a sua decisão");
    expect(acao.mock.calls.every(([v]) => v === "proposal.status")).toBe(true);
  });
  it.each(["aguardando_vendedor", "completa", "cancelada", "rascunho"])(
    "status %s nunca entra no resumo de enviar/encerrar",
    async (status) => {
      acao.mockResolvedValue({ status: 200, body: { proposta: { ...aguardando, status } } });
      for (const op of ["enviar_proprietario", "encerrar"] as const) {
        const r = await iniciarAssinatura(op, ctx("x"), deps, "PROP-2026-0031");
        expect(r.fluxo).toBeNull();
      }
    }
  );
  it.each(["enviar_proprietario", "encerrar"] as const)(
    "esteira B: status `enviada` (fluxo em awaiting_release/ready_to_finish) chega ao resumo; o servidor decide",
    async (op) => {
      acao.mockResolvedValue({ status: 200, body: { proposta: { ...aguardando, status: "enviada" } } });
      const r = await iniciarAssinatura(op, ctx("x"), deps, "PROP-2026-0031");
      expect(r.fluxo).toMatchObject({ kind: "assinatura", operacao: op, etapa: "confirmacao" });
      expect(acao.mock.calls.map(([v]) => v)).toEqual(["proposal.status"]);
    }
  );
  it.each(["enviar_proprietario", "encerrar"] as const)(
    "esteira B: `enviada` ainda coletando, o servidor responde not_awaiting_decision e vira mensagem amigável",
    async (op) => {
      acao.mockResolvedValue({ status: 409, body: { error: "not_awaiting_decision" } });
      const r = await conduzirAssinatura(confirmando(op, { alvo: { ...alvo, status: "enviada" } }), ctx("sim"), deps);
      expect(r.reply).toContain("não está aguardando a sua decisão");
      expect(r.reply).not.toContain("Enviei");
      expect(r.reply).not.toContain("encerrada");
      expect(r.fluxo).toBeNull();
    }
  );
  it("rebaixar: a confirmação volta ao resumo (interrupção do turn)", () => {
    expect(rebaixarFluxo(confirmando("encerrar"))).toMatchObject({ kind: "assinatura", etapa: "resumo" });
  });
});

describe("resumo: texto fixo, sem dado do servidor", () => {
  it("enviar: R$ 1,50 por assinante, sem afirmar quem é o proprietário", async () => {
    acao.mockResolvedValue({ status: 200, body: { proposta: aguardando } });
    const r = await iniciarAssinatura("enviar_proprietario", ctx("x"), deps, "PROP-2026-0031");
    expect(r.reply).toContain("Enviar a proposta PROP-2026-0031 (Rua X, 100) para o proprietário assinar? (R$ 1,50 por assinante)");
  });
  it("encerrar: irreversível, sem custo, o proprietário não assina", async () => {
    acao.mockResolvedValue({ status: 200, body: { proposta: aguardando } });
    const r = await iniciarAssinatura("encerrar", ctx("x"), deps, "PROP-2026-0031");
    expect(r.reply).toContain("Encerrar a proposta PROP-2026-0031 (Rua X, 100) agora, sem o proprietário?");
    expect(r.reply).toContain("não pode ser reaberta");
    expect(r.reply).toContain("Sem custo de assinatura");
  });
});

describe("enviar ao proprietário: SIM e desfechos", () => {
  it("SIM chama proposal.send_owner com {proposta_id} e a messageId do SIM como chave", async () => {
    acao.mockResolvedValue({ status: 200, body: { ok: true, esteira: "a", avisos: [] } });
    const r = await conduzirAssinatura(confirmando("enviar_proprietario"), ctx("sim", { messageId: "m-sim" }), deps);
    expect(acao).toHaveBeenCalledWith("proposal.send_owner", { proposta_id: "p1" }, "m-sim");
    expect(r.fluxo).toBeNull();
    expect(r.reply).toBe("Enviei a proposta PROP-2026-0031 para o proprietário assinar.");
  });
  it("200 sem ok:true NÃO afirma envio", async () => {
    acao.mockResolvedValue({ status: 200, body: {} });
    const r = await conduzirAssinatura(confirmando("enviar_proprietario"), ctx("sim"), deps);
    expect(r.reply).toContain("não confirmou o envio");
    expect(r.reply).not.toContain("Enviei");
  });
  it("sem resposta do servidor: incerto, a chave fica e o próximo SIM confere o MESMO pedido", async () => {
    acao.mockResolvedValueOnce(null);
    const primeiro = await conduzirAssinatura(confirmando("enviar_proprietario"), ctx("sim", { messageId: "m-a" }), deps);
    expect(primeiro.reply).toContain("Ainda não confirmei o resultado");
    expect(primeiro.fluxo).toMatchObject({ chave: { verbo: "proposal.send_owner", valor: "m-a" } });
    acao.mockResolvedValueOnce({ status: 200, body: { ok: true, esteira: "a", avisos: [] } });
    const segundo = await conduzirAssinatura(primeiro.fluxo as FluxoAssinatura, ctx("sim", { messageId: "m-b" }), deps);
    expect(acao).toHaveBeenLastCalledWith("proposal.send_owner", { proposta_id: "p1" }, "m-a");
    expect(segundo.reply).toContain("Enviei a proposta");
  });
  it("409 em_andamento é incerto, não recusa", async () => {
    acao.mockResolvedValue({ status: 409, body: { error: "em_andamento" } });
    const r = await conduzirAssinatura(confirmando("enviar_proprietario"), ctx("sim"), deps);
    expect(r.reply).toContain("Ainda não confirmei o resultado");
    expect(r.fluxo).not.toBeNull();
  });
  it("202 em_conciliacao: não afirma envio, pede para não repetir e mantém a mesma chave", async () => {
    acao.mockResolvedValue({ status: 202, body: { error: "em_conciliacao" } });
    const r = await conduzirAssinatura(confirmando("enviar_proprietario"), ctx("sim", { messageId: "m-a" }), deps);
    expect(r.reply).toContain("Não repita o pedido");
    expect(r.reply).not.toContain("Enviei");
    expect(r.fluxo).toMatchObject({ etapa: "resumo", chave: { valor: "m-a" } });
  });
  it.each([
    [402, { error: "plano_clicksign_esgotado" }, "limite de assinaturas do plano"],
    [403, { error: "Forbidden" }, "Sua permissão no sistema não permite enviar ao proprietário"],
    [403, { error: "papel_sem_envio" }, "Sua permissão no sistema não permite enviar ao proprietário"],
    [403, { error: "Forbidden", reason: "politica_nao_concede" }, "não está liberado para você"],
    [404, { error: "not_found" }, "Não encontrei a proposta PROP-2026-0031"],
    [409, { error: "not_awaiting_decision" }, "não está aguardando a sua decisão"],
    [409, { error: "ja_enviada" }, "já foi enviada"],
    [409, { error: "proprietario_ja_junto" }, "já foi enviada"],
    [409, { error: "fluxo_em_revisao" }, "em revisão"],
    [409, { error: "fluxo_indisponivel" }, "Não consegui ler o andamento"],
    [409, { error: "liberacao_recusada", codigo: "x", vendedor_incluido: true }, "não liberou a assinatura do proprietário"],
    [422, { error: "vendedor_nao_incluido" }, "Não consegui incluir o proprietário"],
    [422, { error: "assinatura_nao_configurada" }, "não está pronta para enviar"],
    [500, { error: "envio_falhou" }, "não confirmou o envio"],
  ])("%s %j vira frase fixa e nunca afirma o envio", async (status, body, trecho) => {
    acao.mockResolvedValue({ status, body });
    const r = await conduzirAssinatura(confirmando("enviar_proprietario"), ctx("sim"), deps);
    expect(r.reply).toContain(trecho);
    expect(r.reply).not.toContain("Enviei");
    expect(r.fluxo).toBeNull();
  });
  it("mensagem crua do servidor (dado de signatário) nunca sai na resposta", async () => {
    acao.mockResolvedValue({ status: 422, body: { error: "preflight_recusado", message: "e-mail joao@x.com inválido", signatario: "João" } });
    const r = await conduzirAssinatura(confirmando("enviar_proprietario"), ctx("sim"), deps);
    expect(r.reply).not.toContain("joao@x.com");
    expect(r.reply).not.toContain("João");
  });
});

describe("enviar ao proprietário: esteira B sem vendedor (422 vendedor_obrigatorio)", () => {
  it("pede nome e e-mail, sem guardar a chave (nada foi feito)", async () => {
    acao.mockResolvedValue({ status: 422, body: { error: "vendedor_obrigatorio" } });
    const r = await conduzirAssinatura(confirmando("enviar_proprietario"), ctx("sim"), deps);
    expect(r.fluxo).toMatchObject({ etapa: "vendedor" });
    expect((r.fluxo as FluxoAssinatura).chave).toBeUndefined();
    expect(r.reply).toContain("nome e o e-mail");
    expect(r.reply).toContain("nada foi enviado ainda");
  });
  it("resposta sem e-mail (ou sem nome) pergunta de novo e não chama o servidor", async () => {
    const f = confirmando("enviar_proprietario", { etapa: "vendedor" });
    for (const t of ["Maria Souza", "maria@exemplo.com", "Maria Souza, maria@"]) {
      const r = await conduzirAssinatura(f, ctx(t), deps);
      expect(r.fluxo).toMatchObject({ etapa: "vendedor" });
      expect(r.reply).toContain("Preciso do nome e do e-mail");
    }
    expect(acao).not.toHaveBeenCalled();
  });
  it("com nome e e-mail, mostra o resumo e só o SIM manda args.sellers, com chave NOVA", async () => {
    const f = confirmando("enviar_proprietario", { etapa: "vendedor" });
    const resumo = await conduzirAssinatura(f, ctx("Maria Souza, maria@exemplo.com", { messageId: "m-nome" }), deps);
    expect(acao).not.toHaveBeenCalled();
    expect(resumo.fluxo).toMatchObject({ etapa: "confirmacao", vendedor: { name: "Maria Souza", email: "maria@exemplo.com" } });
    expect(resumo.reply).toContain("Maria Souza (maria@exemplo.com)");
    acao.mockResolvedValue({ status: 200, body: { ok: true, esteira: "b", vendedor_incluido: true } });
    const fim = await conduzirAssinatura(resumo.fluxo as FluxoAssinatura, ctx("sim", { messageId: "m-sim" }), deps);
    expect(acao).toHaveBeenCalledWith("proposal.send_owner", { proposta_id: "p1", sellers: [{ name: "Maria Souza", email: "maria@exemplo.com" }] }, "m-sim");
    expect(fim.reply).toBe("Enviei a proposta PROP-2026-0031 para o proprietário assinar.");
  });
  it("se o servidor pedir o vendedor DE NOVO (já informado), não entra em laço: recusa com frase fixa", async () => {
    acao.mockResolvedValue({ status: 422, body: { error: "vendedor_obrigatorio" } });
    const r = await conduzirAssinatura(confirmando("enviar_proprietario", { vendedor: { name: "Maria Souza", email: "maria@exemplo.com" } }), ctx("sim"), deps);
    expect(r.fluxo).toBeNull();
    expect(r.reply).toContain("não confirmou o envio");
  });
  it("vendedorDaFrase: só aceita nome + e-mail", () => {
    expect(vendedorDaFrase("Maria Souza, maria@exemplo.com")).toEqual({ name: "Maria Souza", email: "maria@exemplo.com" });
    expect(vendedorDaFrase("o nome é Maria Souza e o e-mail: maria@exemplo.com.")).toEqual({ name: "Maria Souza", email: "maria@exemplo.com" });
    expect(vendedorDaFrase("maria@exemplo.com")).toBeNull();
    expect(vendedorDaFrase("Maria Souza")).toBeNull();
    expect(vendedorDaFrase("M maria@exemplo.com")).toBeNull();
  });
});

describe("encerrar: SIM e desfechos", () => {
  it("SIM chama proposal.complete com {proposta_id} e a messageId do SIM", async () => {
    acao.mockResolvedValue({ status: 200, body: { ok: true, status: "encerrada" } });
    const r = await conduzirAssinatura(confirmando("encerrar"), ctx("sim", { messageId: "m-sim" }), deps);
    expect(acao).toHaveBeenCalledWith("proposal.complete", { proposta_id: "p1" }, "m-sim");
    expect(r.reply).toBe("Proposta PROP-2026-0031 encerrada sem o proprietário. Ele não vai assinar.");
    expect(r.fluxo).toBeNull();
  });
  it("200 sem status de encerramento NÃO afirma que encerrou", async () => {
    acao.mockResolvedValue({ status: 200, body: { ok: true, status: "enviada" } });
    const r = await conduzirAssinatura(confirmando("encerrar"), ctx("sim"), deps);
    expect(r.reply).toContain("não confirmou o encerramento");
    expect(r.reply).not.toContain("encerrada sem");
  });
  it.each([
    [409, { error: "not_awaiting_decision" }, "não está aguardando a sua decisão"],
    [403, { error: "Forbidden" }, "não permite encerrar"],
    [404, { error: "not_found" }, "Não encontrei a proposta"],
    [422, { error: "conclusao_recusada" }, "Não consegui encerrar"],
  ])("%s %j vira frase fixa", async (status, body, trecho) => {
    acao.mockResolvedValue({ status, body });
    const r = await conduzirAssinatura(confirmando("encerrar"), ctx("sim"), deps);
    expect(r.reply).toContain(trecho);
    expect(r.fluxo).toBeNull();
  });
  it("sem resposta do servidor: incerto, nunca afirma que encerrou", async () => {
    acao.mockResolvedValue(null);
    const r = await conduzirAssinatura(confirmando("encerrar"), ctx("sim", { messageId: "m-a" }), deps);
    expect(r.reply).toContain("Ainda não confirmei o resultado");
    expect(r.fluxo).toMatchObject({ chave: { verbo: "proposal.complete", valor: "m-a" } });
  });
});
