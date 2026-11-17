/**
 * Busca de negócio por nome (`listar_negocios {busca}`, par do `deal.list` do contractmaker).
 *
 * O servidor procura em `title` OU `clientName`. Mas um CM ANTIGO descarta `busca` em silêncio e devolve a
 * lista inteira, então o Max filtra de novo por conta própria, ANTES de numerar: item que não casa nunca
 * ganha número, logo nunca pode ser detalhado por engano (fail-closed).
 */

/** Tamanho máximo do termo, igual ao do receptor (1 a 80 caracteres depois do trim). */
export const BUSCA_MAX = 80;

/**
 * O termo que pode seguir: texto, aparado e cortado em `BUSCA_MAX`. Vazio, só espaço ou tipo errado: `null`
 * (sem busca). Cortar em vez de recusar: o termo longo do modelo ainda é útil, e recusar derrubaria a consulta.
 */
export function lerBusca(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const termo = v.trim().slice(0, BUSCA_MAX).trim();
  return termo ? termo : null;
}

/** Minúsculas, sem acento e com espaços colapsados — a mesma régua dos dois lados da comparação. */
export function normalizarParaBusca(texto: string): string {
  return texto.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();
}

/**
 * Mantém só os itens cujo `titulo` ou `cliente` contém o termo. Item sem nenhum dos dois como texto não casa:
 * na dúvida, fora (nunca numerar o que não se pôde conferir).
 */
export function filtrarPorBusca(items: unknown[], termo: string): unknown[] {
  const alvo = normalizarParaBusca(termo);
  if (!alvo) return items;
  return items.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const { titulo, cliente } = item as { titulo?: unknown; cliente?: unknown };
    return [titulo, cliente].some((campo) => typeof campo === "string" && normalizarParaBusca(campo).includes(alvo));
  });
}
