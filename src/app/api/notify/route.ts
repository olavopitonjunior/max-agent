import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireHmac } from "@/lib/auth";
import { enqueue } from "@/lib/outbox";
import { toZapiPhone } from "@/lib/phone";
import { isOrgKnown } from "@/lib/orgs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** O mesmo `PARAM_KEY` que o contractmaker usa para validar o `kind` antes de mandar. */
const KIND_RE = /^[a-z][a-z0-9_]{0,31}$/;
const PARAM_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Só `string → string`, chave no formato, no máximo 8, valor numa linha e
 * curto. O que não passa é descartado sem erro — mesma política do lado de lá
 * (`sanitizeParams` do cm), repetida aqui porque este serviço não confia no
 * formato de quem chama.
 */
function limparParams(raw: Record<string, unknown> | undefined): Record<string, string> | null {
  if (!raw) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw).slice(0, 8)) {
    if (!PARAM_KEY_RE.test(k) || typeof v !== "string") continue;
    const limpo = v.replace(/\s+/g, " ").trim().slice(0, 120);
    if (limpo) out[k] = limpo;
  }
  return Object.keys(out).length > 0 ? out : null;
}

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
  /**
   * Tipo da notificação e variáveis do template da Meta (contractmaker
   * cm#887, 2026-09-22). TOLERANTES de propósito: o contractmaker de produção
   * já manda os dois, e um valor fora do formato não pode virar 400 — a
   * notificação seria perdida por causa de um enfeite. Inválido vira ausente,
   * e o envio cai no template genérico. Nada de `.strict()` neste schema:
   * chave que este Max ainda não conhece tem que ser descartada, não recusada.
   */
  kind: z.string().regex(KIND_RE).optional().catch(undefined),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .catch(undefined)
    .transform(limparParams),
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
  const auth = await requireHmac(req);
  if (!auth.ok) return auth.response;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(auth.rawBody);
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

  // Já no formato que a Z-API quer (E.164 sem "+"): `toZapiPhone` é null
  // exatamente quando a normalização falha, então um só passo cobre o 422 e
  // o valor entregue à fila.
  const phone = toZapiPhone(p.phone);
  if (!phone) {
    return NextResponse.json({ error: "invalid_phone" }, { status: 422 });
  }

  const result = await enqueue({
    orgId: p.orgId,
    dedupeKey: p.dedupeKey,
    audience: p.audience,
    phone,
    recipientName: p.recipientName,
    title: p.title,
    body: p.body,
    linkUrl: p.linkUrl,
    dealId: p.dealId,
    orgName: p.orgName,
    kind: p.kind ?? null,
    params: p.params,
  });

  if (result.status === "duplicate") {
    return NextResponse.json({ id: result.id, duplicate: true }, { status: 409 });
  }

  return NextResponse.json(
    { id: result.id, deliverAfter: result.deliverAfter.toISOString() },
    { status: 202 }
  );
}
