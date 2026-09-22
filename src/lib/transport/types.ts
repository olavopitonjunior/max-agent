/**
 * O vocabulário do Max para falar com o WhatsApp, sem nome de provedor.
 *
 * Nasceu dentro de `zapi.ts`, quando a Z-API era o único canal. Saiu daqui em
 * 2026-09-22 porque o Max passa a poder falar pela Cloud API oficial da Meta:
 * o grafo, a fila de inbound, o outbox e a reconciliação de entrega consomem
 * ESTES tipos, e cada provedor traduz o próprio webhook para eles. Nada aqui
 * pode ter campo que só um provedor entende.
 */

import type { Inoperancia } from "../zapi-erro";

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
   * Referência OPACA à mídia: quem a interpreta é o `downloadMedia` do mesmo
   * provedor que a produziu (URL pública na Z-API).
   */
  mediaUrl: string | null;
  mimeType: string | null;
  /** Instante da mensagem no provedor, em ms. */
  timestampMs: number | null;
  senderName: string | null;
  /** Id da mensagem citada, quando é resposta a outra mensagem. */
  replyToMessageId: string | null;
}

/**
 * Status de uma mensagem ENVIADA, como o provedor mandou. A tradução para o
 * nosso vocabulário (`sent`/`delivered`/`read`) é da reconciliação de entrega.
 */
export interface StatusCallback {
  /** Como o provedor mandar, sem normalizar (SENT/RECEIVED/READ/PLAYED na Z-API). */
  status: string;
  /** Ids das mensagens a que o status se refere. */
  messageIds: string[];
  phone: string | null;
  momment: number | null;
}

export interface ConnectionState {
  connected: boolean;
  session?: string;
  raw: unknown;
  /**
   * Presente quando `connected` é `false` por INOPERÂNCIA (assinatura ou
   * credencial, ver `zapi-erro.ts`), e não por desemparelhamento. Ausente na
   * queda de sessão comum — que continua sendo "repareie por QR".
   */
  inoperante?: Inoperancia;
}

/** O que o envio devolve, já sem o formato do provedor. */
export interface SendResult {
  /** Id que os callbacks de status vão citar. `null` se o provedor não deu. */
  messageId: string | null;
}

export type ProviderName = "zapi";
