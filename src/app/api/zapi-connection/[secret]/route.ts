import { NextRequest, NextResponse } from "next/server";
import { connectionStatus } from "@/lib/zapi";
import { observeConnection } from "@/lib/connection";
import { requireZapiSecret } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Callbacks de CONEXÃO da Z-API — os campos `connectedCallbackUrl` e
 * `disconnectedCallbackUrl` da instância, apontados para cá.
 *
 * Rota separada das outras duas pelo mesmo motivo que separou mensagem de
 * status: conexão não é mensagem e não pode encostar na fila de turns. O
 * secret é o mesmo (`ZAPI_WEBHOOK_SECRET`) — é a mesma instância falando, pelo
 * mesmo canal não assinado, com a mesma mitigação e a mesma rotação.
 *
 * ── A decisão que faz esta rota ser robusta ───────────────────────────────
 *
 * **Ela não confia no corpo do callback.** O POST é tratado como GATILHO, e o
 * estado de verdade vem de `connectionStatus()`. Três coisas saem de graça:
 *
 *  · não precisamos conhecer o formato do payload (que a Z-API não documenta
 *    para estes dois campos, e que pode mudar sem aviso);
 *  · callback fora de ordem ou reentregue não inverte o estado, porque a
 *    resposta autoritativa é sempre a mesma pergunta;
 *  · um callback forjado por quem tenha o secret no path não consegue mentir
 *    sobre o estado — no máximo faz o Max perguntar de novo.
 *
 * O custo é uma chamada ao `/status` por callback, e callback de conexão é
 * raro por definição.
 *
 * Responde 200 SEMPRE (mesmo contrato das outras duas): 5xx faria a Z-API
 * reentregar um evento idempotente por natureza — e a rede de segurança do
 * cron cobre o callback que se perder de vez.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { secret: string } }
) {
  const denied = requireZapiSecret(params.secret);
  if (denied) return denied;

  // Nem lemos o corpo: ver acima. `connectionStatus()` LANÇA quando o /status
  // falha ou vem num formato desconhecido — e isso é "não consegui
  // PERGUNTAR", nunca "está desconectado". Não observamos nada nesse caso; o
  // cron pergunta de novo em até um minuto.
  let connected: boolean;
  try {
    ({ connected } = await connectionStatus());
  } catch (err) {
    console.warn(
      "[zapi-connection] callback recebido mas não deu pra checar a instância:",
      err instanceof Error ? err.message : String(err)
    );
    return NextResponse.json({ ok: true, checked: false });
  }

  const r = await observeConnection({ connected, fonte: "push" });
  return NextResponse.json({
    ok: true,
    connected: r.connected,
    transicao: r.transicao,
    alertou: r.alertou,
  });
}

/** Confere a URL no painel sem mandar evento de verdade. */
export async function GET(
  _req: NextRequest,
  { params }: { params: { secret: string } }
) {
  const denied = requireZapiSecret(params.secret);
  if (denied) return denied;
  return NextResponse.json({
    ok: true,
    service: "max-agent",
    handler: "connection",
  });
}
