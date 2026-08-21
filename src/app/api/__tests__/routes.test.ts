import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * As rotas testadas COMO rotas — auth, status codes e descartes.
 *
 * O HMAC já era testado como função (`hmac.test.ts`), mas nunca como rota: a
 * comparação de segredo do webhook, o Bearer dos crons e os 401/403/409 do
 * `/notify` nunca tinham sido exercitados de ponta a ponta. Os handlers do App
 * Router são funções puras (NextRequest → NextResponse), então o custo é baixo
 * e o que se ganha é a camada que estava a zero.
 *
 * Tudo abaixo da rota é mockado: aqui o assunto é o contrato HTTP, não a fila.
 */

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/inbound", () => ({
  enqueueInbound: vi.fn().mockResolvedValue({ status: "queued", id: "row-1" }),
  processInboundNow: vi.fn().mockResolvedValue(undefined),
  sweepInbound: vi.fn().mockResolvedValue({ claimed: 0, done: 0, failed: 0, retry: 0, blocked: 0 }),
}));
vi.mock("@/lib/outbox", () => ({
  enqueue: vi.fn().mockResolvedValue({ status: "queued", id: "out-1", deliverAfter: new Date() }),
  dispatchDue: vi.fn().mockResolvedValue({ claimed: 0, sent: 0, failed: 0, blocked: 0 }),
}));
vi.mock("@/lib/orgs", () => ({
  isOrgKnown: vi.fn().mockResolvedValue(true),
  encrypt: vi.fn((s: string) => `enc:${s}`),
  __resetOrgCache: vi.fn(),
}));
vi.mock("@/lib/identity", () => ({
  clearIdentityCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/db", () => ({
  query: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/delivery", () => ({
  applyStatusCallback: vi.fn().mockResolvedValue({ outbox: 1, replies: 0 }),
  reconcile: vi.fn().mockResolvedValue({ unconfirmed: 0, reported: 0, reportFailed: 0 }),
}));
vi.mock("@/lib/zapi", async (orig) => ({
  ...(await orig<typeof import("@/lib/zapi")>()),
  connectionStatus: vi.fn().mockResolvedValue({ connected: true, raw: {} }),
}));

const { POST: webhookPost } = await import("../zapi-webhook/[secret]/route");
const { POST: statusPost } = await import("../zapi-status/[secret]/route");
const { POST: notifyPost } = await import("../notify/route");
const { GET: cronInbound } = await import("../cron/inbound/route");
const { GET: cronOutbox } = await import("../cron/outbox/route");
const { GET: adminStatus } = await import("../admin/status/route");
const { sign } = await import("@/lib/hmac");
const { enqueueInbound } = await import("@/lib/inbound");
const { applyStatusCallback } = await import("@/lib/delivery");
const { enqueue: enqueueOutbox } = await import("@/lib/outbox");

const enfileira = enqueueInbound as unknown as ReturnType<typeof vi.fn>;
const aplicaStatus = applyStatusCallback as unknown as ReturnType<typeof vi.fn>;
const enfileiraOut = enqueueOutbox as unknown as ReturnType<typeof vi.fn>;

const SECRET = "hmac-secret-de-teste";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ZAPI_WEBHOOK_SECRET", "hook-secret");
  vi.stubEnv("ZAPI_INSTANCE_ID", "INST");
  vi.stubEnv("MAX_NOTIFY_SECRET", SECRET);
  vi.stubEnv("CRON_SECRET", "cron-secret");
});
afterEach(() => vi.unstubAllEnvs());

