import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizarWaId,
  connectionStatus,
  downloadMedia,
  isExpectedPhoneNumber,
  parseWebhook,
  sendText,
  verifyChallenge,
  verifySignature,
} from "../meta";

/**
 * Os payloads seguem o formato DOCUMENTADO da Cloud API (webhooks → messages),
 * não o que o parser espera: `object`, `entry[].changes[].value` com
 * `metadata`, `contacts`, `messages` e `statuses`. Um mock derivado do código
 * faria a suíte concordar com o defeito.
 */
const PNID = "123456789012345";

function webhook(value: Record<string, unknown>, field = "messages") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field,
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "5511970850046", phone_number_id: PNID },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

const contato = (wa_id: string, name: string) => ({ profile: { name }, wa_id });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("parseWebhook — mensagens", () => {
  it("texto: remetente, id, instante em ms, nome do perfil e citação", () => {
    const ev = parseWebhook(
      webhook({
        contacts: [contato("5511987654321", "Ana Corretora")],
        messages: [
          {
            from: "5511987654321",
            id: "wamid.AAA",
            timestamp: "1758549600",
            type: "text",
            text: { body: "cria um form de venda" },
            context: { from: "5511970850046", id: "wamid.CITADA" },
          },
        ],
      })
    );
    expect(ev.phoneNumberIds).toEqual([PNID]);
    expect(ev.messages).toEqual([
      {
        messageId: "wamid.AAA",
        fromPhone: "5511987654321",
        groupId: null,
        kind: "text",
        text: "cria um form de venda",
        mediaUrl: null,
        mimeType: null,
        timestampMs: 1758549600000,
        senderName: "Ana Corretora",
        replyToMessageId: "wamid.CITADA",
      },
    ]);
  });

  it("mídia vira referência opaca `meta:<id>` — nunca uma URL", () => {
    const ev = parseWebhook(
      webhook({
        messages: [
          {
            from: "5511987654321",
            id: "wamid.AUD",
            timestamp: "1758549600",
            type: "audio",
            audio: { mime_type: "audio/ogg; codecs=opus", sha256: "x", id: "MEDIA1", voice: true },
          },
          {
            from: "5511987654321",
            id: "wamid.IMG",
            timestamp: "1758549601",
            type: "image",
            image: { caption: "matrícula", mime_type: "image/jpeg", sha256: "y", id: "MEDIA2" },
          },
          {
            from: "5511987654321",
            id: "wamid.DOC",
            timestamp: "1758549602",
            type: "document",
            document: { filename: "rg.pdf", mime_type: "application/pdf", sha256: "z", id: "MEDIA3" },
          },
        ],
      })
    );
    expect(ev.messages.map((m) => [m.kind, m.mediaUrl, m.mimeType, m.text])).toEqual([
      ["audio", "meta:MEDIA1", "audio/ogg; codecs=opus", null],
      ["image", "meta:MEDIA2", "image/jpeg", "matrícula"],
      ["document", "meta:MEDIA3", "application/pdf", "rg.pdf"],
    ]);
  });

  it("toque em botão de template e resposta interativa viram texto", () => {
    const ev = parseWebhook(
      webhook({
        messages: [
          {
            from: "5511987654321",
            id: "wamid.BTN",
            timestamp: "1758549600",
            type: "button",
            button: { payload: "SIM", text: "Sim" },
          },
          {
            from: "5511987654321",
            id: "wamid.INT",
            timestamp: "1758549601",
            type: "interactive",
            interactive: { type: "button_reply", button_reply: { id: "b1", title: "Venda" } },
          },
        ],
      })
    );
    expect(ev.messages.map((m) => [m.kind, m.text])).toEqual([
      ["text", "Sim"],
      ["text", "Venda"],
    ]);
  });

  it("reação, sticker e grupo não viram mensagem", () => {
    const ev = parseWebhook(
      webhook({
        messages: [
          {
            from: "5511987654321",
            id: "wamid.R",
            timestamp: "1",
            type: "reaction",
            reaction: { message_id: "wamid.X", emoji: "👍" },
          },
          { from: "5511987654321", id: "wamid.S", timestamp: "1", type: "sticker", sticker: { id: "M" } },
          {
            from: "5511987654321",
            id: "wamid.G",
            timestamp: "1",
            type: "text",
            group_id: "GRUPO",
            text: { body: "oi grupo" },
          },
        ],
      })
    );
    expect(ev.messages).toEqual([]);
  });

  it("tipo sem suporte vira `unknown` (o grafo responde que não entendeu, não cala)", () => {
    const ev = parseWebhook(
      webhook({
        messages: [
          {
            from: "5511987654321",
            id: "wamid.LOC",
            timestamp: "1",
            type: "location",
            location: { latitude: -23.5, longitude: -46.6 },
          },
        ],
      })
    );
    expect(ev.messages[0]).toMatchObject({ kind: "unknown", text: null, mediaUrl: null });
  });

  it("outro objeto ou outro campo não produz nada", () => {
    expect(parseWebhook({ object: "page", entry: [] }).phoneNumberIds).toEqual([]);
    const outroCampo = parseWebhook(webhook({ event: "APPROVED" }, "message_template_status_update"));
    expect(outroCampo).toEqual({ phoneNumberIds: [], messages: [], statuses: [], failures: [] });
    expect(parseWebhook(null).messages).toEqual([]);
  });
});

