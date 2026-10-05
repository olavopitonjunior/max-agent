import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * O aceite roda ANTES da identidade e do modelo. Sem esta trava, tirar a
 * chamada de `runTurn` passaria com a suíte inteira verde (achado do code
 * review): os testes do aceite provam `interceptar`, não que ele é chamado.
 */

vi.mock("@/lib/aceite", () => ({ interceptar: vi.fn(), repassarDesconhecido: vi.fn() }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  resolveIdentity: vi.fn().mockResolvedValue({ kind: "unknown", alreadyGreeted: true }),
}));
vi.mock("@/lib/turnlog", async (orig) => ({
  ...(await orig<typeof import("@/lib/turnlog")>()),
  registrarTurn: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/llm", () => ({
  DEFAULT_MODEL: "m",
  complete: vi.fn(),
}));

const { runTurn } = await import("../graph");
const { interceptar, repassarDesconhecido } = await import("@/lib/aceite");
const { resolveIdentity } = await import("@/lib/identity");
const { complete } = await import("@/lib/llm");

const intercepta = interceptar as unknown as ReturnType<typeof vi.fn>;
const repassa = repassarDesconhecido as unknown as ReturnType<typeof vi.fn>;
const identidade = resolveIdentity as unknown as ReturnType<typeof vi.fn>;

const MSG = {
  messageId: "wamid.T1",
  fromPhone: "5511900004444",
  groupId: null,
  kind: "text" as const,
  text: "ok",
  mediaUrl: null,
  mimeType: null,
  timestampMs: null,
  senderName: "Carlos",
  replyToMessageId: null,
  buttonPayload: "ok:row1",
};

describe("runTurn × aceite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repassa.mockResolvedValue(null);
  });

  it("interceptado: responde o que o aceite devolveu sem identidade nem modelo", async () => {
    intercepta.mockResolvedValue({ reply: "*Mensagem da X*\n\noi", orgId: "org1", marca: "aceite_entregue" });
    const r = await runTurn(MSG);
    expect(intercepta).toHaveBeenCalledWith(MSG);
    expect(r.reply).toBe("*Mensagem da X*\n\noi");
    expect(identidade).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("não interceptado: segue para a identidade", async () => {
    intercepta.mockResolvedValue(null);
    await runTurn(MSG);
    expect(identidade).toHaveBeenCalledTimes(1);
  });

  /**
   * Desconhecido que insiste (já apresentado): o repasse é chamado, e a
   * resposta dele vai para a pessoa. Sem esta trava, tirar a chamada do
   * `runTurn` passaria com os testes do `repassarDesconhecido` verdes.
   */
  it("desconhecido já apresentado: com repasse, responde; sem repasse, silêncio", async () => {
    intercepta.mockResolvedValue(null);
    repassa.mockResolvedValueOnce({ reply: "Passei sua mensagem para a nossa equipe.", marca: "desconhecido_repassado" });
    const r1 = await runTurn({ ...MSG, text: "quero falar com o Fabio", buttonPayload: null });
    expect(repassa).toHaveBeenCalledTimes(1);
    expect(r1.reply).toBe("Passei sua mensagem para a nossa equipe.");

    const r2 = await runTurn({ ...MSG, messageId: "wamid.T2", text: "alô?", buttonPayload: null });
    expect(r2.reply).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("repasse que lança não derruba o turno: silêncio", async () => {
    intercepta.mockResolvedValue(null);
    repassa.mockRejectedValueOnce(new Error("banco fora"));
    const r = await runTurn({ ...MSG, text: "oi", buttonPayload: null });
    expect(r.reply).toBeNull();
  });
});