function webhookReq(body: unknown, secret = "hook-secret") {
  return [
    new NextRequest(`http://max.test/api/zapi-webhook/${secret}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: { secret } },
  ] as const;
}

const MSG = {
  instanceId: "INST",
  messageId: "M1",
  phone: "5511987654321",
  text: { message: "oi" },
};

describe("POST /api/zapi-webhook/[secret]", () => {
  it("segredo errado é 404 — o endpoint não deve nem existir para quem sonda", async () => {
    const res = await webhookPost(...webhookReq(MSG, "errado"));
    expect(res.status).toBe(404);
  });

  it("sem ZAPI_WEBHOOK_SECRET é 500, nunca 200 silencioso", async () => {
    vi.stubEnv("ZAPI_WEBHOOK_SECRET", "");
    const res = await webhookPost(...webhookReq(MSG));
    expect(res.status).toBe(500);
    expect(enfileira).not.toHaveBeenCalled();
  });

  it("mensagem válida é aceita e enfileirada", async () => {
    const res = await webhookPost(...webhookReq(MSG));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(enfileira).toHaveBeenCalledOnce();
  });

  it("reação/sticker/status não viram linha na fila", async () => {
    for (const payload of [
      { ...MSG, reaction: { value: "👍" } },
      { ...MSG, sticker: { stickerUrl: "https://x/s.webp" } },
      { ...MSG, type: "MessageStatusCallback", status: "READ", ids: ["M1"] },
    ]) {
      const res = await webhookPost(...webhookReq(payload));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ignored: true });
    }
    expect(enfileira).not.toHaveBeenCalled();
  });

  it("instanceId de outra instância é ignorado", async () => {
    const res = await webhookPost(...webhookReq({ ...MSG, instanceId: "OUTRA" }));
    expect(res.status).toBe(200);
    expect(enfileira).not.toHaveBeenCalled();
  });
});

describe("POST /api/zapi-status/[secret]", () => {
  function statusCbReq(body: unknown, secret = "hook-secret") {
    return [
      new NextRequest(`http://max.test/api/zapi-status/${secret}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
      { params: { secret } },
    ] as const;
  }

  const CB = {
    instanceId: "INST",
    type: "MessageStatusCallback",
    status: "READ",
    ids: ["PROV-1"],
  };

  it("segredo errado é 404", async () => {
    expect((await statusPost(...statusCbReq(CB, "errado"))).status).toBe(404);
  });

  it("callback válido aplica o status", async () => {
    const res = await statusPost(...statusCbReq(CB));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: { outbox: 1 } });
    expect(aplicaStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "READ", messageIds: ["PROV-1"] })
    );
  });

  it("payload que não é status é ignorado sem tocar o banco", async () => {
    const res = await statusPost(
      ...statusCbReq({ instanceId: "INST", messageId: "M1", phone: "551199", text: { message: "oi" } })
    );
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(aplicaStatus).not.toHaveBeenCalled();
  });

  it("falha do banco ainda responde 200 — reentrega não resolveria", async () => {
    aplicaStatus.mockRejectedValueOnce(new Error("db fora"));
    const res = await statusPost(...statusCbReq(CB));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ error: true });
  });
});

function notifyReq(body: string, headers: Record<string, string>) {
  return new NextRequest("http://max.test/api/notify", {
    method: "POST",
    body,
    headers,
  });
}

const NOTIFY_BODY = JSON.stringify({
  orgId: "org1",
  audience: "platform_user",
  phone: "+5511987654321",
  dedupeKey: "n:1",
});

