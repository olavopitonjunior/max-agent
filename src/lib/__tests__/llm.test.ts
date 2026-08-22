import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { complete, DEFAULT_MODEL, type LlmUsage } from "../llm";

function mockFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fn = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const OK = {
  model: "openai/gpt-5.4-nano",
  choices: [{ message: { content: "  O formulário tem 7 etapas.  " } }],
  usage: { prompt_tokens: 120, completion_tokens: 18 },
};

describe("complete (OpenRouter)", () => {
  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("usa o mesmo modelo do Newton por padrão", () => {
    expect(DEFAULT_MODEL).toBe("openai/gpt-5.4-nano");
  });

  it("manda o system como PRIMEIRA mensagem, não como campo à parte", async () => {
    const f = mockFetch(OK);

    await complete({
      system: "Você é o Max.",
      messages: [{ role: "user", content: "oi" }],
    });

    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.messages[0]).toEqual({ role: "system", content: "Você é o Max." });
    expect(body.messages[1]).toEqual({ role: "user", content: "oi" });
    expect(body.model).toBe("openai/gpt-5.4-nano");
  });

  it("identifica o Max no painel do OpenRouter (a conta é compartilhada com o Newton)", async () => {
    const f = mockFetch(OK);
    await complete({ system: "s", messages: [{ role: "user", content: "oi" }] });
    expect(f.mock.calls[0][1].headers["X-Title"]).toContain("Max");
  });

  it("devolve texto aparado e o consumo do turn", async () => {
    mockFetch(OK);

    const r = await complete({ system: "s", messages: [{ role: "user", content: "oi" }] });

    expect(r.text).toBe("O formulário tem 7 etapas.");
    expect(r.usage).toMatchObject({
      model: "openai/gpt-5.4-nano",
      promptTokens: 120,
      completionTokens: 18,
      success: true,
    });
  });

  /** O custo é do que o provedor DIZ ter usado, não do que pedimos. */
  it("registra o modelo que o provedor roteou, não o solicitado", async () => {
    mockFetch({ ...OK, model: "openai/gpt-5.4-nano:free" });

    const r = await complete({ system: "s", messages: [{ role: "user", content: "oi" }] });

    expect(r.usage.model).toBe("openai/gpt-5.4-nano:free");
  });

  /**
   * Armadilha do OpenRouter: quando o roteamento falha (modelo indisponível,
   * sem crédito), ele responde **HTTP 200 com `error` no corpo**. Tratar isso
   * como sucesso devolveria resposta vazia ao usuário, em silêncio.
   */
  it("200 com `error` no corpo é FALHA, não resposta vazia", async () => {
    mockFetch({ error: { message: "No endpoints found" } });

    await expect(
      complete({ system: "s", messages: [{ role: "user", content: "oi" }] })
    ).rejects.toThrow(/No endpoints found/);
  });

  it("resposta vazia também é falha", async () => {
    mockFetch({ ...OK, choices: [{ message: { content: "   " } }] });

    await expect(
      complete({ system: "s", messages: [{ role: "user", content: "oi" }] })
    ).rejects.toThrow(/vazia/);
  });

  it("erro HTTP vira falha com o status", async () => {
    mockFetch({ detail: "rate limit" }, { ok: false, status: 429 });

    await expect(
      complete({ system: "s", messages: [{ role: "user", content: "oi" }] })
    ).rejects.toThrow(/OpenRouter 429/);
  });

  /**
   * Sem isto, um agente que só erra apareceria no painel de custo como um
   * agente que não gasta nada.
   */
  it("a falha carrega o consumo da tentativa, pro chamador reportar", async () => {
    mockFetch({ detail: "boom" }, { ok: false, status: 500 });

    const err = await complete({
      system: "s",
      messages: [{ role: "user", content: "oi" }],
    }).catch((e) => e as Error & { usage?: LlmUsage });

    expect(err.usage).toMatchObject({ success: false, model: "openai/gpt-5.4-nano" });
    expect(err.usage?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  /**
   * O `usage` inline do OpenRouter já traz custo e cache, e até 22/08 este
   * módulo descartava os dois na porta de entrada. É o que fazia o painel do
   * ImobPro superestimar em 304% um turn com cache de prefixo.
   */
  describe("custo real e cache do provedor", () => {
    // Os números medidos em produção em 21/08, turno 2.
    const COM_CACHE = {
      id: "gen-abc123",
      model: "openai/gpt-5.4-nano",
      choices: [{ message: { content: "resposta" } }],
      usage: {
        prompt_tokens: 1956,
        completion_tokens: 18,
        cost: 0.00010614,
        prompt_tokens_details: { cached_tokens: 1792, cache_write_tokens: 0 },
      },
    };

    it("propaga custo, tokens de cache e o id da geração", async () => {
      mockFetch(COM_CACHE);
      const r = await complete({ system: "s", messages: [{ role: "user", content: "oi" }] });
      expect(r.usage.costUsd).toBeCloseTo(0.00010614, 8);
      expect(r.usage.cacheReadTokens).toBe(1792);
      expect(r.usage.cacheWriteTokens).toBe(0);
      expect(r.usage.generationId).toBe("gen-abc123");
    });

    /**
     * A regra que sustenta o outro lado: ausência vira `null`, NUNCA 0. Um
     * custo ausente carimbado como zero seria indistinguível de um turn de
     * graça, e o receptor perderia a chance de cair na tabela de preços.
     */
    it("provedor sem `cost` devolve null, não zero", async () => {
      mockFetch(OK);
      const r = await complete({ system: "s", messages: [{ role: "user", content: "oi" }] });
      expect(r.usage.costUsd).toBeNull();
      expect(r.usage.cacheReadTokens).toBe(0);
      expect(r.usage.generationId).toBeNull();
    });

    it("custo malformado (NaN, negativo, string) também vira null", async () => {
      for (const cost of [Number.NaN, -1, "0.5" as unknown as number]) {
        mockFetch({ ...OK, usage: { ...OK.usage, cost } });
        const r = await complete({ system: "s", messages: [{ role: "user", content: "oi" }] });
        expect(r.usage.costUsd).toBeNull();
      }
    });

    it("a falha também carrega os campos novos, com null", async () => {
      mockFetch({ error: { message: "rate limited" } });
      await expect(
        complete({ system: "s", messages: [{ role: "user", content: "oi" }] })
      ).rejects.toMatchObject({
        usage: { costUsd: null, generationId: null, cacheReadTokens: 0, success: false },
      });
    });
  });

  it("sem chave falha claro, sem chamar a rede", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const f = mockFetch(OK);

    await expect(
      complete({ system: "s", messages: [{ role: "user", content: "oi" }] })
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(f).not.toHaveBeenCalled();
  });
});
