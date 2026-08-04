import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Integração de verdade, contra o Postgres.
 *
 * Como no outbox, o que está sob teste é SQL, não TypeScript: o
 * `ON CONFLICT DO NOTHING` que transforma reentrega da Z-API em duplicata, e o
 * claim com mudança de estado que impede o caminho rápido e o cron de
 * responderem a mesma mensagem. Mock não prova nenhum dos dois — ele devolve o
 * que eu mandar.
 *
 * Pula sem `DATABASE_URL` para que `npm test` continue verde em quem não tem
 * banco à mão.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

vi.mock("../zapi", () => ({
  sendText: vi.fn().mockResolvedValue({ messageId: "REPLY-MID" }),
  connectionStatus: vi.fn().mockResolvedValue({ connected: true, raw: {} }),
}));

vi.mock("@/graph/graph", () => ({
  runTurn: vi.fn().mockResolvedValue("resposta do Max"),
}));

const { enqueueInbound, sweepInbound, processInboundNow } = await import(
  "../inbound"
);
const { query, db } = await import("../db");
const { sendText, connectionStatus } = await import("../zapi");
const { runTurn } = await import("@/graph/graph");

const sent = sendText as unknown as ReturnType<typeof vi.fn>;
const turn = runTurn as unknown as ReturnType<typeof vi.fn>;
const status = connectionStatus as unknown as ReturnType<typeof vi.fn>;

const PHONE = "5511900000001";

function msg(over: Record<string, unknown> = {}) {
  return {
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    fromPhone: PHONE,
    groupId: null,
    kind: "text",
    text: "como funciona a assinatura?",
    mediaUrl: null,
    mimeType: null,
    timestampMs: 1754300000000,
    senderName: "Wesley",
    replyToMessageId: null,
    ...over,
  } as Parameters<typeof enqueueInbound>[0];
}

async function statusDe(id: string) {
  const r = await query<{
    status: string;
    attempts: number;
    reply_text: string | null;
    reply_message_id: string | null;
    last_error: string | null;
  }>(
    `SELECT status, attempts, reply_text, reply_message_id, last_error
       FROM inbound_queue WHERE id = $1`,
    [id]
  );
  return r[0];
}

