import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rota do webhook da Meta, com o parser e a verificação de assinatura
 * REAIS. Só a fila e a entrega são mockadas — o assunto aqui é a porta:
 * quem entra, o que é recusado e o que vira linha.
 */
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/inbound", () => ({
  enqueueInbound: vi.fn(),
  processInboundNow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/delivery", () => ({
  applyStatusCallback: vi.fn().mockResolvedValue({ outbox: 1, replies: 0 }),
  applyFalhaDeEnvio: vi.fn().mockResolvedValue(1),
}));

const { POST, GET } = await import("../meta-webhook/route");
const inbound = await import("@/lib/inbound");
const delivery = await import("@/lib/delivery");
const { waitUntil } = await import("@vercel/functions");

const enqueue = inbound.enqueueInbound as unknown as ReturnType<typeof vi.fn>;
const PNID = "123456789012345";
const SECRET = "app-secret";

function corpo(value: Record<string, unknown>, pnid = PNID) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "5511970850046", phone_number_id: pnid },
              ...value,
            },
          },
        ],
      },
    ],
  });
}

const texto = (id: string) => ({
  contacts: [{ profile: { name: "Ana" }, wa_id: "5511987654321" }],
  messages: [{ from: "5511987654321", id, timestamp: "1758549600", type: "text", text: { body: "oi" } }],
});

function post(body: string, assinatura: string | null = assinar(body)) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (assinatura !== null) headers["x-hub-signature-256"] = assinatura;
  return new NextRequest("https://max.test/api/meta-webhook", { method: "POST", body, headers });
}

function assinar(body: string, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("META_APP_SECRET", SECRET);
  vi.stubEnv("META_PHONE_NUMBER_ID", PNID);
  vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "verify-tok");
  enqueue.mockResolvedValue({ status: "queued", id: "row-1" });
});

afterEach(() => vi.unstubAllEnvs());

describe("POST /api/meta-webhook", () => {
  it("mensagem assinada vira linha na fila e processamento em background", async () => {
    const res = await POST(post(corpo(texto("wamid.A"))));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, accepted: 1 });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "wamid.A", fromPhone: "5511987654321", text: "oi", senderName: "Ana" })
    );
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  /** Mutação de controle do plano: sem assinatura válida, NADA entra. */
  it("assinatura errada, ausente ou de outro segredo: 401 e nada enfileirado", async () => {
    const b = corpo(texto("wamid.B"));
    for (const sig of [null, "sha256=00", assinar(b, "outro-segredo"), assinar(b + " ")]) {
      const res = await POST(post(b, sig));
      expect(res.status).toBe(401);
    }
    expect(enqueue).not.toHaveBeenCalled();
    expect(delivery.applyStatusCallback).not.toHaveBeenCalled();
  });

  it("sem META_APP_SECRET no ambiente: 401 mesmo com assinatura de string vazia", async () => {
    vi.stubEnv("META_APP_SECRET", "");
    const b = corpo(texto("wamid.C"));
    const res = await POST(post(b, assinar(b, "")));
    expect(res.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("outro phone_number_id do mesmo app é ignorado com 200", async () => {
    const res = await POST(post(corpo(texto("wamid.D"), "999")));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "numero" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reentrega (duplicata) não dispara segundo processamento", async () => {
    enqueue.mockResolvedValue({ status: "duplicate", id: "row-1" });
    const res = await POST(post(corpo(texto("wamid.E"))));
    expect(await res.json()).toMatchObject({ accepted: 0 });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("status e falha de envio são aplicados; falha leva o código da Meta", async () => {
    const res = await POST(
      post(
        corpo({
          statuses: [
            { id: "wamid.O1", status: "delivered", timestamp: "1758549600", recipient_id: "5511987654321" },
            {
              id: "wamid.O2",
              status: "failed",
              timestamp: "1758549601",
              recipient_id: "5511987654321",
              errors: [{ code: 131026, title: "Message undeliverable" }],
            },
          ],
        })
      )
    );
    expect(res.status).toBe(200);
    expect(delivery.applyStatusCallback).toHaveBeenCalledTimes(2);
    expect(delivery.applyFalhaDeEnvio).toHaveBeenCalledWith({
      messageId: "wamid.O2",
      code: 131026,
      title: "Message undeliverable",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("JSON inválido assinado e campo que não é `messages`: 200, nada feito", async () => {
    const lixo = "{nao-json";
    expect((await POST(post(lixo))).status).toBe(200);
    const tpl = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "WABA", changes: [{ field: "message_template_status_update", value: { event: "APPROVED" } }] }],
    });
    const res = await POST(post(tpl));
    expect(await res.json()).toMatchObject({ ignored: "campo" });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("GET /api/meta-webhook (handshake)", () => {
  const get = (qs: string) => new NextRequest(`https://max.test/api/meta-webhook?${qs}`);

  it("devolve o challenge em texto puro quando o token confere", async () => {
    const res = await GET(get("hub.mode=subscribe&hub.verify_token=verify-tok&hub.challenge=1158201444"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1158201444");
  });

  it("403 com token errado", async () => {
    const res = await GET(get("hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1"));
    expect(res.status).toBe(403);
  });
});
