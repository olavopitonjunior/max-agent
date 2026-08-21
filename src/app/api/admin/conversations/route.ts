import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { requireHmac } from "@/lib/auth";
import { maskPhone } from "@/lib/phone";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/admin/conversations — o que o painel do Max, dentro do admin do
 * ImobPro, mostra de CONVERSA.
 *
 * O `/admin/status` responde "a fila está saudável?". Este responde a outra
 * pergunta, que até agora não tinha onde ser feita: **"o que o agente andou
 * dizendo, e quanto isso custou?"**. As duas primeiras conversas reais em
 * produção renderam quatro defeitos, todos achados garimpando tabela à mão —
 * é essa investigação que esta rota substitui.
 *
 * ── Superfície mínima, de propósito ──────────────────────────────────────
 *
 * Sem busca por texto, sem filtro por conteúdo. Só recorte por tenant e
 * paginação por tempo. Uma rota de leitura de conversa é a superfície mais
 * sensível que este serviço expõe, e cada filtro novo é um jeito a mais de
 * pescar. Quando o painel pedir busca, ela nasce com o caso de uso concreto.
 *
 * Auth: mesmo HMAC do `/admin/status`, assinando `${ts}.${method}.${path com
 * query}` — e **sem `allowLegacyEmptyBody`**. A tolerância ao formato antigo
 * existe lá para não quebrar um cliente que já chamava; aqui não há cliente
 * antigo, então a rota nasce só com o formato que cobre a query. Aceitar o
 * legado numa rota nova seria criar dívida no dia do parto.
 *
 * Do lado do ImobPro, quem chama tem que checar `getPlatformRole`: isto é
 * super-admin, não dono de tenant (decisão do PRD).
 */

/** Teto por página. Alto o bastante para o painel, baixo para não virar dump. */
const MAX_LIMITE = 100;

interface Linha extends Record<string, unknown> {
  id: string;
  org_id: string;
  phone: string;
  message_id: string | null;
  kind: string;
  inbound_text: string | null;
  transcript: string | null;
  reply_text: string | null;
  tools_json: unknown;
  usage_json: unknown;
  latency_ms: number | null;
  error: string | null;
  created_at: string;
}

export async function GET(req: NextRequest) {
  const auth = await requireHmac(req, { signQuery: true });
  if (!auth.ok) return auth.response;

  const sp = req.nextUrl.searchParams;
  const orgId = sp.get("orgId");

  /**
   * Sem `orgId`, é preciso pedir `scope=all` explicitamente.
   *
   * O default de uma rota que lê CONVERSA não pode ser "todos os tenants".
   * A visão cross-tenant é legítima para o super-admin — mas tem que ser um
   * ato, não o que acontece quando alguém esquece um parâmetro.
   */
  if (!orgId && sp.get("scope") !== "all") {
    return NextResponse.json(
      { error: "org_id_obrigatorio", hint: "use ?orgId=<id> ou ?scope=all" },
      { status: 400 }
    );
  }

  const limiteBruto = Number(sp.get("limit") ?? 50);
  const limite = Number.isFinite(limiteBruto)
    ? Math.min(Math.max(Math.trunc(limiteBruto), 1), MAX_LIMITE)
    : 50;

  /**
   * Paginação por `(created_at, id)`, não por offset e não só por tempo.
   *
   * Offset anda sozinho quando chega turn novo durante a navegação, e o
   * operador pularia linhas justamente enquanto investiga. Mas só o tempo não
   * basta: `timestamptz` empata, e dois turns gravados no mesmo instante
   * (instâncias diferentes, ou um backfill) podem cair um de cada lado da
   * fronteira da página. Aí `created_at < cursor` exclui TODAS as linhas
   * daquele instante — inclusive a que nunca foi mostrada.
   *
   * Numa tabela de auditoria isso é "linha some da investigação sem erro
   * nenhum": exatamente a classe de defeito que esta tabela existe para matar.
   * O `id` é UUID e não repete, então o par ordenado desempata sempre.
   *
   * Formato do cursor: `<iso>|<uuid>` — o mesmo que a resposta devolve.
   */
  const cursorBruto = sp.get("cursor");
  let cursorTs: string | null = null;
  let cursorId: string | null = null;
  if (cursorBruto) {
    const [ts, id] = cursorBruto.split("|");
    const tsValido = ts && !Number.isNaN(Date.parse(ts));
    const idValido = /^[0-9a-f-]{36}$/i.test(id ?? "");
    if (!tsValido || !idValido) {
      return NextResponse.json({ error: "cursor_invalido" }, { status: 400 });
    }
    cursorTs = ts;
    cursorId = id;
  }

  const linhas = await query<Linha>(
    `SELECT id, org_id, phone, message_id, kind, inbound_text, transcript,
            reply_text, tools_json, usage_json, latency_ms, error,
            created_at::text AS created_at
       FROM conversation_turn
      WHERE ($1::text IS NULL OR org_id = $1)
        AND ($2::timestamptz IS NULL
             OR (created_at, id) < ($2::timestamptz, $3::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT $4`,
    [orgId, cursorTs, cursorId, limite]
  ).catch((err) => {
    /**
     * Só a tabela AUSENTE (42P01) degrada em silêncio, e só porque a janela
     * deploy-antes-de-migrar é real.
     *
     * Qualquer outro erro vira 500. Devolver `[]` com 200 para tudo faria
     * "banco fora do ar" e "nenhuma conversa" ficarem indistinguíveis —
     * justamente na rota que alguém abre para investigar.
     */
    const code = (err as { code?: string }).code;
    console.warn(
      "[admin/conversations] leitura falhou:",
      err instanceof Error ? err.message : String(err)
    );
    if (code === "42P01") return "sem_tabela" as const;
    throw err;
  });

  if (linhas === "sem_tabela") {
    return NextResponse.json({ turns: [], nextCursor: null, degraded: "sem_tabela" });
  }

  return NextResponse.json({
    turns: linhas.map((l) => ({
      id: l.id,
      orgId: l.org_id,
      /**
       * Telefone MASCARADO na resposta, inteiro no banco.
       *
       * A coluna existe para investigar "por que fulano não recebeu" e fica
       * atrás de credencial de banco. A resposta HTTP atravessa rede, log de
       * proxy e navegador — os 4 finais bastam para correlacionar, e é o mesmo
       * contrato que o log estruturado já segue.
       */
      phone: maskPhone(l.phone),
      messageId: l.message_id,
      kind: l.kind,
      inboundText: l.inbound_text,
      transcript: l.transcript,
      replyText: l.reply_text,
      tools: l.tools_json,
      usage: l.usage_json,
      latencyMs: l.latency_ms,
      error: l.error,
      createdAt: l.created_at,
    })),
    // `null` quando a página não encheu: não há mais o que buscar.
    nextCursor:
      linhas.length === limite
        ? `${linhas[linhas.length - 1].created_at}|${linhas[linhas.length - 1].id}`
        : null,
  });
}
