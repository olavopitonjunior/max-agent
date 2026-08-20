import { NextRequest, NextResponse } from "next/server";
import { parseStatusCallback, isExpectedInstance } from "@/lib/zapi";
import { applyStatusCallback } from "@/lib/delivery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Callback de STATUS de mensagem da Z-API (SENT/RECEIVED/READ/PLAYED) — o
 * campo "ao alterar status da mensagem" no painel, apontado para cá.
 *
 * Rota SEPARADA do webhook de mensagens de propósito: status não é mensagem e
 * não pode nem encostar na fila de turns — a mistura obrigaria os dois parses
 * a coabitar o mesmo handler e um erro viraria turn de LLM. O secret é o
 * mesmo (`ZAPI_WEBHOOK_SECRET`): é a mesma instância falando, pelo mesmo
 * canal não assinado, com as mesmas mitigação e rotação.
 *
 * Responde 200 SEMPRE (mesmo contrato do webhook de mensagens): 5xx faria a
 * Z-API reentregar um evento que é idempotente por natureza — o upgrade
 * monotônico já absorve reentrega e desordem.
 *
 * Id desconhecido é o caso NORMAL: mensagens mandadas por humanos pelo mesmo
 * número também geram callback. Ignorado sem log — logar cada um afogaria o
 * que importa.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { secret: string } }
) {
  const expected = process.env.ZAPI_WEBHOOK_SECRET;
  if (!expected) {
    console.error("[zapi-status] ZAPI_WEBHOOK_SECRET não configurada");
    return NextResponse.json({ error: "not_configured" }, { status: 500 });
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
    console.warn("[zapi-status] instanceId inesperado — ignorado");
    return NextResponse.json({ ok: true });
  }

  const cb = parseStatusCallback(payload);
  if (!cb) return NextResponse.json({ ok: true, ignored: true });

  try {
    const applied = await applyStatusCallback(cb);
    return NextResponse.json({ ok: true, applied });
  } catch (err) {
    // 200 mesmo em falha (ver acima) — mas com o erro no log: um problema de
    // banco aqui não pode virar tempestade de reentrega.
    console.error(
      "[zapi-status] falhou:",
      err instanceof Error ? err.message : String(err)
    );
    return NextResponse.json({ ok: true, error: true });
  }
}

/** Confere a URL no painel sem mandar evento de verdade. */
export async function GET(
  _req: NextRequest,
  { params }: { params: { secret: string } }
) {
  const expected = process.env.ZAPI_WEBHOOK_SECRET;
  if (!expected || params.secret !== expected) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, service: "max-agent", handler: "status" });
}
