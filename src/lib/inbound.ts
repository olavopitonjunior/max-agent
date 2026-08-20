import { randomUUID } from "node:crypto";
import { query } from "./db";
import { sendText, connectionStatus, type InboundMessage } from "./zapi";
import { maskPhone } from "./phone";
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
  /** O envio COMEÇOU numa tentativa (ver migration 007). */
  last_send_started_at: string | Date | null;
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
  attempts, reply_text, last_send_started_at`;

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
 * "Já tem outro turn rodando para este telefone agora?"
 *
 * Fragmento reusado pelos dois claims. Órfão (parado além da janela) NÃO conta:
 * ele já é elegível para reprocessamento, e deixá-lo bloquear travaria a
 * conversa até alguém intervir.
 *
 * ── Por que isto existe ──────────────────────────────────────────────────
 * Duas mensagens em segundos abrem duas invocações de function. Cada uma
 * reivindica a SUA linha — o compare-and-swap abaixo só impede que a mesma linha
 * seja pega duas vezes, não que duas linhas do mesmo telefone rodem juntas. E as
 * duas fazem `invoke` no MESMO `thread_id`, com o mesmo checkpointer.
 *
 * Antes da Fase 3 o prejuízo era histórico perdido (uma escrita de checkpoint
 * sobrescrevendo a outra). Com escrita de verdade no grafo, passa a ser criar
 * dois formulários: a pessoa manda "cria um form" e emenda "sim" antes de o
 * primeiro turn terminar, e os dois turns leem `pendingAction` do mesmo
 * checkpoint pré-confirmação.
 *
 * A serialização mora na FILA, e não num lock novo, porque a fila já é a única
 * verdade sobre o que entrou — um lock à parte seria a segunda verdade que a
 * `inbound_seen` ensinou a não criar.
 */
/**
 * Prefiltro — **não** é a garantia de serialização.
 *
 * A garantia é o índice único parcial da migration 006
 * (`inbound_queue_um_processing_por_telefone`). Esta subquery é uma leitura sem
 * lock: sob READ COMMITTED ela não enxerga escrita não-commitada de outra
 * transação, então duas invocações concorrentes reivindicando linhas DIFERENTES
 * do mesmo telefone passariam as duas. Era assim que estava, e era check-then-act.
 *
 * Ela fica porque evita a maioria das colisões antes de chegarem ao índice —
 * violação de unicidade é mais cara que um `NOT EXISTS` que já filtrou.
 *
 * Sem exceção para órfão, de propósito: uma linha parada em `processing` pode
 * ter um processo vivo do outro lado, e "provavelmente morreu" não é base para
 * rodar um segundo turn no mesmo thread. O órfão volta a rodar porque o
 * candidato mais antigo do telefone é ele mesmo — reivindicá-lo de novo não
 * muda o `status` e não toca no índice.
 */
function semOutroTurnDoMesmoTelefone(alias: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM inbound_queue outro
     WHERE outro.from_phone = ${alias}.from_phone
       AND outro.id <> ${alias}.id
       AND outro.status = 'processing'
  )`;
}

/** Violação de unique no Postgres. */
const UNIQUE_VIOLATION = "23505";

