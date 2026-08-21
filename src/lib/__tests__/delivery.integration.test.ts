import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

/**
 * Reconciliação de entrega (008), contra o Postgres.
 *
 * O que se protege: o upgrade MONOTÔNICO (callbacks chegam fora de ordem e
 * reentregues), o `unconfirmed` de quem ficou sem notícia, e o report ao
 * Contractmaker carimbando `reported_at` só quando o POST deu certo.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const { applyStatusCallback, reconcile, mapZapiStatus } = await import("../delivery");
const { query, db } = await import("../db");

const MID = "PROV-MSG-1";
const REPLY_MID = "REPLY-MSG-1";

/**
 * Linha do outbox com `created_at` ANTIGO de propósito: o `reconcile` varre a
 * tabela inteira e ordena por `report_attempts, created_at`, então linhas
 * deixadas por outros arquivos de teste entrariam no lote antes destas e
 * roubariam a única tentativa que o `break` permite. Envelhecer as próprias
 * linhas vence a ordenação sem TOCAR nas alheias — mexer nelas disputaria
 * lock com o teste de claim concorrente do outbox.
 *
 * Envelhecer resolve a ORDEM, não a contagem: linha alheia elegível ainda
 * entra no lote DEPOIS das daqui e infla os totais. Por isso as asserções
 * abaixo olham o ESTADO das próprias linhas (reported_at, report_attempts),
 * e só usam `totals` onde o número é do próprio lote por construção.
 */
