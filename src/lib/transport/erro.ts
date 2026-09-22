/**
 * A pergunta "isso é o CANAL recusando, ou a mensagem?", feita a um erro de
 * envio de qualquer provedor — num módulo sem `fetch`, pelo mesmo motivo de
 * `zapi-erro.ts`: os testes que mockam os clientes não precisam reexportar
 * funções puras.
 *
 * A resposta decide o destino da fila. Inoperância REPRESA (o outbox devolve a
 * tentativa e o inbound para de consumir, ver `dispatchDue`/`podeResponder`);
 * erro de mensagem segue o caminho comum de retentativa. Um falso positivo
 * aqui para as notificações inteiras — por isso só entra o que a documentação
 * do provedor descreve como a conta ou o número recusando.
 */

import { ZapiHttpError, classificarInoperancia } from "../zapi-erro";

/**
 * Por que o canal está fora de serviço sem ser queda de sessão. Cada valor
 * muda o conselho do alerta:
 *
 *  · `assinatura` — cobrança: Z-API 400 "must subscribe"; Meta 131042
 *    (forma de pagamento da conta WhatsApp Business);
 *  · `credencial` — token recusado: Z-API 401/403; Meta 0/3/10/190/200/131005;
 *  · `numero` — só Meta: o número foi restrito, bloqueado ou saiu do registro
 *    da Cloud API (368, 131031, 131045, 133010, ou `status` ≠ CONNECTED).
 */
export type MotivoInoperante = "assinatura" | "credencial" | "numero";

export interface Inoperancia {
  motivo: MotivoInoperante;
  detalhe: string;
}

/** Não-2xx da Graph API, com o código de erro da Meta já extraído do corpo. */
export class MetaHttpError extends Error {
  readonly path: string;
  readonly status: number;
  /** `error.code` do corpo, quando veio. */
  readonly code: number | null;
  readonly body: string;

  constructor(path: string, status: number, body: string) {
    const code = codigoMeta(body);
    super(`Meta ${path} ${status}${code !== null ? ` (#${code})` : ""}: ${body.slice(0, 500)}`);
    this.name = "MetaHttpError";
    this.path = path;
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function codigoMeta(body: string): number | null {
  try {
    const c = (JSON.parse(body) as { error?: { code?: unknown } }).error?.code;
    return typeof c === "number" ? c : null;
  } catch {
    return null;
  }
}

/**
 * Tabela conferida em developers.facebook.com/docs/whatsapp/cloud-api/support/
 * error-codes (2026-09-22). Só códigos da CONTA ou do NÚMERO; os da mensagem
 * (template, destinatário, janela de 24h) ficam em `falhaDaMensagemMeta`.
 */
const INOPERANCIA_META: Record<number, MotivoInoperante> = {
  0: "credencial",
  3: "credencial",
  10: "credencial",
  190: "credencial",
  200: "credencial",
  131005: "credencial",
  131042: "assinatura",
  368: "numero",
  131031: "numero",
  131045: "numero",
  133010: "numero",
};

export function classificarMeta(code: number | null): MotivoInoperante | null {
  return code === null ? null : (INOPERANCIA_META[code] ?? null);
}

/**
 * O que a Meta disse sobre ESTA mensagem, quando o problema não é o canal.
 *
 *  · `requer_template` — 131047: passaram 24h desde a última mensagem da
 *    pessoa; texto livre não sai, só template aprovado. Não adianta
 *    retentar: a linha espera (ver `dispatchDue`);
 *  · `limite` — 130429/131048/131056: vazão ou par remetente-destinatário;
 *    retentar depois resolve.
 */
export type FalhaDaMensagem = "requer_template" | "limite";

const FALHA_META: Record<number, FalhaDaMensagem> = {
  131047: "requer_template",
  130429: "limite",
  131048: "limite",
  131056: "limite",
};

export function falhaDaMensagemMeta(err: unknown): FalhaDaMensagem | null {
  if (!(err instanceof MetaHttpError) || err.code === null) return null;
  return FALHA_META[err.code] ?? null;
}

/** A mesma pergunta, feita a um erro de ENVIO já lançado — de qualquer provedor. */
export function inoperanciaDoErro(err: unknown): Inoperancia | null {
  if (err instanceof ZapiHttpError) {
    const motivo = classificarInoperancia(err.status, err.body);
    return motivo ? { motivo, detalhe: err.message.slice(0, 300) } : null;
  }
  if (err instanceof MetaHttpError) {
    const motivo = classificarMeta(err.code);
    return motivo ? { motivo, detalhe: err.message.slice(0, 300) } : null;
  }
  return null;
}
