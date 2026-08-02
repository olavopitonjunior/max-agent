import { NextRequest, NextResponse } from "next/server";
import { parseInbound, isExpectedInstance, sendText } from "@/lib/zapi";
import { query } from "@/lib/db";
import { runTurn } from "@/graph/graph";

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
 * Responde 200 SEMPRE — inclusive quando o turn falha. Um 5xx faria a Z-API
 * reentregar, e o dedupe já consumiu o `messageId`: o usuário ficaria sem
 * resposta e sem rastro.
 *
 * O turn roda INLINE por enquanto, o que é aceitável porque o grafo ainda não
 * chama modelo. Quando a Fase 2 entrar, isso tem que virar fila: uma resposta
 * de LLM demora mais que o timeout da Z-API, e o retry dela esbarraria no
 * dedupe — silêncio, não duplicata.
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

  console.log(
    `[zapi-webhook] inbound ${msg.kind} de ${msg.fromPhone}${msg.groupId ? ` (grupo ${msg.groupId})` : ""}`
  );

  // Grupo não é respondido: o Max nasce como canal de DM, e responder em grupo
  // sem gate de menção transformaria qualquer conversa em barulho. A leitura de
  // grupo do Newton (WhatsappGroup/DealGroupLink) é outro assunto.
  if (msg.groupId) {
    return NextResponse.json({ ok: true, ignored: "grupo" });
  }

  try {
    const reply = await runTurn(msg);
    if (reply) {
      await sendText({ to: msg.fromPhone, body: reply, quoteMessageId: msg.messageId });
    }
  } catch (err) {
    // Nunca propaga: erro aqui viraria 5xx, a Z-API reentregaria, e o dedupe
    // acima já consumiu o messageId — o usuário ficaria sem resposta E sem
    // rastro. Logar e devolver 200 mantém o incidente visível num lugar só.
    console.error(
      "[zapi-webhook] turn falhou:",
      err instanceof Error ? err.message : String(err)
    );
  }

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
