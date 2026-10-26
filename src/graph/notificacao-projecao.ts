import { imobproBase } from "@/lib/http";

/**
 * O que o Max mostra de cada item de `notification.list`.
 *
 * O CM projeta `id`, `tipo`, `lida`, `criadoEm` e, desde o Passo 5, `titulo` e
 * `corpo` (até 280 caracteres, podem ser `null`) e `link` opcional. Ausentes
 * (CM antigo, ou `null`), o item sai EXATAMENTE como sempre saiu.
 *
 * Whitelist, e não repasse: campo novo do servidor só chega ao modelo depois de
 * alguém decidir isso aqui (regra 5 do `docs/max.md`: o que o modelo não recebe,
 * ele não vaza).
 *
 * `titulo` e `corpo` são texto montado a partir de dado de terceiros (nome de
 * cliente, observação de formulário público): vão marcados `_untrusted` para o
 * modelo tratá-los como dado, nunca como instrução, e saem sem quebra de linha
 * nem caractere de controle. O limite de 280 é reaplicado aqui: não confiamos no
 * servidor para o tamanho do que entra no prompt.
 *
 * `link` só passa se for do MESMO host do ImobPro (https): URL de outro lugar
 * dentro de uma notificação é exatamente o que uma injeção usaria. Caminho
 * relativo ("/negocios/x") é resolvido contra a base.
 */
export const LIMITE_TEXTO_NOTIFICACAO = 280;
const LIMITE_LINK = 300;

function texto(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const limpo = v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  return limpo ? limpo.slice(0, LIMITE_TEXTO_NOTIFICACAO) : null;
}

function linkSeguro(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const bruto = v.trim();
  if (!bruto || bruto.length > LIMITE_LINK || /\s/.test(bruto)) return null;
  try {
    const base = new URL(imobproBase());
    const url = bruto.startsWith("/") && !bruto.startsWith("//") ? new URL(bruto, base) : new URL(bruto);
    if (url.protocol !== "https:" || url.origin !== base.origin || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function projetarNotificacao(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const it = item as Record<string, unknown>;
  const saida: Record<string, unknown> = {};
  for (const campo of ["id", "tipo", "lida", "criadoEm"]) {
    if (Object.hasOwn(it, campo)) saida[campo] = it[campo];
  }
  const titulo = texto(it.titulo);
  const corpo = texto(it.corpo);
  const link = linkSeguro(it.link);
  if (titulo) saida.titulo = titulo;
  if (corpo) saida.corpo = corpo;
  if (titulo || corpo) saida._untrusted = true;
  if (link) saida.link = link;
  return saida;
}
