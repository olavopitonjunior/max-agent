import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../zapi", () => ({
  sendText: vi.fn(),
  connectionStatus: vi.fn(),
  downloadMedia: vi.fn(),
}));
vi.mock("../meta", async (orig) => ({
  ...(await orig<typeof import("../meta")>()),
  sendText: vi.fn(),
  connectionStatus: vi.fn(),
  downloadMedia: vi.fn(),
}));

const zapi = await import("../zapi");
const meta = await import("../meta");
const { provider, sendText, connectionStatus, downloadMedia } = await import("../transport");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(zapi.sendText).mockReset();
  vi.mocked(zapi.connectionStatus).mockReset();
  vi.mocked(zapi.downloadMedia).mockReset();
  vi.mocked(meta.sendText).mockReset();
  vi.mocked(meta.connectionStatus).mockReset();
  vi.mocked(meta.downloadMedia).mockReset();
});

describe("provider", () => {
  it("ausente ou vazio é zapi — o único canal que existia antes da migração", () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "");
    expect(provider()).toBe("zapi");
    vi.stubEnv("WHATSAPP_PROVIDER", " ZAPI ");
    expect(provider()).toBe("zapi");
  });

  /**
   * Um erro de digitação na env não pode virar "cai no default": na migração,
   * o default é justamente o canal que foi desligado.
   */
  it("valor desconhecido lança, e nenhuma chamada chega ao provedor", async () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "zpai");
    expect(() => provider()).toThrow(/WHATSAPP_PROVIDER inválido/);
    await expect(sendText({ to: "5511999990000", body: "oi" })).rejects.toThrow(
      /WHATSAPP_PROVIDER inválido/
    );
    await expect(connectionStatus()).rejects.toThrow(/WHATSAPP_PROVIDER inválido/);
    await expect(downloadMedia("https://x")).rejects.toThrow(/WHATSAPP_PROVIDER inválido/);
    expect(zapi.sendText).not.toHaveBeenCalled();
    expect(zapi.connectionStatus).not.toHaveBeenCalled();
    expect(zapi.downloadMedia).not.toHaveBeenCalled();
  });
});

describe("sendText", () => {
  it("repassa os parâmetros e devolve o id já normalizado", async () => {
    vi.mocked(zapi.sendText).mockResolvedValue({ messageId: "M1", zaapId: "Z1", id: "I1" });
    const res = await sendText({ to: "5511999990000", body: "oi", quoteMessageId: "Q" });
    expect(zapi.sendText).toHaveBeenCalledWith({
      to: "5511999990000",
      body: "oi",
      quoteMessageId: "Q",
    });
    expect(res).toEqual({ messageId: "M1" });
  });

  it("sem messageId usa o id; sem nenhum, null — nunca o zaapId", async () => {
    vi.mocked(zapi.sendText).mockResolvedValue({ zaapId: "Z1", id: "I1" });
    expect(await sendText({ to: "1", body: "x" })).toEqual({ messageId: "I1" });
    vi.mocked(zapi.sendText).mockResolvedValue({ zaapId: "Z1" });
    expect(await sendText({ to: "1", body: "x" })).toEqual({ messageId: null });
  });

  it("erro do provedor atravessa intacto — outbox e inbound classificam a inoperância por ele", async () => {
    const erro = new Error("Z-API /send-text 400: subscribe");
    vi.mocked(zapi.sendText).mockRejectedValue(erro);
    await expect(sendText({ to: "1", body: "x" })).rejects.toBe(erro);
  });
});

describe("provedor meta", () => {
  it("WHATSAPP_PROVIDER=meta manda envio e status para a Meta, e nada para a Z-API", async () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "Meta");
    expect(provider()).toBe("meta");
    vi.mocked(meta.sendText).mockResolvedValue({ messageId: "wamid.X" });
    vi.mocked(meta.connectionStatus).mockResolvedValue({ connected: true, raw: {} });

    expect(await sendText({ to: "5511999990000", body: "oi" })).toEqual({ messageId: "wamid.X" });
    expect(await connectionStatus()).toEqual({ connected: true, raw: {} });
    expect(zapi.sendText).not.toHaveBeenCalled();
    expect(zapi.connectionStatus).not.toHaveBeenCalled();
  });

  /**
   * No minuto do cutover a fila pode ter uma mensagem da Z-API (URL pública)
   * esperando: ela tem que baixar pela Z-API mesmo com o provedor já em Meta.
   */
  it("mídia é roteada pela REFERÊNCIA, não pela env", async () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "meta");
    await downloadMedia("meta:MEDIA1");
    await downloadMedia("https://storage.z-api.io/arquivo.ogg");
    expect(meta.downloadMedia).toHaveBeenCalledWith("meta:MEDIA1");
    expect(zapi.downloadMedia).toHaveBeenCalledWith("https://storage.z-api.io/arquivo.ogg");

    vi.stubEnv("WHATSAPP_PROVIDER", "");
    await downloadMedia("meta:MEDIA2");
    expect(meta.downloadMedia).toHaveBeenCalledWith("meta:MEDIA2");
  });
});
