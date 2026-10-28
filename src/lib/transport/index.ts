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
import { log } from "../log";
import { logAdapter } from "./adapters/log";
import { metaAdapter } from "./adapters/meta";
import { NEWTON_SYNTHETIC_PREFIX, newtonBridgeAdapter } from "./adapters/newton-bridge";
import { MetaHttpError, classificarMeta, falhaDaMensagemMeta } from "./erro";
import type {
  BotaoEnviado,
  ConnectionState,
  Interativo,
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
  Interativo,
  OpcaoInterativa,
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
 * de staging e da homologação, e é recusado em produção. Qualquer outro valor
 * lança: cair na Meta por engano mandaria mensagem pelo número errado.
 */
export function adapter(): TransportAdapter {
  const desvio = (process.env.AGENT_TRANSPORT ?? "").trim().toLowerCase();
  if (desvio === "log") {
    if (!logPermitido()) throw new Error("transport_log_em_producao");
    return logAdapter;
  }
  if (desvio !== "") throw new Error(`transport_invalido: ${desvio}`);

  const nome = deployProfile().transport;
  if (nome === "meta") {
    avisarProvedorMeta();
    return metaAdapter;
  }
  if (nome === "newton-bridge") return newtonBridgeAdapter;
  if (nome === "log") return logAdapter;
  throw new Error(`transport_nao_implementado: ${nome}`);
}

/**
 * O transporte sem rede marca a linha como `sent` sem entregar nada: em
 * produção isso é perda silenciosa. Por isso a lista é de onde PODE, e não de
 * onde não pode. Preview da Vercel roda com `NODE_ENV=production`, e por isso
 * vale pelo `VERCEL_ENV`. Fora da Vercel (sem `VERCEL_ENV`), só vale num
 * processo que não é de produção.
 */
function logPermitido(): boolean {
  const vercel = (process.env.VERCEL_ENV ?? "").trim();
  if (vercel === "preview" || vercel === "development") return true;
  if (vercel !== "") return false;
  return process.env.NODE_ENV !== "production";
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

/**
 * Texto livre. Com `interativo`, e onde o provedor sabe (`capabilities.interactive`),
 * vai como botões/lista; `body` é o texto numerado equivalente, que vai no
 * lugar quando o provedor não tem botão (Newton, log), quando
 * `MAX_INTERACTIVE=off`, ou quando a Meta RECUSA a forma (400: nada foi
 * entregue, então mandar o texto não duplica). Timeout e 5xx não caem para o
 * texto: podem ter sido aceitos, e a retentativa da fila decide.
 */
export async function sendText(params: {
  to: string;
  body: string;
  quoteMessageId?: string;
  interativo?: Interativo | null;
}): Promise<SendResult> {
  if (process.env.MAX_OUTBOUND_KILL === "true") throw new Error("outbound_disabled");
  if (currentExecution() && currentExecution()!.context.mode !== "live") throw new Error("playground_transport_denied");
  const { interativo, ...texto } = params;
  const a = adapter();
  if (interativo && a.sendInteractive && interativoDisponivel()) {
    try {
      return await a.sendInteractive({ to: texto.to, interativo, quoteMessageId: texto.quoteMessageId });
    } catch (err) {
      // Só a FORMA recusada (parâmetro inválido) cai no texto. Conta, número,
      // vazão e restrição também vêm como 400, mas o texto bateria no mesmo
      // muro — relança para a fila classificar, como faria com o texto.
      if (!(err instanceof MetaHttpError) || err.status !== 400 || classificarMeta(err.code) || falhaDaMensagemMeta(err)) throw err;
      log.warn("transport.interativo_recusado", { tipo: interativo.tipo, code: err.code });
    }
  }
  return a.sendText(texto);
}

function interativoLigado(): boolean {
  return (process.env.MAX_INTERACTIVE ?? "").trim().toLowerCase() !== "off";
}

/**
 * Botões/lista de fato disponíveis agora: o provedor sabe (`capabilities.interactive`)
 * E o kill switch `MAX_INTERACTIVE` não está em `off`. Fonte única para quem
 * envia (`sendText`) e para quem monta o texto (`renderMessage`: sem botão, o
 * texto precisa trazer o bloco numerado).
 */
export function interativoDisponivel(): boolean {
  return adapter().capabilities.interactive && interativoLigado();
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

/**
 * Reação com emoji à mensagem que a pessoa mandou (o toque de botão, por
 * exemplo). Cortesia de UX: nunca lança, `false` = não foi (provedor sem
 * `reactions`, kill switch, playground, id sintético ou recusa da Meta).
 */
export async function sendReaction(params: { to: string; messageId: string; emoji: string }): Promise<boolean> {
  try {
    if (process.env.MAX_OUTBOUND_KILL === "true") return false;
    if (currentExecution() && currentExecution()!.context.mode !== "live") return false;
    if (!params.messageId || SINTETICOS.some((p) => params.messageId.startsWith(p))) return false;
    const a = adapter();
    if (!a.capabilities.reactions || !a.sendReaction) return false;
    await a.sendReaction(params);
    return true;
  } catch (err) {
    log.warn("transport.reacao_falhou", { motivo: err instanceof Error ? err.name : "erro" });
    return false;
  }
}

export async function connectionStatus(): Promise<ConnectionState> {
  return adapter().connectionStatus();
}

export async function downloadMedia(
  ref: string
): Promise<{ data: Buffer; contentType: string | null } | null> {
  return adapter().downloadMedia(ref);
}

/** Prefixos de id que o código fabrica (não existem na Meta): Newton, playground e handoff. */
const SINTETICOS = [NEWTON_SYNTHETIC_PREFIX, "playground-", "human-"];

/**
 * Mark-as-read + "digitando…" para a mensagem que acabou de chegar. Só onde o
 * provedor sabe fazer (`capabilities.typing`) e só com id real: o do Newton é
 * sintético (`newton:` e afins) e a Meta devolveria erro. `MAX_TYPING_INDICATOR=off`
 * desliga (padrão ligado). Nunca lança nem espera quem chama: `false` = não
 * foi, por qualquer motivo.
 */
export async function markReadTyping(messageId: string): Promise<boolean> {
  try {
    if ((process.env.MAX_TYPING_INDICATOR ?? "").trim().toLowerCase() === "off") return false;
    if (!messageId || SINTETICOS.some((p) => messageId.startsWith(p))) return false;
    const a = adapter();
    if (!a.capabilities.typing || !a.markReadTyping) return false;
    return await a.markReadTyping(messageId);
  } catch (err) {
    log.warn("transport.typing_falhou", { motivo: err instanceof Error ? err.name : "erro" });
    return false;
  }
}
