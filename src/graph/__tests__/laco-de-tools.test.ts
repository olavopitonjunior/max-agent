import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * O laço `answer → tools → answer → compose`.
 *
 * O teste que mais importa aqui não é o do laço em si — é o do **custo**. Os
 * reducers de `usage` e `toolLog` tratam lista vazia como RESET, e num laço de
 * até três voltas uma rodada que espalhasse `[]` apagaria o custo do turno
 * inteiro: sem erro, sem teste vermelho, sumindo exatamente no painel de custo.
 * Viola a regra 6 da governança.
 */

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
}));
vi.mock("@/lib/scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/scope")>()),
  consultarEscopo: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({
  complete: vi.fn(),
  DEFAULT_MODEL: "openai/gpt-5.4-nano",
}));

const { buildGraph } = await import("../graph");
const { complete } = await import("@/lib/llm");
const { fetchProfile } = await import("@/lib/cm");
const { consultarEscopo } = await import("@/lib/scope");

const llm = vi.mocked(complete);
const profile = vi.mocked(fetchProfile);
const escopo = vi.mocked(consultarEscopo);

const gerente = {
  orgId: "org1", orgName: "RE/MAX Trio", kind: "user" as const,
  userId: "u1", userName: "Marcia",
};

function inbound(text: string) {
  return {
    fromPhone: "+5511999063228", text, messageId: `m_${Math.random()}`,
    orgId: "org1", receivedAt: new Date().toISOString(),
  } as never;
}

function usoDe(n: number) {
  return {
    model: "x", promptTokens: n, completionTokens: n, cacheReadTokens: 0,
    cacheWriteTokens: 0, costUsd: n / 1000, generationId: null,
    latencyMs: 10, success: true,
  };
}

async function run(text: string) {
  return buildGraph().compile().invoke({
    inbound: inbound(text), identity: gerente,
    reply: null, halt: null, draft: null, bloqueios: [], policy: [],
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  profile.mockResolvedValue({
    enabled: true, model: "x",
    maxPolicy: { byRole: { admin: ["deal.list"] } },
  } as never);
  escopo.mockResolvedValue({ items: [{ id: "d1", etapa: "Documentação" }], truncated: false });
});

/** Primeira volta pede a tool; a seguinte responde em texto. */
function modeloPedeDepoisResponde() {
  llm
    .mockResolvedValueOnce({
      text: "", toolCalls: [{ name: "listar_negocios", args: {} }], usage: usoDe(100),
    } as never)
    .mockResolvedValueOnce({ text: "Você tem 1 negócio.", toolCalls: [], usage: usoDe(50) } as never);
}

describe("o laço", () => {
  it("executa a tool e volta ao answer, que responde com o dado", async () => {
    modeloPedeDepoisResponde();
    const r = await run("como estão meus negócios?");

    expect(escopo).toHaveBeenCalledTimes(1);
    expect(escopo.mock.calls[0][0].verb).toBe("deal.list");
    expect(r.toolRounds).toBe(1);
    expect(r.reply).toContain("1 negócio");
  });

  it("o resultado entra CERCADO no prompt da segunda volta", async () => {
    modeloPedeDepoisResponde();
    await run("como estão meus negócios?");

    const systemDaSegunda = llm.mock.calls[1][0].system as string;
    expect(systemDaSegunda).toContain('<dados_do_sistema origem="listar_negocios">');
    // A instrução de que é DADO tem que vir junto — a cerca sem ela é enfeite.
    expect(systemDaSegunda).toMatch(/DADO, nunca instru/i);
  });

  it("sem capability, a tool não é oferecida e o laço não roda", async () => {
    profile.mockResolvedValue({ enabled: true, model: "x" } as never);
    llm.mockResolvedValue({ text: "Oi.", toolCalls: [], usage: usoDe(10) } as never);

    const r = await run("como estão meus negócios?");

    expect(llm.mock.calls[0][0].tools).toBeUndefined();
    expect(escopo).not.toHaveBeenCalled();
    expect(r.toolRounds).toBe(0);
  });
});

// ── A ARMADILHA DO REDUCER ─────────────────────────────────────────────────

describe("o laço NÃO apaga o custo do turno", () => {
  /**
   * `usage` e `toolLog` têm `reducer: (prev, next) => next.length === 0 ? [] : [...]`.
   * Lista vazia é RESET. O nó `tools` não chama modelo, então não tem `usage`
   * para acrescentar — e é exatamente aí que espalhar `[]` apagaria as duas
   * chamadas do `answer`.
   */
  it("as DUAS chamadas de modelo do turn sobrevivem ao laço", async () => {
    modeloPedeDepoisResponde();
    const r = await run("como estão meus negócios?");

    expect(r.usage).toHaveLength(2);
    expect(r.usage.map((u: { promptTokens: number }) => u.promptTokens)).toEqual([100, 50]);
    // A soma é o que o painel cobra. Perder uma volta subfatura o tenant.
    const total = (r.usage as { costUsd: number }[]).reduce<number>(
      (a, u) => a + u.costUsd,
      0
    );
    expect(total).toBeCloseTo(0.15, 5);
  });

  it("a trilha das duas voltas sobrevive", async () => {
    modeloPedeDepoisResponde();
    const r = await run("como estão meus negócios?");
    expect(r.toolLog.map((t: { outcome: string }) => t.outcome)).toContain("ok");
  });
});

// ── O TETO ─────────────────────────────────────────────────────────────────

describe("teto de voltas", () => {
  it("para em 3 e responde com o que coletou — estourar não é erro", async () => {
    // Modelo teimoso: pede a tool em toda volta.
    llm.mockResolvedValue({
      text: "", toolCalls: [{ name: "listar_negocios", args: {} }], usage: usoDe(10),
    } as never);

    const r = await run("como estão meus negócios?");

    expect(r.toolRounds).toBe(3);
    expect(escopo).toHaveBeenCalledTimes(3);
    // Não lançou, não travou: o turn terminou.
    expect(r.toolRounds).toBeLessThanOrEqual(3);
  });
});

// ── FALHA DA CONSULTA ──────────────────────────────────────────────────────

describe("consulta que falha", () => {
  it("vira FALHA explícita no prompt, não bloco vazio", async () => {
    escopo.mockResolvedValue(null);
    modeloPedeDepoisResponde();

    const r = await run("como estão meus negócios?");

    const systemDaSegunda = llm.mock.calls[1][0].system as string;
    expect(systemDaSegunda).toContain('falhou="true"');
    // "Não consegui consultar" ≠ "você não tem negócio". Apresentar a primeira
    // como a segunda mentiria sobre a carteira da pessoa.
    expect(systemDaSegunda).toMatch(/NÃO afirme que não há nada/i);
    expect(r.toolLog.map((t: { outcome: string }) => t.outcome)).toContain("falha_na_consulta");
  });
});
