import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A escrita por conversa: propor num turn, confirmar no seguinte.
 *
 * O que está sob teste é a MÁQUINA DE ESTADO, não o modelo. Por isso o `confirm`
 * é determinístico e por isso ele dá para testar assim: as decisões que importam
 * — executar, cancelar, descartar, expirar — não passam por LLM nenhum, e um
 * teste que dependesse do nano provaria o humor do modelo, não o código.
 */

vi.mock("@/lib/cm", async (orig) => ({
  // `ModuloDesligadoError` vem do módulo REAL: o `confirm` faz `instanceof`
  // nela, e uma classe redefinida no mock nunca casaria — o teste passaria
  // exercitando o caminho de falha genérica, que é o oposto do que ele afirma.
  ...(await orig<typeof import("@/lib/cm")>()),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn(),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  criarFormularioVenda: vi.fn(),
  criarFormularioLocacao: vi.fn(),
  criarRascunhoProposta: vi.fn(),
  brokerRecipientId: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({
  complete: vi.fn(),
  DEFAULT_MODEL: "openai/gpt-5.4-nano",
}));

const { buildGraph } = await import("../graph");
const { TOOL_PROPOR_FORM, PENDING_TTL_MS, lerConfirmacao, shouldOfferTools } =
  await import("../tools");
const {
  fetchProfile,
  searchKnowledge,
  criarFormularioVenda,
  criarFormularioLocacao,
  criarRascunhoProposta,
  brokerRecipientId,
  ModuloDesligadoError,
} = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");

const profile = fetchProfile as unknown as ReturnType<typeof vi.fn>;
const search = searchKnowledge as unknown as ReturnType<typeof vi.fn>;
const criar = criarFormularioVenda as unknown as ReturnType<typeof vi.fn>;
const criarLocacao = criarFormularioLocacao as unknown as ReturnType<typeof vi.fn>;
const criarProposta = criarRascunhoProposta as unknown as ReturnType<typeof vi.fn>;
const recipient = brokerRecipientId as unknown as ReturnType<typeof vi.fn>;
const llm = complete as unknown as ReturnType<typeof vi.fn>;

const usuario = {
  orgId: "org1",
  orgName: "RE/MAX Trio",
  kind: "user" as const,
  userId: "u1",
  userName: "Marcia Gerente",
};

/** Corretor comissionado: existe no `SplitRecipient`, não tem `User`. */
const corretorSemLogin = {
  orgId: "org1",
  orgName: "RE/MAX Trio",
  kind: "broker" as const,
  splitRecipientId: "sr1",
  label: "Wesley Cappozzi",
};

function inbound(text: string, messageId = "m1") {
  return {
    messageId,
    fromPhone: "5511987654321",
    groupId: null,
    kind: "text" as const,
    text,
    mediaUrl: null,
    mimeType: null,
    timestampMs: null,
    senderName: "Marcia",
    replyToMessageId: null,
  };
}

function llmTexto(text: string) {
  return {
    text,
    toolCalls: [],
    usage: {
      model: "openai/gpt-5.4-nano",
      promptTokens: 100,
      completionTokens: 20,
      latencyMs: 50,
      success: true,
    },
  };
}

function llmChamaFerramenta(args: Record<string, unknown> = { tipo: "venda" }) {
  return {
    // Chamada de ferramenta vem com `content: null` no provedor — é o formato
    // normal, e foi o que quase quebrou o `complete`.
    text: "",
    toolCalls: [{ name: TOOL_PROPOR_FORM, args }],
    usage: {
      model: "openai/gpt-5.4-nano",
      promptTokens: 120,
      completionTokens: 15,
      latencyMs: 60,
      success: true,
    },
  };
}

async function run(
  text: string,
  state: Record<string, unknown> = {},
  identity: typeof usuario | typeof corretorSemLogin = usuario,
  messageId = "m1"
) {
  const app = buildGraph().compile();
  return app.invoke({
    inbound: inbound(text, messageId),
    identity,
    reply: null,
    halt: null,
    propostaDescartada: false,
    ...state,
  });
}

function pendenciaDe(
  nomeCliente?: string,
  askedAt = Date.now(),
  extra: Record<string, unknown> = {}
) {
  return {
    kind: "criar_documento" as const,
    args: { tipo: "venda", nomeCliente, ...extra },
    askedAt,
    askedForMessageId: "m-anterior",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  profile.mockResolvedValue({ enabled: true, model: "x", instructions: null });
  search.mockResolvedValue([]);
  llm.mockResolvedValue(llmTexto("resposta qualquer"));
  criar.mockResolvedValue({
    token: "tok123",
    url: "https://imobpro.ia.br/f/tok123/joao-silva",
    dealId: "deal1",
  });
  criarLocacao.mockResolvedValue({
    token: "loc456",
    url: "https://imobpro.ia.br/f/loc456/ana",
    dealId: "deal2",
  });
  criarProposta.mockResolvedValue({
    id: "prop1",
    url: "https://imobpro.ia.br/pipeline/propostas/prop1/editar",
  });
  recipient.mockResolvedValue("sr-wesley");
});

describe("propor", () => {
  it("chamada de ferramenta vira pendência e pergunta — sem criar nada", async () => {
    llm.mockResolvedValue(
      llmChamaFerramenta({ tipo: "venda", nome_cliente: "João Silva" })
    );

    const s = await run("me manda um link de formulário pro João Silva");

    expect(criar).not.toHaveBeenCalled();
    expect(s.pendingAction?.kind).toBe("criar_documento");
    expect(s.pendingAction?.args.tipo).toBe("venda");
    expect(s.pendingAction?.args.nomeCliente).toBe("João Silva");
    expect(s.reply).toContain("João Silva");
    // A pergunta ensina a palavra que confirma — sem isso o casamento estrito
    // do matcher viraria armadilha.
    expect(s.reply).toContain("SIM");
  });

  /**
   * O texto que a pessoa lê para confirmar sai de TEMPLATE. Se viesse do
   * modelo, confirmar deixaria de significar alguma coisa: ela estaria
   * aprovando uma paráfrase, não a ação.
   */
  it("a pergunta não vem do modelo", async () => {
    llm.mockResolvedValue({
      ...llmChamaFerramenta({ tipo: "venda", nome_cliente: "João" }),
      text: "TEXTO INVENTADO PELO MODELO",
    });

    const s = await run("cria um formulário");

    expect(s.reply).not.toContain("TEXTO INVENTADO");
  });

  it("nome ausente propõe sem nome, não inventa", async () => {
    llm.mockResolvedValue(llmChamaFerramenta({ tipo: "venda" }));

    const s = await run("preciso de um formulário novo");

    expect(s.pendingAction?.args.nomeCliente).toBeUndefined();
    expect(s.reply).toContain("Confirma?");
  });

  /**
   * O nano às vezes inventa um valor fora do enum ("aluguel", "form"). Escolher
   * o mais parecido criaria a coisa errada com a confirmação da pessoa em cima:
   * ela leria "formulário de venda" tendo dito "aluguel".
   */
  it("tipo fora do enum descarta a chamada em vez de adivinhar", async () => {
    llm.mockResolvedValue(llmChamaFerramenta({ tipo: "aluguel" }));

    const s = await run("cria um formulário de aluguel");

    expect(s.pendingAction).toBeNull();
    expect(criar).not.toHaveBeenCalled();
  });

  it("corretor sem login não recebe a ferramenta e nada é proposto", async () => {
    llm.mockResolvedValue(llmTexto("Isso é pelo sistema."));

    await run("me manda um link de formulário", {}, corretorSemLogin);

    expect(llm).toHaveBeenCalledWith(
      expect.objectContaining({ tools: undefined })
    );
  });

  it("pergunta sobre processo não expõe a ferramenta", async () => {
    await run("como funciona a assinatura do contrato?");

    expect(llm).toHaveBeenCalledWith(
      expect.objectContaining({ tools: undefined })
    );
  });
});

describe("confirmar", () => {
  it("SIM cria o formulário e responde com o link, sem chamar o modelo", async () => {
    const s = await run("sim", { pendingAction: pendenciaDe("João Silva") }, usuario, "m-confirma");

    expect(criar).toHaveBeenCalledTimes(1);
    expect(criar).toHaveBeenCalledWith("org1", {
      title: "Formulário — João Silva",
      /**
       * Id de SplitRecipient resolvido pelo broker-scope, NUNCA o userId da
       * identidade: os corretorIds do /api/forms são SplitRecipient, e um
       * userId ali seria descartado em silêncio — form sem comissionado e sem
       * notificação, sem ninguém perceber.
       */
      corretorIds: ["sr-wesley"],
      // A mensagem que CONFIRMOU. Um uuid novo seria diferente a cada
      // retentativa e não protegeria de criar dois.
      idempotencyKey: "m-confirma",
    });
    // O broker-scope foi consultado com o TELEFONE de quem confirmou.
    expect(recipient).toHaveBeenCalledWith("org1", "5511987654321");
    expect(s.reply).toContain("https://imobpro.ia.br/f/tok123/joao-silva");
    expect(s.pendingAction).toBeNull();
    // Turn de confirmação custa ZERO token: quem responde é o template.
    expect(llm).not.toHaveBeenCalled();
  });

  /**
   * `null` do broker-scope é resultado normal — gerente que pede form sem ser
   * comissionado. O form nasce sem seed, e nada disso é erro.
   */
  it("sem SplitRecipient, cria sem corretorIds em vez de falhar", async () => {
    recipient.mockResolvedValue(null);

    const s = await run("sim", { pendingAction: pendenciaDe("João") });

    expect(criar).toHaveBeenCalledWith(
      "org1",
      expect.objectContaining({ corretorIds: undefined })
    );
    expect(s.reply).toContain("https://imobpro.ia.br/f/tok123");
  });

  it("NÃO cancela sem criar nada", async () => {
    const s = await run("não", { pendingAction: pendenciaDe() });

    expect(criar).not.toHaveBeenCalled();
    expect(s.pendingAction).toBeNull();
    expect(s.reply).toBe("Beleza, não criei nada.");
    expect(llm).not.toHaveBeenCalled();
  });

  /**
   * O caso que o `interrupt()` do LangGraph trataria mal: a pessoa não responde
   * a pergunta que você fez, ela muda de assunto. A pendência é descartada e o
   * turn segue normal — nenhuma thread fica travada esperando confirmação.
   */
  it("mudar de assunto descarta a pendência e responde a pergunta", async () => {
    const s = await run("quanto tempo demora a certidão?", {
      pendingAction: pendenciaDe(),
    });

    expect(criar).not.toHaveBeenCalled();
    expect(s.pendingAction).toBeNull();
    expect(s.propostaDescartada).toBe(true);
    expect(llm).toHaveBeenCalledTimes(1); // respondeu a pergunta de verdade
  });

  it("proposta vencida não é executada por um SIM tardio", async () => {
    const velha = pendenciaDe("João", Date.now() - PENDING_TTL_MS - 1000);

    const s = await run("sim", { pendingAction: velha });

    expect(criar).not.toHaveBeenCalled();
    expect(s.pendingAction).toBeNull();
  });

  it("falha na criação avisa que NÃO criou, e limpa a pendência", async () => {
    criar.mockRejectedValue(new Error("ImobPro /api/forms 500"));

    const s = await run("sim", { pendingAction: pendenciaDe() });

    expect(s.reply).toContain("nada foi criado");
    // Manter a pendência faria a próxima mensagem ser lida como uma segunda
    // confirmação, que a pessoa nunca deu.
    expect(s.pendingAction).toBeNull();
  });

  it("sem pendência, um SIM solto não cria nada", async () => {
    const s = await run("sim");

    expect(criar).not.toHaveBeenCalled();
    expect(s.pendingAction).toBeNull();
  });
});

describe("locação e proposta", () => {
  it("locação usa a rota de locação, com a finalidade, e NÃO manda corretorIds", async () => {
    const s = await run(
      "sim",
      { pendingAction: pendenciaDe("Ana", Date.now(), { tipo: "locacao", finalidade: "comercial" }) },
      usuario,
      "m-loc"
    );

    expect(criarLocacao).toHaveBeenCalledWith("org1", {
      title: "Formulário — Ana",
      finalidade: "comercial",
      idempotencyKey: "m-loc",
    });
    // A rota de locação não aceita o campo — mandá-lo seria erro de contrato.
    expect(criar).not.toHaveBeenCalled();
    expect(s.reply).toContain("https://imobpro.ia.br/f/loc456");
  });

  /**
   * A proposta nasce RASCUNHO e sem valores. A resposta precisa dizer isso: sem
   * o aviso, o corretor manda o link direto pro cliente achando que está
   * pronto, e o cliente abre uma proposta vazia.
   */
  it("proposta cria rascunho, avisa que está vazio e aponta pra tela de edição", async () => {
    const s = await run(
      "sim",
      { pendingAction: pendenciaDe("Carlos", Date.now(), { tipo: "proposta" }) },
      usuario,
      "m-prop"
    );

    expect(criarProposta).toHaveBeenCalledWith("org1", {
      title: "Proposta — Carlos",
      schemaType: "compra_venda_v1",
      idempotencyKey: "m-prop",
    });
    expect(s.reply).toContain("RASCUNHO");
    expect(s.reply).toContain("/pipeline/propostas/prop1/editar");
  });

  /**
   * Proposta de LOCAÇÃO por conversa: a natureza escolhe o schema que a rota
   * já aceitava — o hardcode de compra_venda_v1 era o que a deixava
   * inexistente. E o texto de confirmação precisa DIZER que é de locação:
   * a pessoa confirmaria "rascunho de proposta" achando que é de venda.
   */
  it("proposta de locação usa o schema de locação (residencial por padrão)", async () => {
    const s = await run(
      "sim",
      {
        pendingAction: pendenciaDe("Bia", Date.now(), {
          tipo: "proposta",
          natureza: "locacao",
        }),
      },
      usuario,
      "m-prop-loc"
    );

    expect(criarProposta).toHaveBeenCalledWith("org1", {
      title: "Proposta — Bia",
      schemaType: "locacao_residencial_v1",
      idempotencyKey: "m-prop-loc",
    });
    expect(s.reply).toContain("RASCUNHO");
  });

  it("proposta de locação comercial usa o schema comercial e se descreve inteira", async () => {
    const { textoProposta } = await import("../tools");
    const args = {
      tipo: "proposta",
      natureza: "locacao",
      finalidade: "comercial",
    } as const;
    expect(textoProposta(args)).toContain("rascunho de proposta de locação comercial");

    await run("sim", { pendingAction: pendenciaDe(undefined, Date.now(), args) }, usuario, "m-plc");
    expect(criarProposta).toHaveBeenCalledWith(
      "org1",
      expect.objectContaining({ schemaType: "locacao_comercial_v1" })
    );
  });

  /**
   * Duas bordas que o campo novo cria, ambas com resposta silenciosa (nada
   * falha, o documento é que nasce errado) — por isso teste explícito:
   *  - pendência gravada no checkpoint ANTES do deploy não tem `natureza`;
   *    confirmada depois, tem que continuar sendo proposta de VENDA;
   *  - `finalidade` sem `natureza: locacao` é órfã (a pessoa disse
   *    "comercial" numa proposta de venda) e não pode escolher schema.
   */
  it("pendência sem natureza (pré-deploy) e finalidade órfã continuam em compra_venda_v1", async () => {
    await run(
      "sim",
      { pendingAction: pendenciaDe("Zé", Date.now(), { tipo: "proposta" }) },
      usuario,
      "m-compat"
    );
    expect(criarProposta).toHaveBeenCalledWith(
      "org1",
      expect.objectContaining({ schemaType: "compra_venda_v1" })
    );

    criarProposta.mockClear();
    await run(
      "sim",
      {
        pendingAction: pendenciaDe("Zé", Date.now(), {
          tipo: "proposta",
          finalidade: "comercial",
        }),
      },
      usuario,
      "m-orfa"
    );
    expect(criarProposta).toHaveBeenCalledWith(
      "org1",
      expect.objectContaining({ schemaType: "compra_venda_v1" })
    );
  });

  /**
   * Módulo desligado não é falha transitória: retentar não resolve e quem
   * resolve não é quem pediu. "Tenta de novo em instantes" mandaria a pessoa
   * bater na mesma parede.
   */
  it("módulo desligado diz o que é, e não manda tentar de novo", async () => {
    criarLocacao.mockRejectedValue(new ModuloDesligadoError("/api/locacao/forms"));

    const s = await run("sim", {
      pendingAction: pendenciaDe(undefined, Date.now(), { tipo: "locacao" }),
    });

    expect(s.reply).toContain("não está habilitado");
    expect(s.reply).toContain("Nada foi criado");
    expect(s.reply).not.toContain("Tenta de novo");
    expect(s.pendingAction).toBeNull();
  });
});

describe("matcher de confirmação", () => {
  it("aceita as formas que a pergunta induz", () => {
    for (const t of ["sim", "SIM", "Sim.", "pode criar", "isso", "ok", "👍", "beleza"]) {
      expect(lerConfirmacao(t), t).toBe("sim");
    }
  });

  it("reconhece recusa", () => {
    for (const t of ["não", "nao", "n", "cancela", "deixa pra lá", "esquece"]) {
      expect(lerConfirmacao(t), t).toBe("nao");
    }
  });

  /**
   * O caso que justifica o casamento ancorado. Um `includes("sim")` executaria
   * a escrita em todos estes — e o primeiro é literalmente a pessoa pedindo
   * para esperar.
   */
  it("não confirma o que só CONTÉM um sim", () => {
    for (const t of [
      "sim mas espera",
      "sim, mas antes me diz quanto custa",
      "não sei, pode ser",
      "assim não dá",
      "quanto tempo demora?",
    ]) {
      expect(lerConfirmacao(t), t).toBe("nenhum");
    }
  });

  it("negativa vence quando as duas palavras aparecem", () => {
    expect(lerConfirmacao("não precisa")).toBe("nao");
    expect(lerConfirmacao("agora não")).toBe("nao");
  });

  /**
   * Confirmação por ÁUDIO é aceita — a transcrição já roda antes do grafo, e a
   * proposta que a pessoa está confirmando foi renderizada em texto, então ela
   * leu o que vai confirmar. O que a protege é o matcher ser estrito: uma
   * transcrição ruidosa não vira "sim" por acaso.
   */
  it("transcrição ruidosa não vira confirmação", () => {
    for (const t of ["sim sim sim quer dizer não", "ahn... deixa eu ver", ""]) {
      expect(lerConfirmacao(t), t).toBe("nenhum");
    }
  });
});

describe("prefiltro de ferramenta", () => {
  it("reconhece pedido de escrita", () => {
    for (const t of [
      "me manda um link de formulário",
      "abre uma ficha pro cliente",
      "preciso cadastrar um cliente novo",
      "cria um formulario",
    ]) {
      expect(shouldOfferTools(t), t).toBe(true);
    }
  });

  it("não expõe em pergunta de processo", () => {
    for (const t of [
      "como funciona a assinatura?",
      "quanto tempo demora a certidão?",
      "bom dia",
    ]) {
      expect(shouldOfferTools(t), t).toBe(false);
    }
  });
});
