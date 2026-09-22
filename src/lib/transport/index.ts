/**
 * A porta única do Max para o WhatsApp.
 *
 * Até 2026-09-22, dez módulos importavam `@/lib/zapi` direto. Com a migração
 * para a Cloud API da Meta, o provedor passa a ser escolhido por env
 * (`WHATSAPP_PROVIDER`) e o resto do código deixa de saber qual é: o outbox, a
 * fila de inbound, o grafo e as rotas de admin chamam ESTAS funções.
 *
 * O que continua específico de provedor — e por isso NÃO passa por aqui — são
 * as rotas de webhook: cada provedor tem a sua, com a própria autenticação e o
 * próprio parser, e todas desembocam nos tipos de `./types`.
 *
 * Delegação por chamada, não por import: o provedor é lido no momento do uso,
 * então trocar a env na Vercel troca o canal sem deploy — e um teste que mocka
 * `../zapi` continua valendo, porque esta camada só repassa.
 */

import * as zapi from "../zapi";
import type { ConnectionState, ProviderName, SendResult } from "./types";

export type {
  ConnectionState,
  InboundKind,
  InboundMessage,
  ProviderName,
  SendResult,
  StatusCallback,
} from "./types";

/**
 * Qual provedor está valendo. Ausente = `zapi` (o único que existia).
 *
 * Valor DESCONHECIDO lança em vez de cair no default: um erro de digitação na
 * env faria o Max falar pelo canal errado em silêncio — e o canal errado, na
 * migração, é justamente o que foi desligado.
 */
export function provider(): ProviderName {
  const v = (process.env.WHATSAPP_PROVIDER ?? "").trim().toLowerCase();
  if (v === "" || v === "zapi") return "zapi";
  throw new Error(`WHATSAPP_PROVIDER inválido: "${v}" (aceitos: zapi)`);
}

export async function sendText(params: {
  to: string;
  body: string;
  quoteMessageId?: string;
}): Promise<SendResult> {
  provider();
  const res = await zapi.sendText(params);
  return { messageId: res.messageId ?? res.id ?? null };
}

export async function connectionStatus(): Promise<ConnectionState> {
  provider();
  return zapi.connectionStatus();
}

/**
 * `ref` é o `mediaUrl` do `InboundMessage`, opaco: só o provedor que o
 * produziu sabe o que ele é.
 */
export async function downloadMedia(
  ref: string
): Promise<{ data: Buffer; contentType: string | null } | null> {
  provider();
  return zapi.downloadMedia(ref);
}
