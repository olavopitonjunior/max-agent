import { describe, it, expect, vi } from "vitest";

/**
 * Prod 07/10: rascunho PROP-2026-0001 às 10:06; "Pode enviar para assinatura"
 * às 11:28 — o fluxo (TTL de 30 min) tinha vencido, o modelo livre respondeu
 * "a proposta já foi enviada para assinatura" e nada foi enviado (zero
 * envelopes). Três travas, testadas com as frases reais.
 */

const F = await import("../fluxos");
const { afirmaEnvio, travarCriacaoFalsa, TEXTO_NADA_ENVIADO } = await import("../compose");
type Fluxo = import("../fluxos").Fluxo;

const TUDO = ["proposal.create", "proposal.send", "form.create"] as const;
const agora = 1_000_000;
const ctx = (texto: string, extra: Partial<import("../fluxos").ContextoDoTurno> = {}) => ({
  texto,
  messageId: "m1",
  policy: [...TUDO],
  agora,
  ...extra,
});
const OPCOES = {
  status: 200,
  body: {
    metodos: [
      { valor: "email", rotulo: "E-mail (token)" },
      { valor: "whatsapp", rotulo: "WhatsApp (token)" },
    ],
    signatarios: [{ nome: "Letícia Gonçalves", papel: "proponente" }],
  },
};

describe("pedido de envio", () => {
  it.each([
    "Pode enviar para assinatura",
    "manda pra assinatura",
    "segue para assinatura por favor",
    "envia a proposta pra assinatura",
  ])("reconhece: %s", (t) => expect(F.pedeEnvio(t)).toBe(true));

  it.each([
    "como envio para assinatura?",
    "quanto custa mandar para assinatura?",
    "a assinatura é eletrônica?",
    "status das minhas propostas",
    "já enviou para assinatura?",
    "não envia para assinatura ainda",
    "o seguro fiança precisa de assinatura",
    "enviaram pra assinatura ontem",
    "o envio para assinatura falhou",
    "Mandei a assinatura do cliente",
  ])("não confunde pergunta, negação ou relato com pedido: %s", (t) => expect(F.pedeEnvio(t)).toBe(false));

  it("pedido com 'porque'/'como combinamos' no meio continua sendo pedido", () => {
    expect(F.pedeEnvio("pode enviar para assinatura porque o cliente aprovou")).toBe(true);
    expect(F.pedeEnvio("manda pra assinatura como combinamos")).toBe(true);
  });
});

describe("retomar o envio sem fluxo ativo", () => {
  it("um rascunho: retoma na escolha do tipo de assinatura — sem enviar", async () => {
    const acao = vi.fn().mockImplementation(async (verb: string) =>
      verb === "proposal.list"
        ? {
            status: 200,
            body: {
              items: [
                { id: "p1", codigo: "PROP-2026-0001", estado: "Rascunho" },
                { id: "p0", codigo: "PROP-2025-0099", estado: "Assinada" },
              ],
            },
          }
        : OPCOES
    );
    const p = await F.retomarEnvio(ctx("Pode enviar para assinatura"), {
      acao,
      extrairProposta: vi.fn(),
      extrairCampos: vi.fn(),
    });
    expect(p.reply).toContain("Retomando a proposta PROP-2026-0001");
    expect(p.reply).toContain("1. E-mail (token)");
    expect(p.fluxo).toMatchObject({ kind: "proposta", etapa: "metodo", propostaId: "p1", codigo: "PROP-2026-0001" });
    expect(acao.mock.calls.map((c) => c[0])).not.toContain("proposal.send");
  });

  it("vários rascunhos: pergunta qual, e o número escolhe", async () => {
    const acao = vi.fn().mockImplementation(async (verb: string) =>
      verb === "proposal.list"
        ? {
            status: 200,
            body: {
              items: [
                { id: "a", codigo: "PROP-1", estado: "Rascunho" },
                { id: "b", codigo: "PROP-2", estado: "Rascunho" },
              ],
            },
          }
        : OPCOES
    );
    const deps = { acao, extrairProposta: vi.fn(), extrairCampos: vi.fn() };
    let p = await F.retomarEnvio(ctx("manda pra assinatura"), deps);
    expect(p.reply).toContain("2. PROP-2");
    const q = await F.conduzirFluxo(p.fluxo!, ctx("2"), deps);
    expect(q.fluxo).toMatchObject({ propostaId: "b", etapa: "metodo" });
  });

  it("nenhum rascunho: diz isso, não inventa envio", async () => {
    const acao = vi.fn().mockResolvedValue({ status: 200, body: { items: [{ id: "x", estado: "Enviada" }] } });
    const p = await F.retomarEnvio(ctx("manda pra assinatura"), { acao, extrairProposta: vi.fn(), extrairCampos: vi.fn() });
    expect(p.reply).toContain("Não encontrei proposta sua em rascunho");
    expect(p.fluxo).toBeNull();
  });

  it("sem proposal.send na política: não oferece envio", async () => {
    const acao = vi.fn();
    const p = await F.retomarEnvio(ctx("manda pra assinatura", { policy: ["proposal.create"] }), {
      acao,
      extrairProposta: vi.fn(),
      extrairCampos: vi.fn(),
    });
    expect(p.reply).toContain("não está liberado");
    expect(acao).not.toHaveBeenCalled();
  });
});

