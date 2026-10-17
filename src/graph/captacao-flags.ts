/**
 * As flags da captação pelo Max (P9). Num módulo próprio, sem imports, para
 * `tools.ts` e `capacidades.ts` poderem lê-las sem criar ciclo com `captacao.ts`.
 *
 * Capability nova nasce DESLIGADA (regra 3 da governança do Max): sem a env, o
 * Max se comporta exatamente como antes do P9 — inclusive para quem já tem
 * `captacao.*` na política da org.
 */
const LIGADO = /^(1|true|on|sim)$/i;

/** `MAX_CAPTACAO` (default desligado): criar, completar, conferir e listar. */
export function captacaoLigada(): boolean {
  return LIGADO.test(process.env.MAX_CAPTACAO ?? "");
}

/** `MAX_CAPTACAO_ENVIO` (default desligado): além do fluxo, o envio para assinatura. */
export function captacaoEnvioLigado(): boolean {
  return captacaoLigada() && LIGADO.test(process.env.MAX_CAPTACAO_ENVIO ?? "");
}
