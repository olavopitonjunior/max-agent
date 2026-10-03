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
  sendTemplate: vi.fn().mockResolvedValue({ messageId: "wamid.TPL" }),
  connectionStatus: vi.fn().mockResolvedValue({ connected: true, raw: {} }),
}));
vi.mock("../zapi", async (orig) => ({
  ...(await orig<typeof import("../zapi")>()),
  sendText: vi.fn().mockResolvedValue({ messageId: "ZMID" }),
  connectionStatus: vi.fn().mockResolvedValue({ connected: true, raw: {} }),
}));

const { enqueue, dispatchDue, MARCA_TEMPLATE_PENDENTE, MARCA_FORA_DA_REGUA, MARCA_TEMPLATE_INVALIDO } =
  await import("../outbox");
const { MetaHttpError } = await import("../transport/erro");
const { enqueueInbound } = await import("../inbound");
const { janelaAberta } = await import("../janela24h");
const { applyFalhaDeEnvio, applyStatusCallback } = await import("../delivery");
const { query } = await import("../db");
const meta = await import("../meta");
const zapi = await import("../zapi");

const PHONE = "5511900001111";
const metaSend = meta.sendText as unknown as ReturnType<typeof vi.fn>;
const metaSendTemplate = meta.sendTemplate as unknown as ReturnType<typeof vi.fn>;
const zapiSend = zapi.sendText as unknown as ReturnType<typeof vi.fn>;

/** Template da linha padrão (`kind: form_completed`). */
const TPL = "max_formulario_concluido";

async function linhaVencida(dedupeKey: string, kind: string | null = "form_completed") {
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
    kind,
    params: { negocio: "Venda Apto 302" },
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
    template_name: string | null;
  }>(
    `SELECT status, attempts, last_error, deliver_after, provider_message_id,
            error_code, reported_at, delivery_status, template_name
       FROM outbox WHERE dedupe_key = $1`,
    [dedupeKey]
  );
  return r[0];
}