describe("fluxo com rascunho dura mais", () => {
  it("com rascunho: 1h20 depois o fluxo ainda vale (vencia em 30 min)", () => {
    const f: Fluxo = { kind: "proposta", etapa: "ajustes", natureza: "venda", dados: {}, propostaId: "p1", atualizadoEm: agora };
    expect(F.fluxoExpirou(f, agora + 80 * 60 * 1000)).toBe(false);
    expect(F.fluxoExpirou(f, agora + 25 * 60 * 60 * 1000)).toBe(true);
  });

  it("sem rascunho: continua 30 min", () => {
    const f: Fluxo = { kind: "proposta", etapa: "coleta", natureza: "venda", dados: {}, atualizadoEm: agora };
    expect(F.fluxoExpirou(f, agora + 31 * 60 * 1000)).toBe(true);
  });

  it("'Pode enviar para assinatura' nos ajustes vai para o tipo de assinatura (antes caía na extração)", async () => {
    const acao = vi.fn().mockResolvedValue(OPCOES);
    const f: Fluxo = { kind: "proposta", etapa: "ajustes", natureza: "venda", dados: {}, propostaId: "p1", codigo: "P-1", atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("Pode enviar para assinatura"), { acao, extrairProposta: vi.fn(), extrairCampos: vi.fn() });
    expect(p.reply).toContain("Como os assinantes vão se identificar");
  });
});

describe("trava: afirmação de envio falsa (frases reais de 07/10)", () => {
  it.each([
    "Ok, seguindo para assinatura agora para Letícia Gonçalves no 11941-469037.",
    "A proposta já foi enviada para assinatura no sistema.",
    "Perfeito. Vou encaminhar a proposta para assinatura pelo sistema.",
    "Enviei para assinatura.",
  ])("pega: %s", (t) => expect(afirmaEnvio(t)).toBe(true));

  it.each([
    "Como os assinantes vão se identificar para assinar?",
    "Para enviar, me diga se é por e-mail ou WhatsApp.",
    "A assinatura é eletrônica pela ClickSign.",
  ])("não pega: %s", (t) => expect(afirmaEnvio(t)).toBe(false));

  it("troca pelo texto honesto quando o turn não leu dados", () => {
    expect(travarCriacaoFalsa("A proposta já foi enviada para assinatura no sistema.", { houveLeitura: false, podeCriar: true, podeEnviar: true })).toEqual({
      texto: TEXTO_NADA_ENVIADO,
      travou: true,
    });
  });

  it("com leitura no turn (status real) não troca", () => {
    const t = "1. PROP-2026-0001 — foi enviada para assinatura em 05/10.";
    expect(travarCriacaoFalsa(t, { houveLeitura: true, podeCriar: true })).toEqual({ texto: t, travou: false });
  });
});

const OP = { status: 200, body: { metodos: [{ valor: "email", rotulo: "E-mail" }, { valor: "whatsapp", rotulo: "WhatsApp" }], signatarios: [{ nome: "L G", papel: "proponente" }] } };
const dep = (acao = vi.fn().mockResolvedValue(OP)) => ({ acao, extrairProposta: vi.fn().mockResolvedValue({ valor: 9 }), extrairCampos: vi.fn() });

