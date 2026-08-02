import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Integração de verdade, contra o Postgres.
 *
 * O que está sendo testado aqui NÃO é lógica de TypeScript — é SQL: o
 * `ON CONFLICT DO NOTHING ... RETURNING` que transforma reenvio em 409, e o
 * `FOR UPDATE SKIP LOCKED` que impede duas execuções sobrepostas do cron de
 * mandar a mesma mensagem duas vezes. Nenhum dos dois pode ser provado com
 * mock: um mock devolve o que eu mandar ele devolver.
 *
 * Pula sem `DATABASE_URL` para que `npm test` continue verde na máquina de
 * quem não tem banco à mão.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

vi.mock("../zapi", () => ({
  sendText: vi.fn().mockResolvedValue({ messageId: "MID" }),
}));

const { enqueue, dispatchDue, renderMessage } = await import("../outbox");
const { query, db } = await import("../db");
const { sendText } = await import("../zapi");

const sent = sendText as unknown as ReturnType<typeof vi.fn>;

function args(over: Partial<Parameters<typeof enqueue>[0]> = {}) {
  return {
    orgId: "org-test",
    dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
    audience: "platform_user",
    phone: "5511987654321",
    recipientName: "Marcia Gerente",
    title: "Contrato pronto",
    body: "O contrato foi gerado.",
    linkUrl: "https://imobpro.ia.br/deals/1",
    dealId: "deal1",
    orgName: "RE/MAX Trio",
    ...over,
  };
}

d("outbox (Postgres real)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    sent.mockResolvedValue({ messageId: "MID" });
    await query(`DELETE FROM outbox WHERE org_id = 'org-test'`);
  });

  afterAll(async () => {
    await query(`DELETE FROM outbox WHERE org_id = 'org-test'`);
    await db().end();
  });

  it("enfileira e devolve o horário de entrega", async () => {
    const r = await enqueue(args());
    expect(r.status).toBe("queued");
  });

  /**
   * A dedupeKey é o id da linha de log do ImobPro. Se o motor de lá reentregar
   * o mesmo evento (webhook reprocessado, retry de rede), NÃO pode virar duas
   * mensagens no celular de alguém.
   */
  it("mesma dedupeKey é duplicata, não segunda mensagem", async () => {
    const a = args({ dedupeKey: "k-dup" });
    const first = await enqueue(a);
    const second = await enqueue(a);

    expect(first.status).toBe("queued");
    expect(second.status).toBe("duplicate");
    if (second.status === "duplicate") {
      expect(second.id).toBe(first.status === "queued" ? first.id : "");
    }

    const rows = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM outbox WHERE dedupe_key = 'k-dup'`
    );
    expect(rows[0].n).toBe("1");
  });

  it("despacha o que está vencido e marca sent com o id do provedor", async () => {
    await enqueue(args({ dedupeKey: "k-send" }));
    await query(
      `UPDATE outbox SET deliver_after = now() - interval '1 minute' WHERE dedupe_key = 'k-send'`
    );

    const totals = await dispatchDue();

    expect(totals.sent).toBeGreaterThanOrEqual(1);
    expect(sent).toHaveBeenCalled();
    const row = await query<{ status: string; provider_message_id: string | null }>(
      `SELECT status, provider_message_id FROM outbox WHERE dedupe_key = 'k-send'`
    );
    expect(row[0].status).toBe("sent");
    expect(row[0].provider_message_id).toBe("MID");
  });

  /** O que ainda não venceu não pode sair — é a janela 7h–22h em ação. */
  it("não toca no que está agendado pro futuro", async () => {
    await enqueue(args({ dedupeKey: "k-future" }));
    await query(
      `UPDATE outbox SET deliver_after = now() + interval '3 hours' WHERE dedupe_key = 'k-future'`
    );

    await dispatchDue();

    const row = await query<{ status: string }>(
      `SELECT status FROM outbox WHERE dedupe_key = 'k-future'`
    );
    expect(row[0].status).toBe("pending");
    expect(sent).not.toHaveBeenCalled();
  });

  /**
   * Falha transitória volta pra `pending` com backoff — desistir na primeira
   * tentativa perderia a notificação, porque não há reconciliação do lado do
   * ImobPro.
   */
  it("falha reagenda em vez de descartar, e só desiste no fim das tentativas", async () => {
    sent.mockRejectedValue(new Error("Z-API 500"));
    await enqueue(args({ dedupeKey: "k-fail" }));
    await query(
      `UPDATE outbox SET deliver_after = now() - interval '1 minute' WHERE dedupe_key = 'k-fail'`
    );

    await dispatchDue();
    let row = await query<{ status: string; attempts: number; last_error: string }>(
      `SELECT status, attempts, last_error FROM outbox WHERE dedupe_key = 'k-fail'`
    );
    expect(row[0].status).toBe("pending");
    expect(row[0].attempts).toBe(1);
    expect(row[0].last_error).toContain("Z-API 500");

    // Esgota as tentativas.
    for (let i = 0; i < 3; i++) {
      await query(
        `UPDATE outbox SET deliver_after = now() - interval '1 minute' WHERE dedupe_key = 'k-fail'`
      );
      await dispatchDue();
    }

    row = await query<{ status: string; attempts: number; last_error: string }>(
      `SELECT status, attempts, last_error FROM outbox WHERE dedupe_key = 'k-fail'`
    );
    expect(row[0].status).toBe("failed");
  });

  /**
   * `FOR UPDATE SKIP LOCKED`: a Vercel pode disparar o cron de novo antes de o
   * anterior terminar. Duas passadas concorrentes têm que dividir o trabalho,
   * nunca repetir.
   */
  it("execuções concorrentes do cron não despacham a mesma linha duas vezes", async () => {
    for (let i = 0; i < 6; i++) {
      await enqueue(args({ dedupeKey: `k-race-${i}` }));
    }
    await query(
      `UPDATE outbox SET deliver_after = now() - interval '1 minute' WHERE org_id = 'org-test'`
    );

    const [a, b] = await Promise.all([dispatchDue(), dispatchDue()]);

    expect(a.claimed + b.claimed).toBe(6);
    expect(sent).toHaveBeenCalledTimes(6);
  });
});

describe("renderMessage", () => {
  it("monta a mensagem a partir dos campos separados que o ImobPro manda", () => {
    const out = renderMessage({
      title: "Contrato assinado",
      body: "Todas as partes assinaram.",
      link_url: "https://imobpro.ia.br/deals/1",
      org_name: "RE/MAX Trio",
      recipient_name: "Marcia Gerente",
    });
    expect(out).toContain("Oi, Marcia!");
    expect(out).toContain("*Contrato assinado*");
    expect(out).toContain("https://imobpro.ia.br/deals/1");
    expect(out).toContain("— RE/MAX Trio");
  });

  it("sem nome do destinatário não vira 'Oi, !'", () => {
    const out = renderMessage({
      title: "T",
      body: "B",
      link_url: null,
      org_name: "",
      recipient_name: "",
    });
    expect(out).not.toContain("Oi, !");
    expect(out.startsWith("*T*")).toBe(true);
  });
});
