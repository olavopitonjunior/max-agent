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

const { buildGraph, RESET_DO_TURN } = await import("../graph");
const { MemorySaver } = await import("@langchain/langgraph");
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


// ── A FRONTEIRA DO TURN ────────────────────────────────────────────────────

describe("o estado do laço NAO atravessa turns", () => {
  /**
   * Os testes acima são de UMA invocação e, por construção, não conseguem
   * pegar isto — foi assim que o defeito passou.
   *
   * O checkpointer restaura o estado inteiro por `thread_id`, e o `runTurn`
   * zera explicitamente o que é do turn. Se `toolRounds` e `toolResults`
   * ficarem de fora desse zeramento, o defeito é duplo e silencioso:
   *
   *  - a seleção só roda em `toolRounds === 0`, então a tool nunca mais é
   *    oferecida naquela conversa depois do primeiro uso;
   *  - `toolResults` segue injetando o resultado do primeiro turn em todo
   *    prompt seguinte, apresentando dado velho como atual.
   */
  async function turno(app: unknown, texto: string, thread: string) {
    return (app as {
      invoke: (s: unknown, c: unknown) => Promise<Record<string, unknown>>;
    }).invoke(
      {
        // ⚠️ Espalha o CONTRATO real, não uma cópia dele. A primeira versão
        // deste helper listava os campos à mão — e por isso passava mesmo com
        // o reset removido do `runTurn`: o teste replicava o contrato em vez
        // de testá-lo. Mutação de controle é que revelou.
        ...RESET_DO_TURN,
        inbound: inbound(texto), identity: gerente, policy: [],
      },
      { configurable: { thread_id: thread } }
    );
  }

  it("segundo turn na MESMA thread comeca limpo", async () => {
    const app = buildGraph().compile({ checkpointer: new MemorySaver() });
    const thread = "org1:conversa-x";

    modeloPedeDepoisResponde();
    const t1 = await turno(app, "como estão meus negócios?", thread);
    expect(t1.toolRounds).toBe(1);

    llm.mockReset();
    llm.mockResolvedValue({ text: "Bom dia!", toolCalls: [], usage: usoDe(5) } as never);
    const t2 = await turno(app, "bom dia", thread);

    // Se isto voltar 1, a tool nunca mais é oferecida nesta conversa.
    expect(t2.toolRounds).toBe(0);
    // E o dado do turn 1 não pode reaparecer no prompt do turn 2.
    const systemT2 = llm.mock.calls[0][0].system as string;
    expect(systemT2).not.toContain("<dados_do_sistema");
  });
});

// ── A CAPABILITY E RECONFERIDA NA EXECUCAO ─────────────────────────────────

describe("execucao revalida a capability", () => {
  it("chamada sem a capability NAO executa a consulta", async () => {
    profile.mockResolvedValue({ enabled: true, model: "x" } as never);
    llm
      .mockResolvedValueOnce({
        text: "", toolCalls: [{ name: "listar_negocios", args: {} }], usage: usoDe(10),
      } as never)
      .mockResolvedValueOnce({ text: "Não consegui.", toolCalls: [], usage: usoDe(5) } as never);

    const r = await run("como estão meus negócios?");

    expect(escopo).not.toHaveBeenCalled();
    expect(r.toolLog.map((t: { outcome: string }) => t.outcome)).toContain("capability_negada");
  });
});


describe("RESET_DO_TURN é o contrato, e precisa cobrir o laço", () => {
  /**
   * Estrutural de propósito. O defeito que o review pegou não é de
   * comportamento dentro de um turn — é de ESQUECIMENTO ao acrescentar campo
   * de estado. Um teste que enumera os campos do laço falha na hora em que
   * alguém adiciona o quarto e não o zera.
   */
  it("cobre os três campos do laço de tools", () => {
    expect(RESET_DO_TURN).toMatchObject({
      pendingToolCalls: [],
      toolRounds: 0,
      toolResults: [],
    });
  });

  it("cobre também o que já era do turn — não regrediu", () => {
    expect(Object.keys(RESET_DO_TURN)).toEqual(
      expect.arrayContaining([
        "reply", "halt", "propostaDescartada", "draft",
        "bloqueios", "usage", "toolLog",
      ])
    );
  });
});


describe("truncamento LOCAL se declara", () => {
  /**
   * `r.truncated` é do servidor; o `slice(0, 4000)` é nosso. Anunciar só o
   * primeiro deixaria uma lista cortada aqui passar por completa.
   */
  it("lista grande com truncated=false do servidor ainda avisa", async () => {
    const gigante = Array.from({ length: 400 }, (_, i) => ({
      id: `d${i}`, etapa: "Documentação", pendencias: ["certidão de ônus"],
    }));
    escopo.mockResolvedValue({ items: gigante, truncated: false });
    modeloPedeDepoisResponde();

    await run("como estão meus negócios?");

    const systemDaSegunda = llm.mock.calls[1][0].system as string;
    expect(systemDaSegunda).toContain('truncado="true"');
  });
});
