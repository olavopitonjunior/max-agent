import { NextRequest, NextResponse } from "next/server";
import { requireHmac } from "@/lib/auth";
import {
  filtrarThreads,
  interpretarBusca,
  listarThreads,
  paraResposta,
  type ThreadInterna,
} from "@/lib/threads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/admin/threads — uma linha por pessoa que conversou com o Max ou
 * recebeu aviso dele, numa org. É a lista do painel de conversas (Fase 4).
 *
 * Contrato de auth igual ao do `/admin/conversations`: HMAC sobre
 * `${ts}.GET.${path com query}`, então `orgId`, `cursor` e `q` estão todos
 * assinados e não dá para trocar a org de uma URL assinada.
 *
 * Quem chama decide QUEM pode ver QUAL org: o ImobPro passa o `orgId` da
 * sessão para o admin do tenant, e só o super-admin pode pedir `scope=all`.
 * Este serviço não conhece usuário; ele garante que a resposta NUNCA mistura
 * orgs além do que foi pedido e que o telefone cru não sai.
 *
 * Query: `orgId` (ou `scope=all`), `q` (4+ dígitos finais ou 2+ letras do
 * nome), `limit` (1-100, padrão 50), `cursor` (o `nextCursor` anterior).
 */

const MAX_LIMITE = 100;

export async function GET(req: NextRequest) {
  const auth = await requireHmac(req, { signQuery: true });
  if (!auth.ok) return auth.response;

  const sp = req.nextUrl.searchParams;
  const orgId = sp.get("orgId");
  if (!orgId && sp.get("scope") !== "all") {
    return NextResponse.json(
      { error: "org_id_obrigatorio", hint: "use ?orgId=<id> ou ?scope=all" },
      { status: 400 }
    );
  }

  const busca = interpretarBusca(sp.get("q") ?? "");
  if (busca === "invalida") {
    return NextResponse.json(
      { error: "busca_invalida", hint: "4+ dígitos finais do telefone ou 2+ letras do nome" },
      { status: 400 }
    );
  }

  const limiteBruto = Number(sp.get("limit") ?? 50);
  const limite = Number.isFinite(limiteBruto)
    ? Math.min(Math.max(Math.trunc(limiteBruto), 1), MAX_LIMITE)
    : 50;

  /**
   * Cursor `<ultimaEm>|<key>|<orgId>`: a ordem é por esses três, decrescente.
   * O `orgId` entra porque no `scope=all` o mesmo telefone (mesma `key`) pode
   * aparecer em duas orgs, e aí os dois primeiros empatam.
   */
  const cursorBruto = sp.get("cursor");
  let cursor: [string, string, string] | null = null;
  if (cursorBruto) {
    // O `orgId` vai por último e absorve o resto: nada impõe que ele não
    // tenha "|", e a tag e o instante nunca têm.
    const [ts, key, ...org] = cursorBruto.split("|");
    if (
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(ts ?? "") ||
      !/^tel_[0-9a-f]{12}$/.test(key ?? "") ||
      !org.length || !org.join("|")
    ) {
      return NextResponse.json({ error: "cursor_invalido" }, { status: 400 });
    }
    cursor = [ts, key, org.join("|")];
  }

  const resultado = await listarThreads(orgId).catch((err) => {
    // Mesma regra do /admin/conversations: só tabela ausente degrada.
    console.warn(
      "[admin/threads] leitura falhou:",
      err instanceof Error ? err.message : String(err)
    );
    if ((err as { code?: string }).code === "42P01") return "sem_tabela" as const;
    throw err;
  });
  if (resultado === "sem_tabela") {
    return NextResponse.json({ threads: [], nextCursor: null, truncado: false, degraded: "sem_tabela" });
  }

  const chave = (t: ThreadInterna): [string, string, string] => [t.ultimaEm, t.key, t.orgId];
  const ordenadas = filtrarThreads(resultado.threads, busca).sort((a, b) =>
    comparar(chave(b), chave(a))
  );
  const depois = cursor
    ? ordenadas.filter((t) => comparar(chave(t), cursor) < 0)
    : ordenadas;
  const pagina = depois.slice(0, limite);
  const ultima = pagina[pagina.length - 1];

  return NextResponse.json({
    threads: pagina.map(paraResposta),
    nextCursor: depois.length > limite && ultima ? chave(ultima).join("|") : null,
    truncado: resultado.truncado,
  });
}

/**
 * Compara as tuplas campo a campo, como texto. Funciona para `ultimaEm` porque
 * ele é ISO UTC de largura fixa (ver `listarThreads`).
 */
function comparar(a: [string, string, string], b: [string, string, string]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}
