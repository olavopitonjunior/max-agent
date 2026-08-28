import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { connectionStatus } from "@/lib/zapi";
import { requireHmac } from "@/lib/auth";
import { isWithinWindow, nextDeliveryTime } from "@/lib/window";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/admin/status — o que o Mission Control do Max, dentro do admin do
 * ImobPro, mostra.
 *
 * O Newton tem um painel próprio (`agentpro.ia.br`) porque o OpenClaw traz um.
 * O Max não traz nada, e construir um segundo painel para três tenants seria
 * mais superfície para manter e mais um lugar para esquecer de olhar — então o
 * painel vive no admin que já existe, e este endpoint é a única coisa que o
 * serviço precisa expor.
 *
 * Auth: o MESMO segredo do `/notify`, mas a assinatura cobre
 * `${timestamp}.${method}.${path com query}` — assinar o corpo vazio deixava o
 * `?orgId=` FORA da assinatura, e uma assinatura capturada valia 5 minutos
 * para qualquer org (enumeração cross-tenant da fila). O formato antigo
 * (corpo vazio) NÃO é mais aceito desde 2026-08-28 (#21).
 *
 * **`zapi.connected` é o número mais importante da tela.** Instância
 * desemparelhada aceita `send-text` com HTTP 200 e `messageId` válido e não
 * entrega nada: sem olhar aqui, a fila parece saudável enquanto ninguém recebe.
 */
export async function GET(req: NextRequest) {
  const auth = await requireHmac(req, { signQuery: true });
  if (!auth.ok) return auth.response;

  const orgId = req.nextUrl.searchParams.get("orgId");

  const [counts, recent, zapi, inboundCounts, oldestPending, delivery] = await Promise.all([
    query<{ status: string; n: string }>(
      `SELECT status, COUNT(*)::text AS n
         FROM outbox
        WHERE created_at > now() - interval '7 days'
          AND ($1::text IS NULL OR org_id = $1)
        GROUP BY status`,
      [orgId]
    ),
    query<Record<string, unknown>>(
      `SELECT id, org_id, audience, title, status, deliver_after,
              attempts, last_error, created_at, sent_at
         FROM outbox
        WHERE ($1::text IS NULL OR org_id = $1)
        ORDER BY created_at DESC
        LIMIT 50`,
      [orgId]
    ),
    // Nunca derruba a tela: se a Z-API estiver fora, o painel ainda precisa
    // mostrar a fila — que é justamente o que se quer ver nessa hora.
    connectionStatus().catch((err) => ({
      connected: false,
      error: err instanceof Error ? err.message : String(err),
      raw: null,
    })),
    // A fila de ENTRADA era invisível: falha de conversa (failed, órfã em
    // processing) não aparecia em lugar nenhum — o operador não tinha como
    // ver que respostas estavam falhando.
    // `.catch` nas três consultas novas, como no probe da Z-API: na janela
    // deploy-antes-de-migrar uma coluna ausente não pode derrubar o painel
    // inteiro — que é onde o operador olharia nessa hora.
    query<{ status: string; n: string }>(
      `SELECT status, COUNT(*)::text AS n
         FROM inbound_queue
        WHERE created_at > now() - interval '7 days'
        GROUP BY status`
    ).catch(() => []),
    query<{ oldest: string | null }>(
      `SELECT min(created_at)::text AS oldest
         FROM inbound_queue WHERE status = 'pending'`
    ).catch(() => []),
    // Reconciliação de entrega: o que saiu e está sem notícia é o número que
    // acorda alguém.
    query<{ delivery_status: string; n: string }>(
      `SELECT COALESCE(delivery_status, 'aguardando') AS delivery_status,
              COUNT(*)::text AS n
         FROM outbox
        WHERE status = 'sent' AND created_at > now() - interval '7 days'
          AND ($1::text IS NULL OR org_id = $1)
        GROUP BY 1`,
      [orgId]
    ).catch(() => []),
  ]);

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]));
  const inboundByStatus = Object.fromEntries(
    inboundCounts.map((c) => [c.status, Number(c.n)])
  );
  const deliveryByStatus = Object.fromEntries(
    delivery.map((c) => [c.delivery_status, Number(c.n)])
  );

  return NextResponse.json({
    service: "max-agent",
    zapi,
    window: {
      open: isWithinWindow(),
      nextDelivery: nextDeliveryTime().toISOString(),
    },
    outbox: {
      last7d: byStatus,
      pending: byStatus.pending ?? 0,
      failed: byStatus.failed ?? 0,
      delivery7d: deliveryByStatus,
      unconfirmed: deliveryByStatus.unconfirmed ?? 0,
      recent,
    },
    inbound: {
      // A fila de entrada não tem org_id (migration 004): este bloco é SEMPRE
      // global, mesmo com ?orgId= — o campo scope evita que o painel apresente
      // contagem de todos os tenants como se fosse de um.
      scope: "global",
      last7d: inboundByStatus,
      pending: inboundByStatus.pending ?? 0,
      processing: inboundByStatus.processing ?? 0,
      failed: inboundByStatus.failed ?? 0,
      oldestPending: oldestPending[0]?.oldest ?? null,
    },
  });
}
