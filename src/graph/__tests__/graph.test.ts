import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/cm", () => ({
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn(),
  reportUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/llm", () => ({
  complete: vi.fn(),
  DEFAULT_MODEL: "openai/gpt-5.4-nano",
}));

const { buildGraph, threadIdFor } = await import("../graph");
const { fetchProfile, searchKnowledge, reportUsage } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");

const profile = fetchProfile as unknown as ReturnType<typeof vi.fn>;
const search = searchKnowledge as unknown as ReturnType<typeof vi.fn>;
const usage = reportUsage as unknown as ReturnType<typeof vi.fn>;
const llm = complete as unknown as ReturnType<typeof vi.fn>;

const identity = {
  orgId: "org1",
  orgName: "RE/MAX Trio",
  kind: "user" as const,
  userId: "u1",
  userName: "Marcia Gerente",
  role: "sales",
};

function inbound(text: string) {
  return {
    messageId: "m1",
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

function llmOk(text: string, model = "openai/gpt-5.4-nano") {
  return {
    text,
    // Resposta em texto é `toolCalls` VAZIO, nunca ausente — é o contrato do
    // `complete`. Um mock que omite o campo esconderia do teste o caminho de
    // ferramenta em vez de exercitá-lo.
    toolCalls: [],
    usage: { model, promptTokens: 100, completionTokens: 20, latencyMs: 50, success: true },
  };
}

async function run(text: string, state: Record<string, unknown> = {}) {
  const app = buildGraph().compile();
  return app.invoke({ inbound: inbound(text), identity, ...state });
}

describe("grafo de conversa", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profile.mockResolvedValue({ enabled: true, model: "claude-sonnet-4-6", instructions: null });
    search.mockResolvedValue([{ id: "k1", title: "T", content: "C", lowConfidence: false }]);
    llm.mockResolvedValue(llmOk("O formulário tem 7 etapas."));
  });

  it("responde e registra os dois lados da conversa no histórico", async () => {
    const r = await run("como funciona o formulário?");

    expect(r.reply).toBe("O formulário tem 7 etapas.");
    expect(r.messages).toEqual([
      { role: "user", content: "como funciona o formulário?" },
      { role: "assistant", content: "O formulário tem 7 etapas." },
    ]);
  });

  /**
   * Kill switch do console do ImobPro. Desligar lá tem que calar o agente aqui
   * sem redeploy — e sem gastar modelo.
   */
  it("perfil desabilitado encerra o turn sem chamar o modelo", async () => {
    profile.mockResolvedValue({ enabled: false, model: "x", instructions: null });

    const r = await run("como funciona o formulário?");

    expect(r.reply).toContain("indisponível");
    expect(llm).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  /**
   * Persona e modelo são controle de tom e custo, não de segurança. Ficar mudo
   * porque a API do ImobPro oscilou é o pior dos dois erros.
   */
  it("perfil indisponível NÃO derruba o turn", async () => {
    profile.mockRejectedValue(new Error("502"));

    const r = await run("como funciona o formulário?");

    expect(r.reply).toBe("O formulário tem 7 etapas.");
  });

  /**
   * O `model` do perfil carrega id Anthropic e este runtime fala com o
   * OpenRouter — honrá-lo mandaria um id inexistente. O registry do ImobPro já
   * declara `supports.model: false` pro Max por isso.
   */
  it("IGNORA o modelo do perfil (é id Anthropic; aqui é OpenRouter)", async () => {
    profile.mockResolvedValue({ enabled: true, model: "claude-opus-4-6", instructions: null });

    await run("como funciona o formulário?");

    expect(llm).toHaveBeenCalledWith(
      expect.objectContaining({ model: "openai/gpt-5.4-nano" })
    );
  });

  it("saudação não gasta busca semântica", async () => {
    await run("oi");
    expect(search).not.toHaveBeenCalled();
    expect(llm).toHaveBeenCalled();
  });

  /** Base fora do ar vira "não sei", não silêncio. */
  it("RAG falhando ainda produz resposta", async () => {
    search.mockRejectedValue(new Error("timeout"));

    const r = await run("como funciona o formulário?");

    expect(r.hits).toEqual([]);
    expect(r.reply).toBe("O formulário tem 7 etapas.");
  });

  it("modelo falhando devolve recado humano e registra o custo da tentativa", async () => {
    llm.mockRejectedValue(
      Object.assign(new Error("529"), {
        usage: { model: "m", promptTokens: 0, completionTokens: 0, latencyMs: 10, success: false },
      })
    );

    const r = await run("como funciona o formulário?");

    expect(r.reply).toContain("problema pra responder");
    expect(usage).toHaveBeenCalledWith(
      "org1",
      expect.objectContaining({ success: false })
    );
  });

  /**
   * O ImobPro é a fonte da verdade do gasto de IA. Se o Max não reportar, o
   * painel de lá mente por omissão.
   */
  it("reporta o consumo de cada turn", async () => {
    await run("como funciona o formulário?");

    expect(usage).toHaveBeenCalledWith(
      "org1",
      expect.objectContaining({
        model: "openai/gpt-5.4-nano",
        promptTokens: 100,
        success: true,
      })
    );
  });
});

describe("compactação", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profile.mockResolvedValue({ enabled: true, model: "claude-sonnet-4-6", instructions: null });
    search.mockResolvedValue([]);
  });

  function historico(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `msg ${i}`,
    }));
  }

  it("histórico curto não é compactado", async () => {
    llm.mockResolvedValue(llmOk("ok"));

    const r = await run("pergunta qualquer sobre contrato", { messages: historico(4) });

    expect(r.summary).toBeNull();
    // 4 antigas + o par deste turn.
    expect(r.messages).toHaveLength(6);
  });

  /**
   * O reducer de `messages` CONCATENA. Encolher o histórico só é possível pela
   * forma `{ replace }` — com um reducer que só soma, devolver a lista podada a
   * acrescentaria de novo.
   */
  it("histórico longo vira resumo E encolhe de verdade", async () => {
    llm
      .mockResolvedValueOnce(llmOk("resposta do turn"))
      .mockResolvedValueOnce(llmOk("resumo dos turnos antigos"));

    const r = await run("pergunta qualquer sobre contrato", { messages: historico(20) });

    expect(r.summary).toBe("resumo dos turnos antigos");
    expect(r.messages).toHaveLength(6);
    // Os que sobraram são os MAIS RECENTES.
    expect(r.messages[r.messages.length - 1].content).toBe("resposta do turn");
  });

  it("compacta com teto de tokens curto — resumo não é redação", async () => {
    llm
      .mockResolvedValueOnce(llmOk("resposta"))
      .mockResolvedValueOnce(llmOk("resumo"));

    await run("pergunta qualquer sobre contrato", { messages: historico(20) });

    expect(llm.mock.calls[1][0].maxTokens).toBe(400);
  });

  /**
   * Nunca descartar histórico sem ter conseguido resumi-lo — seria perder
   * contexto de verdade para economizar tokens.
   */
  it("resumo falhando PRESERVA o histórico", async () => {
    llm
      .mockResolvedValueOnce(llmOk("resposta"))
      .mockRejectedValueOnce(new Error("529"));

    const r = await run("pergunta qualquer sobre contrato", { messages: historico(20) });

    expect(r.summary).toBeNull();
    expect(r.messages).toHaveLength(22);
  });
});

describe("threadIdFor", () => {
  /** Isolamento por tenant é por construção: outra org, outra thread. */
  it("a org vem primeiro e separa memórias do mesmo telefone", () => {
    expect(threadIdFor("orgA", "5511999")).toBe("orgA:5511999");
    expect(threadIdFor("orgA", "5511999")).not.toBe(threadIdFor("orgB", "5511999"));
  });
});
