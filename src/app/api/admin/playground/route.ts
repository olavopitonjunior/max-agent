import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireHmac } from "@/lib/auth";
import { query } from "@/lib/db";
import { runTurn, threadIdFor } from "@/graph/graph";
import { resolveIdentity } from "@/lib/identity";
import { limparThreadDoCheckpointer } from "@/lib/checkpointer-reset";
import type { InboundMessage } from "@/lib/transport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Um turno de credito encadeia mais de uma chamada de modelo - os 60s que as
// outras rotas usam (webhook, crons) ficam curtos demais com folga.
export const maxDuration = 120;

/**
 * POST /api/admin/playground - roda UM turno do Max fora do WhatsApp, pelo
 * admin do ImobPro. Pedido do Olavo (13/10): testar o agente sem depender da
 * Z-API/Cloud API - staging primeiro, escritas REAIS (mesmo runTurn, mesmo
 * afterReply que a fila chama), com a resposta e o rastro interno na tela.
 *
 * Gate de ambiente primeiro, antes da auth: em producao MAX_PLAYGROUND
 * nao existe, e a rota devolve 404 SEM corpo - quem nao tem a flag nao deve
 * nem saber que ela existe. E o mesmo raciocinio do requireHmac nao
 * distinguir "assinatura errada" de "timestamp velho".
 *
 * Auth: requireHmac sem signQuery - como /notify e /admin/forget, o
 * corpo CRU e o que esta assinado (nao ha query relevante aqui).
 *
 * A IDENTIDADE MANDA, nao o orgId do corpo. runTurn resolve a org pelo
 * TELEFONE (resolveIdentity), nao pelo orgId pedido - entao checar a
 * identidade DEPOIS de rodar o turno so documentava um descompasso que ja
 * tinha acontecido: o turno ja escreveu na org errada (ou respondeu por uma
 * identidade pendente/ambigua/desconhecida) antes de alguem notar. Por isso a
 * resolucao vem ANTES de qualquer efeito - inclusive antes do novo, que ja
 * limpa thread de verdade. So segue quem esta resolved E cuja
 * candidate.orgId e EXATAMENTE a orgId pedida; qualquer outro caso (outra
 * org, pending, ambiguous, unknown) devolve 409 sem tocar em nada.
 *
 * novo: true limpa a thread do checkpointer antes de rodar (mesmas tres
 * tabelas que scripts/turn.ts --novo limpa - ver limparThreadDoCheckpointer).
 * Com novo e sem text, a rota so limpa e devolve sem rodar turno.
 *
 * requestId evita turno em dobro. Quem chama pode reenviar (timeout do
 * lado do admin, duplo clique) sem saber se o primeiro POST ja rodou. O
 * messageId do turno e derivado dele (playground-${requestId}), e antes
 * de rodar a rota checa se ja existe conversation_turn com esse
 * message_id - se existir, devolve 409 sem rodar de novo.
 */
export const RASTRO_SELECT_SQL = `SELECT org_id, kind, inbound_text, transcript, reply_text,
            route, intent_json, tools_json, usage_json, timings_json,
            signals_json, degradado, latency_ms, error, created_at
       FROM conversation_turn
      WHERE message_id = $1
      ORDER BY created_at DESC
      LIMIT 1`;

export const DEDUPE_SELECT_SQL =
  "SELECT 1 AS ja_existe FROM conversation_turn WHERE message_id = $1 LIMIT 1";

const TELEFONE_E164 = /^\+[1-9]\d{6,14}$/;

const bodySchema = z
  .object({
    orgId: z.string().min(1),
    phone: z.string().regex(TELEFONE_E164, "telefone deve ser E.164"),
    requestId: z.string().uuid(),
    text: z.string().min(1).max(2000).optional(),
    novo: z.boolean().optional(),
  })
  .refine((b) => b.novo === true || b.text !== undefined, {
    message: "text e obrigatorio quando novo nao e true",
    path: ["text"],
  });

interface RastroRow extends Record<string, unknown> {
  org_id: string;
  kind: string;
  inbound_text: string | null;
  transcript: string | null;
  reply_text: string | null;
  route: string | null;
  intent_json: unknown;
  tools_json: unknown;
  usage_json: unknown;
  timings_json: unknown;
  signals_json: unknown;
  degradado: boolean;
  latency_ms: number | null;
  error: string | null;
  created_at: string;
}

export async function POST(req: NextRequest) {
  if (process.env.MAX_PLAYGROUND !== "true") {
    return new NextResponse(null, { status: 404 });
  }

  const auth = await requireHmac(req);
  if (!auth.ok) return auth.response;

  let json: unknown;
  try {
    json = JSON.parse(auth.rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad_request", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { orgId, phone, text, novo, requestId } = parsed.data;

  // Identidade primeiro, antes de QUALQUER efeito (inclusive novo). Ver
  // comentario acima: o telefone e quem decide a org de verdade.
  const identity = await resolveIdentity(phone);
  if (identity.kind !== "resolved" || identity.candidate.orgId !== orgId) {
    return NextResponse.json(
      {
        error: "identidade_diverge",
        identidade: {
          kind: identity.kind,
          orgId: identity.kind === "resolved" ? identity.candidate.orgId : null,
        },
      },
      { status: 409 }
    );
  }
  const identidade = { kind: identity.kind, orgId: identity.candidate.orgId };

  const threadId = threadIdFor(orgId, phone);

  if (novo) {
    await limparThreadDoCheckpointer(threadId);
  }

  if (!text) {
    // So limpeza pedida: nada para rodar, nada para auditar.
    return NextResponse.json({ reply: null, rastro: null, threadId });
  }

  const messageId = `playground-${requestId}`;

  // Replay: requestId ja usado antes viraria um turno NOVO se nao checarmos -
  // o admin pode reenviar o mesmo POST sem saber se o primeiro ja rodou.
  const dedupe = await query<{ ja_existe: number }>(DEDUPE_SELECT_SQL, [messageId]);
  if (dedupe.length > 0) {
    return NextResponse.json({ error: "repetido" }, { status: 409 });
  }

  const inbound: InboundMessage = {
    messageId,
    fromPhone: phone,
    groupId: null,
    kind: "text",
    text,
    mediaUrl: null,
    mimeType: null,
    senderName: null,
    replyToMessageId: null,
    timestampMs: Date.now(),
  };

  const resultado = await runTurn(inbound);
  await resultado.afterReply();

  const rows = await query<RastroRow>(RASTRO_SELECT_SQL, [messageId]);
  const row = rows[0] ?? null;

  const rastro = row
    ? {
        orgId: row.org_id,
        kind: row.kind,
        inboundText: row.inbound_text,
        transcript: row.transcript,
        replyText: row.reply_text,
        route: row.route,
        intent: row.intent_json,
        tools: row.tools_json,
        usage: row.usage_json,
        timings: row.timings_json,
        signals: row.signals_json,
        degradado: row.degradado,
        latencyMs: row.latency_ms,
        error: row.error,
        createdAt: row.created_at,
        identidade,
      }
    : null;

  return NextResponse.json({ reply: resultado.reply, rastro, threadId });
}
