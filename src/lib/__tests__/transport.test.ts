import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../meta", async (orig) => ({
  ...(await orig<typeof import("../meta")>()),
  sendText: vi.fn(),
  sendTemplate: vi.fn(),
  connectionStatus: vi.fn(),
  downloadMedia: vi.fn(),
}));

const meta = await import("../meta");
const { provider, capabilities, sendText, sendTemplate, connectionStatus, downloadMedia } =
  await import("../transport");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(meta.sendText).mockReset();
  vi.mocked(meta.sendTemplate).mockReset();
  vi.mocked(meta.connectionStatus).mockReset();
  vi.mocked(meta.downloadMedia).mockReset();
});

describe("provider", () => {
  it("ausente ou vazio é meta — só ela existe desde a migração", () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "");
    expect(provider()).toBe("meta");
    vi.stubEnv("WHATSAPP_PROVIDER", " META ");
    expect(provider()).toBe("meta");
  });

  /**
   * A Z-API foi cancelada em 10/09 e não há para onde cair: um valor
   * desconhecido na env não pode derrubar outbox/inbound/admin — só avisar.
   */
  it("valor desconhecido não lança — devolve meta e avisa (uma vez)", async () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "zapi");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Módulo novo: o aviso é uma vez POR PROCESSO, e outro teste já o consumiu.
    vi.resetModules();
    const fresco = await import("../transport");
    expect(fresco.provider()).toBe("meta");
    expect(fresco.provider()).toBe("meta");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(provider()).toBe("meta");
    vi.mocked(meta.sendText).mockResolvedValue({ messageId: "M1" });
    expect(await sendText({ to: "5511999990000", body: "oi" })).toEqual({ messageId: "M1" });
    vi.mocked(meta.connectionStatus).mockResolvedValue({ connected: true, raw: {} });
    expect(await connectionStatus()).toEqual({ connected: true, raw: {} });
    warn.mockRestore();
  });
});

describe("sendText", () => {
  it("repassa os parâmetros e devolve o que a Meta mandou", async () => {
    vi.mocked(meta.sendText).mockResolvedValue({ messageId: "wamid.M1" });
    const res = await sendText({ to: "5511999990000", body: "oi", quoteMessageId: "Q" });
    expect(meta.sendText).toHaveBeenCalledWith({
      to: "5511999990000",
      body: "oi",
      quoteMessageId: "Q",
    });
    expect(res).toEqual({ messageId: "wamid.M1" });
  });

  it("erro do provedor atravessa intacto — outbox e inbound classificam a inoperância por ele", async () => {
    const erro = new Error("Meta /123/messages 400: subscribe");
    vi.mocked(meta.sendText).mockRejectedValue(erro);
    await expect(sendText({ to: "1", body: "x" })).rejects.toBe(erro);
  });
});

describe("sendTemplate e downloadMedia", () => {
  it("sendTemplate repassa para a Meta", async () => {
    vi.mocked(meta.sendTemplate).mockResolvedValue({ messageId: "wamid.T1" });
    const res = await sendTemplate({
      to: "5511999990000",
      name: "max_formulario_concluido",
      lang: "pt_BR",
      bodyParams: ["Ana"],
      botoes: [],
    });
    expect(meta.sendTemplate).toHaveBeenCalledOnce();
    expect(res).toEqual({ messageId: "wamid.T1" });
  });

  it("downloadMedia repassa a referência para a Meta", async () => {
    vi.mocked(meta.downloadMedia).mockResolvedValue({ data: Buffer.from("x"), contentType: "image/jpeg" });
    await downloadMedia("meta:MEDIA1");
    expect(meta.downloadMedia).toHaveBeenCalledWith("meta:MEDIA1");
  });
});

/**
 * O adapter sai do perfil de deploy (`AGENT_DEPLOY_PROFILE`), com
 * `AGENT_TRANSPORT=log` como desvio para playground e staging. Perfil ausente
 * continua sendo a Meta, com as mesmas capacidades de antes.
 */
describe("adapter pelo perfil", () => {
  it("perfil ausente: meta, com template e janela de 24h", () => {
    expect(provider()).toBe("meta");
    expect(capabilities()).toEqual({
      templates: true,
      window24h: true,
      media: true,
      groups: false,
      status: true,
    });
  });

  it("AGENT_TRANSPORT=log: sendText não chama a Meta e devolve id log-", async () => {
    vi.stubEnv("AGENT_TRANSPORT", " LOG ");
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await sendText({ to: "5511999990000", body: "oi" });
    expect(meta.sendText).not.toHaveBeenCalled();
    expect(res.messageId).toMatch(/^log-[0-9a-f-]{36}$/);
    expect(provider()).toBe("log");
    expect(capabilities().window24h).toBe(false);
    expect(capabilities().templates).toBe(false);
    expect(await connectionStatus()).toEqual({ connected: true, raw: { adapter: "log" } });
    expect(await downloadMedia("meta:X")).toBeNull();
    info.mockRestore();
  });

  it("log sem template: sendTemplate lança transport_sem_template", async () => {
    vi.stubEnv("AGENT_TRANSPORT", "log");
    await expect(
      sendTemplate({ to: "1", name: "x", lang: "pt_BR", bodyParams: [], botoes: [] })
    ).rejects.toThrow("transport_sem_template");
    expect(meta.sendTemplate).not.toHaveBeenCalled();
  });

  it("log recusado em produção", async () => {
    vi.stubEnv("AGENT_TRANSPORT", "log");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(() => provider()).toThrow("transport_log_em_producao");
    await expect(sendText({ to: "1", body: "x" })).rejects.toThrow("transport_log_em_producao");
  });

  it("log sem VERCEL_ENV num processo de produção também é recusado (fail-closed)", () => {
    vi.stubEnv("AGENT_TRANSPORT", "log");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => provider()).toThrow("transport_log_em_producao");
  });

  it("log vale em preview e em desenvolvimento local", () => {
    vi.stubEnv("AGENT_TRANSPORT", "log");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NODE_ENV", "production");
    expect(provider()).toBe("log");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(provider()).toBe("log");
  });

  it("AGENT_TRANSPORT desconhecido lança transport_invalido", () => {
    vi.stubEnv("AGENT_TRANSPORT", "zapi");
    expect(() => provider()).toThrow("transport_invalido");
  });

  it("perfil newton vai ao bridge, sem template e sem cair na Meta", async () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    vi.stubEnv("NEWTON_BRIDGE_URL", "");
    expect(provider()).toBe("newton-bridge");
    expect(capabilities().window24h).toBe(false);
    await expect(sendText({ to: "5511999990000", body: "x" })).rejects.toThrow("newton_bridge_nao_configurado");
    await expect(
      sendTemplate({ to: "5511999990000", name: "t", lang: "pt_BR", bodyParams: [], botoes: [] })
    ).rejects.toThrow("transport_sem_template");
    expect(meta.sendText).not.toHaveBeenCalled();
  });

  it("kill switch vem antes do adapter", async () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    vi.stubEnv("MAX_OUTBOUND_KILL", "true");
    await expect(sendText({ to: "1", body: "x" })).rejects.toThrow("outbound_disabled");
  });
});
