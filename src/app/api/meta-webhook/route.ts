import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import {
  isExpectedPhoneNumber,
  parseWebhook,
  verifyChallenge,
  verifySignature,
} from "@/lib/meta";
import { enqueueInbound, processInboundNow } from "@/lib/inbound";
import { applyFalhaDeEnvio, applyStatusCallback } from "@/lib/delivery";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Mesmo orçamento da rota da Z-API: o `waitUntil` roda um turn completo. */
export const maxDuration = 60;

/**
 * Webhook da WhatsApp Cloud API (Meta) — mensagens recebidas E status de
 * entrega chegam aqui, no mesmo POST (na Z-API eram duas rotas).
 *
 * ── Autenticação ─────────────────────────────────────────────────────────
 * Ao contrário da Z-API, a Meta ASSINA: `X-Hub-Signature-256` é o HMAC-SHA256
 * do corpo cru com o app secret. Por isso a URL não carrega segredo no path.
 * Assinatura ausente ou errada é 401 — e sem `META_APP_SECRET` configurado
 * NADA passa (fail-closed; o bridge do Newton aceitava tudo nesse caso).
 *
 * ── Resposta ─────────────────────────────────────────────────────────────
 * Com assinatura válida, 200 SEMPRE, pelo mesmo motivo da rota da Z-API: a
 * Meta reentrega o que não recebeu 200, e a linha da fila já foi gravada — a
 * reentrega bate no dedupe por `message_id` e não faz mal, mas um 5xx por um
 * erro NOSSO geraria reentregas por horas.
 *
 * ── O que esta rota faz ──────────────────────────────────────────────────
 * Só ACEITA: grava na fila e responde. O turn roda em background
 * (`waitUntil`), e o cron do inbound varre o que ele não fechar. Status de
 * entrega é aplicado inline — são dois UPDATEs indexados.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"))) {
    console.warn("[meta-webhook] assinatura inválida ou ausente — recusado");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true, ignored: "json" });
  }

  const ev = parseWebhook(payload);
  if (ev.phoneNumberIds.length === 0) {
    // Outro campo assinado no app (templates, qualidade, conta) — não é
    // mensagem nem status. Tratado nas fases seguintes; aceito e ignorado.
    return NextResponse.json({ ok: true, ignored: "campo" });
  }
  if (!isExpectedPhoneNumber(ev.phoneNumberIds)) {
    // O mesmo app pode servir outro número (o do Newton, p.ex.). Não é nosso.
    console.warn("[meta-webhook] phone_number_id inesperado — ignorado");
    return NextResponse.json({ ok: true, ignored: "numero" });
  }

  const aceitas: string[] = [];
  for (const msg of ev.messages) {
    const r = await enqueueInbound(msg);
    if (r.status === "duplicate") continue;
    log.info("inbound.aceito", {
      messageId: msg.messageId,
      rowId: r.id,
      phone: msg.fromPhone,
      kind: msg.kind,
    });
    aceitas.push(r.id);
  }

  let statusAplicados = 0;
  for (const cb of ev.statuses) {
    const t = await applyStatusCallback(cb);
    statusAplicados += t.outbox + t.replies;
  }
  for (const f of ev.failures) {
    await applyFalhaDeEnvio(f);
  }

  // Um `waitUntil` por linha: cada processamento reivindica a SUA linha, e a
  // serialização por telefone está na fila (migration 006), não aqui.
  for (const id of aceitas) waitUntil(processInboundNow(id));

  return NextResponse.json({
    ok: true,
    accepted: aceitas.length,
    statuses: statusAplicados,
    failures: ev.failures.length,
  });
}

/**
 * Handshake de verificação: a Meta faz GET com `hub.mode=subscribe`,
 * `hub.verify_token` e `hub.challenge`, e só ativa o webhook se receber o
 * challenge de volta, em texto puro.
 */
export async function GET(req: NextRequest) {
  const challenge = verifyChallenge(req.nextUrl.searchParams);
  if (challenge === null) return new NextResponse("forbidden", { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}