describe("parseWebhook — status de entrega", () => {
  it("sent/delivered/read viram StatusCallback com o instante em ms", () => {
    const ev = parseWebhook(
      webhook({
        statuses: [
          { id: "wamid.OUT1", status: "sent", timestamp: "1758549600", recipient_id: "5511987654321" },
          { id: "wamid.OUT1", status: "delivered", timestamp: "1758549605", recipient_id: "5511987654321" },
          { id: "wamid.OUT1", status: "read", timestamp: "1758549610", recipient_id: "5511987654321" },
        ],
      })
    );
    expect(ev.statuses).toEqual([
      { status: "sent", messageIds: ["wamid.OUT1"], phone: "5511987654321", momment: 1758549600000 },
      { status: "delivered", messageIds: ["wamid.OUT1"], phone: "5511987654321", momment: 1758549605000 },
      { status: "read", messageIds: ["wamid.OUT1"], phone: "5511987654321", momment: 1758549610000 },
    ]);
    expect(ev.failures).toEqual([]);
  });

  it("failed traz o código da Meta — é o 131047 que chega DEPOIS de um envio aceito", () => {
    const ev = parseWebhook(
      webhook({
        statuses: [
          {
            id: "wamid.OUT2",
            status: "failed",
            timestamp: "1758549600",
            recipient_id: "5511987654321",
            errors: [
              {
                code: 131047,
                title: "Re-engagement message",
                message: "Re-engagement message",
                error_data: { details: "Message failed to send because more than 24 hours have passed" },
              },
            ],
          },
        ],
      })
    );
    expect(ev.failures).toEqual([{ messageId: "wamid.OUT2", code: 131047, title: "Re-engagement message" }]);
  });
});

describe("canonicalizarWaId — 9º dígito", () => {
  it("celular BR sem o 9 ganha o 9; com 9, fixo e estrangeiro não mudam", () => {
    expect(canonicalizarWaId("551187654321")).toBe("5511987654321");
    expect(canonicalizarWaId("5511987654321")).toBe("5511987654321");
    expect(canonicalizarWaId("551133334444")).toBe("551133334444"); // fixo
    expect(canonicalizarWaId("14155550123")).toBe("14155550123");
  });

  it("o parser aplica: a mesma pessoa não abre conversa paralela", () => {
    const ev = parseWebhook(
      webhook({
        contacts: [contato("551187654321", "Ana")],
        messages: [{ from: "551187654321", id: "w", timestamp: "1", type: "text", text: { body: "oi" } }],
      })
    );
    expect(ev.messages[0].fromPhone).toBe("5511987654321");
    // O nome é casado pelo wa_id ORIGINAL, antes de canonicalizar.
    expect(ev.messages[0].senderName).toBe("Ana");
  });
});

