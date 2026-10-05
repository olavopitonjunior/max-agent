/**
 * A porta única do Max para o WhatsApp.
 *
 * Até 2026-09-22 o canal era a Z-API; dez módulos importavam `@/lib/zapi`
 * direto. Com a migração para a Cloud API da Meta (concluída em 28/09, Z-API
 * cancelada em 10/09), o provedor é só a Meta — mas a camada fica: o outbox, a
 * fila de inbound, o grafo e as rotas de admin continuam chamando ESTAS
 * funções, e não `@/lib/meta` direto, porque um teste que mocka `./index`
 * continua valendo se um segundo provedor voltar a existir um dia.
 *
 * O que continua específico de provedor — e por isso NÃO passa por aqui — são
 * as rotas de webhook: cada provedor tem a sua, com a própria autenticação e o
 * próprio parser, e todas desembocam nos tipos de `./types`.
 */

import * as meta from "../meta";
import type { BotaoEnviado, ConnectionState, ProviderName, SendResult } from "./types";

export type {
  BotaoEnviado,
  ConnectionState,
  InboundKind,
  InboundMessage,
  ProviderName,
  SendResult,
  StatusCallback,
} from "./types";

/** Para não repetir o `console.warn` em TODA chamada de um processo que nunca corrige a env. */
let avisouProvedorInvalido = false;

/**
 * Qual provedor está valendo. Só existe um: `meta`.
 *
 * `WHATSAPP_PROVIDER` ausente ou com qualquer valor que não seja `"meta"` NÃO
 * lança — a Z-API foi desligada em 10/09 e não há para onde cair. Lançar aqui
 * derrubaria outbox, inbound e admin por uma env desatualizada ou ausente;
 * um `console.warn` (uma vez por processo) é o suficiente para alguém notar e
 * corrigir a env sem silenciar o Max inteiro.
 */
export function provider(): ProviderName {
  const v = (process.env.WHATSAPP_PROVIDER ?? "").trim().toLowerCase();
  if (v !== "meta" && !avisouProvedorInvalido) {
    avisouProvedorInvalido = true;
    console.warn(
      `[transport] WHATSAPP_PROVIDER="${v}" — só "meta" existe desde a migração; seguindo com meta`
    );
  }
  return "meta";
}

export async function sendText(params: {
  to: string;
  body: string;
  quoteMessageId?: string;
}): Promise<SendResult> {
  provider();
  return meta.sendText(params);
}

/**
 * Envio por template aprovado. `dispatchDue` só chama isto com a janela de
 * 24h fechada e o template confirmado `APPROVED` em `wa_template`.
 */
export async function sendTemplate(params: {
  to: string;
  name: string;
  lang: string;
  bodyParams: string[];
  botoes: BotaoEnviado[];
}): Promise<SendResult> {
  provider();
  return meta.sendTemplate(params);
}

export async function connectionStatus(): Promise<ConnectionState> {
  provider();
  return meta.connectionStatus();
}

export async function downloadMedia(
  ref: string
): Promise<{ data: Buffer; contentType: string | null } | null> {
  provider();
  return meta.downloadMedia(ref);
}
