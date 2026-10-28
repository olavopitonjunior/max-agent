import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../meta", async (orig) => ({
  ...(await orig<typeof import("../meta")>()),
  sendText: vi.fn(),
  sendInteractive: vi.fn(),
  sendReaction: vi.fn(),
}));

const meta = await import("../meta");
const { MetaHttpError } = await import("../transport/erro");
const { sendReaction, sendText } = await import("../transport");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(meta.sendText).mockReset();
  vi.mocked(meta.sendInteractive).mockReset();
  vi.mocked(meta.sendReaction).mockReset();
});

describe("sendReaction (transporte)", () => {
  it("Meta: reage à mensagem e devolve true", async () => {
    vi.mocked(meta.sendReaction).mockResolvedValue({ messageId: "wamid.R" });
    await expect(sendReaction({ to: "5511999990000", messageId: "wamid.IN1", emoji: "✅" })).resolves.toBe(true);
    expect(meta.sendReaction).toHaveBeenCalledWith({ to: "5511999990000", messageId: "wamid.IN1", emoji: "✅" });
  });

  it("newton-bridge (reactions:false): false sem chamar a Meta", async () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    await expect(sendReaction({ to: "5511999990000", messageId: "wamid.IN1", emoji: "✅" })).resolves.toBe(false);
    expect(meta.sendReaction).not.toHaveBeenCalled();
  });

  it("transporte log (reactions:false): false", async () => {
    vi.stubEnv("AGENT_TRANSPORT", "log");
    await expect(sendReaction({ to: "5511999990000", messageId: "wamid.IN1", emoji: "✅" })).resolves.toBe(false);
    expect(meta.sendReaction).not.toHaveBeenCalled();
  });

  it("MAX_OUTBOUND_KILL=true: false, sem chamada", async () => {
    vi.stubEnv("MAX_OUTBOUND_KILL", "true");
    await expect(sendReaction({ to: "5511999990000", messageId: "wamid.IN1", emoji: "✅" })).resolves.toBe(false);
    expect(meta.sendReaction).not.toHaveBeenCalled();
  });

  it("Meta recusa (400): false, sem lançar", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(meta.sendReaction).mockRejectedValue(new MetaHttpError("/x/messages", 400, "{}"));
    await expect(sendReaction({ to: "5511999990000", messageId: "wamid.IN1", emoji: "✅" })).resolves.toBe(false);
    warn.mockRestore();
  });

  it("mensagem sintética ou vazia: false, sem chamada", async () => {
    await expect(sendReaction({ to: "5511999990000", messageId: "newton:abc", emoji: "✅" })).resolves.toBe(false);
    await expect(sendReaction({ to: "5511999990000", messageId: "", emoji: "✅" })).resolves.toBe(false);
    expect(meta.sendReaction).not.toHaveBeenCalled();
  });
});

describe("sendText com imagemUrl", () => {
  it("passa o interativo com imagemUrl intacto à Meta", async () => {
    vi.mocked(meta.sendInteractive).mockResolvedValue({ messageId: "wamid.I" });
    const interativo = {
      tipo: "botoes" as const,
      corpo: "c",
      imagemUrl: "https://x.test/i.png",
      opcoes: [{ id: "av:r:abrir", titulo: "Abrir" }],
    };
    await sendText({ to: "5511999990000", body: "c", interativo });
    expect(vi.mocked(meta.sendInteractive).mock.calls[0][0].interativo).toEqual(interativo);
  });
});
