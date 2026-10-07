import { describe, it, expect, vi } from "vitest";

/**
 * Prod 07/10, 16:32–16:35: "Tente agora o envio da proposta novamente" virou
 * CRIAÇÃO (escolha 1/2); a escolha ficou pendurada; "Envie essa da Letícia"
 * caiu no modelo livre, que ENCENOU "responda SIM" e um menu de assinatura; o
 * "2" (WhatsApp, na cabeça da pessoa) foi lido como "2. formulário de negócio"
 * e o "Sim" criou um formulário + negócio reais. A proposta não foi enviada.
 */

const F = await import("../fluxos");
const { encenaConfirmacao, travarCriacaoFalsa, TEXTO_SEM_ENCENACAO } = await import("../compose");

const agora = 1_000_000;
const ctx = (texto: string) => ({
  texto,
  messageId: "m1",
  policy: ["proposal.create", "proposal.send", "form.create"] as const,
  agora,
});

describe("pedido de envio sem a palavra 'assinatura' (frases reais)", () => {
  it.each([
    "Envie essa da Letícia",
    "Tente agora o envio da proposta novamente",
    "envia a proposta 1",
    "manda o rascunho",
    "reenvia a proposta",
    "reenviar a proposta da Letícia",
    "Pode enviar",
    "Envie novamente",
  ])(
    "reconhece: %s",
    (t) => expect(F.pedeEnvio(t)).toBe(true)
  );

  it.each([
    "me manda o link do formulário pro João",
    "manda uma proposta pro João",
    "cria uma proposta nova",
    "quero criar um formulário de venda",
    "vou enviar os documentos dela depois?",
    "me manda o telefone dela",
    "me envia o contrato dela",
    "envia o boleto dela",
    "manda uma mensagem pra ela",
    "me manda a proposta em pdf",
    "vou enviar a proposta depois",
    "já fiz o envio da proposta pela tela",
    "ainda não envie a proposta",
    "por enquanto não manda a proposta",
  ])("não confunde criação/link/pergunta/relato/negação: %s", (t) => expect(F.pedeEnvio(t)).toBe(false));
});

describe("o rascunho citado pelo nome é o escolhido", () => {
  const itens = [
    { id: "a", codigo: "PROP-2026-0001", titulo: "Proposta — Letícia Gonçalves" },
    { id: "b", codigo: "PROP-2026-0002", titulo: "Proposta — Carlos Souza" },
  ];
  const ids = (t: string) => F.filtrarPorCitacao(t, itens).itens.map((i) => i.id);
  it("'da Letícia' escolhe a da Letícia (com ou sem maiúscula)", () => {
    expect(ids("Envie essa da Letícia")).toEqual(["a"]);
    expect(ids("envie essa da leticia")).toEqual(["a"]);
  });
  it("código (inteiro ou só o número) escolhe pelo código", () => {
    expect(ids("envia a PROP-2026-0002")).toEqual(["b"]);
    expect(ids("envia a 0002")).toEqual(["b"]);
  });
  it("sem citação, todos", () => {
    expect(F.filtrarPorCitacao("manda o rascunho", itens)).toMatchObject({ citou: null });
    expect(F.filtrarPorCitacao("envia a proposta por favor", itens).citou).toBeNull();
  });
  it("citação sem rascunho: nenhum (nunca cai em outro)", () => {
    expect(ids("envie a da Maria")).toEqual([]);
  });

  it("retomarEnvio com dois rascunhos e 'da Letícia' vai direto à dela", async () => {
    const acao = vi.fn().mockImplementation(async (verb: string) =>
      verb === "proposal.list"
        ? {
            status: 200,
            body: {
              items: [
                { id: "a", codigo: "PROP-2026-0001", titulo: "Proposta — Letícia Gonçalves", estado: "Rascunho" },
                { id: "b", codigo: "PROP-2026-0002", titulo: "Proposta — Carlos Souza", estado: "Rascunho" },
              ],
            },
          }
        : { status: 200, body: { metodos: [{ valor: "email", rotulo: "E-mail" }, { valor: "whatsapp", rotulo: "WhatsApp" }], signatarios: [{ nome: "Letícia Gonçalves", papel: "proponente" }] } }
    );
    const p = await F.retomarEnvio(ctx("Envie essa da Letícia"), { acao, extrairProposta: vi.fn(), extrairCampos: vi.fn() });
    expect(p.reply).toContain("Retomando a proposta PROP-2026-0001");
    expect(p.fluxo).toMatchObject({ propostaId: "a", etapa: "metodo" });
  });
});

