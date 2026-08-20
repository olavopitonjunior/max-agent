import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseInbound,
  parseStatusCallback,
  isGroupJid,
  sendText,
  sendAudio,
  connectionStatus,
} from "../zapi";

/**
 * O parser existe porque o payload da Z-API tem defeitos que já custaram
 * investigação em produção. Cada teste aqui corresponde a um deles.
 */
describe("parseInbound", () => {
  const base = {
    instanceId: "INST",
    messageId: "3EB0",
    phone: "5511999063228",
    momment: 1_800_000_000_000,
    senderName: "Olavo",
  };

  it("extrai texto de DM", () => {
    const m = parseInbound({ ...base, text: { message: "oi" } });
    expect(m).toMatchObject({
      messageId: "3EB0",
      fromPhone: "5511999063228",
      groupId: null,
      kind: "text",
      text: "oi",
      timestampMs: 1_800_000_000_000,
    });
  });

  /**
   * Armadilha nº 1: com "notificar mensagens enviadas por mim" ligado no
   * painel, cada resposta do agente volta como mensagem nova. Sem este corte o
   * bot conversa sozinho até o rate limit.
   */
  it("descarta o eco das próprias mensagens (fromMe)", () => {
    expect(parseInbound({ ...base, fromMe: true, text: { message: "eco" } })).toBeNull();
  });

  /**
   * Armadilha nº 2: em grupo, `phone` é o JID do GRUPO. Ler `phone` como
   * remetente atribuiria a mensagem ao grupo inteiro.
   */
  it("em grupo, o remetente é participantPhone — não `phone`", () => {
    const m = parseInbound({
      ...base,
      phone: "120363407415575253-group",
      isGroup: true,
      participantPhone: "5511987654321",
      text: { message: "e aí" },
    });
    expect(m).toMatchObject({
      groupId: "120363407415575253-group",
      fromPhone: "5511987654321",
    });
  });

  /**
   * A mesma URL pode receber outros callbacks se os campos do painel forem
   * apontados errado. Status de entrega tem `phone` e `messageId` e passaria
   * pelo resto do parse — virando um turn de LLM pago sobre um evento que não
   * é mensagem.
   */
  it("descarta callback que não é ReceivedCallback", () => {
    expect(
      parseInbound({
        ...base,
        type: "MessageStatusCallback",
        status: "READ",
        ids: ["3EB0"],
      })
    ).toBeNull();
    expect(parseInbound({ ...base, type: "PresenceChatCallback" })).toBeNull();
    // `type` presente e correto segue normal.
    expect(
      parseInbound({ ...base, type: "ReceivedCallback", text: { message: "oi" } })
    ).toMatchObject({ kind: "text" });
  });

  it("descarta reação e sticker — responder a um 👍 é ruído", () => {
    expect(
      parseInbound({ ...base, reaction: { value: "👍", referencedMessage: {} } })
    ).toBeNull();
    expect(
      parseInbound({ ...base, sticker: { stickerUrl: "https://x/s.webp" } })
    ).toBeNull();
  });

  it("grupo sem participantPhone é descartado em vez de virar turn do grupo", () => {
    expect(
      parseInbound({
        ...base,
        phone: "120363407415575253-group",
        isGroup: true,
        text: { message: "x" },
      })
    ).toBeNull();
  });

  it("reconhece áudio, imagem e documento com URL e mime", () => {
    expect(
      parseInbound({ ...base, audio: { audioUrl: "https://x/a.ogg", mimeType: "audio/ogg" } })
    ).toMatchObject({ kind: "audio", mediaUrl: "https://x/a.ogg", mimeType: "audio/ogg" });

    expect(
      parseInbound({ ...base, image: { imageUrl: "https://x/i.jpg", caption: "olha" } })
    ).toMatchObject({ kind: "image", mediaUrl: "https://x/i.jpg", text: "olha" });

    expect(
      parseInbound({ ...base, document: { documentUrl: "https://x/d.pdf", fileName: "d.pdf" } })
    ).toMatchObject({ kind: "document", text: "d.pdf" });
  });

  it("payload sem messageId ou sem phone não vira turn", () => {
    expect(parseInbound({ ...base, messageId: undefined })).toBeNull();
    expect(parseInbound({ ...base, phone: undefined })).toBeNull();
    expect(parseInbound(null)).toBeNull();
    expect(parseInbound("nada")).toBeNull();
  });

  it("captura o wamid citado quando é resposta", () => {
    const m = parseInbound({ ...base, text: { message: "isso" }, referenceMessageId: "3EA9" });
    expect(m?.replyToMessageId).toBe("3EA9");
  });
});

describe("isGroupJid", () => {
  it("reconhece os dois formatos e recusa telefone", () => {
    expect(isGroupJid("120363407415575253-group")).toBe(true);
    expect(isGroupJid("120363019502650977@g.us")).toBe(true);
    expect(isGroupJid("5511999063228")).toBe(false);
  });
});

