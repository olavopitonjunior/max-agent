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
  vi.stubEnv("NEWTON_GATEWAY_TOKEN", TOKEN);
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

  it("sem NEWTON_GATEWAY_TOKEN configurado nada passa (503)", async () => {
    vi.stubEnv("NEWTON_GATEWAY_TOKEN", "");
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
          members: [{ phone: "5511900000001", name: "Olavo" }],
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
});
