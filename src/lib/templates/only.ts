/**
 * `--only` do `scripts/templates-sync.ts`: restringe a submissão a templates
 * nomeados. Existe porque o `--apply` submete TODO template ausente de
 * `wa_template` — e o catálogo pode ter texto ainda não revisado pelo Olavo
 * convivendo com o que ele já aprovou (caso de 14/10/2026: o de atividades
 * pendentes junto com dois de proposta de 07/10).
 *
 * Nome desconhecido é erro, não filtro vazio: um typo no nome não pode virar
 * "nada a fazer" silencioso, nem — pior — o script seguir sem filtro.
 */

/** Lê `--only a,b` ou `--only=a,b`. `null` = sem filtro. */
export function lerOnly(argv: readonly string[]): string[] | null {
  let bruto: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") {
      bruto = argv[i + 1];
      if (bruto === undefined || bruto.startsWith("--")) {
        throw new Error("--only precisa de nome(s): --only max_x[,max_y]");
      }
    } else if (a.startsWith("--only=")) {
      bruto = a.slice("--only=".length);
    }
  }
  if (bruto === undefined) return null;
  const nomes = bruto
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (nomes.length === 0) throw new Error("--only precisa de nome(s): --only max_x[,max_y]");
  return nomes;
}

/** Filtra o catálogo pelos nomes; lança se algum nome não existir. */
export function filtrarPorNomes<T extends { name: string }>(
  catalogo: readonly T[],
  nomes: readonly string[] | null
): T[] {
  if (nomes === null) return [...catalogo];
  const existentes = new Set(catalogo.map((d) => d.name));
  const desconhecidos = nomes.filter((n) => !existentes.has(n));
  if (desconhecidos.length > 0) {
    throw new Error(`--only: template(s) fora do catálogo: ${desconhecidos.join(", ")}`);
  }
  const pedidos = new Set(nomes);
  return catalogo.filter((d) => pedidos.has(d.name));
}
