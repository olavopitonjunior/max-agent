import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Prod (Max Fincasa): a pergunta do bot "celular ou link no WhatsApp?" virou o
 * fato `preferências_trabalho_recorrentes` da pessoa. O extrator só pode ver o
 * que a PESSOA escreveu; o que o assistente diz nunca chega ao modelo.
 */
const llm = vi.hoisted(() => ({ complete: vi.fn() }));

vi.mock("../db", () => ({ query: vi.fn(async () => []), db: {} }));
vi.mock("../llm", () => ({ complete: llm.complete, DEFAULT_MODEL: "x" }));
vi.mock("../cm", () => ({ reportUsage: vi.fn().mockResolvedValue(undefined) }));

const { extractFacts } = await import("../memory");

const uso = { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true };

beforeEach(() => {
  llm.complete.mockReset();
  llm.complete.mockResolvedValue({ text: "{}", toolCalls: [], usage: uso });
});

describe("extractFacts: só a fala da pessoa", () => {
  it("a pergunta do assistente não chega ao modelo, mesmo que um chamador a passe", async () => {
    const PERGUNTA_DO_BOT = "Você prefere receber por celular ou link no WhatsApp?";
    await extractFacts({
      orgId: "org1",
      phone: "5511900000001",
      userText: "manda a proposta da Ana",
      known: {},
      // chamador antigo: o campo não existe mais na assinatura e é ignorado.
      ...({ replyText: PERGUNTA_DO_BOT } as object),
    });

    const enviado = JSON.stringify(llm.complete.mock.calls[0]![0].messages);
    expect(enviado).toContain("manda a proposta da Ana");
    expect(enviado).not.toContain("celular ou link");
    expect(enviado).not.toContain("Assistente:");
  });

  it("o prompt de sistema diz que só recebe falas da pessoa e não trata resposta curta como preferência", async () => {
    await extractFacts({ orgId: "org1", phone: "5511900000001", userText: "celular", known: {} });
    const system: string = llm.complete.mock.calls[0]![0].system;
    expect(system).toMatch(/SÓ as falas da pessoa/);
    expect(system).toMatch(/resposta curta a uma pergunta/);
  });

  it("sem fato durável devolve {} e não grava nada do bot", async () => {
    const fatos = await extractFacts({ orgId: "org1", phone: "5511900000001", userText: "celular", known: {} });
    expect(fatos).toEqual({});
  });
});