describe("achados do code review", () => {
  it("B1: ajuste pendente + pedido de envio mostra o resumo do ajuste, não vai ao envio do rascunho velho", async () => {
    const d = dep();
    const f: Fluxo = {
      kind: "proposta", etapa: "ajustes", natureza: "venda", propostaId: "p1", ajustePendente: true, atualizadoEm: agora,
      dados: { proponente: { nome: "Ana Lima", telefone: "11999990000" }, imovel: { endereco: "Rua A" }, valor: 10 },
    };
    const p = await F.conduzirFluxo(f, ctx("Pode enviar para assinatura"), d);
    expect(p.fluxo).toMatchObject({ etapa: "revisao_ajuste" });
    expect(d.acao).not.toHaveBeenCalled();
  });

  it("B2: fluxo RETOMADO não extrai nem sobrescreve — ajuste é pela tela", async () => {
    const d = dep();
    const f: Fluxo = { kind: "proposta", etapa: "ajustes", dados: {}, propostaId: "p1", codigo: "P-1", atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("o valor é 900 mil"), d);
    expect(p.reply).toContain("use a tela de propostas");
    expect(d.extrairProposta).not.toHaveBeenCalled();
    expect(d.acao).not.toHaveBeenCalled();
  });

  it("B2: pendência no envio de fluxo retomado manda completar na tela", async () => {
    const d = dep(vi.fn().mockResolvedValue({ status: 422, body: { error: "pendencias", faltando: [{ signatario: { papel: "proponente" }, campo: "email" }] } }));
    const f: Fluxo = { kind: "proposta", etapa: "envio", dados: {}, propostaId: "p1", metodo: { valor: "email", rotulo: "E-mail" }, assinantes: [], atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("sim"), d);
    expect(p.reply).toContain("Complete na tela de propostas");
  });

  it("N4: pedido de envio na etapa de ENVIO mostra de novo quem assina — não é o 'sim'", async () => {
    const d = dep();
    const f: Fluxo = { kind: "proposta", etapa: "envio", natureza: "venda", dados: {}, propostaId: "p1", metodo: { valor: "email", rotulo: "E-mail" }, assinantes: [{ nome: "L G", papel: "proponente" }], atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("pode enviar para assinatura"), d);
    expect(p.reply).toContain("Confirma? Responda *SIM*");
    expect(d.acao).not.toHaveBeenCalled();
  });

  it("N4: pedido de envio na escolha do método repete as opções", async () => {
    const f: Fluxo = { kind: "proposta", etapa: "metodo", natureza: "venda", dados: {}, propostaId: "p1", metodos: [{ valor: "email", rotulo: "E-mail" }], atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("manda pra assinatura"), dep());
    expect(p.reply).toContain("1. E-mail");
  });

  it("N4: pedido de envio antes do rascunho explica que ainda não há rascunho", async () => {
    const f: Fluxo = { kind: "proposta", etapa: "coleta", natureza: "venda", dados: {}, atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("manda pra assinatura"), dep());
    expect(p.reply).toContain("Ainda não há rascunho para enviar");
  });

  it("N5: com envio incerto (chave), o fluxo NÃO ganha 24h", () => {
    const f: Fluxo = {
      kind: "proposta", etapa: "ajustes", natureza: "venda", dados: {}, propostaId: "p1",
      chave: { verbo: "proposal.send", valor: "k" }, atualizadoEm: agora,
    };
    expect(F.fluxoExpirou(f, agora + 31 * 60 * 1000)).toBe(true);
  });

  it("N6: retomar depois de um envio incerto reaproveita a chave do envio", async () => {
    const acao = vi.fn().mockImplementation(async (verb: string) =>
      verb === "proposal.list" ? { status: 200, body: { items: [{ id: "p1", codigo: "P-1", estado: "Rascunho" }] } } : OP
    );
    const anterior: Fluxo = { kind: "proposta", etapa: "envio", dados: {}, propostaId: "p1", chave: { verbo: "proposal.send", valor: "k-velha" }, atualizadoEm: 0 };
    const p = await F.retomarEnvio(ctx("manda pra assinatura"), dep(acao), anterior);
    expect(p.fluxo).toMatchObject({ chave: { verbo: "proposal.send", valor: "k-velha" } });
  });

  it("selecao_envio aceita o código e libera número fora da lista", async () => {
    const f: Fluxo = { kind: "proposta", etapa: "selecao_envio", dados: {}, candidatos: [{ id: "a", codigo: "PROP-1" }, { id: "b", codigo: "PROP-2" }], atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("a PROP-2"), dep());
    expect(p.fluxo).toMatchObject({ propostaId: "b" });
    const q = await F.conduzirFluxo(f, ctx("7"), dep());
    expect(q.liberar).toBe(true);
  });
});

describe("trava de envio: explicação e negação passam (N3)", () => {
  it.each([
    "Depois que você confirmar, a proposta será enviada para assinatura dos envolvidos.",
    "Ela não foi enviada para assinatura ainda.",
  ])("não troca: %s", (t) => expect(afirmaEnvio(t)).toBe(false));

  it.each(["Pronto, mandei para assinatura.", "Já enviamos para assinatura.", "A proposta foi pra assinatura."])(
    "pega: %s",
    (t) => expect(afirmaEnvio(t)).toBe(true)
  );

  it("quem não pode enviar não é mandado pedir o envio", () => {
    expect(travarCriacaoFalsa("Enviei para assinatura.", { houveLeitura: false, podeCriar: false, podeEnviar: false }).texto).toContain(
      "o envio é feito pelo sistema"
    );
  });
});

