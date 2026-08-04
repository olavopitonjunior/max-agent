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
  runTurn: vi.fn().mockResolvedValue({ reply: "resposta do Max" }),
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
    turn.mockResolvedValue({ reply: "resposta do Max" });
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

  /**
   * ── Serialização por telefone ────────────────────────────────────────────
   *
   * Duas mensagens em segundos abrem duas invocações de function. Cada uma
   * reivindica a SUA linha — o compare-and-swap só impede pegar a MESMA linha
   * duas vezes — e as duas fazem `invoke` no mesmo `thread_id`.
   *
   * Antes da escrita no grafo o prejuízo era histórico perdido. Com escrita,
   * passa a ser criar dois formulários: "cria um form" seguido de "sim" antes
   * de o primeiro turn terminar, e os dois leem o checkpoint pré-confirmação.
   */
  it("segunda mensagem do mesmo telefone não roda em paralelo com a primeira", async () => {
    const a = await enqueueInbound(msg({ messageId: "m-serial-1" }));
    const b = await enqueueInbound(msg({ messageId: "m-serial-2" }));
    if (a.status !== "queued" || b.status !== "queued") {
      throw new Error("esperava queued");
    }

    // Segura o primeiro turn enquanto a varredura tenta pegar o segundo.
    let liberar!: () => void;
    const emCurso = new Promise<void>((r) => (liberar = r));
    turn.mockImplementationOnce(async () => {
      await emCurso;
      return { reply: "resposta do Max" };
    });

    const primeiro = processInboundNow(a.id);
    await vi.waitFor(async () => {
      expect((await statusDe(a.id)).status).toBe("processing");
    });

    // O cron roda no meio. Não pode encostar na segunda linha deste telefone.
    const totals = await sweepInbound();
    expect(totals.claimed).toBe(0);
    expect((await statusDe(b.id)).status).toBe("pending");

    liberar();
    await primeiro;

    // Liberado o primeiro, o caminho rápido DRENA a segunda em vez de deixá-la
    // esperar o próximo cron — a serialização não pode custar um minuto de
    // silêncio no meio de uma conversa.
    expect((await statusDe(b.id)).status).toBe("done");
    expect(turn).toHaveBeenCalledTimes(2);
  });

  /**
   * A prova que faltava — e que expôs o bug.
   *
   * O teste acima espera a primeira linha virar `processing` ANTES de tentar a
   * segunda, ou seja, espera a primeira transação COMMITAR. Com isso ele prova
   * que uma linha já em processamento bloqueia — e não prova nada sobre o que
   * importa: duas transações cujas janelas se SOBREPÕEM.
   *
   * Sob READ COMMITTED, o `NOT EXISTS` do claim é uma leitura sem lock: ela não
   * enxerga escrita não-commitada da outra transação. Antes da migration 006 as
   * duas passavam e dois turns do mesmo telefone rodavam no mesmo `thread_id` —
   * check-then-act clássico, exatamente o bug que a serialização dizia fechar.
   *
   * Aqui as duas transações são abertas à mão e ficam vivas ao mesmo tempo, o
   * que só é possível com conexões dedicadas (o `query()` do módulo é
   * autocommit por statement).
   */
  it("duas transações SOBREPOSTAS não reivindicam o mesmo telefone", async () => {
    const a = await enqueueInbound(msg({ messageId: "m-corrida-1" }));
    const b = await enqueueInbound(msg({ messageId: "m-corrida-2" }));
    if (a.status !== "queued" || b.status !== "queued") {
      throw new Error("esperava queued");
    }

    const c1 = await db().connect();
    const c2 = await db().connect();
    const CLAIM = `UPDATE inbound_queue
        SET status = 'processing', attempts = attempts + 1, last_attempt_at = now()
      WHERE id = $1 AND status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM inbound_queue outro
           WHERE outro.from_phone = inbound_queue.from_phone
             AND outro.id <> inbound_queue.id
             AND outro.status = 'processing')
      RETURNING id`;

    try {
      await c1.query("BEGIN");
      await c2.query("BEGIN");

      const r1 = await c1.query(CLAIM, [a.id]);
      expect(r1.rowCount).toBe(1); // a primeira sempre passa

      // A segunda roda com a primeira AINDA não commitada. Sem o índice da 006
      // ela também passaria — o `NOT EXISTS` não vê a escrita da outra.
      // Com o índice, ela bloqueia até o commit e então falha com 23505.
      const segunda = c2.query(CLAIM, [b.id]).then(
        (r) => ({ ok: true as const, rows: r.rowCount }),
        (err: { code?: string }) => ({ ok: false as const, code: err.code })
      );

      await c1.query("COMMIT");
      const resultado = await segunda;
      await c2.query("COMMIT").catch(() => c2.query("ROLLBACK"));

      // Ou o índice recusou (23505), ou o compare-and-swap não casou. O que
      // NÃO pode acontecer é as duas reivindicarem.
      if (resultado.ok) {
        expect(resultado.rows).toBe(0);
      } else {
        expect(resultado.code).toBe("23505");
      }

      const processando = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM inbound_queue
          WHERE from_phone = $1 AND status = 'processing'`,
        [PHONE]
      );
      expect(processando[0].n).toBe(1);
    } finally {
      c1.release();
      c2.release();
      await query(
        `UPDATE inbound_queue SET status = 'done', settled_at = now()
          WHERE from_phone = $1 AND status = 'processing'`,
        [PHONE]
      );
    }
  });

  /**
   * O dreno só pega mensagem NOVA (`attempts = 0`).
   *
   * Sem esse recorte ele repescaria a linha que acabou de falhar — ela voltou a
   * `pending`, afinal — queimando as três tentativas em segundos e anulando a
   * espera pelo cron, que existe para dar tempo de o problema passar.
   */
  it("o dreno não retenta na hora o que acabou de falhar", async () => {
    const r = await enqueueInbound(msg({ messageId: "m-nao-retenta" }));
    if (r.status !== "queued") throw new Error("esperava queued");

    sent.mockRejectedValue(new Error("z-api fora do ar"));
    await processInboundNow(r.id);

    const row = await statusDe(r.id);
    expect(row.status).toBe("pending");
    // UMA tentativa, não três: o dreno não pegou a linha de volta.
    expect(row.attempts).toBe(1);
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

    turn.mockResolvedValue({ reply: null });
    await processInboundNow(r.id);

    const row = await statusDe(r.id);
    expect(row.status).toBe("done");
    expect(row.reply_message_id).toBeNull();
    expect(sent).not.toHaveBeenCalled();
  });

  /**
   * A promessa do desenho: a memória é extraída FORA do caminho crítico.
   *
   * `afterReply` é um thunk justamente pra que isso seja estrutura e não
   * comentário — mas estrutura só vale se alguém a chamar no lugar certo. Este
   * teste é o que prova a ORDEM: a pessoa recebe a resposta primeiro, e só
   * depois o modelo de extração roda.
   */
  it("memória é extraída DEPOIS do envio da resposta", async () => {
    const after = vi.fn().mockResolvedValue(undefined);
    turn.mockResolvedValue({ reply: "resposta do Max", afterReply: after });

    const r = await enqueueInbound(msg());
    if (r.status !== "queued") throw new Error("esperava queued");
    await processInboundNow(r.id);

    expect(after).toHaveBeenCalledTimes(1);
    expect(after.mock.invocationCallOrder[0]).toBeGreaterThan(
      sent.mock.invocationCallOrder[0]
    );
  });

  /**
   * Falha na memória não pode desfazer um turn que deu certo. Se ela reabrisse
   * a linha, o cron reenviaria a MESMA resposta — a pessoa receberia duas vezes
   * por causa de um erro em algo opcional.
   */
  it("memória que falha não reabre o turn nem duplica a resposta", async () => {
    turn.mockResolvedValue({
      reply: "resposta do Max",
      afterReply: vi.fn().mockRejectedValue(new Error("banco fora")),
    });

    const r = await enqueueInbound(msg());
    if (r.status !== "queued") throw new Error("esperava queued");
    await processInboundNow(r.id);

    expect((await statusDe(r.id)).status).toBe("done");
    expect(sent).toHaveBeenCalledTimes(1);
  });

  /**
   * Retentativa que só REENVIA não tem turn novo do qual aprender: o grafo não
   * rodou. Extrair ali gravaria os mesmos fatos de novo, com uma segunda
   * chamada de modelo paga.
   */
  it("reenvio não extrai memória de novo", async () => {
    const after = vi.fn().mockResolvedValue(undefined);
    turn.mockResolvedValue({ reply: "resposta do Max", afterReply: after });

    const r = await enqueueInbound(msg());
    if (r.status !== "queued") throw new Error("esperava queued");

    sent.mockRejectedValueOnce(new Error("z-api fora do ar"));
    await processInboundNow(r.id); // grafo roda, envio falha
    await sweepInbound(); // só reenvia

    expect(sent).toHaveBeenCalledTimes(2);
    expect(turn).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
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
