import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { parseInbound, isExpectedInstance } from "@/lib/zapi";
import { enqueueInbound, processInboundNow } from "@/lib/inbound";

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
 * Responde 200 SEMPRE — inclusive quando algo falha. Um 5xx faria a Z-API
 * reentregar, e a linha da fila já foi criada: a mensagem seria processada uma
 * vez e reentregue mesmo assim.
 *
 * ── Esta rota só ACEITA ──────────────────────────────────────────────────
 * O turn rodava INLINE aqui. Era aceitável enquanto o grafo não chamava modelo,
 * e o comentário anterior registrava o prazo; a Fase 2 entrou em produção em
 * 2026-08-03 e a premissa caiu.
 *
 * O modo de falha é o pior tipo: um turn mais lento que o timeout do webhook
 * faz a Z-API REENTREGAR, a reentrega bate no dedupe (que já consumiu o
 * `messageId`), e a pessoa fica sem resposta e sem rastro. Duplicata incomoda;
 * silêncio ninguém vê.
 *
 * Agora: grava na fila, responde, e processa em background. O `waitUntil`
 * mantém a latência de conversa (não espera o cron), e o cron varre o que ele
 * não fechou — a function pode ser morta a qualquer momento, então o caminho
 * rápido é otimização, nunca a garantia.
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

  // Grupo não é respondido: o Max nasce como canal de DM, e responder em grupo
  // sem gate de menção transformaria qualquer conversa em barulho. Descartado
  // ANTES da fila — o que nunca vai ser processado não merece linha, e reentrega
  // de grupo cai aqui de novo e é ignorada do mesmo jeito.
  if (msg.groupId) {
    return NextResponse.json({ ok: true, ignored: "grupo" });
  }

  const enfileirado = await enqueueInbound(msg);
  if (enfileirado.status === "duplicate") {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  console.log(
    `[zapi-webhook] aceito ${msg.kind} de ${msg.fromPhone} (${enfileirado.id})`
  );

  // Fire-and-forget de verdade: sem `waitUntil` a Vercel congela a function no
  // instante da resposta e o processamento morreria no meio.
  waitUntil(processInboundNow(enfileirado.id));

  return NextResponse.json({ ok: true, accepted: true, id: enfileirado.id });
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
