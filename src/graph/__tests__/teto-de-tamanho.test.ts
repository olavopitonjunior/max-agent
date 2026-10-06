import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * G6 — ≤ 500 caracteres e ≤ 6 linhas, no CÓDIGO.
 *
 * A métrica 4 do plano é "respostas acima do teto: 0" — e só é zero se o corte
 * não depender de o nano obedecer ao prompt. O teste mede a SAÍDA do grafo,
 * não a função isolada só: um teto aplicado fora do `compose` seria um teto
 * que algum caminho pula.
 */

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));

const { limitarTamanho, TETO_CARACTERES, TETO_LINHAS, SUFIXO_RESTO } = await import("../compose");
const { buildGraph, RESET_DO_TURN } = await import("../graph");
const { MemorySaver } = await import("@langchain/langgraph");
const { complete } = await import("@/lib/llm");
const { fetchProfile } = await import("@/lib/cm");
const llm = vi.mocked(complete);
const profile = vi.mocked(fetchProfile);

const dentroDoTeto = (t: string) =>
  t.length <= TETO_CARACTERES && t.split("\n").length <= TETO_LINHAS;

const frase = (i: number) => `Esta é a frase número ${i} da resposta comprida do Max.`;

describe("limitarTamanho", () => {
  it("texto que cabe volta INTACTO, sem resto", () => {
    const t = "Tudo certo.\nO contrato saiu ontem.";
    expect(limitarTamanho(t)).toEqual({ texto: t, resto: null });
  });

  it("acima de 500 caracteres: corta em fim de frase e oferece o resto", () => {
    const longo = Array.from({ length: 20 }, (_, i) => frase(i)).join(" ");
    const r = limitarTamanho(longo);

    expect(dentroDoTeto(r.texto)).toBe(true);
    expect(r.texto.endsWith(`\n${SUFIXO_RESTO}`)).toBe(true);
    // Corte em fim de frase: a parte termina com ponto antes do sufixo.
    expect(r.texto.replace(`\n${SUFIXO_RESTO}`, "")).toMatch(/\.$/);
    // Nada se perde: parte + resto = original.
    expect(`${r.texto.replace(`\n${SUFIXO_RESTO}`, "")} ${r.resto}`).toBe(longo);
  });

  it("acima de 6 linhas (curtas): corta por linha", () => {
    const linhas = Array.from({ length: 9 }, (_, i) => `${i + 1}. item`).join("\n");
    const r = limitarTamanho(linhas);
    expect(r.texto.split("\n")).toHaveLength(TETO_LINHAS);
    expect(r.texto).toBe(`1. item\n2. item\n3. item\n4. item\n5. item\n${SUFIXO_RESTO}`);
    expect(r.resto).toBe("6. item\n7. item\n8. item\n9. item");
  });

  it("palavra gigante sem espaço nem ponto: corte duro, ainda dentro do teto", () => {
    const r = limitarTamanho("a".repeat(1200));
    expect(dentroDoTeto(r.texto)).toBe(true);
    expect(r.resto).not.toBeNull();
  });

  it("o resto também passa pelo teto em pedaços", () => {
    const longo = Array.from({ length: 40 }, (_, i) => frase(i)).join(" ");
    let resto: string | null = longo;
    let pedacos = 0;
    while (resto) {
      const r = limitarTamanho(resto);
      expect(dentroDoTeto(r.texto)).toBe(true);
      resto = r.resto;
      pedacos++;
      expect(pedacos).toBeLessThan(20);
    }
    expect(pedacos).toBeGreaterThan(2);
  });
});

// ── No grafo: o corte e o "quer ver o resto?" ──────────────────────────────

describe("no grafo", () => {
  const gerente = { orgId: "org1", orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "M" };
  const uso = { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true };
  const longo = Array.from({ length: 20 }, (_, i) => frase(i)).join(" ");

  async function turno(app: unknown, texto: string, id: string) {
    return (app as { invoke: (s: unknown, c: unknown) => Promise<Record<string, unknown>> }).invoke(
      { ...RESET_DO_TURN, inbound: { fromPhone: "+5511999990000", text: texto, messageId: id }, identity: gerente },
      { configurable: { thread_id: "org1:teto" } }
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    profile.mockResolvedValue({ enabled: true, model: "x" } as never);
  });

  it("resposta longa do modelo sai cortada; 'sim' manda o resto SEM chamar o modelo", async () => {
    const app = buildGraph().compile({ checkpointer: new MemorySaver() });
    llm.mockResolvedValue({ text: longo, toolCalls: [], usage: uso } as never);

    const t1 = await turno(app, "me explica o processo todo", "m1");
    expect(dentroDoTeto(t1.reply as string)).toBe(true);
    expect(t1.reply).toContain(SUFIXO_RESTO);
    expect(t1.restoDaResposta).not.toBeNull();

    llm.mockClear();
    const t2 = await turno(app, "sim", "m2");
    expect(llm).not.toHaveBeenCalled();
    expect(dentroDoTeto(t2.reply as string)).toBe(true);
    expect(longo).toContain((t2.reply as string).replace(`\n${SUFIXO_RESTO}`, "").slice(0, 40));
  });

  it("qualquer outra mensagem descarta o resto (sobrevive UM turn)", async () => {
    const app = buildGraph().compile({ checkpointer: new MemorySaver() });
    llm.mockResolvedValue({ text: longo, toolCalls: [], usage: uso } as never);
    await turno(app, "me explica o processo todo", "m1");

    llm.mockResolvedValue({ text: "Bom dia!", toolCalls: [], usage: uso } as never);
    const t2 = await turno(app, "bom dia", "m2");
    expect(t2.reply).toBe("Bom dia!");
    expect(t2.restoDaResposta).toBeNull();

    // E um "sim" depois disso não ressuscita o resto: vai ao modelo.
    llm.mockResolvedValue({ text: "Sim o quê?", toolCalls: [], usage: uso } as never);
    const t3 = await turno(app, "sim", "m3");
    expect(t3.reply).toBe("Sim o quê?");
  });

  it("template (texto fixo) não é cortado nem ganha sufixo", async () => {
    profile.mockResolvedValue({ enabled: false, model: "x" } as never);
    const r = await buildGraph().compile().invoke({
      inbound: { fromPhone: "+5511999990000", text: "oi", messageId: "m1" },
      identity: gerente,
    } as never);
    expect(r.reply).not.toContain(SUFIXO_RESTO);
  });
});