async function outboxRow(over: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO outbox (id, org_id, dedupe_key, audience, phone, recipient_name,
                         title, body, link_url, deal_id, org_name, deliver_after,
                         status, sent_at, provider_message_id, created_at)
     VALUES ($1, 'org-d', $2, 'platform_user', '5511900000088', 'Teste',
             't', 'b', NULL, NULL, 'Org', now(),
             'sent', COALESCE($4, now()), $3, now() - interval '365 days')`,
    [id, `dk-${id}`, over.provider_message_id ?? MID, over.sent_at ?? null]
  );
  return id;
}

async function outboxDe(id: string) {
  const r = await query<Record<string, unknown>>(
    `SELECT status, delivery_status, delivered_at, read_at, reported_at,
            dedupe_key, report_attempts
       FROM outbox WHERE id = $1`,
    [id]
  );
  return r[0];
}

d("entrega", () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await query(`DELETE FROM outbox WHERE org_id = 'org-d'`);
    await query(`DELETE FROM inbound_queue WHERE from_phone = '5511900000088'`);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await query(`DELETE FROM outbox WHERE org_id = 'org-d'`);
    await query(`DELETE FROM inbound_queue WHERE from_phone = '5511900000088'`);
    await db().end();
  });

  it("mapeia o vocabulário da Z-API e ignora o resto", () => {
    expect(mapZapiStatus("SENT")).toBe("sent");
    expect(mapZapiStatus("RECEIVED")).toBe("delivered");
    expect(mapZapiStatus("READ")).toBe("read");
    expect(mapZapiStatus("PLAYED")).toBe("read");
    expect(mapZapiStatus("QUALQUER")).toBeNull();
  });

  it("callback aplica o status e o timestamp do EVENTO", async () => {
    const id = await outboxRow();
    const applied = await applyStatusCallback({
      status: "RECEIVED",
      messageIds: [MID],
      phone: null,
      momment: Date.parse("2026-08-20T12:00:00Z"),
    });
    expect(applied.outbox).toBe(1);

    const row = await outboxDe(id);
    expect(row.delivery_status).toBe("delivered");
    expect(new Date(row.delivered_at as string).toISOString()).toBe(
      "2026-08-20T12:00:00.000Z"
    );
  });

  it("upgrade é monotônico: READ antes, RECEIVED atrasado não regride", async () => {
    const id = await outboxRow();

    await applyStatusCallback({ status: "READ", messageIds: [MID], phone: null, momment: null });
    const lido = await outboxDe(id);
    expect(lido.delivery_status).toBe("read");
    expect(lido.read_at).not.toBeNull();
    // READ implica entregue: delivered_at preenchido junto.
    expect(lido.delivered_at).not.toBeNull();

    const atrasado = await applyStatusCallback({
      status: "RECEIVED",
      messageIds: [MID],
      phone: null,
      momment: null,
    });
    expect(atrasado.outbox).toBe(0);
    expect((await outboxDe(id)).delivery_status).toBe("read");
  });

  it("id desconhecido não toca nada — é o caso normal", async () => {
    await outboxRow();
    const applied = await applyStatusCallback({
      status: "READ",
      messageIds: ["ID-DE-HUMANO"],
      phone: null,
      momment: null,
    });
    expect(applied).toEqual({ outbox: 0, replies: 0 });
  });

  it("a resposta do Max também fecha o laço (reply_message_id)", async () => {
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO inbound_queue (id, message_id, from_phone, kind, status, reply_message_id)
       VALUES ($1, $2, '5511900000088', 'text', 'done', $3)`,
      [id, `m-${id}`, REPLY_MID]
    );

    const applied = await applyStatusCallback({
      status: "READ",
      messageIds: [REPLY_MID],
      phone: null,
      momment: null,
    });
    expect(applied.replies).toBe(1);

    const r = await query<{ reply_delivery_status: string }>(
      `SELECT reply_delivery_status FROM inbound_queue WHERE id = $1`,
      [id]
    );
    expect(r[0].reply_delivery_status).toBe("read");
  });

  it("SENT sem RECEIVED também vira unconfirmed — número bloqueado não escapa", async () => {
    // O achado do review: callback SENT marcava delivery_status='sent' e a
    // linha ficava isenta da varredura para sempre.
    const id = await outboxRow({ sent_at: new Date(Date.now() - 20 * 60_000) });
    await applyStatusCallback({ status: "SENT", messageIds: [MID], phone: null, momment: null });
    expect((await outboxDe(id)).delivery_status).toBe("sent");

    await reconcile();
    // Estado da PRÓPRIA linha: `totals.unconfirmed` conta a tabela toda e
    // linha alheia de outro arquivo somaria junto.
    expect((await outboxDe(id)).delivery_status).toBe("unconfirmed");
  });

  it("muro na integração interrompe o lote SEM condenar as outras linhas", async () => {
    vi.stubEnv("MAX_WEBHOOK_SECRET", "s3");
    const idA = await outboxRow({ provider_message_id: "MID-A" });
    const idB = await outboxRow({ provider_message_id: "MID-B" });
    await applyStatusCallback({ status: "READ", messageIds: ["MID-A", "MID-B"], phone: null, momment: null });

    // Primeira linha bate num 500 → unavailable → break: a segunda nem é tentada.
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    const totals = await reconcile();
    expect(totals.reportUnavailable).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A linha que bateu no muro contou tentativa (rotação); a outra ficou intacta.
    const attempts = [
      (await outboxDe(idA)).report_attempts,
      (await outboxDe(idB)).report_attempts,
    ].sort();
    expect(attempts).toEqual([0, 1]);

    // Integração volta: as DUAS são reportadas — conferido nas próprias
    // linhas, porque `totals.reported` inclui linha de outro arquivo.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
    await reconcile();
    expect((await outboxDe(idA)).reported_at).not.toBeNull();
    expect((await outboxDe(idB)).reported_at).not.toBeNull();
  });

  it("report que o Contractmaker rejeita não monopoliza o lote (teto de tentativas)", async () => {
    vi.stubEnv("MAX_WEBHOOK_SECRET", "s3");
    const id = await outboxRow();
    await applyStatusCallback({ status: "READ", messageIds: [MID], phone: null, momment: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => "" }));

    // 422 é recusa de payload: conta tentativa e o lote SEGUE (sem break).
    await reconcile();
    expect((await outboxDe(id)).report_attempts).toBe(1);

    // No teto (60), a linha condenada sai do lote de vez.
    await query(`UPDATE outbox SET report_attempts = 59 WHERE id = $1`, [id]);
    await reconcile(); // 60ª tentativa — desiste com log
    await reconcile();
    // No teto, a linha sai do lote: o contador não anda mais.
    expect((await outboxDe(id)).report_attempts).toBe(60);
  });

  it("sent antigo sem callback vira unconfirmed; callback atrasado corrige", async () => {
    const id = await outboxRow({
      sent_at: new Date(Date.now() - 20 * 60_000),
    });

    await reconcile();
    // Estado da PRÓPRIA linha: `totals.unconfirmed` conta a tabela toda e
    // linha alheia de outro arquivo somaria junto.
    expect((await outboxDe(id)).delivery_status).toBe("unconfirmed");

    // A notícia atrasada tem razão sobre o "sem notícia".
    await applyStatusCallback({ status: "RECEIVED", messageIds: [MID], phone: null, momment: null });
    expect((await outboxDe(id)).delivery_status).toBe("delivered");
  });

  it("reporta desfecho ao Contractmaker e carimba reported_at só no sucesso", async () => {
    vi.stubEnv("MAX_WEBHOOK_SECRET", "s3");
    const id = await outboxRow();
    await applyStatusCallback({ status: "READ", messageIds: [MID], phone: null, momment: null });

    // 1ª passada: o outro lado ainda não tem a rota (404) → INTEGRAÇÃO fora,
    // segue devendo SEM queimar tentativa (o período pré-deploy da rota não
    // pode consumir o teto da linha).
    const fail = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "" });
    vi.stubGlobal("fetch", fail);
    await reconcile();
    expect((await outboxDe(id)).reported_at).toBeNull();
    // A tentativa CONTA (é o que rotaciona a fila), mas o teto de 60 e o
    // break impedem a perda do desfecho no pré-deploy.
    expect((await outboxDe(id)).report_attempts).toBe(1);

    // 2ª passada: rota no ar → reporta com HMAC e carimba.
    const ok = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", ok);
    await reconcile();
    expect((await outboxDe(id)).reported_at).not.toBeNull();

    const [url, init] = ok.mock.calls[0];
    expect(String(url)).toContain("/api/webhooks/max");
    expect(init.headers["x-max-signature"]).toBeTruthy();
    const body = JSON.parse(init.body);
    expect(body.status).toBe("read");
    expect(body.dedupeKey).toMatch(/^dk-/);
    // A costura exige org — o receptor recusa payload sem ele.
    expect(body.orgId).toBe("org-d");
  });

  it("sem MAX_WEBHOOK_SECRET o report é pulado sem barulho", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await outboxRow();
    await applyStatusCallback({ status: "READ", messageIds: [MID], phone: null, momment: null });

    // Aqui `totals` é seguro: sem secret o reconcile nem chega ao lote.
    const totals = await reconcile();
    expect(totals.reported).toBe(0);
    expect(totals.reportFailed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
