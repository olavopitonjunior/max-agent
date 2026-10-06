/**
 * O vocabulário do Max para falar com o WhatsApp, sem nome de provedor.
 *
 * Nasceu dentro do antigo cliente da Z-API, quando ela era o único canal.
 * Saiu dali em 2026-09-22 com a migração para a Cloud API oficial da Meta
 * (concluída em 28/09; Z-API cancelada em 10/09): o grafo, a fila de inbound,
 * o outbox e a reconciliação de entrega consomem ESTES tipos, e o provedor
 * traduz o próprio webhook para eles. Nada aqui pode ter campo que só um
 * provedor entende.
 */

import type { Inoperancia } from "./erro";

export type InboundKind = "text" | "image" | "audio" | "document" | "unknown";

export interface InboundMessage {
  messageId: string;
  /** Quem falou, E.164 sem "+". Em grupo é o participante, não o grupo. */
  fromPhone: string;
  /** Preenchido só em grupo — o JID do grupo. */
  groupId: string | null;
  kind: InboundKind;
  text: string | null;
  /**
   * Referência OPACA à mídia, no formato `meta:<media-id>`: quem a interpreta
   * é o `downloadMedia` do provedor que a produziu.
   */
  mediaUrl: string | null;
  mimeType: string | null;
  /** Instante da mensagem no provedor, em ms. */
  timestampMs: number | null;
  senderName: string | null;
  /** Id da mensagem citada, quando é resposta a outra mensagem. */
  replyToMessageId: string | null;
  /**
   * Payload do botão de resposta rápida tocado (`ok:<id>`, `duvida:<id>`),
   * quando a mensagem é um toque em botão de template. Opcional: ausente
   * quando não é toque em botão, e o texto visível continua em `text`.
   */
  buttonPayload?: string | null;
}

/** Botão preenchido na hora do envio, na ordem em que o template os declara. */
export type BotaoEnviado =
  | { tipo: "url"; param: string }
  | { tipo: "quick_reply"; payload: string };

/**
 * Status de uma mensagem ENVIADA, como o provedor mandou. A tradução para o
 * nosso vocabulário (`sent`/`delivered`/`read`) é da reconciliação de entrega.
 */
export interface StatusCallback {
  /** Como o provedor mandar, sem normalizar (`sent`/`delivered`/`read` na Meta). */
  status: string;
  /** Ids das mensagens a que o status se refere. */
  messageIds: string[];
  phone: string | null;
  momment: number | null;
  /**
   * Cobrança da mensagem, como a Meta informa no status (`pricing`). Ausente
   * quando o status não traz o bloco.
   */
  pricing?: {
    billable: boolean | null;
    category: string | null;
    type: string | null;
  } | null;
}

export interface ConnectionState {
  connected: boolean;
  session?: string;
  raw: unknown;
  /**
   * Presente quando `connected` é `false` por INOPERÂNCIA (assinatura,
   * credencial ou número, ver `transport/erro.ts`), e não por queda de sessão.
   * Ausente na queda de sessão comum.
   */
  inoperante?: Inoperancia;
}

/** O que o envio devolve, já sem o formato do provedor. */
export interface SendResult {
  /** Id que os callbacks de status vão citar. `null` se o provedor não deu. */
  messageId: string | null;
}

export type ProviderName = "meta";