describe("envio", () => {
  beforeEach(() => {
    vi.stubEnv("ZAPI_INSTANCE_ID", "INST");
    vi.stubEnv("ZAPI_INSTANCE_TOKEN", "TOK");
    vi.stubEnv("ZAPI_CLIENT_TOKEN", "CLI");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function mockFetch(res: Partial<Response> = {}) {
    const fn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messageId: "MID", zaapId: "ZID" }),
      text: async () => "{}",
      ...res,
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  /**
   * ── "Desemparelhada" não pode ser o veredito de toda falha ────────────────
   *
   * `connectionStatus` não checava `res.ok`. Um 401 (Client-Token da conta
   * trocado) ou 404 (instance id errado) devolvem corpo sem `connected`, e
   * `Boolean(undefined)` é `false` — então erro de credencial era carimbado na
   * fila como "instância desemparelhada", mandando quem investigasse ler um QR
   * code que não resolveria nada. Custou re-pareamentos que não eram o problema.
   *
   * Lançar é o certo porque os chamadores tratam exceção como "não consegui
   * PERGUNTAR" e seguem (fail open), com o motivo real no log.
   */
  it("401 LANÇA em vez de dizer desemparelhada", async () => {
    mockFetch({
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid client-token"}',
    });

    await expect(connectionStatus()).rejects.toThrow(/401.*NÃO é desemparelhamento/s);
  });

  it("404 (instance id errado) também lança", async () => {
    mockFetch({ ok: false, status: 404, text: async () => "not found" });

    await expect(connectionStatus()).rejects.toThrow(/ZAPI_INSTANCE_ID/);
  });

  /** 200 sem campo de conexão é formato desconhecido, não desconexão. */
  it("200 sem campo de conexão lança em vez de assumir desconectado", async () => {
    mockFetch({ ok: true, status: 200, json: async () => ({ foo: "bar" }) });

    await expect(connectionStatus()).rejects.toThrow(/formato inesperado/);
  });

  /** O caso real de desconexão continua sendo relatado como desconexão. */
  it("desemparelhamento de verdade devolve connected:false, sem lançar", async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: async () => ({
        connected: false,
        session: false,
        error: "You are not connected.",
        smartphoneConnected: false,
      }),
    });

    const s = await connectionStatus();
    expect(s.connected).toBe(false);
  });

  it("conectada devolve connected:true", async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: async () => ({ connected: true, smartphoneConnected: true }),
    });

    expect((await connectionStatus()).connected).toBe(true);
  });

  it("send-text monta a URL da instância e manda o Client-Token", async () => {
    const fetchMock = mockFetch();
    await sendText({ to: "5511999063228", body: "oi" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.z-api.io/instances/INST/token/TOK/send-text");
    expect(init.headers["Client-Token"]).toBe("CLI");
    expect(JSON.parse(init.body)).toEqual({
      phone: "5511999063228",
      message: "oi",
    });
  });

  it("send-audio manda voice note (waveform), não anexo de arquivo", async () => {
    const fetchMock = mockFetch();
    await sendAudio({ to: "5511999063228", audio: Buffer.from("abc") });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.waveform).toBe(true);
    expect(body.audio).toBe(`data:audio/mpeg;base64,${Buffer.from("abc").toString("base64")}`);
  });

  it("erro HTTP vira exceção com o status (o caller decide o retry)", async () => {
    mockFetch({ ok: false, status: 401, text: async () => "token inválido" });
    await expect(sendText({ to: "5511999063228", body: "oi" })).rejects.toThrow(
      /Z-API \/send-text 401/
    );
  });

  it("sem env de instância falha claro, não com URL 'undefined'", async () => {
    vi.stubEnv("ZAPI_INSTANCE_ID", "");
    mockFetch();
    await expect(sendText({ to: "5511999063228", body: "oi" })).rejects.toThrow(
      /ZAPI_INSTANCE_ID/
    );
  });
});

/**
 * O callback de status é o único canal que distingue "a Z-API aceitou" de
 * "chegou no aparelho" — a reconciliação de entrega (Fase 4) consome isto.
 */
describe("parseStatusCallback", () => {
  it("extrai status e ids", () => {
    expect(
      parseStatusCallback({
        type: "MessageStatusCallback",
        status: "READ",
        ids: ["A1", "A2"],
        phone: "5511999063228",
        momment: 1_800_000_000_000,
      })
    ).toEqual({
      status: "READ",
      messageIds: ["A1", "A2"],
      phone: "5511999063228",
      momment: 1_800_000_000_000,
    });
  });

  it("aceita messageId único no lugar de ids", () => {
    expect(
      parseStatusCallback({ type: "MessageStatusCallback", status: "SENT", messageId: "B9" })
    ).toMatchObject({ status: "SENT", messageIds: ["B9"] });
  });

  it("recusa o que não é MessageStatusCallback, e status/ids ausentes", () => {
    expect(parseStatusCallback({ type: "ReceivedCallback", status: "READ", ids: ["x"] })).toBeNull();
    expect(parseStatusCallback({ type: "MessageStatusCallback", ids: ["x"] })).toBeNull();
    expect(parseStatusCallback({ type: "MessageStatusCallback", status: "READ", ids: [] })).toBeNull();
    expect(parseStatusCallback(null)).toBeNull();
  });
});
