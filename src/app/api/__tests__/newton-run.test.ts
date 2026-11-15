import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A porta de entrada do Newton, com os corpos que o `forwardToNewton` do
 * bridge manda de verdade. Só a fila é mockada: o assunto é quem entra, o que
 * é recusado e o que vira linha.
 */
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/inbound", () => ({
  enqueueInbound: vi.fn(),
  processInboundNow: vi.fn().mockResolvedValue(undefined),
}));

import fixtureMidia from "./__fixtures__/newton-run-midia.json";

const { POST } = await import("../agents/newton/run/route");
const inbound = await import("@/lib/inbound");
const { waitUntil } = await import("@vercel/functions");
const enqueue = inbound.enqueueInbound as unknown as ReturnType<typeof vi.fn>;

const TOKEN = "gateway-teste";

/** Formato do `forwardToNewton` (whatsapp-newton-bridge, src/lib/newton.ts). */
function corpoDM(extra: Record<string, unknown> = {}) {
  return {
    caller: { phone: "5511900000001", name: "Olavo" },
    channel: "whatsapp",
    orgId: "org-newcore",
    groupId: null,
    groupName: null,
    members: [],
    text: "quais negócios estão parados?",
    attachments: [],
    ...extra,
  };
}

function req(body: unknown, auth: string | null = `Bearer ${TOKEN}`) {
  return new NextRequest("https://newton.example/api/agents/newton/run", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
  vi.stubEnv("NEWTON_INBOUND_TOKEN", TOKEN);
  enqueue.mockResolvedValue({ status: "queued", id: "row-1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(waitUntil).mockClear();
  enqueue.mockReset();
});

describe("POST /api/agents/newton/run", () => {
  it("no deploy do Max a porta não existe (404), mesmo com token certo", async () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "");
    const res = await POST(req(corpoDM()));
    expect(res.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("sem NEWTON_INBOUND_TOKEN configurado nada passa (503)", async () => {
    vi.stubEnv("NEWTON_INBOUND_TOKEN", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await POST(req(corpoDM()))).status).toBe(503);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("token ausente ou errado é 401", async () => {
    expect((await POST(req(corpoDM(), null))).status).toBe(401);
    expect((await POST(req(corpoDM(), "Bearer outro"))).status).toBe(401);
    expect((await POST(req(corpoDM(), TOKEN))).status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("JSON inválido ou telefone inválido é 400", async () => {
    expect((await POST(req("{nao-json"))).status).toBe(400);
    expect((await POST(req(corpoDM({ caller: { phone: "abc" } })))).status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("DM vira linha de texto na fila, roda em waitUntil e responde vazio", async () => {
    const res = await POST(req(corpoDM()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "", blocked: false });
    const msg = enqueue.mock.calls[0][0];
    expect(msg).toMatchObject({
      fromPhone: "5511900000001",
      groupId: null,
      kind: "text",
      text: "quais negócios estão parados?",
      senderName: "Olavo",
      mediaUrl: null,
    });
    expect(msg.messageId).toMatch(/^newton:/);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(inbound.processInboundNow).toHaveBeenCalledWith("row-1");
  });

  it("a org não vem do corpo: o orgId do bridge não entra na mensagem", async () => {
    await POST(req(corpoDM({ orgId: "org-de-outro-tenant" })));
    expect(JSON.stringify(enqueue.mock.calls[0][0])).not.toContain("org-de-outro-tenant");
  });

  it("duplicado não roda o turn de novo", async () => {
    enqueue.mockResolvedValue({ status: "duplicate", id: "row-1" });
    const res = await POST(req(corpoDM()));
    expect(await res.json()).toEqual({ text: "", blocked: false });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("a mesma mensagem reenviada no mesmo minuto leva o mesmo id", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-23T15:00:05Z"));
      await POST(req(corpoDM()));
      vi.setSystemTime(new Date("2026-10-23T15:00:50Z"));
      await POST(req(corpoDM()));
      vi.setSystemTime(new Date("2026-10-23T15:01:01Z"));
      await POST(req(corpoDM()));
    } finally {
      vi.useRealTimers();
    }
    const ids = enqueue.mock.calls.map((c) => c[0].messageId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("grupo é aceito e ignorado (PR 2.2): nada vai à fila", async () => {
    const res = await POST(
      req(
        corpoDM({
          groupId: "120363012345678901-group",
          groupName: "Deals Newcore",
          members: ["5511900000001", "5511900000002"],
          text: "@Newton status do AP101?",
        })
      )
    );
    expect(await res.json()).toEqual({ text: "", blocked: false });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("anexo sem texto vira unknown (o grafo pede por escrito); com texto vale o texto", async () => {
    const anexo = { type: "image", mime: "image/jpeg", base64: "AAAA", filename: "foto.jpg" };
    await POST(req(corpoDM({ text: "", attachments: [anexo] })));
    expect(enqueue.mock.calls[0][0]).toMatchObject({ kind: "unknown", text: null, mediaUrl: null });
    await POST(req(corpoDM({ text: "segue a matrícula", attachments: [anexo] })));
    expect(enqueue.mock.calls[1][0]).toMatchObject({ kind: "text", text: "segue a matrícula" });
  });

  it("sem texto e sem anexo não enfileira nada", async () => {
    const res = await POST(req(corpoDM({ text: "   " })));
    expect(await res.json()).toEqual({ text: "", blocked: false });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("o token antigo do sidecar não abre esta porta", async () => {
    vi.stubEnv("NEWTON_GATEWAY_TOKEN", "token-do-sidecar");
    expect((await POST(req(corpoDM(), "Bearer token-do-sidecar"))).status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("marcador do bridge sozinho não é texto: imagem e documento sem legenda viram unknown", async () => {
    const anexo = { type: "image", mime: "image/jpeg", base64: "AAAA", filename: "foto.jpg" };
    await POST(req(corpoDM({ text: "[imagem enviada]", attachments: [anexo] })));
    await POST(req(corpoDM({ text: "[documento: matricula.pdf]", attachments: [{ ...anexo, type: "document" }] })));
    await POST(
      req(corpoDM({ text: "[áudio enviado — transcrição indisponível, OPENROUTER_API_KEY não configurada ou Whisper falhou]", attachments: [anexo] }))
    );
    for (const [m] of enqueue.mock.calls) expect(m).toMatchObject({ kind: "unknown", text: null });
    // Foto e documento no mesmo minuto são duas mensagens, não uma.
    expect(new Set(enqueue.mock.calls.map(([m]) => m.messageId)).size).toBe(3);
  });

  it("áudio transcrito entra só com a transcrição", async () => {
    await POST(req(corpoDM({ text: "[áudio transcrito · 12.3KB]\nquais negócios estão parados?" })));
    expect(enqueue.mock.calls[0][0]).toMatchObject({ kind: "text", text: "quais negócios estão parados?" });
  });

  it("com messageId do bridge vale o id da Z-API; id sintético no corpo é recusado", async () => {
    await POST(req(corpoDM({ messageId: "3EB0C431D8A1B2" })));
    await POST(req(corpoDM({ messageId: "newton:forjado" })));
    expect(enqueue.mock.calls[0][0].messageId).toBe("3EB0C431D8A1B2");
    expect(enqueue.mock.calls[1][0].messageId).toMatch(/^newton:[0-9a-f]{40}$/);
  });

  it("fila fora do ar não devolve 500: registra e responde vazio", async () => {
    enqueue.mockRejectedValue(new Error("pg down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(req(corpoDM()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "", blocked: false });
    expect(waitUntil).not.toHaveBeenCalled();
    expect(err.mock.calls.flat().join(" ")).toContain("newton.fila_falhou");
    err.mockRestore();
  });
});

/**
 * Mídia por URL (`mediaUrl`/`mediaKind`/`mimeType`, plano de mídia do Newton).
 * O fixture é o MESMO arquivo que a ponte tem em `__fixtures__/`: é ele que
 * faz o papel do teste de paridade, já que aqui não há HMAC.
 */
describe("POST /api/agents/newton/run: mídia por URL", () => {
  const fixture = fixtureMidia as Record<string, unknown>;
  const { messageId: _semId, ...semMessageId } = fixture;
  void _semId;
  const URL_FOTO = "https://media.zapi.example/instances/X/foto.jpeg";

  beforeEach(() => {
    vi.stubEnv("NEWTON_MEDIA_HOSTS", "media.zapi.example");
  });

  function ligar() {
    vi.stubEnv("NEWTON_MEDIA_INBOUND", "true");
  }

  it("flag desligada: o fixture inteiro vira unknown, igual a hoje (receptor inerte)", async () => {
    const res = await POST(req(fixture));
    expect(await res.json()).toEqual({ text: "", blocked: false });
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      kind: "unknown",
      text: null,
      mediaUrl: null,
      mimeType: null,
      messageId: "3EB0A1B2C3D4E5F6",
    });
  });

  it("flag desligada com qualquer valor que não seja 'true'", async () => {
    vi.stubEnv("NEWTON_MEDIA_INBOUND", "1");
    await POST(req(fixture));
    vi.stubEnv("NEWTON_MEDIA_INBOUND", "false");
    await POST(req(fixture));
    for (const [m] of enqueue.mock.calls) expect(m).toMatchObject({ kind: "unknown", mediaUrl: null });
  });

  it("flag desligada: a mídia sem anexo e sem texto nem enfileira, como sempre", async () => {
    await POST(req(corpoDM({ text: "", attachments: [], mediaUrl: URL_FOTO, mediaKind: "image", mimeType: "image/jpeg" })));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("flag ligada com host fora da allowlist, http ou mime não permitido: cai em unknown", async () => {
    ligar();
    const ruins = [
      { mediaUrl: "https://evil.example/foto.jpeg" },
      { mediaUrl: "http://media.zapi.example/foto.jpeg" },
      { mediaUrl: "https://127.0.0.1/foto.jpeg" },
      { mediaUrl: "https://media.zapi.example@evil.example/foto.jpeg" },
      { mimeType: "image/gif" },
      { mimeType: "application/pdf" },
      { mediaKind: "audio" },
      { mediaKind: "video", mimeType: "video/mp4" },
    ];
    for (const ruim of ruins) {
      const res = await POST(req({ ...fixture, ...ruim }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ text: "", blocked: false });
    }
    expect(enqueue).toHaveBeenCalledTimes(ruins.length);
    for (const [m] of enqueue.mock.calls) expect(m).toMatchObject({ kind: "unknown", mediaUrl: null, mimeType: null });
  });

  it("flag ligada com a allowlist vazia: recusa tudo", async () => {
    ligar();
    vi.stubEnv("NEWTON_MEDIA_HOSTS", "");
    await POST(req(fixture));
    expect(enqueue.mock.calls[0][0]).toMatchObject({ kind: "unknown", mediaUrl: null });
  });

  it("flag ligada + grupo com mediaUrl: nada é enfileirado", async () => {
    ligar();
    const res = await POST(req({ ...fixture, groupId: "120363012345678901-group" }));
    expect(await res.json()).toEqual({ text: "", blocked: false });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("flag ligada + fixture: imagem com a referência zapi:, sem o marcador como texto", async () => {
    ligar();
    const res = await POST(req(fixture));
    expect(await res.json()).toEqual({ text: "", blocked: false });
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      kind: "image",
      mediaUrl: `zapi:${URL_FOTO}`,
      mimeType: "image/jpeg",
      text: null,
      messageId: "3EB0A1B2C3D4E5F6",
      groupId: null,
      fromPhone: "5511900000001",
    });
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("flag ligada + legenda: a legenda é o texto", async () => {
    ligar();
    await POST(req({ ...fixture, text: "segue o RG do comprador" }));
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      kind: "image",
      text: "segue o RG do comprador",
      mediaUrl: `zapi:${URL_FOTO}`,
    });
  });

  it("flag ligada + PDF: kind document, marcador não vira texto", async () => {
    ligar();
    await POST(
      req({
        ...fixture,
        text: "[documento: matricula.pdf]",
        attachments: [{ type: "document", mime: "application/pdf", filename: "matricula.pdf" }],
        mediaUrl: "https://media.zapi.example/instances/X/matricula.pdf",
        mediaKind: "document",
        mimeType: "application/pdf",
      })
    );
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      kind: "document",
      text: null,
      mimeType: "application/pdf",
      mediaUrl: "zapi:https://media.zapi.example/instances/X/matricula.pdf",
    });
  });

  it("flag ligada: mediaUrl vale mesmo sem o array attachments", async () => {
    ligar();
    await POST(req({ ...fixture, attachments: [], text: "" }));
    expect(enqueue.mock.calls[0][0]).toMatchObject({ kind: "image", mediaUrl: `zapi:${URL_FOTO}` });
  });

  it("flag ligada: mimeType em maiúscula e com parâmetro chega normalizado", async () => {
    ligar();
    await POST(req({ ...fixture, mimeType: "IMAGE/JPEG; charset=binary" }));
    expect(enqueue.mock.calls[0][0]).toMatchObject({ kind: "image", mimeType: "image/jpeg" });
  });

  it("sem messageId, duas fotos sem legenda no mesmo minuto não colidem; reentrega da mesma é igual", async () => {
    ligar();
    const outra = { ...semMessageId, mediaUrl: "https://media.zapi.example/instances/X/outra.jpeg" };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-23T15:00:05Z"));
      await POST(req(semMessageId));
      vi.setSystemTime(new Date("2026-10-23T15:00:20Z"));
      await POST(req(outra));
      vi.setSystemTime(new Date("2026-10-23T15:00:40Z"));
      await POST(req(semMessageId));
    } finally {
      vi.useRealTimers();
    }
    const ids = enqueue.mock.calls.map((c) => c[0].messageId);
    expect(ids[0]).toMatch(/^newton:[0-9a-f]{40}$/);
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids[2]).toBe(ids[0]);
  });

  it("a URL nunca vai para log, console nem para o que o motor registra de erro", async () => {
    ligar();
    const espioes = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      await POST(req(fixture)); // aceita
      await POST(req({ ...fixture, mediaUrl: "https://evil.example/instances/X/foto.jpeg" })); // recusada
      enqueue.mockRejectedValueOnce(new Error("pg down")); // falha de fila
      await POST(req(fixture));
      const saida = espioes.flatMap((s) => s.mock.calls.flat()).join(" ");
      expect(saida).not.toContain("foto.jpeg");
      expect(saida).not.toContain("instances/X");
      expect(saida).toContain("newton.midia_recusada");
    } finally {
      espioes.forEach((s) => s.mockRestore());
    }
  });
});

/** O bridge chama o caminho do sidecar antigo, na raiz. */
describe("rewrite do caminho do bridge", () => {
  it("/agents/newton/run cai na rota /api/agents/newton/run", async () => {
    const cfg = createRequire(import.meta.url)("../../../../next.config.js") as {
      rewrites(): Promise<unknown[]>;
    };
    const regras = await cfg.rewrites();
    expect(regras).toContainEqual({ source: "/agents/newton/run", destination: "/api/agents/newton/run" });
  });
});
