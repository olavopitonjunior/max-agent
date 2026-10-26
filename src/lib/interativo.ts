import type { Interativo, OpcaoInterativa } from "./transport/types";

/**
 * Botões e listas a partir da resposta que o grafo JÁ montou em texto.
 *
 * Só os nós determinísticos escrevem "Responda SIM" e menu numerado (o prompt
 * proíbe o modelo de fazer isso), e o toque volta como o mesmo texto que a
 * pessoa digitaria (`op:SIM` → "SIM", `op:2` → "2"). Por isso uma detecção a
 * mais é inofensiva: o servidor refaz telefone → sujeito → org e a pendência
 * decide o que o SIM vale, exatamente como se tivesse sido digitado.
 *
 * Fora dos limites da Meta (corpo, quantidade de opções), devolve `null` e o
 * texto numerado segue como está.
 */

export const PREFIXO_OPCAO = "op:";

/** Limites da Cloud API para mensagens interativas. */
const MAX_CORPO = 1024;
const MAX_BOTOES = 3;
const MAX_TITULO_BOTAO = 20;
const MAX_LINHAS = 10;
const MAX_TITULO_LINHA = 24;
const MAX_DESCRICAO_LINHA = 72;
const BOTAO_DA_LISTA = "Ver opções";

// Por ponto de código: cortar no meio de um par substituto quebra emoji.
const corta = (s: string, n: number) => {
  const cs = Array.from(s);
  return cs.length > n ? cs.slice(0, n - 1).join("") + "…" : s;
};
const opcao = (texto: string, titulo: string, descricao?: string): OpcaoInterativa =>
  ({ id: `${PREFIXO_OPCAO}${texto}`, titulo, ...(descricao ? { descricao } : {}) });

const LINHA_NUMERADA = /^(\d{1,2})[).]\s+(.+)$/;
const PEDE_NUMERO = /Responda com o número/i;
const DIGA_MAIS = /\bDiga MAIS\b/;
const PEDE_SIM = /\bRespond[ae]\s+\*?SIM\*?/i;

export function derivarInterativo(texto: string | null | undefined): Interativo | null {
  if (!texto) return null;
  return lista(texto) ?? botoes(texto);
}

function lista(texto: string): Interativo | null {
  if (!PEDE_NUMERO.test(texto)) return null;
  const linhas = texto.split("\n");
  const numeradas = linhas
    .map((l, i) => ({ i, m: LINHA_NUMERADA.exec(l.trim()) }))
    .filter((x): x is { i: number; m: RegExpExecArray } => x.m !== null);
  if (numeradas.length < 2) return null;
  // Um bloco só, sem buraco: uma lista no meio do texto e outra no fim não é menu.
  if (numeradas.some((x, k) => k > 0 && x.i !== numeradas[k - 1].i + 1)) return null;
  const numeros = numeradas.map((x) => x.m[1]);
  if (new Set(numeros).size !== numeros.length) return null;

  const opcoes = numeradas.map(({ m }) => {
    const rotulo = m[2].trim();
    return opcao(
      m[1],
      corta(rotulo, MAX_TITULO_LINHA),
      rotulo.length > MAX_TITULO_LINHA ? corta(rotulo, MAX_DESCRICAO_LINHA) : undefined
    );
  });
  const mais = DIGA_MAIS.test(texto);
  if (mais) opcoes.push(opcao("MAIS", "Ver mais"));
  if (opcoes.length > MAX_LINHAS) return null;

  const fora = new Set(numeradas.map((x) => x.i));
  const corpo =
    linhas
      .filter((l, i) => !fora.has(i) && !(mais && DIGA_MAIS.test(l)))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() || "Escolha uma opção.";
  if (corpo.length > MAX_CORPO) return null;
  return { tipo: "lista", corpo, botao: BOTAO_DA_LISTA, opcoes };
}

function botoes(texto: string): Interativo | null {
  const pedido = PEDE_SIM.exec(texto);
  if (!pedido || texto.length > MAX_CORPO) return null;
  // "peça que ele responda SIM no WhatsApp da ClickSign": instrução para
  // terceiro, não pergunta ao usuário.
  if (/\bque\s+(?:\S+\s+){0,3}$/i.test(texto.slice(0, pedido.index))) return null;
  // Só o que o texto oferece como alternativa: NÃO em maiúsculas, ou "ou não"
  // / "sim/não" em qualquer caixa. "Isso não duplica" é prosa, não opção.
  const depois = texto.slice(pedido.index);
  const opcoes = [opcao("SIM", "SIM")];
  if (/(?:^|[^\p{L}])NÃO(?![\p{L}])/u.test(depois) || /(?:\bou\s+|\/)\*?n[aã]o\*?(?![\p{L}])/iu.test(depois)) {
    opcoes.push(opcao("NÃO", "NÃO"));
  }
  if (/\bCANCELAR\b/.test(depois)) opcoes.push(opcao("CANCELAR", "CANCELAR"));
  if (opcoes.length > MAX_BOTOES || opcoes.some((o) => o.titulo.length > MAX_TITULO_BOTAO)) return null;
  return { tipo: "botoes", corpo: texto, opcoes };
}