describe("verifySignature", () => {
  const corpo = JSON.stringify(webhook({ messages: [] }));
  const assinar = (s: string, body = corpo) =>
    `sha256=${createHmac("sha256", s).update(body, "utf8").digest("hex")}`;

  it("aceita a assinatura do app secret sobre o corpo CRU", () => {
    vi.stubEnv("META_APP_SECRET", "segredo");
    expect(verifySignature(corpo, assinar("segredo"))).toBe(true);
  });

  it("recusa segredo errado, corpo alterado, cabeçalho ausente ou sem prefixo", () => {
    vi.stubEnv("META_APP_SECRET", "segredo");
    expect(verifySignature(corpo, assinar("outro"))).toBe(false);
    expect(verifySignature(corpo + " ", assinar("segredo"))).toBe(false);
    expect(verifySignature(corpo, null)).toBe(false);
    expect(verifySignature(corpo, assinar("segredo").slice("sha256=".length))).toBe(false);
    expect(verifySignature(corpo, "sha256=zz")).toBe(false);
  });

  /** O bridge do Newton aceitava tudo sem secret ("DEV ONLY"). Aqui não. */
  it("FAIL-CLOSED: sem META_APP_SECRET nada passa, nem assinatura 'válida' de string vazia", () => {
    vi.stubEnv("META_APP_SECRET", "");
    expect(verifySignature(corpo, assinar(""))).toBe(false);
  });
});