describe("achados do code review (envio por nome)", () => {
  const LISTA = {
    status: 200,
    body: { items: [{ id: "a", codigo: "PROP-2026-0001", titulo: "Proposta — Letícia Gonçalves", estado: "Rascunho" }] },
  };
  const OPC = {
    status: 200,
    body: {
      metodos: [{ valor: "email", rotulo: "E-mail" }, { valor: "whatsapp", rotulo: "WhatsApp" }],
      signatarios: [{ nome: "Letícia Gonçalves", papel: "proponente" }],
    },
  };
  const dep = (acao: ReturnType<typeof vi.fn>) => ({ acao, extrairProposta: vi.fn().mockResolvedValue({}), extrairCampos: vi.fn() });

  it("B1: 'envie a da Maria' com só o rascunho da Letícia NÃO retoma o da Letícia", async () => {
    const acao = vi.fn().mockResolvedValue(LISTA);
    const p = await F.retomarEnvio(ctx("envie a da Maria"), dep(acao));
    expect(p.reply).toContain('Não achei rascunho de "maria"');
    expect(p.reply).toContain("1. PROP-2026-0001 — Proposta — Letícia Gonçalves");
    expect(p.fluxo).toMatchObject({ etapa: "selecao_envio" });
    expect(acao.mock.calls.map((c) => c[0])).not.toContain("proposal.options");
  });

  it("B1: 'Retomando' mostra o nome do cliente, não só o código", async () => {
    const acao = vi.fn().mockImplementation(async (v: string) => (v === "proposal.list" ? LISTA : OPC));
    const p = await F.retomarEnvio(ctx("Envie essa da Letícia"), dep(acao));
    expect(p.reply).toContain("Retomando a proposta PROP-2026-0001 — Proposta — Letícia Gonçalves");
  });

  it("B2: método dito por extenso ('manda pelo whatsapp pra ela') vai para o envio", async () => {
    const f = {
      kind: "proposta" as const, etapa: "metodo" as const, natureza: "venda" as const, dados: {}, propostaId: "a",
      metodos: OPC.body.metodos, assinantes: OPC.body.signatarios, atualizadoEm: agora,
    };
    const p = await F.conduzirFluxo(f, ctx("manda pelo whatsapp pra ela"), dep(vi.fn()));
    expect(p.fluxo).toMatchObject({ etapa: "envio", metodo: { valor: "whatsapp" } });
  });

  it("W3: ajuste junto com o pedido de envio não perde o ajuste", async () => {
    const d = { acao: vi.fn(), extrairProposta: vi.fn().mockResolvedValue({ proponente: { email: "novo@x.com" } }), extrairCampos: vi.fn() };
    const f = {
      kind: "proposta" as const, etapa: "ajustes" as const, natureza: "venda" as const, propostaId: "a", atualizadoEm: agora,
      dados: { proponente: { nome: "Letícia Gonçalves", telefone: "11999990000" }, imovel: { endereco: "Rua A" }, valor: 10 },
    };
    const p = await F.conduzirFluxo(f, ctx("corrige o email dela pra novo@x.com e manda a proposta"), d);
    expect(p.reply).toContain("Atualizo o rascunho assim?");
    expect(d.acao).not.toHaveBeenCalled();
  });

  it("W5: lista de rascunhos sem escolha legível ENCERRA; nome escolhe", async () => {
    const f = {
      kind: "proposta" as const, etapa: "selecao_envio" as const, dados: {}, atualizadoEm: agora,
      candidatos: [{ id: "a", codigo: "PROP-1", titulo: "Proposta — Letícia Gonçalves" }, { id: "b", codigo: "PROP-2", titulo: "Proposta — Carlos Souza" }],
    };
    const q = await F.conduzirFluxo(f, ctx("e o tempo hoje"), dep(vi.fn()));
    expect(q.fluxo).toBeNull();
    const r = await F.conduzirFluxo(f, ctx("a do Carlos"), dep(vi.fn().mockResolvedValue(OPC)));
    expect(r.fluxo).toMatchObject({ propostaId: "b" });
  });
});

