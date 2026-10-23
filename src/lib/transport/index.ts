import { currentExecution } from "../runtime/context";
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

import { deployProfile } from "../deploy-profile";
import { logAdapter } from "./adapters/log";
import { metaAdapter } from "./adapters/meta";
import type {
  BotaoEnviado,
  ConnectionState,
  ProviderName,
  SendResult,
  TransportAdapter,
  TransportCapabilities,
} from "./types";

export type {
  BotaoEnviado,
  ConnectionState,
  InboundKind,
  InboundMessage,
  ProviderName,
  SendResult,
  StatusCallback,
  TransportAdapter,
  TransportCapabilities,
} from "./types";

/** Para não repetir o `console.warn` em TODA chamada de um processo que nunca corrige a env. */
let avisouProvedorInvalido = false;

/**
 * O adapter valendo. Vem do perfil de deploy (`AGENT_DEPLOY_PROFILE`; ausente
 * é o Max, na Meta). `AGENT_TRANSPORT=log` desvia para o transporte sem rede
 * do playground e de staging, e é recusado em produção. Qualquer outro valor
 * lança: cair na Meta por engano mandaria mensagem pelo número errado.
 */
export function adapter(): TransportAdapter {
  const desvio = (process.env.AGENT_TRANSPORT ?? "").trim().toLowerCase();
  if (desvio === "log") {
    if (process.env.VERCEL_ENV === "production") throw new Error("transport_log_em_producao");
    return logAdapter;
  }
  if (desvio !== "") throw new Error(`transport_invalido: ${desvio}`);

  const nome = deployProfile().transport;
  if (nome === "meta") {
    avisarProvedorMeta();
    return metaAdapter;
  }
  if (nome === "log") return logAdapter;
  throw new Error(`transport_nao_implementado: ${nome}`);
}

/**
 * `WHATSAPP_PROVIDER` ausente ou com qualquer valor que não seja `"meta"` NÃO
 * lança — a Z-API foi desligada em 10/09 e não há para onde cair. Lançar aqui
 * derrubaria outbox, inbound e admin por uma env desatualizada ou ausente;
 * um `console.warn` (uma vez por processo) é o suficiente para alguém notar e
 * corrigir a env sem silenciar o Max inteiro.
 */
function avisarProvedorMeta(): void {
  const v = (process.env.WHATSAPP_PROVIDER ?? "").trim().toLowerCase();
  if (v !== "meta" && !avisouProvedorInvalido) {
    avisouProvedorInvalido = true;
    console.warn(
      `[transport] WHATSAPP_PROVIDER="${v}" — só "meta" existe desde a migração; seguindo com meta`
    );
  }
}

/** Qual provedor está valendo. */
export function provider(): ProviderName {
  return adapter().name;
}

/** O que o provedor valendo sabe fazer (janela de 24h, template, mídia...). */
export function capabilities(): TransportCapabilities {
  return adapter().capabilities;
}

export async function sendText(params: {
  to: string;
  body: string;
  quoteMessageId?: string;
}): Promise<SendResult> {
  if (process.env.MAX_OUTBOUND_KILL === "true") throw new Error("outbound_disabled");
  if (currentExecution() && currentExecution()!.context.mode !== "live") throw new Error("playground_transport_denied");
  return adapter().sendText(params);
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
  if (process.env.MAX_OUTBOUND_KILL === "true") throw new Error("outbound_disabled");
  if (currentExecution() && currentExecution()!.context.mode !== "live") throw new Error("playground_transport_denied");
  const a = adapter();
  if (!a.capabilities.templates || !a.sendTemplate) throw new Error("transport_sem_template");
  return a.sendTemplate(params);
}

export async function connectionStatus(): Promise<ConnectionState> {
  return adapter().connectionStatus();
}

export async function downloadMedia(
  ref: string
): Promise<{ data: Buffer; contentType: string | null } | null> {
  return adapter().downloadMedia(ref);
}
