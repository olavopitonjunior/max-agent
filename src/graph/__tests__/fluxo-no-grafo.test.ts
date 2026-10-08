import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * O fluxo de criação no GRAFO: o nó `conduzir` responde por template, sem o
 * modelo de resposta, e o que a pessoa ditou (CPF, telefone) não vai para a
 * trilha do turn. Mesmo padrão de mocks do `formbuilder.test.ts`.
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
const POLITICA = {
  byRole: { "*": ["deal.list", "deal.pending", "proposal.list", "form.create", "proposal.create", "proposal.send"] },
  byRecipient: {},
  brokerDefault: ["deal.list", "deal.pending"],
};
const uso = { model: "openai/gpt-5.4-nano", promptTokens: 10, completionTokens: 5, latencyMs: 5, success: true };

function run(text: string, state: Record<string, unknown> = {}, messageId = "m1") {
  return buildGraph()
    .compile()
    .invoke({
      inbound: {
        messageId,
        fromPhone: "5511987654321",
        groupId: null,
        kind: "text" as const,
        text,
        mediaUrl: null,
        mimeType: null,
        timestampMs: null,
        senderName: "Olavo",
        replyToMessageId: null,
      },
      identity: usuario,
      reply: null,
      halt: null,
      propostaDescartada: false,
      ...state,
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: POLITICA } as never);
  vi.mocked(searchKnowledge).mockResolvedValue([]);
});

describe("cronometrar (O0)", () => {
  it("cada nó que rodou deixa { no, ms } em timings, na ordem do grafo", async () => {
    llm.mockResolvedValue({ text: "Olá! Posso ajudar com propostas e negócios.", toolCalls: [], usage: uso });
    const s = await run("oi");
    const nos = (s.timings as { no: string; ms: number }[]).map((t) => t.no);
    expect(nos.slice(0, 4)).toEqual(["gate", "continuar", "conduzir", "confirm"]);
    expect(nos).toContain("answer");
    expect(nos).toContain("compose");
    for (const t of s.timings as { no: string; ms: number }[]) expect(t.ms).toBeGreaterThanOrEqual(0);
  });
  it("turn barrado no gate mede só o que rodou", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: false, model: "x", instructions: null, maxPolicy: POLITICA } as never);
    const s = await run("oi");
    expect((s.timings as { no: string }[]).map((t) => t.no)).toEqual(["gate", "compose"]);
    expect(llm).not.toHaveBeenCalled();
  });
});

