import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as meta from "../meta";
import * as transport from "../transport";

const ALLOWED = "5511999990001";
const OTHER = "5511999990002";
const interativo = { tipo: "botoes" as const, corpo: "Escolha", opcoes: [{ id: "op:SIM", titulo: "SIM" }] };
const template = { name: "pilot_test", lang: "pt_BR", bodyParams: [], botoes: [] };

// Exercise the real transport and adapter, replacing only the external HTTP boundary.
const fetchMock = vi.fn();
const senders = [
  { name: "transport text", send: (to: string) => transport.sendText({ to, body: "teste" }) },
  { name: "transport interactive", send: (to: string) => transport.sendText({ to, body: "teste", interativo }) },
  { name: "transport template", send: (to: string) => transport.sendTemplate({ to, ...template }) },
  { name: "Meta text", send: (to: string) => meta.sendText({ to, body: "teste" }) },
  { name: "Meta interactive", send: (to: string) => meta.sendInteractive({ to, interativo }) },
  { name: "Meta template", send: (to: string) => meta.sendTemplate({ to, ...template }) },
  { name: "Meta reaction", send: (to: string) => meta.sendReaction({ to, messageId: "wamid.IN", emoji: "✅" }) },
];

beforeEach(() => {
  vi.stubEnv("MAX_WHATSAPP_PILOT_ALLOWLIST", undefined);
  vi.stubEnv("AGENT_DEPLOY_PROFILE", "");
  vi.stubEnv("AGENT_TRANSPORT", "");
  vi.stubEnv("WHATSAPP_PROVIDER", "meta");
  vi.stubEnv("MAX_OUTBOUND_KILL", "");
  vi.stubEnv("MAX_INTERACTIVE", "");
  vi.stubEnv("MAX_TYPING_INDICATOR", "");
  vi.stubEnv("META_ACCESS_TOKEN", "test-token");
  vi.stubEnv("META_PHONE_NUMBER_ID", "test-phone-id");
  fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each(senders)("pilot isolation: $name", ({ send }) => {
  it("without pilot configuration preserves outbound delivery", async () => {
    await expect(send(OTHER)).resolves.toEqual({ messageId: "wamid.OUT" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("allows an explicitly listed recipient", async () => {
    vi.stubEnv("MAX_WHATSAPP_PILOT_ALLOWLIST", JSON.stringify([ALLOWED]));
    await expect(send(ALLOWED)).resolves.toEqual({ messageId: "wamid.OUT" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).to).toBe(ALLOWED);
  });

  it("denies another recipient before any HTTP request", async () => {
    vi.stubEnv("MAX_WHATSAPP_PILOT_ALLOWLIST", JSON.stringify([ALLOWED]));
    await expect(send(OTHER)).rejects.toThrow("whatsapp_pilot_recipient_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pilot configuration", () => {
  it.each(["", " ", "[]", "null", "{}", "false", ALLOWED, `"${ALLOWED}"`, "[", `[${ALLOWED}]`, `["${ALLOWED}","invalid"]`, `["${ALLOWED}",""]`, '["05511999990001"]', '["5511 999990001"]', '["1234567890123456"]'])(
    "invalid or empty configuration %j fails closed, including otherwise allowed recipients",
    async (config) => {
      vi.stubEnv("MAX_WHATSAPP_PILOT_ALLOWLIST", config);
      await expect(transport.sendText({ to: ALLOWED, body: "teste" })).rejects.toThrow("whatsapp_pilot_recipient_denied");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("accepts the optional international + prefix without accepting suffix matches", async () => {
    vi.stubEnv("MAX_WHATSAPP_PILOT_ALLOWLIST", `["+${ALLOWED}"]`);
    await expect(transport.sendText({ to: ALLOWED, body: "teste" })).resolves.toEqual({ messageId: "wamid.OUT" });
    await expect(transport.sendText({ to: `+${ALLOWED}`, body: "teste" })).resolves.toEqual({ messageId: "wamid.OUT" });
    for (const to of ["0001", `0${ALLOWED}`, `${ALLOWED}@s.whatsapp.net`, "55 11 999990001", ""]) {
      await expect(transport.sendText({ to, body: "teste" })).rejects.toThrow("whatsapp_pilot_recipient_denied");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("checks the current configuration for every send", async () => {
    vi.stubEnv("MAX_WHATSAPP_PILOT_ALLOWLIST", `["${ALLOWED}"]`);
    await transport.sendText({ to: ALLOWED, body: "teste" });
    vi.stubEnv("MAX_WHATSAPP_PILOT_ALLOWLIST", "[]");
    await expect(transport.sendText({ to: ALLOWED, body: "teste" })).rejects.toThrow("whatsapp_pilot_recipient_denied");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([undefined, `["${ALLOWED}"]`])("transport reaction succeeds when recipient is permitted (%j)", async (config) => {
    vi.stubEnv("MAX_WHATSAPP_PILOT_ALLOWLIST", config);
    await expect(transport.sendReaction({ to: ALLOWED, messageId: "wamid.IN", emoji: "✅" })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("transport reaction returns false for a denied recipient without HTTP", async () => {
    vi.stubEnv("MAX_WHATSAPP_PILOT_ALLOWLIST", `["${ALLOWED}"]`);
    await expect(transport.sendReaction({ to: OTHER, messageId: "wamid.IN", emoji: "✅" })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([transport, meta])("does not emit ID-only typing/read events while pilot is configured", async (client) => {
    vi.stubEnv("MAX_WHATSAPP_PILOT_ALLOWLIST", `["${ALLOWED}"]`);
    await expect(client.markReadTyping("wamid.IN")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
