import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireHmac } from "@/lib/auth";
import { query } from "@/lib/db";
import { normalizeBrPhone } from "@/lib/phone";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({ phone: z.string().min(1) });

/**
 * POST /api/admin/forget — direito ao esquecimento de UM telefone.
 *
 * Tudo que o Max sabe sobre uma pessoa é indexado por telefone, espalhado por
 * seis lugares e em DOIS formatos (E.164 com "+" em `phone_org_choice` e
 * `identity_cache`; sem "+" em `memory_facts`, filas e `thread_id` — herança
 * documentada na migration 003/007). Sem uma rota que apague os seis de uma
 * vez, "esquece o que você sabe de mim" viraria caça manual — e a LGPD não
 * aceita caça manual.
 *
 * Apaga TAMBÉM o histórico de conversa (checkpoints do LangGraph): thread é
 * dado pessoal tanto quanto fato extraído. `checkpoint_migrations` fica — é
 * schema, não dado.
 *
 * Auth: o mesmo HMAC do `/notify` (corpo assinado). Devolve a contagem por
 * tabela — o operador precisa poder REGISTRAR o que foi apagado.
 */
export async function POST(req: NextRequest) {
  const auth = await requireHmac(req);
  if (!auth.ok) return auth.response;

  let parsed;
  try {
    parsed = bodySchema.safeParse(JSON.parse(auth.rawBody));
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const e164 = normalizeBrPhone(parsed.data.phone);
  if (!e164) {
    return NextResponse.json({ error: "invalid_phone" }, { status: 422 });
  }
  const semMais = e164.replace(/^\+/, "");

  const del = async (sql: string, params: unknown[]): Promise<number> => {
    const rows = await query<{ n: string }>(
      `WITH apagados AS (${sql} RETURNING 1) SELECT count(*)::text AS n FROM apagados`,
      params
    );
    return Number(rows[0]?.n ?? 0);
  };

  const deleted = {
    memory_facts: await del(`DELETE FROM memory_facts WHERE phone = $1`, [semMais]),
    phone_org_choice: await del(`DELETE FROM phone_org_choice WHERE phone = $1`, [e164]),
    identity_cache: await del(`DELETE FROM identity_cache WHERE phone = $1`, [e164]),
    inbound_queue: await del(`DELETE FROM inbound_queue WHERE from_phone = $1`, [semMais]),
    outbox: await del(`DELETE FROM outbox WHERE phone = $1`, [semMais]),
    // thread_id = orgId:telefone — o sufixo pega a pessoa em TODAS as orgs.
    checkpoints: await del(`DELETE FROM checkpoints WHERE thread_id LIKE '%:' || $1`, [semMais]),
    checkpoint_writes: await del(
      `DELETE FROM checkpoint_writes WHERE thread_id LIKE '%:' || $1`,
      [semMais]
    ),
    checkpoint_blobs: await del(
      `DELETE FROM checkpoint_blobs WHERE thread_id LIKE '%:' || $1`,
      [semMais]
    ),
  };

  console.log(
    `[forget] telefone esquecido — ` +
      Object.entries(deleted)
        .map(([t, n]) => `${t}:${n}`)
        .join(" ")
  );

  return NextResponse.json({ ok: true, deleted });
}