function ehColisaoDeTelefone(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/** Linha que pode ser reivindicada: nunca processada, ou claim órfão. */
function reivindicavel(alias: string, orphan: string): string {
  return `(${alias}.status = 'pending'
           OR (${alias}.status = 'processing'
               AND ${alias}.last_attempt_at < now() - (${orphan} || ' minutes')::interval))`;
}

/**
 * Reivindica UMA linha específica — o caminho rápido, logo depois do webhook.
 *
 * O `status` entra no `WHERE`, então isto é compare-and-swap: se o cron já
 * pegou esta linha, o update não casa e devolve vazio. Não é otimização, é o
 * que impede os dois caminhos de responderem a mesma mensagem.
 */
async function claimById(id: string): Promise<InboundRow | null> {
  try {
    const rows = await query<InboundRow>(
      `UPDATE inbound_queue
          SET status = 'processing', attempts = attempts + 1, last_attempt_at = now()
        WHERE id = $1
          AND ${reivindicavel("inbound_queue", "$2")}
          AND ${semOutroTurnDoMesmoTelefone("inbound_queue")}
        RETURNING ${CLAIM_COLUMNS}`,
      [id, String(PROCESSING_ORPHAN_MINUTES)]
    );
    return rows[0] ?? null;
  } catch (err) {
    // O índice da 006 recusou: outra invocação ganhou a corrida e já está
    // rodando um turn deste telefone. Não é erro — é a serialização
    // funcionando. A linha continua `pending` e o cron a pega depois.
    if (ehColisaoDeTelefone(err)) return null;
    throw err;
  }
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
/**
 * Reivindica um lote — o cron. Escolhe candidatos e reivindica UM DE CADA VEZ.
 *
 * Um único UPDATE em lote seria mais curto e está errado aqui: com o índice da
 * 006, uma linha em colisão aborta o STATEMENT inteiro, e um telefone
 * conflitante derrubaria a varredura toda. Reivindicando linha a linha, a
 * colisão isola quem colidiu e o resto do lote segue.
 */
async function selectCandidates(limit: number): Promise<Array<{ id: string }>> {
  return query<{ id: string }>(
    `SELECT elegiveis.id FROM (
       -- Uma linha por TELEFONE, a mais antiga de cada um. Dois turns da mesma
       -- pessoa em paralelo escreveriam no mesmo thread do checkpointer; e a
       -- segunda mensagem dela quase sempre depende da resposta da primeira,
       -- então processar fora de ordem também responderia errado.
       SELECT DISTINCT ON (fila.from_phone) fila.id, fila.created_at
         FROM inbound_queue fila
        WHERE ${reivindicavel("fila", "$2")}
          AND ${semOutroTurnDoMesmoTelefone("fila")}
        ORDER BY fila.from_phone, fila.created_at
     ) elegiveis
     -- O DISTINCT ON ordena por telefone; reordenar por chegada devolve a
     -- justiça que o LIMIT precisa. Sem isto, com mais telefones que o limite,
     -- quem tem número "maior" nunca seria atendido.
     ORDER BY elegiveis.created_at
     LIMIT $1`,
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
    } else if (row.last_send_started_at != null) {
      /**
       * Resposta pronta E envio já iniciado: a tentativa anterior morreu ENTRE
       * o `sendText` e o UPDATE final (se o envio tivesse falhado, o marcador
       * teria sido limpo). Reenviar aqui era o bug: a pessoa recebia a mesma
       * resposta duas vezes. At-most-once — liquida sem reenviar; o raro caso
       * "começou e não saiu" vira nota na linha, e a reconciliação de entrega
       * (Fase 4) passa a confirmar o desfecho.
       */
      await query(
        `UPDATE inbound_queue
            SET status = 'done', settled_at = now(),
                last_error = 'envio anterior provavelmente concluído — não reenviado'
          WHERE id = $1`,
        [row.id]
      );
      return "done";
    }

    let replyMessageId: string | null = null;
    if (reply) {
      // Marcador ANTES do send — é ele que a retentativa consulta acima.
      await query(
        `UPDATE inbound_queue SET last_send_started_at = now() WHERE id = $1`,
        [row.id]
      );
      let res;
      try {
        res = await sendText({
          to: row.from_phone,
          body: reply,
          quoteMessageId: row.message_id,
        });
      } catch (err) {
        // Envio FALHOU: limpa o marcador para que a retentativa reenvie de
        // verdade — sem isto ela concluiria "provavelmente enviado" e calaria.
        await query(
          `UPDATE inbound_queue SET last_send_started_at = NULL WHERE id = $1`,
          [row.id]
        ).catch(() => undefined);
        throw err;
      }
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
/**
 * Orçamento de TEMPO de uma execução, abaixo do `maxDuration` (60s) com folga
 * para o turn em andamento terminar. O deadline é conferido ANTES de reivindicar
 * a próxima linha, nunca no meio de um turn: linha reivindicada e não processada
 * ficaria em `processing` até virar órfã — 10 minutos de silêncio.
 */
const EXECUTION_BUDGET_MS = 40_000;

export async function processInboundNow(id: string): Promise<void> {
  const deadline = Date.now() + EXECUTION_BUDGET_MS;
  try {
    if (!(await podeResponder())) return; // a linha fica pending; o cron retoma
    const row = await claimById(id);
    if (!row) return; // o cron chegou primeiro, ou há outro turn deste telefone
    await runQueued(row);

    /**
     * Drena o que ficou represado DESTE telefone.
     *
     * A serialização por telefone tem um efeito colateral: a mensagem que chega
     * enquanto a anterior está sendo respondida não é reivindicada, e sem isto
     * esperaria o próximo cron — até um minuto de silêncio, bem no meio de uma
     * conversa (é exatamente o caso "cria um form" seguido de "sim").
     *
     * Uma linha por vez e em série, que é o ponto: drenar em paralelo desfaria
     * a serialização que acabou de ser criada. Só até o deadline: o que sobrar
     * é atraso de até um minuto (cron), nunca perda.
     */
    await drenarTelefone(row.from_phone, deadline);
  } catch (err) {
    console.error(
      "[inbound] caminho rápido falhou:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Teto de linhas drenadas numa execução do caminho rápido.
 *
 * Não é sobre volume, é sobre o orçamento da function: cada turn chama modelo, e
 * uma rajada longa estouraria o `maxDuration` no meio de um turn. O que sobrar
 * fica `pending` e o cron pega — atraso, nunca perda.
 */
const DRENO_MAX = 5;

async function drenarTelefone(phone: string, deadline: number): Promise<void> {
  for (let i = 0; i < DRENO_MAX; i++) {
    // Antes de REIVINDICAR, nunca no meio: sem tempo para mais um turn, o que
    // resta fica `pending` para o cron.
    if (Date.now() > deadline) return;
    /**
     * A MAIS ANTIGA pendente, com `attempts` junto — e as duas coisas importam.
     *
     * Só drena se ela nunca foi tentada. Duas razões distintas:
     *
     * 1. **Não repescar o que acabou de falhar.** A linha que falhou voltou a
     *    `pending`; retentá-la aqui queimaria as três tentativas em segundos e
     *    anularia a espera pelo cron, que existe pra dar tempo de o problema
     *    passar.
     * 2. **Não furar a ordem.** Filtrar por `attempts = 0` na query — em vez de
     *    olhar a mais antiga e parar — faria o dreno PULAR uma mensagem que
     *    falhou e responder a seguinte. Numa conversa isso inverte o sentido:
     *    se "cria um formulário" falhou e "sim" passa na frente, o "sim" chega
     *    sem proposta pendente e é absorvido como conversa fiada; depois a
     *    primeira é retentada e propõe algo que ninguém mais espera confirmar.
     */
    const proxima = await query<{ id: string; attempts: number }>(
      `SELECT id, attempts FROM inbound_queue
        WHERE from_phone = $1 AND status = 'pending'
        ORDER BY created_at
        LIMIT 1`,
      [phone]
    );
    const id = proxima[0]?.id;
    if (!id || proxima[0].attempts > 0) return;

    const row = await claimById(id);
    if (!row) return; // o cron pegou, ou outro turn deste telefone começou
    await runQueued(row);
  }
  console.warn(
    `[inbound] ${maskPhone(phone)} tinha mais de ${DRENO_MAX} mensagens represadas — o cron termina`
  );
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

/**
 * Varredura do cron: pega o que o caminho rápido não fechou.
 *
 * Limitada por TEMPO, não só por contagem: 20 turns em série não cabem nos 60s
 * do cron — cada um chama modelo. O deadline é conferido antes de cada claim;
 * o que não coube fica `pending` e a próxima varredura (1 min) continua.
 */
export async function sweepInbound(limit = 20): Promise<InboundTotals> {
  const deadline = Date.now() + EXECUTION_BUDGET_MS;
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

  const candidatos = await selectCandidates(limit);
  for (const { id } of candidatos) {
    if (Date.now() > deadline) break;
    // `claimById` refaz o compare-and-swap: entre o SELECT e o UPDATE, outro
    // cron pode ter pego a linha. Devolver `null` ali é o caso normal.
    const row = await claimById(id);
    if (!row) continue;
    totals.claimed += 1;
    const r = await runQueued(row);
    totals[r] += 1;
    // O caminho rápido pode ter morrido antes de drenar: a rajada deste
    // telefone também é responsabilidade da varredura.
    if (r === "done") await drenarTelefone(row.from_phone, deadline);
  }
  return totals;
}
