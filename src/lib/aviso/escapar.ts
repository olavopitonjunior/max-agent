/**
 * Escapa dado de usuário (nome de negócio, de pessoa, de etapa) antes de entrar
 * entre `*…*` ou `_…_` numa mensagem de WhatsApp.
 *
 * O WhatsApp não tem escape com barra (`\*` mostraria a barra) e o separador
 * invisível U+2063 não segura a marca: no smoke de 28/10, `*302*` virou negrito
 * e os asteriscos sumiram. A regra que funciona (a mesma da plataforma em prod)
 * é trocar cada marca por um caractere parecido que não formata.
 */
const PARECIDOS: Record<string, string> = { "*": "∗", _: "＿", "~": "∼", "`": "ˋ" };

export function escaparMarkdownWa(s: string): string {
  return s.replace(/[*_~`]/g, (c) => PARECIDOS[c]);
}
