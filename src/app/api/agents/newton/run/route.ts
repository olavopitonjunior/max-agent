import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { deployProfile } from "@/lib/deploy-profile";
import { enqueueInbound, processInboundNow } from "@/lib/inbound";
import { log } from "@/lib/log";
import { idSintetico } from "@/lib/transport/newton-inbound";
import type { InboundMessage } from "@/lib/transport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Mesmo orçamento do webhook da Meta: o `waitUntil` roda um turn completo. */
export const maxDuration = 60;

/**
 * Entrada do Newton: o bridge (`whatsapp-newton-bridge`, `forwardToNewton`)
 * faz POST aqui com o mesmo corpo que mandava ao sidecar do VPS —
 * `{caller:{phone,name}, channel, orgId, groupId, groupName, members, text,
 * attachments}` — e `Bearer NEWTON_GATEWAY_TOKEN`.
 *
 * ── Resposta ─────────────────────────────────────────────────────────────
 * Sempre `{text: "", blocked: false}`: texto vazio o bridge não envia. A
 * resposta de verdade sai depois, pelo adapter `newton-bridge` (`/api/send`),
 * como no Max: aceitar, enfileirar e rodar o turn em `waitUntil`. Assim o
 * prazo de 58 s do bridge nunca corta um turn longo.
 *
 * ── Dedupe ───────────────────────────────────────────────────────────────
 * O bridge não repassa o id da Z-API. O id é sintetizado de (telefone, grupo,
 * texto, anexos, minuto): uma reentrega no mesmo minuto bate no `ON CONFLICT`
 * da fila. O preço é que a MESMA frase repetida de propósito no mesmo minuto
 * vira uma só — aceitável até o bridge mandar o `messageId` (fase 4.2).
 *
 * ── Fora do escopo desta rota (por ora) ──────────────────────────────────
 * Grupo: aceito e ignorado até a resposta a menção existir (PR 2.2). Anexo:
 * sem mídia no transporte; com texto vale o texto, sem texto vira `unknown`
 * e o grafo pede por escrito. `orgId` do corpo não é confiado: a org sai da
 * identidade do telefone, como no Max.
 */

interface CorpoDoBridge {
  caller?: { phone?: unknown; name?: unknown };
  groupId?: unknown;
  text?: unknown;
  attachments?: unknown;
}

const VAZIO = { text: "", blocked: false } as const;

function autorizado(header: string | null): "ok" | "negado" | "sem_token" {
  const esperado = (process.env.NEWTON_GATEWAY_TOKEN ?? "").trim();
  if (!esperado) return "sem_token";
  const recebido = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!recebido) return "negado";
  // Digest dos dois lados: mesmo tamanho para o `timingSafeEqual`, sem vazar o comprimento.
  const a = createHash("sha256").update(esperado).digest();
  const b = createHash("sha256").update(recebido).digest();
  return timingSafeEqual(a, b) ? "ok" : "negado";
}

export async function POST(req: NextRequest) {
  // Só o deploy do Newton atende: no do Max esta porta não existe.
  if (deployProfile().agentKey !== "newton") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const auth = autorizado(req.headers.get("authorization"));
  if (auth === "sem_token") {
    console.error("[newton-run] NEWTON_GATEWAY_TOKEN ausente — nada aceito");
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "negado") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let corpo: CorpoDoBridge;
  try {
    corpo = (await req.json()) as CorpoDoBridge;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const phone = typeof corpo.caller?.phone === "string" ? corpo.caller.phone.replace(/\D/g, "") : "";
  if (!/^\d{10,15}$/.test(phone)) {
    return NextResponse.json({ error: "invalid_caller" }, { status: 400 });
  }
  const groupId = typeof corpo.groupId === "string" && corpo.groupId.trim() ? corpo.groupId.trim() : null;
  const text = typeof corpo.text === "string" ? corpo.text.trim() : "";
  const anexos = Array.isArray(corpo.attachments) ? corpo.attachments.length : 0;

  if (groupId) {
    log.info("newton.grupo_ignorado", { phone });
    return NextResponse.json(VAZIO);
  }
  if (!text && anexos === 0) return NextResponse.json(VAZIO);

  const agoraMs = Date.now();
  const msg: InboundMessage = {
    messageId: idSintetico({ phone, groupId, text, anexos, agoraMs }),
    fromPhone: phone,
    groupId: null,
    kind: text ? "text" : "unknown",
    text: text || null,
    mediaUrl: null,
    mimeType: null,
    timestampMs: agoraMs,
    senderName: typeof corpo.caller?.name === "string" && corpo.caller.name.trim() ? corpo.caller.name.trim() : null,
    replyToMessageId: null,
  };

  const r = await enqueueInbound(msg);
  if (r.status === "queued") {
    log.info("inbound.aceito", { messageId: msg.messageId, rowId: r.id, phone, kind: msg.kind });
    waitUntil(processInboundNow(r.id));
  }
  return NextResponse.json(VAZIO);
}
