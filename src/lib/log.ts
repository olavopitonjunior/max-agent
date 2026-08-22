import { phoneTag } from "./phone";

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
 *
 * Duas garantias que o call-site não precisa lembrar:
 *  - **emitir nunca lança.** Estes logs ficam DENTRO de blocos onde uma
 *    exceção reverteria trabalho já feito (entre o `sendText` e a
 *    liquidação, por exemplo, o catch limparia o marcador e reenviaria uma
 *    mensagem que o provedor já aceitou). Log não pode ter esse poder.
 *  - **telefone vira pseudônimo em qualquer campo**, não só no `phone`: texto
 *    livre de erro do provedor costuma ecoar o número do destinatário
 *    ("Z-API /send-text 400: invalid phone 5511...").
 *
 * **Por que pseudônimo (`tel_9f3a1c4d2e`) e não máscara (`5511***4321`)**:
 * a máscara escondia 5 dígitos, mas em celular BR o primeiro é sempre `9` —
 * sobravam ~10 mil combinações, e dentro da carteira de uma imobiliária os 4
 * finais já identificam a pessoa. O log da Vercel é retido e pesquisável fora
 * do nosso controle de acesso, então aqui o alvo é **não vazar dígito nenhum**.
 * O pseudônimo correlaciona igual (é estável por pessoa) e é irreversível sem a
 * chave. A tela do super-admin continua com a máscara, e isso é deliberado —
 * `maskPhone` em `phone.ts` explica por quê.
 */

export interface LogFields {
  /** Costura de ponta a ponta — o `messageId` da Z-API, quando houver. */
  messageId?: string | null;
  /** Id da linha da fila (inbound_queue.id ou outbox.id). */
  rowId?: string | null;
  orgId?: string | null;
  /** Cru: o pseudônimo é derivado aqui, para não depender de disciplina no chamador. */
  phone?: string | null;
  /** Id devolvido pelo provedor no que SAIU (resposta ou notificação). */
  sentMessageId?: string | null;
  ms?: number;
  [k: string]: unknown;
}

/** Sequência longa de dígitos em texto livre é telefone até prova em
 * contrário — 10 a 13 dígitos cobre E.164 do BR com e sem "+"/9º dígito. */
const DIGITOS_DE_TELEFONE = /\b\d{10,13}\b/g;

function scrub(valor: unknown): unknown {
  return typeof valor === "string"
    ? valor.replace(DIGITOS_DE_TELEFONE, (d) => phoneTag(d))
    : valor;
}

function emit(level: "info" | "warn" | "error", event: string, f: LogFields): void {
  let linha: string;
  try {
    const { phone, ...rest } = f;
    const limpos = Object.fromEntries(
      Object.entries(rest).map(([k, v]) => [k, scrub(v)])
    );
    linha = JSON.stringify({
      event,
      ...(phone ? { phone: phoneTag(phone) } : {}),
      ...limpos,
    });
  } catch (err) {
    // Valor circular, BigInt, getter que lança: o log degrada, o turn segue.
    linha = JSON.stringify({
      event,
      logError: err instanceof Error ? err.message : String(err),
    });
  }
  if (level === "error") console.error(linha);
  else if (level === "warn") console.warn(linha);
  else console.log(linha);
}

export const log = {
  info: (event: string, fields: LogFields = {}) => emit("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => emit("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => emit("error", event, fields),
};