d("canal Meta (Postgres real)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    metaSend.mockResolvedValue({ messageId: "wamid.MID" });
    metaSendTemplate.mockResolvedValue({ messageId: "wamid.TPL" });
    zapiSend.mockResolvedValue({ messageId: "ZMID" });
    vi.stubEnv("WHATSAPP_PROVIDER", "meta");
    await query(`DELETE FROM outbox WHERE org_id = 'org-meta'`);
    await query(`DELETE FROM conversation_window WHERE phone = $1`, [PHONE]);
    await query(`DELETE FROM inbound_queue WHERE from_phone = $1`, [PHONE]);
    // Sem isto, um teste que aprova o template vazaria pro próximo.
    await query(`DELETE FROM wa_template WHERE name = $1`, [TPL]);
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    await query(`DELETE FROM outbox WHERE org_id = 'org-meta'`);
    await query(`DELETE FROM conversation_window WHERE phone = $1`, [PHONE]);
    await query(`DELETE FROM inbound_queue WHERE from_phone = $1`, [PHONE]);
    await query(`DELETE FROM wa_template WHERE name = $1`, [TPL]);
  });

  describe("janela de 24h no outbox", () => {
    /**
     * A Meta aceitaria com 200 e recusaria depois (131047). Represar ANTES é
     * o que evita queimar a notificação: nada é chamado, a tentativa volta.
     */
    it("janela fechada, sem template aprovado: não chama a Meta, represa 1h com a tentativa devolvida e o motivo", async () => {
      await linhaVencida("k-fechada");
      const totals = await dispatchDue();

      expect(metaSend).not.toHaveBeenCalled();
      expect(metaSendTemplate).not.toHaveBeenCalled();
      expect(totals.held).toBe(1);
      expect(totals.sent).toBe(0);
      const l = await linha("k-fechada");
      expect(l.status).toBe("pending");
      expect(l.attempts).toBe(0);
      expect(l.last_error).toBe(MARCA_TEMPLATE_PENDENTE);
      expect(new Date(l.deliver_after).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    });

    it("janela fechada, template APROVADO: sai por template, não por texto livre", async () => {
      await query(
        `INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'APPROVED')`,
        [TPL]
      );
      await linhaVencida("k-template");
      const totals = await dispatchDue();

      expect(metaSend).not.toHaveBeenCalled();
      expect(metaSendTemplate).toHaveBeenCalledTimes(1);
      expect(metaSendTemplate.mock.calls[0][0]).toMatchObject({
        name: TPL,
        lang: "pt_BR",
        bodyParams: ["Ana", "FINCasa", "Venda Apto 302"],
      });
      expect(totals.sent).toBe(1);
      const l = await linha("k-template");
      expect(l.status).toBe("sent");
      expect(l.provider_message_id).toBe("wamid.TPL");
      expect(l.template_name).toBe(TPL);
      // Template da equipe: o botão leva o id da linha (redirecionador /r/<id>).
      const [b] = metaSendTemplate.mock.calls[0][0].botoes;
      expect(b.tipo).toBe("url");
      expect(typeof b.param).toBe("string");
    });

    /**
     * 132xxx no envio: o template existe mas a Meta o recusou (parâmetro,
     * pausa). Marca própria com o código — misturada ao "aguardando
     * aprovação", um template quebrado em loop passava despercebido.
     */
    it("template recusado no envio (132000): represa com marca própria e o código da Meta", async () => {
      await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'APPROVED')`, [TPL]);
      metaSendTemplate.mockRejectedValueOnce(
        new MetaHttpError("/messages", 400, JSON.stringify({ error: { code: 132000, message: "params" } }))
      );
      await linhaVencida("k-132000");
      const totals = await dispatchDue();
      expect(totals.held).toBe(1);
      const l = await linha("k-132000");
      expect(l.status).toBe("pending");
      expect(l.last_error).toBe(`${MARCA_TEMPLATE_INVALIDO} (#132000, ${TPL})`);
      expect(l.last_error).not.toBe(MARCA_TEMPLATE_PENDENTE);
      // O código fica em error_code: last_error é sobrescrito pelo próximo desfecho.
      expect(l.error_code).toBe(132000);
    });

    /** v2 transacional assume quando aprovado; até lá o v1 segue valendo. */
    it("usa o v2 quando aprovado; sem o v2, o v1; nenhum aprovado, represa", async () => {
      const V2 = `${TPL}_v2`;
      try {
        await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'APPROVED')`, [TPL]);
        await linhaVencida("k-v1");
        await dispatchDue();
        expect(metaSendTemplate.mock.calls.at(-1)![0].name).toBe(TPL);

        await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'APPROVED')`, [V2]);
        await linhaVencida("k-v2");
        await dispatchDue();
        expect(metaSendTemplate.mock.calls.at(-1)![0].name).toBe(V2);
        expect((await linha("k-v2")).template_name).toBe(V2);
      } finally {
        await query(`DELETE FROM wa_template WHERE name = $1`, [V2]);
      }
    });

    it("v2 recusado pela Meta no envio: a próxima passada vai pelo v1 aprovado, não repete o v2", async () => {
      const V2 = `${TPL}_v2`;
      try {
        await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'APPROVED'), ($2, 'pt_BR', 'APPROVED')`, [TPL, V2]);
        await linhaVencida("k-recusa");
        await query(
          `UPDATE outbox SET last_error = $2 WHERE dedupe_key = $1`,
          ["k-recusa", `${MARCA_TEMPLATE_INVALIDO} (#132015, ${V2})`]
        );
        await dispatchDue();
        expect(metaSendTemplate.mock.calls.at(-1)![0].name).toBe(TPL);
      } finally {
        await query(`DELETE FROM wa_template WHERE name = $1`, [V2]);
      }
    });

    it("entre aprovados, prefere o que a Meta não classificou como MARKETING", async () => {
      const V2 = `${TPL}_v2`;
      try {
        await query(
          `INSERT INTO wa_template (name, lang, status, category) VALUES ($1, 'pt_BR', 'APPROVED', 'UTILITY'), ($2, 'pt_BR', 'APPROVED', 'MARKETING')`,
          [TPL, V2]
        );
        await linhaVencida("k-cat");
        await dispatchDue();
        expect(metaSendTemplate.mock.calls.at(-1)![0].name).toBe(TPL);
      } finally {
        await query(`DELETE FROM wa_template WHERE name = $1`, [V2]);
      }
    });

    /** A parte não tem link: o template dela é aprovado SEM botão. */
    it("template da PARTE sai sem parâmetro de botão", async () => {
      await query(
        `INSERT INTO wa_template (name, lang, status) VALUES ('max_contrato_assinado_parte', 'pt_BR', 'APPROVED')
         ON CONFLICT (name) DO UPDATE SET status = 'APPROVED'`
      );
      await linhaVencida("k-parte");
      await query(`UPDATE outbox SET kind = 'contract_signed_parte', link_url = NULL WHERE dedupe_key = 'k-parte'`);
      try {
        const totals = await dispatchDue();
        expect(totals.sent).toBe(1);
        expect(metaSendTemplate.mock.calls[0][0]).toMatchObject({
          name: "max_contrato_assinado_parte",
          botoes: [],
        });
      } finally {
        await query(`DELETE FROM wa_template WHERE name = 'max_contrato_assinado_parte'`);
      }
    });

    /**
     * Régua de 01/10: tipo sem template não vira mensagem paga genérica.
     * Fora da janela ele desiste na hora — represar seria esperar uma
     * aprovação que nunca vem.
     */
    it.each([["stage_change"], [null]])(
      "janela fechada, tipo FORA DA RÉGUA (%s): não chama a Meta e falha com o motivo",
      async (kind) => {
        await linhaVencida(`k-fora-${kind}`, kind);
        const totals = await dispatchDue();

        expect(metaSend).not.toHaveBeenCalled();
        expect(metaSendTemplate).not.toHaveBeenCalled();
        expect(totals.failed).toBe(1);
        const l = await linha(`k-fora-${kind}`);
        expect(l.status).toBe("failed");
        expect(l.last_error).toBe(MARCA_FORA_DA_REGUA);
      }
    );

    it("tipo fora da régua com a janela ABERTA ainda sai, como texto livre", async () => {
      await query(`INSERT INTO conversation_window (phone, last_inbound_at) VALUES ($1, now() - interval '1 hour')`, [
        PHONE,
      ]);
      await linhaVencida("k-fora-aberta", "stage_change");
      const totals = await dispatchDue();
      expect(totals.sent).toBe(1);
      expect(metaSend).toHaveBeenCalledTimes(1);
      expect(metaSendTemplate).not.toHaveBeenCalled();
    });

    it("janela aberta: sai como texto livre pela Meta e grava o wamid", async () => {
      await query(`INSERT INTO conversation_window (phone, last_inbound_at) VALUES ($1, now() - interval '2 hours')`, [
        PHONE,
      ]);
      await linhaVencida("k-aberta");
      const totals = await dispatchDue();

      expect(totals.sent).toBe(1);
      expect(metaSend).toHaveBeenCalledTimes(1);
      expect(metaSendTemplate).not.toHaveBeenCalled();
      expect(zapiSend).not.toHaveBeenCalled();
      const l = await linha("k-aberta");
      expect(l.status).toBe("sent");
      expect(l.provider_message_id).toBe("wamid.MID");
      expect(l.template_name).toBeNull();
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

    /** Fora de ordem: a mensagem CHEGOU; reportar falha seria mentir. */
    it("failed depois de delivered não regride a linha", async () => {
      await enviada("k-dlv-fail", "wamid.DF");
      await applyStatusCallback({ status: "delivered", messageIds: ["wamid.DF"], phone: PHONE, momment: Date.now() });
      expect(await applyFalhaDeEnvio({ messageId: "wamid.DF", code: 131000, title: "x" })).toBe(0);
      const l = await linha("k-dlv-fail");
      expect(l.status).toBe("sent");
      expect(l.delivery_status).toBe("delivered");
    });

    it("failed não mexe em linha que não está `sent`, nem em wamid desconhecido", async () => {
      await linhaVencida("k-pend");
      await query(`UPDATE outbox SET provider_message_id = 'wamid.P' WHERE dedupe_key = 'k-pend'`);
      expect(await applyFalhaDeEnvio({ messageId: "wamid.P", code: 131047, title: "x" })).toBe(0);
      expect((await linha("k-pend")).status).toBe("pending");
      expect(await applyFalhaDeEnvio({ messageId: "wamid.NAOEXISTE", code: 1, title: null })).toBe(0);
    });

    /**
     * 131047 ASSÍNCRONO (a Meta aceitou com 200 e recusou depois, no
     * webhook): NÃO é falha permanente. A linha volta a `pending`, pronta pro
     * próximo `dispatchDue` — que agora vai achar a janela fechada de
     * verdade e tentar por template.
     */
    /**
     * A linha PRECISA vir de um `dispatchDue` real: só ele grava
     * `send_started_at`, que é justamente o marcador cujo esquecimento
     * causava o sucesso falso (achado do code review no C1). Um `enviada()`
     * sintético não reproduzia o bug.
     */
    it("131047 assíncrono limpa send_started_at — sem isso o PRÓXIMO dispatchDue liquidaria como 'sent' sem reenviar", async () => {
      // 1) Envio real por texto livre, janela aberta — deixa send_started_at gravado.
      await query(`INSERT INTO conversation_window (phone, last_inbound_at) VALUES ($1, now() - interval '1 hour')`, [
        PHONE,
      ]);
      await linhaVencida("k-131047");
      await dispatchDue();
      const antes = await linha("k-131047");
      expect(antes.status).toBe("sent");
      expect(antes.provider_message_id).toBe("wamid.MID");

      // 2) A Meta aceitou e recusou depois: webhook assíncrono 131047.
      const n = await applyFalhaDeEnvio({ messageId: "wamid.MID", code: 131047, title: "Re-engagement message" });
      expect(n).toBe(1);
      const depois = await linha("k-131047");
      expect(depois.status).toBe("pending");
      expect(depois.provider_message_id).toBeNull();
      expect(depois.template_name).toBeNull();
      expect(depois.last_error).toContain("#131047");
      expect(depois.error_code).toBeNull(); // não é `failed`: error_code é só do desfecho terminal

      // 3) Janela fechou de verdade e o template está aprovado: o PRÓXIMO
      //    dispatchDue precisa REENVIAR por template — não liquidar em
      //    silêncio como "órfã com envio já iniciado" (o bug do C1: sem
      //    limpar send_started_at, cairia ali e nunca chamaria sendTemplate).
      await query(`DELETE FROM conversation_window WHERE phone = $1`, [PHONE]);
      await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'APPROVED')`, [TPL]);
      await query(`UPDATE outbox SET deliver_after = now() - interval '1 minute' WHERE dedupe_key = 'k-131047'`);
      metaSend.mockClear();
      metaSendTemplate.mockClear();
      const totals2 = await dispatchDue();

      expect(totals2.sent).toBe(1);
      expect(metaSendTemplate).toHaveBeenCalledTimes(1);
      expect(metaSend).not.toHaveBeenCalled();
      const final = await linha("k-131047");
      expect(final.status).toBe("sent");
      expect(final.template_name).toBe(TPL);
      expect(final.provider_message_id).toBe("wamid.TPL");
      expect(final.last_error).toBeNull();
    });
  });
});
