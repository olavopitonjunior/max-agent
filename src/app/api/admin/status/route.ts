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
 * para qualquer org (enumeração cross-tenant da fila). O formato antigo segue
 * aceito enquanto o admin do Contractmaker não migra (`allowLegacyEmptyBody`).
 *
 * **`zapi.connected` é o número mais importante da tela.** Instância
 * desemparelhada aceita `send-text` com HTTP 200 e `messageId` válido e não
 * entrega nada: sem olhar aqui, a fila parece saudável enquanto ninguém recebe.
 */
export async function GET(req: NextRequest) {
  const auth = await requireHmac(req, { signQuery: true, allowLegacyEmptyBody: true });
  if (!auth.ok) return auth.response;

  const orgId = req.nextUrl.searchParams.get("orgId");

  const [counts, recent, zapi] = await Promise.all([
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
  ]);

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]));

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
      recent,
    },
  });
}