describe("POST /api/notify", () => {
  it("sem assinatura é 401", async () => {
    expect((await notifyPost(notifyReq(NOTIFY_BODY, {}))).status).toBe(401);
  });

  it("assinatura expirada é 401 indistinguível de inválida", async () => {
    const velho = String(Date.now() - 10 * 60_000);
    const res = await notifyPost(
      notifyReq(NOTIFY_BODY, {
        "x-max-timestamp": velho,
        "x-max-signature": sign(velho, NOTIFY_BODY, SECRET),
      })
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("assinatura válida enfileira e responde 202", async () => {
    const ts = String(Date.now());
    const res = await notifyPost(
      notifyReq(NOTIFY_BODY, {
        "x-max-timestamp": ts,
        "x-max-signature": sign(ts, NOTIFY_BODY, SECRET),
      })
    );
    expect(res.status).toBe(202);
    // O VALOR entregue à fila, não só a chamada: telefone cru no gateway já
    // custou perda silenciosa em produção (#189 e o ramo de corretor do
    // Newton em 2026-08). A Z-API quer E.164 SEM "+".
    // Valor E arity: sem a segunda, um /notify que enfileirasse duas vezes
    // (retry mal fechado) passaria neste teste e no de baixo.
    expect(enfileiraOut).toHaveBeenCalledOnce();
    expect(enfileiraOut).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "5511987654321" })
    );
  });

  it("telefone formatado chega à fila no formato da Z-API", async () => {
    // O caso que distingue o helper do replace inline: com "+5511..." os dois
    // coincidem; com telefone sujo, só a normalização acerta.
    const body = JSON.stringify({
      orgId: "org1",
      audience: "platform_user",
      phone: "(11) 98765-4321",
      dedupeKey: "n:2",
    });
    const ts = String(Date.now());
    const res = await notifyPost(
      notifyReq(body, {
        "x-max-timestamp": ts,
        "x-max-signature": sign(ts, body, SECRET),
      })
    );
    expect(res.status).toBe(202);
    expect(enfileiraOut).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "5511987654321" })
    );
  });

  it("duplicata é 409 — o contrato que o ImobPro lê como 'já assumido'", async () => {
    enfileiraOut.mockResolvedValueOnce({ status: "duplicate", id: "out-1" });
    const ts = String(Date.now());
    const res = await notifyPost(
      notifyReq(NOTIFY_BODY, {
        "x-max-timestamp": ts,
        "x-max-signature": sign(ts, NOTIFY_BODY, SECRET),
      })
    );
    expect(res.status).toBe(409);
  });
});

describe("crons", () => {
  const semAuth = new NextRequest("http://max.test/api/cron/x");
  const comAuth = new NextRequest("http://max.test/api/cron/x", {
    headers: { authorization: "Bearer cron-secret" },
  });

  it("sem Bearer é 401 nos dois", async () => {
    expect((await cronInbound(semAuth)).status).toBe(401);
    expect((await cronOutbox(semAuth)).status).toBe(401);
  });

  it("com Bearer responde os totais", async () => {
    expect((await cronInbound(comAuth)).status).toBe(200);
    expect((await cronOutbox(comAuth)).status).toBe(200);
  });
});

describe("GET /api/admin/status — a query entra na assinatura", () => {
  function statusReq(query: string, signedPayload: string | null) {
    const ts = String(Date.now());
    const headers: Record<string, string> = {};
    if (signedPayload !== null) {
      headers["x-max-timestamp"] = ts;
      headers["x-max-signature"] = sign(ts, signedPayload, SECRET);
    }
    return new NextRequest(`http://max.test/api/admin/status${query}`, { headers });
  }

  it("formato novo: método + path + query assinados", async () => {
    const res = await adminStatus(
      statusReq("?orgId=org1", "GET./api/admin/status?orgId=org1")
    );
    expect(res.status).toBe(200);
  });

  it("assinatura de UMA query não vale para outra org", async () => {
    // Captura da assinatura de ?orgId=org1 reusada com ?orgId=org2 — era o
    // replay cross-tenant que o corpo-vazio permitia.
    const ts = String(Date.now());
    const res = await adminStatus(
      new NextRequest("http://max.test/api/admin/status?orgId=org2", {
        headers: {
          "x-max-timestamp": ts,
          "x-max-signature": sign(ts, "GET./api/admin/status?orgId=org1", SECRET),
        },
      })
    );
    expect(res.status).toBe(401);
  });

  it("formato antigo (corpo vazio) segue aceito até o admin migrar", async () => {
    expect((await adminStatus(statusReq("", ""))).status).toBe(200);
  });

  it("sem assinatura é 401", async () => {
    expect((await adminStatus(statusReq("", null))).status).toBe(401);
  });
});
