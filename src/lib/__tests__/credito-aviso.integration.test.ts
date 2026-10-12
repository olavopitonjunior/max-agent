import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Aviso `credit_result` (M3) ponta a ponta, fora da janela de 24h:
 * `/notify` → outbox → template já aprovado da mensagem da imobiliária → OK
 * → o texto entregue é o texto fixo do aviso. Postgres real; Meta simulada.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

vi.mock("@/graph/graph", () => ({ seedNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../identity", () => ({ resolveIdentity: vi.fn().mockResolvedValue({ kind: "unknown" }) }));
vi.mock("../orgs", async (orig) => ({ ...(await orig<typeof import("../orgs")>()), isOrgKnown: vi.fn().mockResolvedValue(true) }));
vi.mock("../meta", async (orig) => ({
  ...(await orig<typeof import("../meta")>()),
  sendText: vi.fn().mockResolvedValue({ messageId: "wamid.MID" }),
  sendTemplate: vi.fn().mockResolvedValue({ messageId: "wamid.TPL" }),
  connectionStatus: vi.fn().mockResolvedValue({ connected: true, raw: {} }),
}));

const { POST: notifyPost } = await import("@/app/api/notify/route");
const { dispatchDue } = await import("../outbox");
const { interceptar } = await import("../aceite");
const { sign } = await import("../hmac");
const { query } = await import("../db");
const meta = await import("../meta");
import type { InboundMessage } from "../transport";

const ORG = "org-credito-aviso";
const PHONE = "5511900004444";
const SECRET = "hmac-credito-aviso";
const TPL = "max_mensagem_imobiliaria_v3";
const LINK = "https://fincasa.imobpro.ia.br/locacao/pessoas/clientes/lc1";
const AVISO = `A análise de crédito de Letícia Andrade saiu: Aprovado. ${LINK}`;
const metaSendTemplate = meta.sendTemplate as unknown as ReturnType<typeof vi.fn>;
const metaSend = meta.sendText as unknown as ReturnType<typeof vi.fn>;

async function limpar() {
  await query(`DELETE FROM outbox WHERE org_id = $1`, [ORG]);
  await query(`DELETE FROM conversation_window WHERE phone = $1`, [PHONE]);
  await query(`DELETE FROM conversation_turn WHERE phone = $1`, [PHONE]);
  await query(`DELETE FROM wa_template WHERE name = $1`, [TPL]);
}

d("credit_result fora da janela (Postgres real)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("WHATSAPP_PROVIDER", "meta");
    vi.stubEnv("MAX_NOTIFY_SECRET", SECRET);
    await limpar();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(limpar);

  it("/notify → template da mensagem da imobiliária → OK entrega o texto do aviso", async () => {
    await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'APPROVED')`, [TPL]);
    // O corpo LITERAL do `upestate-runner.ts` (C5): o Max troca pelo texto fixo.
    const body = JSON.stringify({
      orgId: ORG, audience: "platform_user", phone: `+${PHONE}`, recipientName: "Olavo Ramos",
      title: "Análise de crédito", body: "A análise de crédito de Letícia Andrade foi atualizada: Aprovado.",
      linkUrl: LINK, orgName: "FINCasa", dedupeKey: `credit_result:r1:${Date.now()}`,
      kind: "credit_result", params: { lead: "Letícia Andrade", decisao: "Aprovado" },
    });
    const ts = String(Date.now());
    const res = await notifyPost(new NextRequest("http://max.test/api/notify", {
      method: "POST", body, headers: { "x-max-timestamp": ts, "x-max-signature": sign(ts, body, SECRET) },
    }));
    expect(res.status).toBe(202);

    await query(`UPDATE outbox SET deliver_after = now() - interval '1 minute' WHERE org_id = $1`, [ORG]);
    await dispatchDue();
    expect(metaSend).not.toHaveBeenCalled();
    expect(metaSendTemplate.mock.calls[0][0]).toMatchObject({ name: TPL, bodyParams: ["Olavo", "FINCasa"] });

    const ok: InboundMessage = {
      messageId: `wamid.CREDITO.${Date.now()}`, fromPhone: PHONE, groupId: null, kind: "text", text: "OK",
      mediaUrl: null, mimeType: null, timestampMs: Date.now(), senderName: "Olavo", replyToMessageId: null, buttonPayload: null,
    };
    const r = await interceptar(ok);
    expect(r?.reply).toBe(`*Mensagem da FINCasa*\n\n${AVISO}`);
  });
});
