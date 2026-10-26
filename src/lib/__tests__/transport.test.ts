import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../meta", async (orig) => ({
  ...(await orig<typeof import("../meta")>()),
  sendText: vi.fn(),
  sendTemplate: vi.fn(),
  sendInteractive: vi.fn(),
  connectionStatus: vi.fn(),
  downloadMedia: vi.fn(),
  markReadTyping: vi.fn(),
}));

const meta = await import("../meta");
const { MetaHttpError } = await import("../transport/erro");
const { provider, capabilities, sendText, sendTemplate, connectionStatus, downloadMedia, markReadTyping } =
  await import("../transport");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(meta.sendText).mockReset();
  vi.mocked(meta.sendTemplate).mockReset();
  vi.mocked(meta.sendInteractive).mockReset();
  vi.mocked(meta.connectionStatus).mockReset();
  vi.mocked(meta.downloadMedia).mockReset();
  vi.mocked(meta.markReadTyping).mockReset();
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

describe("sendText com interativo", () => {
  const interativo = {
    tipo: "botoes" as const,
    corpo: "Responda SIM para confirmar ou NÃO para parar.",
    opcoes: [{ id: "op:SIM", titulo: "SIM" }, { id: "op:NÃO", titulo: "NÃO" }],
  };
  const params = { to: "5511999990000", body: "texto numerado", quoteMessageId: "Q", interativo };

  it("na Meta vai como botões, com a citação, e não manda o texto", async () => {
    vi.mocked(meta.sendInteractive).mockResolvedValue({ messageId: "wamid.I" });
    expect(await sendText(params)).toEqual({ messageId: "wamid.I" });
    expect(meta.sendInteractive).toHaveBeenCalledWith({ to: "5511999990000", interativo, quoteMessageId: "Q" });
    expect(meta.sendText).not.toHaveBeenCalled();
  });

  it("MAX_INTERACTIVE=off manda o texto numerado", async () => {
    vi.stubEnv("MAX_INTERACTIVE", "off");
    vi.mocked(meta.sendText).mockResolvedValue({ messageId: "wamid.T" });
    await sendText(params);
    expect(meta.sendInteractive).not.toHaveBeenCalled();
    expect(meta.sendText).toHaveBeenCalledWith({ to: "5511999990000", body: "texto numerado", quoteMessageId: "Q" });
  });

  it.each([131056, 130429, 131048, 131005])("400 com código de vazão/conta/restrição (%i) não cai no texto: relança", async (code) => {
    const erro = new MetaHttpError("/1/messages", 400, JSON.stringify({ error: { code } }));
    vi.mocked(meta.sendInteractive).mockRejectedValue(erro);
    await expect(sendText(params)).rejects.toBe(erro);
    expect(meta.sendText).not.toHaveBeenCalled();
  });

  it("400 da Meta (forma recusada, nada entregue) cai no texto numerado", async () => {
    vi.mocked(meta.sendInteractive).mockRejectedValue(new MetaHttpError("/1/messages", 400, '{"error":{"code":131009}}'));
    vi.mocked(meta.sendText).mockResolvedValue({ messageId: "wamid.T" });
    expect(await sendText(params)).toEqual({ messageId: "wamid.T" });
    expect(meta.sendText).toHaveBeenCalledWith({ to: "5511999990000", body: "texto numerado", quoteMessageId: "Q" });
  });

  it("5xx ou timeout NÃO cai no texto — pode ter sido aceito; a fila decide", async () => {
    const erro = new MetaHttpError("/1/messages", 503, "");
    vi.mocked(meta.sendInteractive).mockRejectedValue(erro);
    await expect(sendText(params)).rejects.toBe(erro);
    const timeout = new Error("timeout");
    vi.mocked(meta.sendInteractive).mockRejectedValue(timeout);
    await expect(sendText(params)).rejects.toBe(timeout);
    expect(meta.sendText).not.toHaveBeenCalled();
  });

  it("transporte sem botão (log) manda só o texto", async () => {
    vi.stubEnv("AGENT_TRANSPORT", "log");
    const res = await sendText(params);
    expect(res.messageId).toMatch(/^log-/);
    expect(meta.sendInteractive).not.toHaveBeenCalled();
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
      typing: true,
      interactive: true,
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

/**
 * `markReadTyping` do transporte: só onde há capacidade, só com id real, e
 * nunca lança — é cortesia de UX no caminho quente do inbound.
 */
describe("markReadTyping", () => {
  it("meta: chama o adapter com o id e devolve o resultado", async () => {
    vi.mocked(meta.markReadTyping).mockResolvedValue(true);
    expect(await markReadTyping("wamid.IN1")).toBe(true);
    expect(meta.markReadTyping).toHaveBeenCalledOnce();
    expect(meta.markReadTyping).toHaveBeenCalledWith("wamid.IN1");
  });

  it("newton-bridge (typing=false): não chama a Meta", async () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    expect(await markReadTyping("wamid.IN1")).toBe(false);
    expect(meta.markReadTyping).not.toHaveBeenCalled();
  });

  it("transporte log (typing=false): não chama a Meta", async () => {
    vi.stubEnv("AGENT_TRANSPORT", "log");
    expect(await markReadTyping("wamid.IN1")).toBe(false);
    expect(meta.markReadTyping).not.toHaveBeenCalled();
  });

  it("MAX_TYPING_INDICATOR=off desliga (qualquer caixa); ausente liga", async () => {
    vi.mocked(meta.markReadTyping).mockResolvedValue(true);
    vi.stubEnv("MAX_TYPING_INDICATOR", "off");
    expect(await markReadTyping("wamid.IN1")).toBe(false);
    vi.stubEnv("MAX_TYPING_INDICATOR", " OFF ");
    expect(await markReadTyping("wamid.IN1")).toBe(false);
    expect(meta.markReadTyping).not.toHaveBeenCalled();
    vi.stubEnv("MAX_TYPING_INDICATOR", "");
    expect(await markReadTyping("wamid.IN1")).toBe(true);
  });

  it.each(["newton:abc123", "playground-req1", "human-req1", ""])(
    "id sintético/vazio %j não chama a Meta",
    async (id) => {
      expect(await markReadTyping(id)).toBe(false);
      expect(meta.markReadTyping).not.toHaveBeenCalled();
    }
  );

  it("adapter que lança: false, sem propagar", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(meta.markReadTyping).mockRejectedValue(new Error("boom"));
    await expect(markReadTyping("wamid.IN1")).resolves.toBe(false);
    warn.mockRestore();
  });

  it("transporte inválido (adapter() lança): false, sem propagar", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AGENT_TRANSPORT", "zapi");
    await expect(markReadTyping("wamid.IN1")).resolves.toBe(false);
    warn.mockRestore();
  });
});
