import { NextRequest, NextResponse } from "next/server";
import { dispatchDue } from "@/lib/outbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Cron do outbox — o único lugar que de fato manda notificação proativa.
 *
 * Roda a cada minuto (ver `vercel.json`). A maioria das execuções não acha
 * nada e custa uma query indexada; o que importa é que uma mensagem que chegou
 * às 3h saia às 7h em minutos, não na hora seguinte.
 *
 * Auth: `CRON_SECRET`. A Vercel manda `Authorization: Bearer $CRON_SECRET` nos
 * crons dela; sem essa checagem qualquer um dispararia o envio da fila.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron/outbox] CRON_SECRET não configurada");
    return NextResponse.json({ error: "not_configured" }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const totals = await dispatchDue();
    if (totals.claimed > 0) {
      console.log(
        `[cron/outbox] ${totals.sent} enviadas, ${totals.failed} falhas de ${totals.claimed}`
      );
    }
    return NextResponse.json(totals);
  } catch (err) {
    // Nunca 500 silencioso: o cron da Vercel não repete no mesmo minuto, e um
    // erro engolido aqui é fila parada sem ninguém saber.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron/outbox] falhou:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
