import { randomUUID } from "node:crypto";
import { query } from "./db";
import { sendText, connectionStatus, type InboundMessage } from "./zapi";
import { runTurn } from "@/graph/graph";

/**
 * Fila de ENTRADA — o espelho do outbox, do outro lado da conversa.
 *
 * O webhook agora só ACEITA: grava a mensagem e responde 200 na hora. Quem roda
 * o turn é o processador, disparado em background pelo próprio request (caminho
 * rápido) e varrido pelo cron (a rede de segurança).
 *
 * Antes, `runTurn` rodava inline. Com o grafo chamando modelo, um turn mais
 * lento que o timeout do webhook fazia a Z-API reentregar; a reentrega batia no
 * dedupe, que já tinha consumido o `messageId`; e a pessoa ficava sem resposta e
 * sem rastro. Duplicata é chata, silêncio é invisível — por isso a fila.
 */

/** Tentativas antes de desistir. Igual ao outbox, pelo mesmo motivo. */
const MAX_ATTEMPTS = 3;

/**
 * Quanto tempo uma linha pode ficar em `processing` antes de ser considerada
 * órfã. Folga larga sobre o `maxDuration` da function, pra nunca competir com
 * uma execução ainda viva.
 */
const PROCESSING_ORPHAN_MINUTES = 10;

export interface InboundRow extends Record<string, unknown> {
  id: string;
  message_id: string;
  from_phone: string;
  group_id: string | null;
  kind: string;
  text: string | null;
  media_url: string | null;
  mime_type: string | null;
  sender_name: string | null;
  reply_to_message_id: string | null;
  timestamp_ms: string | number | null;
  attempts: number;
  reply_text: string | null;
}

export type EnqueueInboundResult =
  | { status: "queued"; id: string }
  | { status: "duplicate"; id: string | null };

/**
 * Aceita a mensagem. `ON CONFLICT DO NOTHING` + `RETURNING`: a linha só volta
 * quando FOI inserida agora, então conflito é exatamente a reentrega da Z-API.
 *
 * Este INSERT é o dedupe — não existe mais um `inbound_seen` paralelo dizendo a
 * mesma coisa por outro caminho.
 */
export async function enqueueInbound(
  msg: InboundMessage
): Promise<EnqueueInboundResult> {
  const id = randomUUID();
  const rows = await query<{ id: string }>(
    `INSERT INTO inbound_queue
       (id, message_id, from_phone, group_id, kind, text, media_url, mime_type,
        sender_name, reply_to_message_id, timestamp_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING id`,
    [
      id,
      msg.messageId,
      msg.fromPhone,
      msg.groupId,
      msg.kind,
      msg.text,
      msg.mediaUrl,
      msg.mimeType,
      msg.senderName,
      msg.replyToMessageId,
      msg.timestampMs,
    ]
  );

  if (rows.length === 0) {
    const existing = await query<{ id: string }>(
      `SELECT id FROM inbound_queue WHERE message_id = $1`,
      [msg.messageId]
    );
    return { status: "duplicate", id: existing[0]?.id ?? null };
  }
  return { status: "queued", id };
}

const CLAIM_COLUMNS = `id, message_id, from_phone, group_id, kind, text,
  media_url, mime_type, sender_name, reply_to_message_id, timestamp_ms,
  attempts, reply_text`;

/**
 * Dá pra responder agora?
 *
 * Mesma armadilha do outbox, e o mesmo motivo pra checar ANTES do claim: numa
 * instância desemparelhada o `send-text` responde 200 com um `messageId` que
 * não chega a ninguém, e a linha viraria `done` com `reply_message_id` — o
 * registro afirmando que a pessoa foi respondida quando não foi.
 *
 * Antes do claim porque reivindicar incrementa `attempts`: uma queda de vinte
 * minutos queimaria as três tentativas e marcaria como `failed` mensagens que
 * só precisavam esperar o canal voltar.
 *
 * Aqui a checagem economiza mais que no outbox — sem ela o grafo rodaria e o
 * modelo seria PAGO para produzir uma resposta que morre no envio.
 *
 * Falha ABERTA: não conseguir perguntar não é estar desconectado.
 */
