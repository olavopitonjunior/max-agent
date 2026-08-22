import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * O corpo que `reportUsage` põe na rede, e o que ele faz quando o outro lado
 * recusa.
 *
 * Os dois nasceram de code review em 22/08, e pelo mesmo motivo: **o caminho
 * feliz e o caminho perdido tinham a mesma aparência**. O corpo é montado
 * campo a campo, então uma troca (`cacheReadTokens: usage.cacheWriteTokens`)
 * passaria por toda a suíte sem que nada quebrasse; e um 400 do zod de lá
 * descartava a linha de custo em silêncio, porque ninguém olhava `res.ok`.
 */
vi.mock("../orgs", () => ({
  orgById: vi.fn().mockResolvedValue({ apiToken: "tok-de-teste" }),
}));

const { reportUsage } = await import("../cm");

const USO = {
  model: "openai/gpt-5.4-nano",
  promptTokens: 164,
  completionTokens: 18,
  cacheReadTokens: 1792,
  cacheWriteTokens: 7,
  costUsd: 0.00010614,
  latencyMs: 3200,
  success: true,
  dealId: null,
};

function mockFetch(init: { ok?: boolean; status?: number; body?: string } = {}) {
  const fn = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 202,
    text: async () => init.body ?? "{}",
    json: async () => JSON.parse(init.body ?? "{}"),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  // `restoreAllMocks` NÃO serve aqui: ele zeraria também o mock de módulo do
  // `orgById`, e sem org o `reportUsage` retorna antes do fetch — os testes
  // seguintes passariam a não exercitar nada.
  espioes.forEach((s) => s.mockRestore());
  espioes.length = 0;
});

/** Spies de console criados por teste, restaurados um a um no teardown. */
const espioes: Array<{ mockRestore: () => void }> = [];
function espiarErro() {
  const s = vi.spyOn(console, "error").mockImplementation(() => {});
  espioes.push(s);
  return s;
}

describe("reportUsage — o contrato que atravessa a rede", () => {
  it("manda cada campo no lugar certo, sem troca", async () => {
    const f = mockFetch();
    await reportUsage("org-1", USO);

    const corpo = JSON.parse(f.mock.calls[0][1].body);
    expect(corpo).toEqual({
      agentKey: "max",
      provider: "openrouter",
      model: "openai/gpt-5.4-nano",
      promptTokens: 164,
      completionTokens: 18,
      cacheReadTokens: 1792,
      cacheWriteTokens: 7,
      costUsd: 0.00010614,
      latencyMs: 3200,
      success: true,
      dealId: null,
    });
  });

  /**
   * `generationId` vive no `conversation_turn` daqui e NÃO faz parte do
   * contrato. O zod de lá não é `.strict()`, então mandá-lo seria descartado
   * em silêncio — descasamento que ninguém vê até precisar dele.
   */
  it("não vaza campo que o contrato não declara", async () => {
    const f = mockFetch();
    await reportUsage("org-1", { ...USO, generationId: "gen-abc" } as never);
    expect(JSON.parse(f.mock.calls[0][1].body)).not.toHaveProperty("generationId");
  });

  it("autentica com o token da org", async () => {
    const f = mockFetch();
    await reportUsage("org-1", USO);
    expect(f.mock.calls[0][1].headers.Authorization).toBe("Bearer tok-de-teste");
  });

  /**
   * O achado que motivou o `res.ok`: sem ele, um 400 resolve o `fetch`
   * normalmente e o `catch` nunca vê nada. A linha de custo some sem rastro.
   */
  it("recusa do outro lado é LOGADA, não engolida", async () => {
    const erro = espiarErro();
    mockFetch({ ok: false, status: 400, body: '{"error":"Bad Request"}' });

    await reportUsage("org-1", USO);

    expect(erro).toHaveBeenCalledTimes(1);
    const msg = erro.mock.calls[0].join(" ");
    expect(msg).toContain("400");
    expect(msg).toContain("PERDIDA");
  });

  /** Segue fire-and-forget: recusa não pode virar exceção no turn da pessoa. */
  it("recusa não lança", async () => {
    espiarErro();
    mockFetch({ ok: false, status: 500 });
    await expect(reportUsage("org-1", USO)).resolves.toBeUndefined();
  });

  it("sucesso não polui o log de erro", async () => {
    const erro = espiarErro();
    mockFetch();
    await reportUsage("org-1", USO);
    expect(erro).not.toHaveBeenCalled();
  });
});
