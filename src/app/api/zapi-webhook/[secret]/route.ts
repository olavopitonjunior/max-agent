import { NextRequest, NextResponse } from "next/server";
import { parseInbound, isExpectedInstance } from "@/lib/zapi";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Webhook de recebimento da Z-API.
 *
 * A Z-API **não assina** os webhooks (ao contrário da Meta), então a
 * autenticação é o segredo no PATH + conferência do `instanceId` no corpo. É
 * mais fraco que HMAC: trate a URL como credencial, nunca a coloque em log de
 * acesso público, e rotacione-a se vazar.
 *
 * Responde 200 rápido e sempre. Webhook que demora leva a Z-API a reentregar,
 * e reentrega é justamente o que a tabela `inbound_seen` existe para conter.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { secret: string } }
) {
  const expected = process.env.ZAPI_WEBHOOK_SECRET;
  if (!expected) {
    console.error("[zapi-webhook] ZAPI_WEBHOOK_SECRET não configurada");
    return NextResponse.json({ ok: true });
  }
  if (params.secret !== expected) {
    // 404, não 401: para quem sonda a URL, o endpoint não deve nem existir.
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  if (!isExpectedInstance(payload)) {
    console.warn("[zapi-webhook] instanceId inesperado — ignorado");
    return NextResponse.json({ ok: true });
  }

  const msg = parseInbound(payload);
  // `null` cobre o eco das próprias mensagens e payload sem identificação. O
  // eco é a armadilha clássica: com "notificar mensagens enviadas por mim"
  // ligado no painel, cada resposta volta como mensagem nova e o bot conversa
  // sozinho.
  if (!msg) return NextResponse.json({ ok: true, ignored: true });

  // Dedupe ANTES de qualquer trabalho: a Z-API reentrega em timeout, e sem
  // isto uma resposta lenta viraria dois turnos para a mesma mensagem.
  const claimed = await query<{ message_id: string }>(
    `INSERT INTO inbound_seen (message_id) VALUES ($1)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING message_id`,
    [msg.messageId]
  );
  if (claimed.length === 0) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  // Conversa entra na Fase 2. Até lá o Max é canal de notificação: registrar e
  // devolver 200 é honesto — melhor não responder do que responder mal.
  console.log(
    `[zapi-webhook] inbound ${msg.kind} de ${msg.fromPhone}${msg.groupId ? ` (grupo ${msg.groupId})` : ""}`
  );

  return NextResponse.json({ ok: true, accepted: true });
}

/**
 * A Z-API não faz handshake de verificação como a Meta, mas um GET que
 * responde 200 dá um jeito trivial de conferir a URL no painel sem mandar
 * mensagem de teste.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { secret: string } }
) {
  const expected = process.env.ZAPI_WEBHOOK_SECRET;
  if (!expected || params.secret !== expected) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, service: "max-agent" });
}
