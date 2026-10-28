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
  /**
   * Campos de uma resposta de WhatsApp Flow (`nfm_reply`), sem o `flow_token`.
   * O `text` já traz a versão legível; este é o objeto bruto. Opcional e
   * ainda sem consumidor: não é persistido na fila.
   */
  flowResponse?: Record<string, unknown>;
}

/**
 * Uma opção tocável. O `id` é `op:<o texto que a pessoa digitaria>`: o toque
 * volta como esse texto, e o grafo trata igual a digitar (ver `lib/meta.ts`).
 */
export interface OpcaoInterativa {
  id: string;
  titulo: string;
  descricao?: string;
}

/**
 * Mensagem com botões de resposta (até 3) ou lista (até 10 linhas), dentro da
 * janela de 24h. É só a forma: o texto numerado equivalente vai junto como
 * fallback, e o toque nunca é escrita (o SIM continua obrigatório).
 */
export type Interativo =
  | { tipo: "botoes"; corpo: string; opcoes: OpcaoInterativa[]; imagemUrl?: string }
  | { tipo: "lista"; corpo: string; botao: string; opcoes: OpcaoInterativa[] };

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

export type ProviderName = "meta" | "newton-bridge" | "log";

/**
 * O que o provedor sabe fazer. A outbox decide por aqui, e não pelo nome:
 * janela de 24h e template são regras da Meta; um provedor sem elas manda
 * texto livre sempre.
 */
export interface TransportCapabilities {
  templates: boolean;
  window24h: boolean;
  media: boolean;
  groups: boolean;
  status: boolean;
  /** Mark-as-read + "digitando…" ao receber (Meta). */
  typing: boolean;
  /** Botões de resposta e lista na conversa (Meta). Sem isso, texto numerado. */
  interactive: boolean;
  /** Reação com emoji a uma mensagem recebida (Meta). Sem isso, `sendReaction` devolve `false`. */
  reactions: boolean;
}

export interface TransportAdapter {
  name: ProviderName;
  capabilities: TransportCapabilities;
  sendText(params: { to: string; body: string; quoteMessageId?: string }): Promise<SendResult>;
  /** Ausente quando `capabilities.templates` é `false`. */
  sendTemplate?(params: {
    to: string;
    name: string;
    lang: string;
    bodyParams: string[];
    botoes: BotaoEnviado[];
  }): Promise<SendResult>;
  /** Ausente quando `capabilities.interactive` é `false`. */
  sendInteractive?(params: { to: string; interativo: Interativo; quoteMessageId?: string }): Promise<SendResult>;
  /** Ausente quando `capabilities.reactions` é `false`. Lança em erro do provedor. */
  sendReaction?(params: { to: string; messageId: string; emoji: string }): Promise<SendResult>;
  /**
   * Marca a mensagem recebida como lida e mostra "digitando…". Ausente quando
   * `capabilities.typing` é `false`. Nunca lança; `false` = não foi.
   */
  markReadTyping?(messageId: string): Promise<boolean>;
  connectionStatus(): Promise<ConnectionState>;
  downloadMedia(ref: string): Promise<{ data: Buffer; contentType: string | null } | null>;
}
