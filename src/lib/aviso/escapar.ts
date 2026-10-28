/**
 * Escapa dado de usuário (nome de negócio, de pessoa, de etapa) antes de entrar
 * entre `*…*` ou `_…_` numa mensagem de WhatsApp.
 *
 * O WhatsApp não tem escape com barra (`\*` mostraria a barra). O truque é
 * separar o símbolo do texto com U+2063 (separador invisível): `*302*` vira
 * `*⁣302*⁣`, que não abre nem fecha formatação, e visualmente é igual.
 */
const MARCAS = /([*_~`])/g;

export function escaparMarkdownWa(s: string): string {
  return s.replace(MARCAS, "$1⁣");
}
