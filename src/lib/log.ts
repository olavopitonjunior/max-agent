import { maskPhone } from "./phone";

/**
 * Log estruturado dos pontos quentes.
 *
 * O problema que isto resolve não é estética: hoje "por que fulano não
 * recebeu resposta?" se investiga juntando linhas de texto livre por
 * telefone, à mão, no painel da Vercel — e o telefone é justamente o campo
 * que a máscara esconde. Sem um id que atravesse webhook → fila → turn →
 * envio, cada etapa é uma ilha.
 *
 * `messageId` da Z-API é essa costura: ele nasce no webhook, vive na linha da
 * fila (`message_id`), acompanha o turn e liga a resposta enviada
 * (`reply_message_id`). Uma busca por ele devolve a conversa inteira.
 *
 * JSON de uma linha porque é o que a busca da Vercel filtra bem (`event:` ou
 * `messageId:` como termo), e porque um dia isso pode virar dreno para um
 * coletor sem reescrever call-site nenhum.
 *
 * **Contrato dos dois campos de id** (misturá-los derrota a costura — quem
 * busca por um campo tem que achar sempre a mesma natureza de coisa):
 *  - `messageId` = a mensagem que ORIGINOU o evento (a recebida, no inbound).
 *  - `sentMessageId` = o id que o provedor devolveu do que SAIU. Vale para
 *    resposta e para notificação proativa — por isso não se chama "reply".
 */

export interface LogFields {
  /** Costura de ponta a ponta — o `messageId` da Z-API, quando houver. */
  messageId?: string | null;
  /** Id da linha da fila (inbound_queue.id ou outbox.id). */
  rowId?: string | null;
  orgId?: string | null;
  /** Cru: a máscara é aplicada aqui, para não depender de disciplina no chamador. */
  phone?: string | null;
  /** Id devolvido pelo provedor no que SAIU (resposta ou notificação). */
  sentMessageId?: string | null;
  ms?: number;
  [k: string]: unknown;
}

function emit(level: "info" | "warn" | "error", event: string, f: LogFields): void {
  const { phone, ...rest } = f;
  const linha = JSON.stringify({
    event,
    ...(phone ? { phone: maskPhone(phone) } : {}),
    ...rest,
  });
  if (level === "error") console.error(linha);
  else if (level === "warn") console.warn(linha);
  else console.log(linha);
}

export const log = {
  info: (event: string, fields: LogFields = {}) => emit("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => emit("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => emit("error", event, fields),
};
