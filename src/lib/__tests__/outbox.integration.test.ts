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

// Semeadura e identidade mockadas: o assunto deste arquivo é a FILA. Sem o
// mock, cada dispatch rodaria o checkpointer real (DDL + linhas de checkpoint
// que a limpeza daqui não cobre) e a resolução de identidade faria fetch.
vi.mock("@/graph/graph", () => ({
  seedNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../identity", () => ({
  resolveIdentity: vi.fn().mockResolvedValue({ kind: "unknown" }),
}));
vi.mock("../zapi", () => ({
  sendText: vi.fn().mockResolvedValue({ messageId: "MID" }),
  connectionStatus: vi.fn().mockResolvedValue({ connected: true, raw: {} }),
}));

const { enqueue, dispatchDue, renderMessage } = await import("../outbox");
const { query, db } = await import("../db");
const { sendText, connectionStatus } = await import("../zapi");

const sent = sendText as unknown as ReturnType<typeof vi.fn>;
const status = connectionStatus as unknown as ReturnType<typeof vi.fn>;

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
    status.mockResolvedValue({ connected: true, raw: {} });
    await query(`DELETE FROM outbox WHERE org_id = 'org-test'`);
  });

  afterAll(async () => {
    await query(`DELETE FROM outbox WHERE org_id = 'org-test'`);
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
   *
   * A asserção é sobre as LINHAS, não sobre quantas cada passada reivindicou:
   * este banco é o de produção, onde o cron real roda a cada minuto e disputa
   * as mesmas linhas. Contar claims globais daria um número diferente sempre
   * que a execução caísse na virada do minuto — e falharia sem haver bug.
   * `attempts = 1` é a prova direta do que interessa: ninguém foi despachado
   * duas vezes.
   */
  it("execuções concorrentes do cron não despacham a mesma linha duas vezes", async () => {
    for (let i = 0; i < 6; i++) {
      await enqueue(args({ dedupeKey: `k-race-${i}` }));
    }
    await query(
      `UPDATE outbox SET deliver_after = now() - interval '1 minute' WHERE org_id = 'org-test'`
    );

    await Promise.all([dispatchDue(), dispatchDue()]);

    const rows = await query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM outbox WHERE org_id = 'org-test'`
    );
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.status).toBe("sent");
      expect(r.attempts).toBe(1);
    }
  });

  /**
   * Regressão do envio duplo.
   *
   * Enquanto o claim não mudava o estado, a linha ficava `pending` e vencida
   * ENTRE o claim e o envio — porque `FOR UPDATE SKIP LOCKED` só vale dentro do
   * statement, e claim e envio são statements separados. Uma segunda passada
   * nesse intervalo a reivindicava de novo e a mensagem saía duas vezes.
   *
   * Aqui o envio é lento de propósito para alargar exatamente esse intervalo.
   */
  it("segunda passada durante um envio em curso NÃO pega a mesma linha", async () => {
    let liberar: () => void = () => {};
    const emVoo = new Promise<void>((r) => {
      liberar = r;
    });
    sent.mockImplementation(async () => {
      await emVoo;
      return { messageId: "MID" };
    });

    await enqueue(args({ dedupeKey: "k-inflight" }));
    await query(
      `UPDATE outbox SET deliver_after = now() - interval '1 minute' WHERE dedupe_key = 'k-inflight'`
    );

    const primeira = dispatchDue();
    // Dá tempo de a primeira reivindicar e ficar presa no envio.
    await new Promise((r) => setTimeout(r, 300));
    const segunda = await dispatchDue();

    expect(segunda.claimed).toBe(0);

    liberar();
    await primeira;

    const row = await query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM outbox WHERE dedupe_key = 'k-inflight'`
    );
    expect(row[0].status).toBe("sent");
    expect(row[0].attempts).toBe(1);
    expect(sent).toHaveBeenCalledTimes(1);
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

/**
 * Instância desemparelhada.
 *
 * Incidente de 2026-08-04: quatro mensagens reais viraram `sent`, com
 * `messageId` do provedor e sem erro nenhum, e o log disse "4 enviadas, 0
 * falhas" — nenhuma chegou. `send-text` numa instância desconectada responde
 * 200 com um id que não vai a lugar nenhum.
 *
 * Estes testes existem porque o modo de falha é INVISÍVEL: sem eles, a
 * regressão volta e ninguém percebe até alguém reclamar que não recebeu.
 */
const d2 = hasDb ? describe : describe.skip;

d2("instância fora do ar (Postgres real)", () => {
  /**
   * Enfileira e **vence** a linha.
   *
   * `enqueue` agenda por `nextDeliveryTime()`, que respeita a janela 7h–22h de
   * São Paulo: uma linha criada às 22h01 só vence às 7h do dia seguinte, e aí
   * `dispatchDue` não a enxerga — nada é enviado nem bloqueado, e os quatro
   * testes deste bloco falham por um motivo que não tem nada a ver com o que
   * eles testam.
   *
   * Isso não é hipótese: aconteceu em 21/08 às 22h07, e o CI vinha passando
   * porque calhava de rodar dentro da janela. É a pior espécie de teste — o que
   * dá o veredito certo pelo motivo errado, até a hora virar.
   *
   * O bloco de cima já fazia isto linha a linha; aqui faltava. A janela em si
   * tem cobertura própria em `window.test.ts` e não é o assunto daqui.
   */
  async function enfileirarVencido(over: Parameters<typeof args>[0] = {}) {
    const r = await enqueue(args(over));
    // Vence a linha RECÉM-criada, não a org inteira: hoje cada teste enfileira
    // uma só e os dois seriam equivalentes, mas o dia em que alguém enfileirar
    // duas querendo que apenas uma vença, o `WHERE org_id` mentiria em silêncio.
    if (r.status === "queued") {
      await query(
        `UPDATE outbox SET deliver_after = now() - interval '1 minute' WHERE id = $1`,
        [r.id]
      );
    }
    return r;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    sent.mockResolvedValue({ messageId: "MID" });
    status.mockResolvedValue({ connected: true, raw: {} });
    await query(`DELETE FROM outbox WHERE org_id = 'org-test'`);
  });

  afterAll(async () => {
    await query(`DELETE FROM outbox WHERE org_id = 'org-test'`);
  });

  it("desconectada: não envia nada e reporta represado", async () => {
    await enfileirarVencido();
    status.mockResolvedValue({ connected: false, raw: { connected: false } });

    const totals = await dispatchDue();

    expect(sent).not.toHaveBeenCalled();
    expect(totals.blocked).toBe(1);
    expect(totals.sent).toBe(0);
  });

  /**
   * O ponto mais importante. Se o claim rodasse, uma instância fora do ar por
   * vinte minutos queimaria as três tentativas de TODA a fila e marcaria como
   * `failed` mensagens que não têm defeito nenhum — perda definitiva por causa
   * de um problema de canal, temporário por natureza.
   */
  it("não queima tentativa: a linha continua pending com attempts em zero", async () => {
    const r = await enfileirarVencido();
    if (r.status !== "queued") throw new Error("esperava queued");
    status.mockResolvedValue({ connected: false, raw: {} });

    await dispatchDue();
    await dispatchDue();
    await dispatchDue();

    const [row] = await query<{ status: string; attempts: number; last_error: string }>(
      `SELECT status, attempts, last_error FROM outbox WHERE id = $1`,
      [r.id]
    );
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    // O motivo tem que estar na TABELA, não só no log de quem estava olhando.
    expect(row.last_error).toContain("desemparelhada");
  });

  it("reconectou: a mesma fila sai, nada se perdeu", async () => {
    const r = await enfileirarVencido();
    if (r.status !== "queued") throw new Error("esperava queued");

    status.mockResolvedValue({ connected: false, raw: {} });
    expect((await dispatchDue()).blocked).toBe(1);

    status.mockResolvedValue({ connected: true, raw: {} });
    const totals = await dispatchDue();

    expect(totals.sent).toBe(1);
    expect(sent).toHaveBeenCalledTimes(1);
    const [row] = await query<{ status: string }>(
      `SELECT status FROM outbox WHERE id = $1`,
      [r.id]
    );
    expect(row.status).toBe("sent");
  });

  /**
   * Não conseguir PERGUNTAR não é o mesmo que estar desconectado. Falhar
   * fechado aqui deixaria uma instabilidade do endpoint de status calar um
   * canal que estava funcionando.
   */
  it("status indisponível → segue enviando (falha aberta)", async () => {
    await enfileirarVencido();
    status.mockRejectedValue(new Error("timeout"));

    const totals = await dispatchDue();

    expect(totals.sent).toBe(1);
    expect(totals.blocked).toBe(0);
  });

  /** Fila vazia não paga a chamada de status — é a maioria das execuções. */
  it("sem nada vencido, nem pergunta o estado da instância", async () => {
    await dispatchDue();
    expect(status).not.toHaveBeenCalled();
  });
});

/**
 * Fechado no NÍVEL DO ARQUIVO, não dentro de um describe. O `afterAll` de um
 * bloco roda antes dos blocos seguintes, então encerrar o pool ali derrubaria
 * tudo que viesse depois com um erro que não tem nada a ver com o teste.
 */
afterAll(async () => {
  if (hasDb) await db().end();
});