describe("re-review", () => {
  it("1: com chave de envio incerto, escolher o método segue para o envio (sem laço)", async () => {
    const f: Fluxo = {
      kind: "proposta", etapa: "metodo", natureza: "venda", dados: {}, propostaId: "p1",
      metodos: [{ valor: "email", rotulo: "E-mail" }, { valor: "whatsapp", rotulo: "WhatsApp" }],
      assinantes: [{ nome: "L G", papel: "proponente" }],
      chave: { verbo: "proposal.send", valor: "k-velha" }, atualizadoEm: agora,
    };
    const p = await F.conduzirFluxo(f, ctx("1"), dep());
    expect(p.fluxo).toMatchObject({ etapa: "envio", chave: { valor: "k-velha" } });
  });

  it("2: mensagem não relacionada num fluxo retomado vai ao atendimento normal", async () => {
    const f: Fluxo = { kind: "proposta", etapa: "ajustes", dados: {}, propostaId: "p1", atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("obrigado"), dep());
    expect(p.liberar).toBe(true);
  });

  it("4: código exato — PROP-20 não casa com PROP-2", async () => {
    const f: Fluxo = {
      kind: "proposta", etapa: "selecao_envio", dados: {},
      candidatos: [{ id: "a", codigo: "PROP-2" }, { id: "b", codigo: "PROP-20" }], atualizadoEm: agora,
    };
    const p = await F.conduzirFluxo(f, ctx("a PROP-20"), dep());
    expect(p.fluxo).toMatchObject({ propostaId: "b" });
  });
});

describe("bloqueios do envio (prod 07/10: FINCasa sem ClickSign)", () => {
  it.each([
    [409, "clicksign_nao_configurada", "não tem a ClickSign conectada"],
    [422, "documento_indisponivel", "não está pronto para envio"],
    [400, "sem_signatarios", "não tem assinantes"],
    [400, "signatarios_em_conflito", "mesmo CPF ou contato"],
    [400, "roteamento_indisponivel", "Ajuste na tela de propostas"],
  ])("%s %s → texto honesto, sem 'não consegui falar'", async (status, error, trecho) => {
    const d = dep(vi.fn().mockResolvedValue({ status, body: { error } }));
    const f: Fluxo = {
      kind: "proposta", etapa: "envio", natureza: "venda", dados: {}, propostaId: "p1", codigo: "PROP-2026-0001",
      metodo: { valor: "whatsapp", rotulo: "WhatsApp" }, assinantes: [], atualizadoEm: agora,
    };
    const p = await F.conduzirFluxo(f, ctx("sim"), d);
    expect(p.reply).toContain(trecho);
    expect(p.reply).toContain("PROP-2026-0001 continua salvo");
    expect(p.reply).not.toContain("Não consegui falar");
    expect(p.fluxo).toBeNull();
  });
});

describe("ClickSign não conectada: avisa cedo", () => {
  it("preflight assinatura:false → avisa no início e segue a coleta", async () => {
    const acao = vi.fn().mockResolvedValue({ status: 200, body: { modelo: true, assinatura: false } });
    const p = await F.conduzirFluxo({ kind: "proposta", etapa: "natureza", dados: {}, atualizadoEm: agora }, ctx("venda"), dep(acao));
    expect(p.reply).toContain("ainda não tem a ClickSign conectada");
    expect(p.reply).toContain("Comprador");
    expect(p.fluxo).toMatchObject({ etapa: "coleta" });
  });

  it("preflight sem o campo (servidor antigo) não avisa nada", async () => {
    const acao = vi.fn().mockResolvedValue({ status: 200, body: { modelo: true } });
    const p = await F.conduzirFluxo({ kind: "proposta", etapa: "natureza", dados: {}, atualizadoEm: agora }, ctx("venda"), dep(acao));
    expect(p.reply).not.toContain("ClickSign");
  });

  it("options com assinaturaConfigurada:false para antes dos tipos de assinatura", async () => {
    const acao = vi.fn().mockResolvedValue({ status: 200, body: { ...OP.body, assinaturaConfigurada: false } });
    const f: Fluxo = { kind: "proposta", etapa: "ajustes", natureza: "venda", dados: {}, propostaId: "p1", codigo: "PROP-2026-0001", atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("ok"), dep(acao));
    expect(p.reply).toContain("não tem a ClickSign conectada");
    expect(p.reply).not.toContain("Como os assinantes");
    expect(p.fluxo).toBeNull();
  });
});
