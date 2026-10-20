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

/**
 * `MAX_CAPTACAO_AUTORIZACAO` (default desligado, v2/PR7, par do
 * contractmaker#1863): a fila de autorização do gerente (listar, aprovar,
 * negar) pelo Max. Independente de `MAX_CAPTACAO`: o pedido do corretor
 * (`captacao.autorizacao.pedir`) continua atrás de `MAX_CAPTACAO`, porque só
 * existe dentro do fluxo de captação; a fila do gerente é um gatilho próprio,
 * sem depender do rascunho estar ligado.
 */
export function captacaoAutorizacaoLigada(): boolean {
  return LIGADO.test(process.env.MAX_CAPTACAO_AUTORIZACAO ?? "");
}
