import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/auth";
import { dispatchDue } from "@/lib/outbox";
import { reconcile } from "@/lib/delivery";
import { connectionStatus } from "@/lib/zapi";
import { observeConnection } from "@/lib/connection";

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
  const denied = requireCronSecret(req);
  if (denied) return denied;

  // Âncora do orçamento da passada: o prazo do seed no `dispatchDue` é
  // medido daqui, e não do início do despacho — ver o doc de `seedDeadline`.
  const iniciadoEm = Date.now();

  try {
    /**
     * ── Pergunta SEMPRE, uma vez por passada (F7) ────────────────────────
     *
     * Antes o estado da instância só era checado dentro do `dispatchDue`, e só
     * quando havia fila vencida — de propósito, para a execução vazia não
     * custar nada. O efeito colateral: **com a fila vazia, uma queda era
     * invisível para o cron**. E queda com fila vazia importa igual, porque o
     * INBOUND também para: quem escrever para o Max não recebe resposta.
     *
     * A resposta é repassada ao `dispatchDue`, que por isso não pergunta de
     * novo — o total de chamadas ao `/status` não muda quando há fila; sobe em
     * uma por minuto quando não há.
     *
     * `null` = a pergunta FALHOU. Não é "desconectada": exceção aqui significa
     * credencial/rota/formato, e tratá-la como queda mandaria alguém repárear
     * a instância à toa (lição de 21/08). Nesse caso não se observa nada — a
     * máquina de estado só aceita boolean conhecido.
     */
    const status = await connectionStatus().catch((err) => {
      console.warn(
        "[cron/outbox] não deu pra checar a instância:",
        err instanceof Error ? err.message : String(err)
      );
      return null;
    });

    if (status) {
      // Nunca lança; um alerta quebrado não pode quebrar o despacho.
      await observeConnection({ connected: status.connected, fonte: "cron" });
    }

    const totals = await dispatchDue(50, status, iniciadoEm);
    // Reconciliação na MESMA passada, depois do despacho (sem cron novo):
    // marca `unconfirmed` o que ficou sem callback e reporta desfechos ao
    // Contractmaker. Falha aqui não desfaz envio nenhum.
    // Falha vira marcador no payload, não `null`: um reconcile morto por
    // semanas com o cron respondendo 200 limpo seria invisível ao monitoramento
    // (achado do code review).
    const rec = await reconcile().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[cron/outbox] reconcile falhou:", message);
      return { error: message };
    });
    if (totals.blocked > 0) {
      // Nível de erro, e não info: fila represada por canal fora do ar é o
      // estado que precisa acordar alguém. `dispatchDue` já logou o detalhe.
      console.error(
        `[cron/outbox] ${totals.blocked} represada(s) — instância desemparelhada`
      );
    } else if (totals.claimed > 0) {
      console.log(
        `[cron/outbox] ${totals.sent} enviadas, ${totals.failed} falhas de ${totals.claimed}`
      );
    }
    return NextResponse.json({ ...totals, reconcile: rec });
  } catch (err) {
    // Nunca 500 silencioso: o cron da Vercel não repete no mesmo minuto, e um
    // erro engolido aqui é fila parada sem ninguém saber.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron/outbox] falhou:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
