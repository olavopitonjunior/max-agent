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

/**
 * Rótulo interno da cerca que vazou para a resposta entre asteriscos ou aspas (prod 26/11: "só consigo listar
 * *mostrando 5* das suas propostas"): fica só o número. A frase comum ("Mostrando 5 atividades:") não mexe.
 */
export function limparRotuloInterno(texto: string): string {
  return texto.replace(/[*"“'‘]\s*mostrando\s+(\d+)\s*[*"”'’]/gi, "$1");
}

/** Corrige "mostrando N" para o número de linhas realmente listadas. Sem lista no texto, não mexe. */
export function corrigirContagemMostrada(texto: string): string {
  const listadas = linhasListadas(texto);
  if (listadas === 0) return texto;
  return texto.replace(/(\bmostrando\s+)(\d+)\b/gi, (todo, prefixo: string, n: string) =>
    Number(n) === listadas ? todo : `${prefixo}${listadas}`
  );
}
