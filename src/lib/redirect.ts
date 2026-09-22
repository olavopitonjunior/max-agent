/**
 * Regras do redirecionador `/r/<id>` (rota em `src/app/r/[id]/route.ts`).
 * Separadas da rota porque um `route.ts` do Next só pode exportar handlers.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMINIO = "imobpro.ia.br";

/** O destino é um link nosso? Comparação pelo hostname, nunca por substring. */
export function destinoPermitido(link: string | null | undefined): URL | null {
  if (!link) return null;
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (host !== DOMINIO && !host.endsWith(`.${DOMINIO}`)) return null;
  return u;
}

/** O id é o UUID aleatório de uma linha do outbox? */
export function ehIdDeOutbox(id: string): boolean {
  return UUID_RE.test(id);
}