describe("verifyChallenge", () => {
  const qs = (o: Record<string, string>) => new URLSearchParams(o);

  it("devolve o challenge quando modo e token conferem", () => {
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "tok");
    expect(
      verifyChallenge(qs({ "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "42" }))
    ).toBe("42");
  });

  it("null com token errado, modo errado ou sem token configurado", () => {
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "tok");
    expect(verifyChallenge(qs({ "hub.mode": "subscribe", "hub.verify_token": "x", "hub.challenge": "1" }))).toBeNull();
    expect(verifyChallenge(qs({ "hub.mode": "unsubscribe", "hub.verify_token": "tok", "hub.challenge": "1" }))).toBeNull();
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "");
    expect(verifyChallenge(qs({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" }))).toBeNull();
  });
});

describe("isExpectedPhoneNumber", () => {
  it("só o nosso phone_number_id, e todos os do lote", () => {
    vi.stubEnv("META_PHONE_NUMBER_ID", PNID);
    expect(isExpectedPhoneNumber([PNID])).toBe(true);
    expect(isExpectedPhoneNumber([PNID, "outro"])).toBe(false);
    expect(isExpectedPhoneNumber([])).toBe(false);
    vi.stubEnv("META_PHONE_NUMBER_ID", "");
    expect(isExpectedPhoneNumber([PNID])).toBe(false);
  });
});

describe("chamadas à Graph API", () => {
  const fetchMock = vi.fn();
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("META_ACCESS_TOKEN", "TOKEN");
    vi.stubEnv("META_PHONE_NUMBER_ID", PNID);
    vi.stubEnv("META_GRAPH_VERSION", "");
  });

  it("sendText: POST /{pnid}/messages com Bearer, sem preview, com citação; devolve o wamid", async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        messaging_product: "whatsapp",
        contacts: [{ input: "5511987654321", wa_id: "5511987654321" }],
        messages: [{ id: "wamid.NOVO" }],
      })
    );
    const res = await sendText({ to: "5511987654321", body: "oi", quoteMessageId: "wamid.Q" });
    expect(res).toEqual({ messageId: "wamid.NOVO" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://graph.facebook.com/v24.0/${PNID}/messages`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "5511987654321",
      type: "text",
      text: { body: "oi", preview_url: false },
      context: { message_id: "wamid.Q" },
    });
  });

  it("sendText: erro vira MetaHttpError com o código — é ele que classifica canal × mensagem", async () => {
    fetchMock.mockResolvedValue(
      json(401, { error: { message: "Error validating access token", type: "OAuthException", code: 190 } })
    );
    await expect(sendText({ to: "5511987654321", body: "oi" })).rejects.toMatchObject({
      name: "MetaHttpError",
      status: 401,
      code: 190,
    });
  });

  it("META_GRAPH_VERSION antecipa a troca de versão", async () => {
    vi.stubEnv("META_GRAPH_VERSION", "v26.0");
    fetchMock.mockResolvedValue(json(200, { messages: [{ id: "w" }] }));
    await sendText({ to: "1", body: "x" });
    expect(fetchMock.mock.calls[0][0]).toContain("/v26.0/");
  });

  describe("connectionStatus", () => {
    it("CONNECTED é conectado — e qualidade VERMELHA não derruba o canal", async () => {
      fetchMock.mockResolvedValue(json(200, { status: "CONNECTED", quality_rating: "RED", id: PNID }));
      const s = await connectionStatus();
      expect(s.connected).toBe(true);
      expect(s.inoperante).toBeUndefined();
      expect(fetchMock.mock.calls[0][0]).toContain(`/${PNID}?fields=status,quality_rating`);
    });

    it("status diferente de CONNECTED é inoperante por NÚMERO", async () => {
      fetchMock.mockResolvedValue(json(200, { status: "RESTRICTED", quality_rating: "RED" }));
      const s = await connectionStatus();
      expect(s.connected).toBe(false);
      expect(s.inoperante).toMatchObject({ motivo: "numero" });
      expect(s.inoperante?.detalhe).toContain("RESTRICTED");
    });

    it("token recusado é inoperante por CREDENCIAL, não exceção", async () => {
      fetchMock.mockResolvedValue(json(401, { error: { code: 190, message: "expired" } }));
      const s = await connectionStatus();
      expect(s).toMatchObject({ connected: false, inoperante: { motivo: "credencial" } });
    });

    it("5xx e formato desconhecido LANÇAM — 'não consegui perguntar', nunca 'desconectado'", async () => {
      fetchMock.mockResolvedValue(json(500, { error: { code: 1, message: "unknown" } }));
      await expect(connectionStatus()).rejects.toThrow();
      fetchMock.mockResolvedValue(json(200, { id: PNID }));
      await expect(connectionStatus()).rejects.toThrow(/sem campo status/);
    });
  });

  describe("downloadMedia", () => {
    it("dois passos, os dois com o token", async () => {
      fetchMock
        .mockResolvedValueOnce(
          json(200, { url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", mime_type: "audio/ogg", file_size: 10, id: "MEDIA1" })
        )
        .mockResolvedValueOnce(new Response(Buffer.from("OGGDATA"), { status: 200, headers: { "content-type": "audio/ogg" } }));
      const r = await downloadMedia("meta:MEDIA1");
      expect(r?.data.toString()).toBe("OGGDATA");
      expect(r?.contentType).toBe("audio/ogg");
      expect(fetchMock.mock.calls[0][0]).toBe("https://graph.facebook.com/v24.0/MEDIA1");
      expect(fetchMock.mock.calls[1][0]).toContain("lookaside.fbsbx.com");
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer TOKEN");
    });

    it("recusa pelo file_size declarado sem baixar o corpo", async () => {
      fetchMock.mockResolvedValueOnce(json(200, { url: "https://x", file_size: 20 * 1024 * 1024 }));
      expect(await downloadMedia("meta:BIG")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("referência que não é da Meta, ou erro, é null — mídia é melhor-esforço", async () => {
      expect(await downloadMedia("https://api.z-api.io/arquivo.ogg")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      fetchMock.mockResolvedValueOnce(json(404, { error: { code: 100 } }));
      expect(await downloadMedia("meta:SUMIU")).toBeNull();
    });
  });
});