describe("a escolha 1/2 não fica pendurada", () => {
  it("resposta que não é 1/2 ENCERRA a escolha", async () => {
    const p = await F.conduzirFluxo({ kind: "escolha", atualizadoEm: agora }, ctx("Quais propostas tenho em rascunho?"), {
      acao: vi.fn(),
      extrairProposta: vi.fn(),
      extrairCampos: vi.fn(),
    });
    expect(p.liberar).toBe(true);
    expect(p.fluxo).toBeNull();
  });
});

describe("o modelo livre não encena confirmação nem menu", () => {
  it.each([
    "Consigo enviar sim. Só confirma: a assinatura vai para o telefone? Responda SIM ou NÃO.",
    "Para a assinatura, como os assinantes vão se identificar? Responda com um número:\n1 e-mail\n2 WhatsApp",
    "Responda *SIM* para criar.",
  ])("pega: %s", (t) => expect(encenaConfirmacao(t)).toBe(true));

  it.each([
    "Sim, a assinatura é eletrônica.",
    "Você tem 1 proposta em rascunho: PROP-2026-0001.",
    "Quando o cliente receber, peça que ele responda SIM no WhatsApp da ClickSign.",
    "Me responda com o número da proposta que quer ver.",
    "Por favor, responda se não houver problema.",
  ])(
    "não pega: %s",
    (t) => expect(encenaConfirmacao(t)).toBe(false)
  );

  it("troca mesmo com leitura no turn", () => {
    expect(travarCriacaoFalsa("Responda SIM ou NÃO.", { houveLeitura: true, podeCriar: true, podeEnviar: true })).toEqual({
      texto: TEXTO_SEM_ENCENACAO,
      travou: true,
    });
  });
});

describe("re-review", () => {
  it("N1: 'manda' na confirmação final ENVIA (vale como sim)", async () => {
    const acao = vi.fn().mockResolvedValue({ status: 200, body: {} });
    const f = {
      kind: "proposta" as const, etapa: "envio" as const, natureza: "venda" as const, dados: {}, propostaId: "a",
      metodo: { valor: "email", rotulo: "E-mail" }, assinantes: [{ nome: "L G", papel: "proponente" }], atualizadoEm: agora,
    };
    for (const t of ["manda", "Pode mandar"]) {
      acao.mockClear();
      const p = await F.conduzirFluxo(f, ctx(t), { acao, extrairProposta: vi.fn(), extrairCampos: vi.fn() });
      expect(acao).toHaveBeenCalledWith("proposal.send", expect.anything(), expect.any(String));
      expect(p.reply).toContain("enviada para assinatura");
    }
  });

  it.each(["ja manda pra assinatura", "sim, pode enviar", "eu quero enviar para assinatura"])("N2 volta a ser pedido: %s", (t) =>
    expect(F.pedeEnvio(t)).toBe(true)
  );

  it("N3: 'de novo', 'pra mim', 'de venda' não viram nome", () => {
    expect(F.citacaoDoRascunho("envie a proposta de novo")).toBeNull();
    expect(F.citacaoDoRascunho("manda pra mim a de venda por E-mail")).toBeNull();
  });
});
