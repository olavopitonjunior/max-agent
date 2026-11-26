/**
 * Guarda determinística da contagem de uma lista (prod 19/11): o modelo escreveu
 * "mostrando 5… há mais" e listou 4 linhas. O texto final diz quantas linhas a
 * pessoa de fato vê; o número do modelo só vale se bater.
 */

/** Linhas de item no nível raiz: numeradas ("1.", "2)") e, sem elas, marcadores ("•", "-", "*"). */
export function linhasListadas(texto: string): number {
  const linhas = texto.split("\n");
  const numeradas = linhas.filter((l) => /^ {0,1}\d{1,3}[.)]\s+\S/.test(l)).length;
  if (numeradas > 0) return numeradas;
  return linhas.filter((l) => /^ {0,1}[•*-]\s+\S/.test(l)).length;
}

/** Corrige "mostrando N" para o número de linhas realmente listadas. Sem lista no texto, não mexe. */
export function corrigirContagemMostrada(texto: string): string {
  const listadas = linhasListadas(texto);
  if (listadas === 0) return texto;
  return texto.replace(/(\bmostrando\s+)(\d+)\b/gi, (todo, prefixo: string, n: string) =>
    Number(n) === listadas ? todo : `${prefixo}${listadas}`
  );
}