d("inbound_queue (Postgres real)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    sent.mockResolvedValue({ messageId: "REPLY-MID" });
    turn.mockResolvedValue("resposta do Max");
    status.mockResolvedValue({ connected: true, raw: {} });
    await query(`DELETE FROM inbound_queue WHERE from_phone = $1`, [PHONE]);
  });

  afterAll(async () => {
    await query(`DELETE FROM inbound_queue WHERE from_phone = $1`, [PHONE]);
    await db().end();
  });

  it("aceita a mensagem e devolve o id da linha", async () => {
    const r = await enqueueInbound(msg());
    expect(r.status).toBe("queued");
  });

  /**
   * A Z-API reentrega em timeout. A reentrega não pode virar um segundo turn —
   * era este o motivo do `inbound_seen`, e a fila herdou a responsabilidade.
   */
  it("mesmo messageId é duplicata, não segundo turn", async () => {
    const m = msg({ messageId: "m-dup" });
    const first = await enqueueInbound(m);
    const second = await enqueueInbound(m);

    expect(first.status).toBe("queued");
    expect(second.status).toBe("duplicate");
    expect(second.id).toBe(first.status === "queued" ? first.id : null);
  });

  it("processa, responde e fecha o laço", async () => {
    const r = await enqueueInbound(msg());
    if (r.status !== "queued") throw new Error("esperava queued");

    await processInboundNow(r.id);

    const row = await statusDe(r.id);
    expect(row.status).toBe("done");
    expect(row.reply_message_id).toBe("REPLY-MID");
    expect(sent).toHaveBeenCalledTimes(1);
  });

  /**
   * O invariante que justifica a coluna `reply_text`.
   *
   * Se o grafo respondeu e só o ENVIO caiu, a retentativa não pode re-invocar o
   * grafo: o checkpointer já gravou o turn, então a fala da pessoa apareceria
   * duas vezes na thread — e o modelo seria pago de novo.
   */
  it("envio falho preserva a resposta e a retentativa não roda o grafo de novo", async () => {
    const r = await enqueueInbound(msg());
    if (r.status !== "queued") throw new Error("esperava queued");

    sent.mockRejectedValueOnce(new Error("z-api fora do ar"));
    await processInboundNow(r.id);

    const meio = await statusDe(r.id);
    expect(meio.status).toBe("pending"); // volta pra fila, não morre
    expect(meio.reply_text).toBe("resposta do Max");
    expect(turn).toHaveBeenCalledTimes(1);

    // O cron retoma.
    const totals = await sweepInbound();
    expect(totals.done).toBeGreaterThanOrEqual(1);

    const fim = await statusDe(r.id);
    expect(fim.status).toBe("done");
    // O ponto: o grafo NÃO rodou de novo.
    expect(turn).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(2);
  });

  /**
   * O caminho rápido (`waitUntil`) e o cron correm juntos. O claim muda o
   * estado, então só um dos dois pega a linha — se ambos pegassem, a pessoa
   * receberia a mesma resposta duas vezes.
   */
  it("cron e caminho rápido não processam a mesma linha", async () => {
    const r = await enqueueInbound(msg());
    if (r.status !== "queued") throw new Error("esperava queued");

    await Promise.all([processInboundNow(r.id), sweepInbound()]);

    expect(sent).toHaveBeenCalledTimes(1);
    const row = await statusDe(r.id);
    expect(row.status).toBe("done");
    expect(row.attempts).toBe(1);
  });

  /**
   * Claim órfão: a function morreu entre reivindicar e responder. Sem a
   * recuperação por tempo, a linha ficaria em `processing` para sempre — que é
   * exatamente o silêncio que esta fila existe para eliminar.
   */
  it("processing vencido volta a ser reivindicável", async () => {
    const r = await enqueueInbound(msg());
    if (r.status !== "queued") throw new Error("esperava queued");

    await query(
      `UPDATE inbound_queue
          SET status = 'processing', attempts = 1,
              last_attempt_at = now() - interval '30 minutes'
        WHERE id = $1`,
      [r.id]
    );

    const totals = await sweepInbound();
    expect(totals.claimed).toBeGreaterThanOrEqual(1);
    expect((await statusDe(r.id)).status).toBe("done");
  });

  it("esgotadas as tentativas vira failed, não fica girando", async () => {
    const r = await enqueueInbound(msg());
    if (r.status !== "queued") throw new Error("esperava queued");

    turn.mockRejectedValue(new Error("modelo fora"));
    await query(`UPDATE inbound_queue SET attempts = 3 WHERE id = $1`, [r.id]);

    await processInboundNow(r.id);

    const row = await statusDe(r.id);
    expect(row.status).toBe("failed");
    expect(row.last_error).toContain("modelo fora");
  });

  /**
   * Grafo que decide não responder é RESULTADO, não erro: a linha fecha e o
   * modelo não roda de novo.
   */
  it("resposta nula fecha a linha sem enviar nada", async () => {
    const r = await enqueueInbound(msg());
    if (r.status !== "queued") throw new Error("esperava queued");

    turn.mockResolvedValue(null);
    await processInboundNow(r.id);

    const row = await statusDe(r.id);
    expect(row.status).toBe("done");
    expect(row.reply_message_id).toBeNull();
    expect(sent).not.toHaveBeenCalled();
  });

  /**
   * Instância fora do ar — a mesma armadilha do outbox, deste lado.
   *
   * Sem a checagem, `sendText` responde 200 com um `messageId` que não chega a
   * ninguém e a linha vira `done` com `reply_message_id`: o registro afirmando
   * que a pessoa foi respondida quando não foi.
   */
  describe("instância desemparelhada", () => {
    it("não processa, não paga o modelo e não queima tentativa", async () => {
      const r = await enqueueInbound(msg());
      if (r.status !== "queued") throw new Error("esperava queued");
      status.mockResolvedValue({ connected: false, raw: {} });

      await processInboundNow(r.id);
      const totals = await sweepInbound();

      expect(turn).not.toHaveBeenCalled(); // o modelo não é pago à toa
      expect(sent).not.toHaveBeenCalled();
      expect(totals.blocked).toBeGreaterThanOrEqual(1);

      const row = await statusDe(r.id);
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(0);
    });

    it("reconectou: a mensagem é respondida, nada se perdeu", async () => {
      const r = await enqueueInbound(msg());
      if (r.status !== "queued") throw new Error("esperava queued");

      status.mockResolvedValue({ connected: false, raw: {} });
      await sweepInbound();

      status.mockResolvedValue({ connected: true, raw: {} });
      const totals = await sweepInbound();

      expect(totals.done).toBeGreaterThanOrEqual(1);
      expect((await statusDe(r.id)).status).toBe("done");
    });

    it("status indisponível → processa mesmo assim (falha aberta)", async () => {
      const r = await enqueueInbound(msg());
      if (r.status !== "queued") throw new Error("esperava queued");
      status.mockRejectedValue(new Error("timeout"));

      await processInboundNow(r.id);

      expect((await statusDe(r.id)).status).toBe("done");
    });

    it("fila vazia não paga a consulta de status", async () => {
      await sweepInbound();
      expect(status).not.toHaveBeenCalled();
    });
  });
});
