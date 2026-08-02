import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifySignature } from "@/lib/hmac";
import { enqueue } from "@/lib/outbox";
import { normalizeBrPhone } from "@/lib/phone";
import { isOrgKnown } from "@/lib/orgs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  orgId: z.string().min(1),
  audience: z.enum(["platform_user", "deal_broker", "deal_party"]),
  phone: z.string().min(1),
  recipientName: z.string().default(""),
  title: z.string().default(""),
  body: z.string().default(""),
  linkUrl: z.string().nullable().default(null),
  dealId: z.string().nullable().default(null),
  orgName: z.string().default(""),
  dedupeKey: z.string().min(1),
});

/**
 * POST /notify — por onde o ImobPro entrega uma notificação ao Max.
 *
 * Caminho SEM LLM de propósito. O texto já vem pronto do motor de notificações;
 * fazer um modelo retransmiti-lo (que é o que o Newton faz, via turn em
 * linguagem natural) custa token e abre espaço para ele reescrever o fato,
 * errar o destinatário ou decidir não mandar — falha já medida em produção.
 *
 * 202 significa "assumi a entrega", NÃO "entregue": o envio real acontece no
 * cron do outbox, possivelmente horas depois se chegou de madrugada.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.MAX_NOTIFY_SECRET;
  if (!secret) {
    console.error("[notify] MAX_NOTIFY_SECRET não configurada");
    return NextResponse.json({ error: "not_configured" }, { status: 500 });
  }

  // O corpo CRU, byte a byte: assinar o JSON reserializado quebraria a
  // verificação na primeira diferença de ordem de chave ou de escape.
  const rawBody = await req.text();

  const verdict = verifySignature({
    timestamp: req.headers.get("x-max-timestamp"),
    signature: req.headers.get("x-max-signature"),
    rawBody,
    secret,
  });
  if (!verdict.ok) {
    // Sem detalhe no corpo: para quem não tem o segredo, "assinatura inválida"
    // e "timestamp velho" não devem ser distinguíveis.
    console.warn(`[notify] assinatura recusada: ${verdict.reason}`);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(parsedJson);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad_request", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const p = parsed.data;

  // Org fora da allowlist é 403, não 500: quem chamou tem segredo válido, mas
  // aponta para um tenant que este Max não atende. O ImobPro loga e segue.
  if (!(await isOrgKnown(p.orgId))) {
    return NextResponse.json({ error: "unknown_org" }, { status: 403 });
  }

  const phone = normalizeBrPhone(p.phone);
  if (!phone) {
    return NextResponse.json({ error: "invalid_phone" }, { status: 422 });
  }

  const result = await enqueue({
    orgId: p.orgId,
    dedupeKey: p.dedupeKey,
    audience: p.audience,
    // Z-API quer E.164 SEM "+".
    phone: phone.replace(/^\+/, ""),
    recipientName: p.recipientName,
    title: p.title,
    body: p.body,
    linkUrl: p.linkUrl,
    dealId: p.dealId,
    orgName: p.orgName,
  });

  if (result.status === "duplicate") {
    return NextResponse.json({ id: result.id, duplicate: true }, { status: 409 });
  }

  return NextResponse.json(
    { id: result.id, deliverAfter: result.deliverAfter.toISOString() },
    { status: 202 }
  );
}
