import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newtonBridgeAdapter } from "../transport/adapters/newton-bridge";
import { idDoBridge, idSintetico, textoDoBridge } from "../transport/newton-inbound";

/**
 * Contrato com o `whatsapp-newton-bridge` (`src/app/api/send/route.ts`):
 * `POST /api/send`, `Bearer BRIDGE_INTERNAL_TOKEN`, `{to, body, context?}`,
 * resposta `{provider, messageId, raw}`.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEWTON_BRIDGE_URL", "https://bridge.example/");
  vi.stubEnv("NEWTON_BRIDGE_TOKEN", "tok-teste");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockReset();
});

function ok(json: unknown) {
  return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
}

describe("newtonBridgeAdapter.sendText", () => {
  it("posta no /api/send com Bearer e devolve o messageId do bridge", async () => {
    fetchMock.mockResolvedValue(ok({ provider: "zapi", messageId: "ZAPI-1", raw: {} }));
    const r = await newtonBridgeAdapter.sendText({ to: "5511900000001", body: "oi" });
    expect(r).toEqual({ messageId: "ZAPI-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://bridge.example/api/send");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok-teste");
    expect(JSON.parse(init.body)).toEqual({ to: "5511900000001", body: "oi" });
  });

  it("corta o corpo em 4096", async () => {
    fetchMock.mockResolvedValue(ok({ messageId: "Z" }));
    await newtonBridgeAdapter.sendText({ to: "5511900000001", body: "x".repeat(5000) });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).body).toHaveLength(4096);
  });

  it("cita id real da Z-API, nunca o sintético da rota", async () => {
    fetchMock.mockResolvedValue(ok({ messageId: "Z" }));
    await newtonBridgeAdapter.sendText({ to: "5511900000001", body: "a", quoteMessageId: "3EB0ABC" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).context).toEqual({ message_id: "3EB0ABC" });
    await newtonBridgeAdapter.sendText({ to: "5511900000001", body: "b", quoteMessageId: "newton:abc" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).context).toBeUndefined();
  });

  it("aceita grupo no formato do bridge e recusa destino fora dele sem rede", async () => {
    fetchMock.mockResolvedValue(ok({ messageId: "Z" }));
    await newtonBridgeAdapter.sendText({ to: "120363012345678901-group", body: "a" });
    await expect(newtonBridgeAdapter.sendText({ to: "+55 11 9999", body: "a" })).rejects.toThrow(
      "newton_bridge_destino_invalido"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("erro HTTP do bridge vira newton_bridge_http_<status>, sem ecoar o corpo", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "segredo-da-zapi" }), { status: 500 }));
    const err = await newtonBridgeAdapter.sendText({ to: "5511900000001", body: "a" }).catch((e) => e);
    expect(err.message).toBe("newton_bridge_http_500");
  });

  it("sem URL ou token lança antes de qualquer rede", async () => {
    vi.stubEnv("NEWTON_BRIDGE_TOKEN", "");
    await expect(newtonBridgeAdapter.sendText({ to: "5511900000001", body: "a" })).rejects.toThrow(
      "newton_bridge_nao_configurado"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("messageId ausente na resposta vira null", async () => {
    fetchMock.mockResolvedValue(ok({ provider: "zapi" }));
    expect(await newtonBridgeAdapter.sendText({ to: "5511900000001", body: "a" })).toEqual({ messageId: null });
  });
});

describe("newtonBridgeAdapter: capacidades", () => {
  it("texto livre sempre: sem template, sem janela, sem mídia, sem status", () => {
    expect(newtonBridgeAdapter.capabilities).toEqual({
      templates: false,
      window24h: false,
      media: false,
      groups: true,
      status: false,
      typing: false,
    });
    expect(newtonBridgeAdapter.sendTemplate).toBeUndefined();
    expect(newtonBridgeAdapter.markReadTyping).toBeUndefined();
  });

  it("connectionStatus falha aberto e downloadMedia não baixa nada", async () => {
    expect((await newtonBridgeAdapter.connectionStatus()).connected).toBe(true);
    expect(await newtonBridgeAdapter.downloadMedia("x")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("idSintetico", () => {
  const base = { phone: "5511900000001", groupId: null, text: "oi", anexos: 0, agoraMs: 1_700_000_040_000 }; // início exato de um minuto

  it("mesma mensagem no mesmo minuto dá o mesmo id, com prefixo newton:", () => {
    const a = idSintetico(base);
    expect(a).toMatch(/^newton:[0-9a-f]{40}$/);
    expect(idSintetico({ ...base, agoraMs: base.agoraMs + 30_000 })).toBe(a);
  });

  it("muda com minuto, texto, telefone, grupo ou anexos", () => {
    const a = idSintetico(base);
    expect(idSintetico({ ...base, agoraMs: base.agoraMs + 60_000 })).not.toBe(a);
    expect(idSintetico({ ...base, text: "oi!" })).not.toBe(a);
    expect(idSintetico({ ...base, phone: "5511999990000" })).not.toBe(a);
    expect(idSintetico({ ...base, groupId: "1203-group" })).not.toBe(a);
    expect(idSintetico({ ...base, anexos: 1 })).not.toBe(a);
  });
});

describe("textoDoBridge", () => {
  it("marcador sem conteúdo vira vazio; legenda e texto comum ficam", () => {
    expect(textoDoBridge("[imagem enviada]")).toBe("");
    expect(textoDoBridge(" [documento: sem nome] ")).toBe("");
    expect(textoDoBridge("[áudio enviado — transcrição indisponível, Whisper falhou]")).toBe("");
    expect(textoDoBridge("segue a matrícula")).toBe("segue a matrícula");
    expect(textoDoBridge("[imagem enviada] e mais isto")).toBe("[imagem enviada] e mais isto");
  });

  it("áudio transcrito vira só a transcrição", () => {
    expect(textoDoBridge("[áudio transcrito · 8.0KB]\nme liga amanhã")).toBe("me liga amanhã");
  });

  it("marca de citação e aviso do sanitize saem antes do resto", () => {
    expect(textoDoBridge("[respondendo a msg id=3EB0ABC] SIM")).toBe("SIM");
    expect(textoDoBridge("[respondendo a msg id=3EB0ABC] [imagem enviada]")).toBe("");
    const aviso = "[suspicious instruction-like content detected · patterns: ignore_previous]\n";
    expect(textoDoBridge(`${aviso}[respondendo a msg id=3EB0ABC] SIM`)).toBe("SIM");
    expect(textoDoBridge(`${aviso}[documento: x.pdf]`)).toBe("");
    expect(textoDoBridge(`${aviso}[áudio transcrito · 2.1KB]\nconfirmo`)).toBe("confirmo");
  });
});

describe("idDoBridge", () => {
  it("aceita id da Z-API e recusa vazio, curto, forjado ou fora do formato", () => {
    expect(idDoBridge("3EB0C431D8A1B2")).toBe("3EB0C431D8A1B2");
    expect(idDoBridge(" 3EB0C431D8A1B2 ")).toBe("3EB0C431D8A1B2");
    expect(idDoBridge("newton:abcdef")).toBeNull();
    expect(idDoBridge("abc")).toBeNull();
    expect(idDoBridge("id com espaço")).toBeNull();
    expect(idDoBridge(123)).toBeNull();
    expect(idDoBridge(undefined)).toBeNull();
  });
});