async function podeResponder(): Promise<boolean> {
  try {
    const status = await connectionStatus();
    if (!status.connected) {
      console.error(
        `[inbound] INSTÂNCIA DESEMPARELHADA — nada processado, a fila espera. ` +
          `Estado: ${JSON.stringify(status.raw)}`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      "[inbound] não deu pra checar a instância:",
      err instanceof Error ? err.message : String(err)
    );
    return true;
  }
}

/**
 * Reivindica UMA linha específica — o caminho rápido, logo depois do webhook.
 *
 * O `status` entra no `WHERE`, então isto é compare-and-swap: se o cron já
 * pegou esta linha, o update não casa e devolve vazio. Não é otimização, é o
 * que impede os dois caminhos de responderem a mesma mensagem.
 */
async function claimById(id: string): Promise<InboundRow | null> {
  const rows = await query<InboundRow>(
    `UPDATE inbound_queue
        SET status = 'processing', attempts = attempts + 1, last_attempt_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING ${CLAIM_COLUMNS}`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Reivindica um lote — o cron.
 *
 * Mesma correção da migration 002 do outbox: o claim MUDA O ESTADO. `FOR UPDATE
 * SKIP LOCKED` sozinho só vale dentro do statement, e entre o claim e o turn a
 * linha voltaria a ser elegível pra execução seguinte.
 *
 * `processing` vencido entra no conjunto porque claim órfão precisa voltar —
 * morrer entre o claim e a resposta é justamente o silêncio a evitar.
 */
async function claimBatch(limit: number): Promise<InboundRow[]> {
  return query<InboundRow>(
    `UPDATE inbound_queue
        SET status = 'processing', attempts = attempts + 1, last_attempt_at = now()
      WHERE id IN (
        SELECT id FROM inbound_queue
         WHERE status = 'pending'
            OR (status = 'processing'
                AND last_attempt_at < now() - ($2 || ' minutes')::interval)
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING ${CLAIM_COLUMNS}`,
    [limit, String(PROCESSING_ORPHAN_MINUTES)]
  );
}

function toInboundMessage(row: InboundRow): InboundMessage {
  return {
    messageId: row.message_id,
    fromPhone: row.from_phone,
    groupId: row.group_id,
    kind: row.kind as InboundMessage["kind"],
    text: row.text,
    mediaUrl: row.media_url,
    mimeType: row.mime_type,
    timestampMs: row.timestamp_ms == null ? null : Number(row.timestamp_ms),
    senderName: row.sender_name,
    replyToMessageId: row.reply_to_message_id,
  };
}

export type SettleStatus = "done" | "failed" | "retry";

/**
 * Roda o turn de uma linha já reivindicada e liquida o estado.
 *
 * A ordem importa: `reply_text` é gravado ASSIM QUE o grafo responde, antes de
 * tentar enviar. Se o envio falhar, a retentativa encontra o texto pronto e só
 * reenvia — não re-invoca o grafo, que já gravou o turn no checkpoint e faria a
 * fala da pessoa aparecer duas vezes na thread.
 */
export async function runQueued(row: InboundRow): Promise<SettleStatus> {
  try {
    let reply = row.reply_text;
    /**
     * Trabalho pós-resposta do turn — hoje, a extração de memória.
     *
     * Fica `undefined` na retentativa que só reenvia: o grafo não rodou de
     * novo, então não há turn novo do qual aprender. Extrair ali gravaria os
     * mesmos fatos uma segunda vez, com uma segunda chamada de modelo paga.
     */
    let afterReply: (() => Promise<void>) | undefined;

    if (reply == null) {
      const turn = await runTurn(toInboundMessage(row));
      reply = turn.reply;
      afterReply = turn.afterReply;
      // Grava mesmo quando é null: "o grafo decidiu não responder" é resultado,
      // e sem persistir isso a retentativa rodaria o modelo de novo à toa.
      await query(`UPDATE inbound_queue SET reply_text = $2 WHERE id = $1`, [
        row.id,
        reply,
      ]);
    }

    let replyMessageId: string | null = null;
    if (reply) {
      const res = await sendText({
        to: row.from_phone,
        body: reply,
        quoteMessageId: row.message_id,
      });
      replyMessageId = res.messageId ?? res.id ?? null;
    }

    await query(
      `UPDATE inbound_queue
          SET status = 'done', settled_at = now(),
              reply_message_id = $2, last_error = NULL
        WHERE id = $1`,
      [row.id, replyMessageId]
    );

    /**
     * Só agora. A pessoa já recebeu a resposta e a linha já está liquidada —
     * daqui pra frente nada do que acontecer pode atrasar a conversa nem
     * reabrir o que já fechou.
     *
     * `catch` próprio, e não dentro do `try` de cima: uma falha na memória não
     * pode reverter um turn que deu certo pra `pending` e fazer o cron reenviar
     * a MESMA resposta.
     */
    if (afterReply) {
      await afterReply().catch((err) =>
        console.warn(
          "[inbound] memória não gravada (turn já respondido):",
          err instanceof Error ? err.message : String(err)
        )
      );
    }

    return "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Esgotou → `failed`, terminal e visível. Ainda tem crédito → volta pra
    // `pending` e o próximo cron pega.
    const exhausted = row.attempts >= MAX_ATTEMPTS;
    await query(
      `UPDATE inbound_queue
          SET status = $2,
              last_error = $3,
              settled_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END
        WHERE id = $1`,
      [row.id, exhausted ? "failed" : "pending", message.slice(0, 500)]
    );
    console.error(`[inbound] turn falhou (${row.message_id}): ${message}`);
    return exhausted ? "failed" : "retry";
  }
}

/**
 * Caminho rápido: processa a linha recém-aceita, sem esperar o cron.
 *
 * Nunca lança — é chamado de `waitUntil`, onde uma exceção não teria quem a
 * pegasse e a linha ficaria em `processing` até virar órfã.
 */
export async function processInboundNow(id: string): Promise<void> {
  try {
    if (!(await podeResponder())) return; // a linha fica pending; o cron retoma
    const row = await claimById(id);
    if (!row) return; // o cron chegou primeiro
    await runQueued(row);
  } catch (err) {
    console.error(
      "[inbound] caminho rápido falhou:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

export interface InboundTotals {
  claimed: number;
  done: number;
  failed: number;
  retry: number;
  /**
   * Havia o que responder mas a instância está fora — nada foi tentado.
   * Campo próprio pelo mesmo motivo do outbox: "o canal caiu" não é "a
   * mensagem tem problema", e só o primeiro precisa acordar alguém.
   */
  blocked: number;
}

/** Varredura do cron: pega o que o caminho rápido não fechou. */
export async function sweepInbound(limit = 20): Promise<InboundTotals> {
  const totals: InboundTotals = {
    claimed: 0,
    done: 0,
    failed: 0,
    retry: 0,
    blocked: 0,
  };

  // Só paga a consulta de status quando há o que responder — a maioria das
  // execuções não acha nada.
  const [{ due }] = await query<{ due: number }>(
    `SELECT count(*)::int AS due FROM inbound_queue
      WHERE status = 'pending'
         OR (status = 'processing'
             AND last_attempt_at < now() - ($1 || ' minutes')::interval)`,
    [String(PROCESSING_ORPHAN_MINUTES)]
  );
  if (due > 0 && !(await podeResponder())) {
    totals.blocked = due;
    return totals;
  }

  const rows = await claimBatch(limit);
  totals.claimed = rows.length;

  for (const row of rows) {
    const r = await runQueued(row);
    totals[r] += 1;
  }
  return totals;
}
