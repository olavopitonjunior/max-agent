import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/auth";
import { sweepInbound } from "@/lib/inbound";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Cron da fila de ENTRADA — a rede de segurança das respostas.
 *
 * O caminho normal é o `waitUntil` do próprio webhook, que responde em segundos.
 * Este cron existe para o que aquele caminho não garante: a function pode ser
 * morta antes de terminar, e aí a linha fica em `processing` sem ninguém para
 * retomá-la. Sem esta varredura, "o Max não respondeu" seria um estado
 * permanente e invisível.
 *
 * Roda a cada minuto (ver `vercel.json`). A maioria das execuções não acha
 * nada — o custo é uma query no índice parcial.
 *
 * Auth: `CRON_SECRET`, igual ao do outbox. Sem ela, qualquer um forçaria o
 * reprocessamento da fila.
 */
export async function GET(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  try {
    const totals = await sweepInbound();
    if (totals.blocked > 0) {
      console.error(
        `[cron/inbound] ${totals.blocked} sem resposta — instância desemparelhada`
      );
    } else if (totals.claimed > 0) {
      console.log(
        `[cron/inbound] ${totals.done} respondidas, ${totals.retry} pra retentar, ` +
          `${totals.failed} falhas de ${totals.claimed}`
      );
    }
    return NextResponse.json(totals);
  } catch (err) {
    // Nunca 500 silencioso: o cron da Vercel não repete no mesmo minuto, e um
    // erro engolido aqui é fila parada sem ninguém saber.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron/inbound] falhou:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
