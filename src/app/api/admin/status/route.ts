import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { connectionStatus } from "@/lib/zapi";
import { verifySignature } from "@/lib/hmac";
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
 * Auth: o MESMO HMAC do `/notify`. Um segredo compartilhado a menos, e a
 * assinatura cobre `${timestamp}.${rawBody}` — em GET o corpo é vazio, mas o
 * timestamp continua limitando a validade da requisição capturada.
 *
 * **`zapi.connected` é o número mais importante da tela.** Instância
 * desemparelhada aceita `send-text` com HTTP 200 e `messageId` válido e não
 * entrega nada: sem olhar aqui, a fila parece saudável enquanto ninguém recebe.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.MAX_NOTIFY_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "not_configured" }, { status: 500 });
  }

  const verdict = verifySignature({
    timestamp: req.headers.get("x-max-timestamp"),
    signature: req.headers.get("x-max-signature"),
    rawBody: "",
    secret,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
