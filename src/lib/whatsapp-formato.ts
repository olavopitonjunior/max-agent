/**
 * Formatação de saída do WhatsApp: negrito é `*x*`, não `**x**`.
 *
 * O modelo escreve markdown de dois asteriscos por hábito (prod 10/11/2026:
 * "**TESTE assinatura 2**" chegou com os asteriscos visíveis no Max e no
 * Newton). Em vez de depender de o prompt vencer o hábito, o texto é
 * normalizado no ÚNICO ponto de saída (`transport.sendText`), que serve os
 * dois agentes e todos os caminhos (resposta, outbox, avisos).
 *
 * Só mexe em par `**texto**` na mesma linha, com texto colado nos asteriscos.
 * Não toca `*texto*` (já é WhatsApp), marcador de lista `* item`, asterisco
 * solto, nem a URL.
 */
const NEGRITO_MARKDOWN = /\*\*(?=[^\s*])([^*\n]*?[^\s*])\*\*/g;

export function paraFormatoWhatsapp(texto: string): string {
  if (!texto.includes("**")) return texto;
  return texto.replace(NEGRITO_MARKDOWN, "*$1*");
}
