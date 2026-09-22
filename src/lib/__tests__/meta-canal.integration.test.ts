import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";

/**
 * O canal Meta contra o Postgres real: a janela de 24h no outbox e a falha de
 * envio assíncrona. É SQL o que se prova aqui — a represa com a tentativa
 * devolvida, o GREATEST da janela, o `failed` que só pega linha `sent`.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

vi.mock("@/graph/graph", () => ({
  seedNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../identity", () => ({
  resolveIdentity: vi.fn().mockResolvedValue({ kind: "unknown" }),
}));
vi.mock("../meta", async (orig) => ({
  ...(await orig<typeof import("../meta")>()),
  sendText: vi.fn().mockResolvedValue({ messageId: "wamid.MID" }),
  connectionStatus: vi.fn().mockResolvedValue({ connected: true, raw: {} }),
}));
vi.mock("../zapi", async (orig) => ({
  ...(await orig<typeof import("../zapi")>()),
  sendText: vi.fn().mockResolvedValue({ messageId: "ZMID" }),
  connectionStatus: vi.fn().mockResolvedValue({ connected: true, raw: {} }),
}));

const { enqueue, dispatchDue, MARCA_REQUER_TEMPLATE } = await import("../outbox");
const { enqueueInbound } = await import("../inbound");
const { janelaAberta } = await import("../janela24h");
const { applyFalhaDeEnvio, applyStatusCallback } = await import("../delivery");
const { query } = await import("../db");
const meta = await import("../meta");
const zapi = await import("../zapi");

const PHONE = "5511900001111";
const metaSend = meta.sendText as unknown as ReturnType<typeof vi.fn>;
const zapiSend = zapi.sendText as unknown as ReturnType<typeof vi.fn>;

async function linhaVencida(dedupeKey: string) {
  await enqueue({
    orgId: "org-meta",
    dedupeKey,
    audience: "platform_user",
    phone: PHONE,
    recipientName: "Ana",
    title: "Formulário concluído",
    body: "O formulário foi preenchido.",
    linkUrl: "https://imobpro.ia.br/deals/1",
    dealId: "deal1",
    orgName: "FINCasa",
  });
  await query(`UPDATE outbox SET deliver_after = now() - interval '1 minute' WHERE dedupe_key = $1`, [
    dedupeKey,
  ]);
}

async function linha(dedupeKey: string) {
  const r = await query<{
    status: string;
    attempts: number;
    last_error: string | null;
    deliver_after: Date;
    provider_message_id: string | null;
    error_code: number | null;
    reported_at: Date | null;
    delivery_status: string | null;
  }>(
    `SELECT status, attempts, last_error, deliver_after, provider_message_id,
            error_code, reported_at, delivery_status
       FROM outbox WHERE dedupe_key = $1`,
    [dedupeKey]
  );
  return r[0];
}

d("canal Meta (Postgres real)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    metaSend.mockResolvedValue({ messageId: "wamid.MID" });
    zapiSend.mockResolvedValue({ messageId: "ZMID" });
    vi.stubEnv("WHATSAPP_PROVIDER", "meta");
    await query(`DELETE FROM outbox WHERE org_id = 'org-meta'`);
    await query(`DELETE FROM conversation_window WHERE phone = $1`, [PHONE]);
    await query(`DELETE FROM inbound_queue WHERE from_phone = $1`, [PHONE]);
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    await query(`DELETE FROM outbox WHERE org_id = 'org-meta'`);
    await query(`DELETE FROM conversation_window WHERE phone = $1`, [PHONE]);
    await query(`DELETE FROM inbound_queue WHERE from_phone = $1`, [PHONE]);
  });

  describe("janela de 24h no outbox", () => {
    /**
     * A Meta aceitaria com 200 e recusaria depois (131047). Represar ANTES é
     * o que evita queimar a notificação: nada é chamado, a tentativa volta.
     */
    it("janela fechada: não chama a Meta, represa 1h com a tentativa devolvida e o motivo", async () => {
      await linhaVencida("k-fechada");
      const totals = await dispatchDue();

      expect(metaSend).not.toHaveBeenCalled();
      expect(totals.held).toBe(1);
      expect(totals.sent).toBe(0);
      const l = await linha("k-fechada");
      expect(l.status).toBe("pending");
      expect(l.attempts).toBe(0);
      expect(l.last_error).toBe(MARCA_REQUER_TEMPLATE);
      expect(new Date(l.deliver_after).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    });

    it("janela aberta: sai como texto livre pela Meta e grava o wamid", async () => {
      await query(`INSERT INTO conversation_window (phone, last_inbound_at) VALUES ($1, now() - interval '2 hours')`, [
        PHONE,
      ]);
      await linhaVencida("k-aberta");
      const totals = await dispatchDue();

      expect(totals.sent).toBe(1);
      expect(metaSend).toHaveBeenCalledTimes(1);
      expect(zapiSend).not.toHaveBeenCalled();
      const l = await linha("k-aberta");
      expect(l.status).toBe("sent");
      expect(l.provider_message_id).toBe("wamid.MID");
    });

    it("janela vencida (25h) conta como fechada", async () => {
      await query(`INSERT INTO conversation_window (phone, last_inbound_at) VALUES ($1, now() - interval '25 hours')`, [
        PHONE,
      ]);
      await linhaVencida("k-vencida");
      const totals = await dispatchDue();
      expect(totals.held).toBe(1);
      expect(metaSend).not.toHaveBeenCalled();
    });

    /** A Z-API não tem janela: a regra não pode vazar para o canal antigo. */
    it("provedor Z-API ignora a janela", async () => {
      vi.stubEnv("WHATSAPP_PROVIDER", "");
      await linhaVencida("k-zapi");
      const totals = await dispatchDue();
      expect(totals.held).toBe(0);
      expect(totals.sent).toBe(1);
      expect(zapiSend).toHaveBeenCalledTimes(1);
    });
  });

  describe("abertura da janela pelo inbound", () => {
    const msg = (id: string, timestampMs: number | null) => ({
      messageId: id,
      fromPhone: PHONE,
      groupId: null,
      kind: "text" as const,
      text: "oi",
      mediaUrl: null,
      mimeType: null,
      timestampMs,
      senderName: null,
      replyToMessageId: null,
    });

    it("mensagem recebida abre a janela; reentrega atrasada não recua o relógio", async () => {
      expect(await janelaAberta(PHONE)).toBe(false);

      const agora = Date.now();
      await enqueueInbound(msg("wamid.IN1", agora - 60_000));
      expect(await janelaAberta(PHONE)).toBe(true);

      // Mensagem mais velha chegando depois (fora de ordem) não recua.
      await enqueueInbound(msg("wamid.IN0", agora - 30 * 60 * 60_000));
      const r = await query<{ t: Date }>(`SELECT last_inbound_at AS t FROM conversation_window WHERE phone = $1`, [
        PHONE,
      ]);
      expect(new Date(r[0].t).getTime()).toBeGreaterThan(agora - 2 * 60_000);
    });

    it("usa o instante da MENSAGEM: uma mensagem de 30h atrás não abre a janela", async () => {
      await enqueueInbound(msg("wamid.VELHA", Date.now() - 30 * 60 * 60_000));
      expect(await janelaAberta(PHONE)).toBe(false);
    });
  });

  describe("status de entrega da Meta", () => {
    async function enviada(dedupeKey: string, wamid: string) {
      await linhaVencida(dedupeKey);
      await query(
        `UPDATE outbox SET status = 'sent', sent_at = now(), provider_message_id = $2,
                reported_at = now() WHERE dedupe_key = $1`,
        [dedupeKey, wamid]
      );
    }

    /** Sem o DELIVERED no mapa, a entrega da Meta viraria `unconfirmed` em 15 min. */
    it("delivered e read da Meta sobem a linha", async () => {
      await enviada("k-dlv", "wamid.D");
      await applyStatusCallback({ status: "delivered", messageIds: ["wamid.D"], phone: PHONE, momment: Date.now() });
      expect((await linha("k-dlv")).delivery_status).toBe("delivered");
      await applyStatusCallback({ status: "read", messageIds: ["wamid.D"], phone: PHONE, momment: Date.now() });
      expect((await linha("k-dlv")).delivery_status).toBe("read");
    });

    it("failed assíncrono: `sent` vira `failed` com o código, e o report reabre", async () => {
      await enviada("k-fail", "wamid.F");
      const n = await applyFalhaDeEnvio({ messageId: "wamid.F", code: 131026, title: "Message undeliverable" });
      expect(n).toBe(1);
      const l = await linha("k-fail");
      expect(l.status).toBe("failed");
      expect(l.error_code).toBe(131026);
      expect(l.last_error).toContain("#131026");
      expect(l.reported_at).toBeNull();
    });

    it("failed não mexe em linha que não está `sent`, nem em wamid desconhecido", async () => {
      await linhaVencida("k-pend");
      await query(`UPDATE outbox SET provider_message_id = 'wamid.P' WHERE dedupe_key = 'k-pend'`);
      expect(await applyFalhaDeEnvio({ messageId: "wamid.P", code: 131047, title: "x" })).toBe(0);
      expect((await linha("k-pend")).status).toBe("pending");
      expect(await applyFalhaDeEnvio({ messageId: "wamid.NAOEXISTE", code: 1, title: null })).toBe(0);
    });
  });
});
