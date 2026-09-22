/**
 * O erro HTTP da Z-API e a classificação de INOPERÂNCIA — num módulo sem
 * `fetch`, de propósito.
 *
 * `outbox.ts` e `inbound.ts` precisam olhar para dentro de um erro de envio e
 * perguntar "isso é o canal recusando, ou a mensagem?". Se isso morasse em
 * `zapi.ts`, todo teste que mocka `../zapi` (e são vários — mockam
 * `sendText`/`connectionStatus` para não bater na rede) teria que reexportar
 * as funções puras também, ou veria `undefined is not a function` no primeiro
 * `catch`. Puro aqui, mockável lá.
 */

/**
 * Por que a instância está fora de serviço SEM ser queda de sessão do
 * WhatsApp. Cada valor muda o conselho do alerta — e é por isso que existe:
 *
 *  · `assinatura` — a Z-API respondeu 400 "you must subscribe to this
 *    instance again". Cobrança recusada, plano cancelado. Reparear por QR não
 *    resolve nada; o que resolve é o cartão.
 *  · `credencial` — 401/403: `ZAPI_CLIENT_TOKEN` ou o token da instância
 *    trocados. Também não é QR.
 */
export type MotivoInoperanteZapi = "assinatura" | "credencial";

/** Resposta não-2xx de qualquer endpoint da instância, com status e corpo. */
export class ZapiHttpError extends Error {
  readonly path: string;
  readonly status: number;
  readonly body: string;

  constructor(path: string, status: number, body: string) {
    // Formato mantido: é o que já está gravado em `last_error` de produção e
    // o que os testes e o reprocesso reconhecem.
    super(`Z-API ${path} ${status}: ${body.slice(0, 500)}`);
    this.name = "ZapiHttpError";
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

/**
 * Classifica um não-2xx em inoperância CONHECIDA, ou `null` para "não sei o
 * que é isso" — que continua sendo exceção comum.
 *
 * Conservador de propósito: a partir de 2026-09-12 inoperância REPRESA a fila
 * (ver `dispatchDue`), então um falso positivo aqui para as notificações
 * inteiras em vez de tentar entregar. Só entra o que foi visto em produção com
 * corpo inequívoco (o 400 de assinatura, 10/09) e o que o próprio `send-text`
 * recusaria de qualquer jeito (401/403 — um 403 de allowlist de IP também é
 * o canal inteiro recusando, então represar continua certo). 404, 429, 5xx e
 * corpo desconhecido ficam de fora.
 */
export function classificarInoperancia(
  status: number,
  corpo: string
): MotivoInoperanteZapi | null {
  if (status === 400 && /subscri/i.test(corpo)) return "assinatura";
  if (status === 401 || status === 403) return "credencial";
  return null;
}

// A pergunta "é o canal ou a mensagem?" para um erro de envio de QUALQUER
// provedor mora em `transport/erro.ts` (`inoperanciaDoErro`).