describe("fluxo no grafo", () => {
  it("frase real seleciona proposta e converte o mesmo ID, sem criar formulário avulso", async () => {
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "propor_criacao", args: { tipo: "venda" } }], usage: uso });
    acao.mockImplementation(async ({ verb }: { verb: string }) => {
      if (verb === "proposal.status") return { status: 200, body: { proposta: { id: "p1", codigo: "PROP-2026-0001", status: "assinada_proponente" } } };
      if (verb === "proposal.complete") return { status: 200, body: { status: "completa" } };
      if (verb === "proposal.convert") return { status: 201, body: { negocio: { id: "d1", link: "/deals/d1" } } };
      throw new Error(`Ação inesperada: ${verb}`);
    });
    const inicial = await run("Max, tranforme a proposta da Letícia em negócio e gere o link do formulário");
    expect(inicial.fluxo).toMatchObject({ kind: "continuidade", etapa: "selecao", converter: true });
    expect(acao).not.toHaveBeenCalled();
    const selecionado = await run("PROP-2026-0001", { fluxo: inicial.fluxo }, "selecao");
    expect(selecionado.fluxo).toMatchObject({ etapa: "confirmacao", alvo: { id: "p1" } });
    const fim = await run("SIM", { fluxo: selecionado.fluxo }, "confirmacao");
    expect(fim.reply).toContain("/deals/d1");
    expect(acao.mock.calls.map(([p]) => p.verb)).toEqual(["proposal.status", "proposal.complete", "proposal.convert"]);
    expect(llm).not.toHaveBeenCalled();
  });
  it("classificador errado vira continuidade da proposta referenciada, não criação", async () => {
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "propor_criacao", args: { tipo: "venda" } }], usage: uso });
    const s = await run("Aproveite a proposta da Letícia e gere um link");
    expect(s.fluxo).toMatchObject({ kind: "continuidade", etapa: "selecao", converter: true });
    expect(s.reply).toContain("PROP-AAAA-NNNN");
    expect(acao).not.toHaveBeenCalled();
  });
  it("depois do redirecionamento, só o código converte (sem laço de recusa)", async () => {
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "propor_criacao", args: { tipo: "venda" } }], usage: uso });
    acao.mockImplementation(async ({ verb }: { verb: string }) => {
      if (verb === "proposal.status") return { status: 200, body: { proposta: { id: "p1", codigo: "PROP-2026-0001", status: "completa" } } };
      throw new Error(`Ação inesperada: ${verb}`);
    });
    const s = await run("Aproveite a proposta da Letícia e gere um link");
    const r = await run("PROP-2026-0001", { fluxo: s.fluxo }, "selecao");
    expect(r.fluxo).toMatchObject({ kind: "continuidade", etapa: "confirmacao", converter: true, alvo: { id: "p1" } });
    expect(r.reply).toContain("converter a proposta PROP-2026-0001 em negócio");
  });
  it("continuidade vencida conserva o alvo e expira só a confirmação", async () => {
    const s = await run("sim", { fluxo: { kind: "continuidade", etapa: "confirmacao", converter: true,
      alvo: { id: "p1", codigo: "PROP-2026-0001", status: "completa" }, atualizadoEm: Date.now() - 60 * 60 * 1000 } });
    expect(s.reply).toContain("PROP-2026-0001");
    expect(s.fluxo).toMatchObject({ kind: "continuidade", etapa: "confirmacao", alvo: { id: "p1" } });
    expect(acao).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
  });
  it("concluir e criar formulário desse negócio retoma a proposta assinada, nunca form.create", async () => {
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "propor_criacao", args: { tipo: "venda" } }], usage: uso });
    acao.mockImplementation(async ({ verb }: { verb: string }) => {
      if (verb === "proposal.list") return { status: 200, body: { items: [{ id: "p1", codigo: "PROP-2026-0001", status: "assinada_proponente" }], total: 1 } };
      if (verb === "proposal.complete") return { status: 200, body: { ok: true, status: "completa" } };
      if (verb === "proposal.convert") return { status: 201, body: { negocio: { id: "d1", link: "/deals/d1" } } };
      return { status: 200, body: { campos: [] } };
    });
    const inicial = await run("Concluir. Pode criar o formulário desse negócio.");
    expect(inicial.reply).toContain("PROP-2026-0001");
    expect(inicial.reply).toContain("sem enviar ao proprietário");
    expect(acao.mock.calls.map(([p]) => p.verb)).toEqual(["proposal.list"]);
    const confirmado = await run("Sim", { fluxo: inicial.fluxo }, "confirmacao");
    expect(confirmado.reply).toContain("/deals/d1");
    expect(acao.mock.calls.map(([p]) => p.verb)).toEqual(["proposal.list", "proposal.complete", "proposal.convert"]);
    expect(llm).not.toHaveBeenCalled();
  });
  it("turn com fluxo ativo: só a extração chama modelo, resposta é template, trilha sem dado pessoal", async () => {
    llm.mockResolvedValue({
      text: "",
      toolCalls: [
        {
          name: "preencher_proposta",
          args: { proponente: { nome: "Letícia Gonçalves Nogueira", cpf: "12345678909", telefone: "11999990000" } },
        },
      ],
      usage: uso,
    });

    const s = await run("Letícia Gonçalves Nogueira, CPF 123.456.789-09, tel 11 99999-0000", {
      fluxo: { kind: "proposta", etapa: "coleta", natureza: "venda", dados: {}, atualizadoEm: Date.now() },
    });

    expect(llm).toHaveBeenCalledTimes(1);
    expect(llm.mock.calls[0][0].toolChoice).toBe("preencher_proposta");
    expect(s.reply).toContain("endereço do imóvel");
    expect(s.fluxo?.kind === "proposta" && s.fluxo.dados.proponente?.nome).toBe("Letícia Gonçalves Nogueira");
    expect(JSON.stringify(s.toolLog)).not.toContain("12345678909");
    expect(JSON.stringify(s.toolLog)).not.toContain("99999");
    expect(acao).not.toHaveBeenCalled();
  });

  it("B3 — kill switch no meio do envio: o próximo SIM não envia (fluxo volta aos ajustes)", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: false, model: "x", instructions: null, maxPolicy: POLITICA } as never);
    const s = await run("sim", {
      fluxo: {
        kind: "proposta", etapa: "envio", natureza: "venda", dados: {}, propostaId: "p1",
        metodo: { valor: "email", rotulo: "E-mail" }, assinantes: [], atualizadoEm: Date.now(),
      },
    });
    expect(acao).not.toHaveBeenCalled();
    expect(s.fluxo).toMatchObject({ kind: "proposta", etapa: "ajustes" });
  });

  it("pergunta no meio da coleta vai para o atendimento normal e o fluxo fica", async () => {
    llm
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "preencher_proposta", args: {} }], usage: uso })
      .mockResolvedValueOnce({ text: "A assinatura é eletrônica.", toolCalls: [], usage: uso });
    const fluxo = { kind: "proposta", etapa: "coleta", natureza: "venda", dados: {}, atualizadoEm: Date.now() };
    const s = await run("como funciona a assinatura?", { fluxo });
    expect(s.reply).toBe("A assinatura é eletrônica.");
    expect(s.fluxo).toMatchObject({ kind: "proposta", etapa: "coleta" });
  });

  it("N1 — pergunta no ENVIO é liberada e o fluxo sai da etapa em que o SIM envia", async () => {
    llm.mockResolvedValueOnce({ text: "É eletrônica. Quer que eu explique o split?", toolCalls: [], usage: uso });
    const s = await run("a assinatura é eletrônica?", {
      fluxo: {
        kind: "proposta", etapa: "envio", natureza: "venda", dados: {}, propostaId: "p1",
        metodo: { valor: "email", rotulo: "E-mail" }, assinantes: [], atualizadoEm: Date.now(),
      },
    });
    expect(s.reply).toContain("É eletrônica.");
    expect(s.fluxo).toMatchObject({ etapa: "ajustes" });
    expect(acao).not.toHaveBeenCalled();
  });

  it("pedido novo de criação com fluxo em andamento não o apaga", async () => {
    llm
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "preencher_proposta", args: {} }], usage: uso })
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "propor_criacao", args: { tipo: "proposta" } }], usage: uso });
    const fluxo = { kind: "proposta", etapa: "ajustes", natureza: "venda", dados: {}, propostaId: "p1", atualizadoEm: Date.now() };
    const s = await run("gera uma proposta nova", { fluxo });
    expect(s.reply).toContain("já tem uma proposta em andamento");
    expect(s.fluxo).toMatchObject({ propostaId: "p1" });
  });

  it("prod 07/10: 'Pode enviar para assinatura' com o fluxo VENCIDO retoma pelo servidor, sem o modelo livre", async () => {
    acao.mockImplementation(async (p: { verb: string }) =>
      p.verb === "proposal.list"
        ? { status: 200, body: { items: [{ id: "p1", codigo: "PROP-2026-0001", estado: "Rascunho" }] } }
        : { status: 200, body: { metodos: [{ valor: "email", rotulo: "E-mail" }, { valor: "whatsapp", rotulo: "WhatsApp" }], signatarios: [{ nome: "Letícia Gonçalves", papel: "proponente" }] } }
    );
    const s = await run("Pode enviar para assinatura", {
      fluxo: { kind: "proposta", etapa: "coleta", natureza: "venda", dados: {}, atualizadoEm: Date.now() - 31 * 60 * 1000 },
    });
    expect(llm).not.toHaveBeenCalled();
    expect(s.reply).toContain("Como os assinantes vão se identificar");
    expect(s.fluxo).toMatchObject({ propostaId: "p1", etapa: "metodo" });
    expect(acao.mock.calls.map((c) => c[0].verb)).not.toContain("proposal.send");
  });

  it("prod 07/10 16:34: escolha 1/2 aberta + 'Envie essa da Letícia' vai ao ENVIO, não à criação", async () => {
    acao.mockImplementation(async (p: { verb: string }) =>
      p.verb === "proposal.list"
        ? { status: 200, body: { items: [{ id: "p1", codigo: "PROP-2026-0001", titulo: "Proposta — Letícia Gonçalves", estado: "Rascunho" }] } }
        : { status: 200, body: { metodos: [{ valor: "email", rotulo: "E-mail" }, { valor: "whatsapp", rotulo: "WhatsApp" }], signatarios: [{ nome: "Letícia Gonçalves", papel: "proponente" }] } }
    );
    const s = await run("Envie essa da Letícia", { fluxo: { kind: "escolha", atualizadoEm: Date.now() } });
    expect(llm).not.toHaveBeenCalled();
    expect(s.reply).toContain("Retomando a proposta PROP-2026-0001");
    expect(s.fluxo).toMatchObject({ kind: "proposta", propostaId: "p1", etapa: "metodo" });
    const verbos = acao.mock.calls.map((c) => c[0].verb);
    expect(verbos).not.toContain("form.create");
    expect(verbos).not.toContain("proposal.send");
  });

  it("fluxo vencido é descartado e o turn segue normal", async () => {
    llm.mockResolvedValue({ text: "Oi! Como posso ajudar?", toolCalls: [], usage: uso });
    const s = await run("oi", { fluxo: { kind: "escolha", atualizadoEm: Date.now() - 31 * 60 * 1000 } });
    expect(s.fluxo).toBeNull();
    expect(s.reply).toBe("Oi! Como posso ajudar?");
  });

  it("a conversa de 06/10 de ponta a ponta até o PDF: pedido → 1 → venda → dados → SIM", async () => {
    // Turn 1: o modelo reconhece o pedido e chama a ferramenta.
    llm.mockResolvedValueOnce({ text: "", toolCalls: [{ name: "propor_criacao", args: { tipo: "proposta" } }], usage: uso });
    let s = await run("Pode gerar uma proposta pra mim?", {}, "t1");
    expect(s.reply).toContain("proposta rápida");

    s = await run("1", { fluxo: s.fluxo, messages: s.messages }, "t2");
    expect(s.reply).toContain("venda");

    s = await run("Venda", { fluxo: s.fluxo, messages: s.messages }, "t3");
    expect(s.reply).toContain("Comprador");

    llm.mockResolvedValueOnce({
      text: "",
      toolCalls: [
        {
          name: "preencher_proposta",
          args: {
            proponente: { nome: "Letícia Gonçalves Nogueira", telefone: "11999990000" },
            imovel: { endereco: "Rua Senador Godoi, 606", bairro: "Vila São Geraldo" },
            valor: 1500000,
            pagamento: { forma: "200 mil financiado, restante à vista" },
          },
        },
      ],
      usage: uso,
    });
    s = await run(
      "Rua Senador godoi, 606, Vila São geraldo. Compradora Letícia Gonçalves Nogueira, 11 99999-0000. 1.500.000, sendo 200.000 financiado",
      { fluxo: s.fluxo, messages: s.messages },
      "t4"
    );
    expect(s.reply).toContain("Está correto?");
    expect(s.reply).toContain("R$");

    acao.mockResolvedValueOnce({
      status: 201,
      body: { proposal: { id: "p1", codigo: "P-7" }, pdf: { link: "https://imobpro.ia.br/api/public/proposal-pdf/abc" } },
    });
    s = await run("sim", { fluxo: s.fluxo, messages: s.messages }, "t5");
    expect(acao).toHaveBeenCalledWith(expect.objectContaining({ verb: "proposal.create", idempotencyKey: "t5" }));
    expect(s.reply).toContain("https://imobpro.ia.br/api/public/proposal-pdf/abc");
    expect(s.fluxo?.kind).toBe("proposta");
  });
});
