import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireHmac } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizeBrPhone } from "@/lib/phone";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({ phone: z.string().min(1) });

/**
 * Todas as formas sob as quais um telefone pode estar gravado.
 *
 * Duas fontes de divergência (achados do code review): (1) o JID da Z-API
 * pode vir COM ou SEM o 9º dígito, e `normalizeBrPhone` não canonicaliza
 * entre as duas — apagar só a forma digitada devolvia 200 com zero linhas,
 * um apagamento LGPD silenciosamente falho; (2) número estrangeiro não
 * normaliza, mas tem PII nas filas do mesmo jeito — ele é apagado pela forma
 * crua, sem direito a 422.
 */
function phoneVariants(raw: string): { bare: string[]; plus: string[] } | null {
  const e164 = normalizeBrPhone(raw);
  if (!e164) {
    const digits = (raw ?? "").replace(/\D/g, "");
    if (digits.length < 8) return null; // curto demais até para forma crua
    return { bare: [digits], plus: [`+${digits}`] };
  }
  const d = e164.slice(1); // 55 + DDD(2) + numero(8|9)
  const ddd = d.slice(2, 4);
  const num = d.slice(4);
  const formas = new Set([d]);
  if (num.length === 9 && num.startsWith("9")) formas.add(`55${ddd}${num.slice(1)}`);
  if (num.length === 8) formas.add(`55${ddd}9${num}`);
  const bare = [...formas];
  return { bare, plus: bare.map((b) => `+${b}`) };
}

/**
 * POST /api/admin/forget — direito ao esquecimento de UM telefone.
 *
 * Tudo que o Max sabe sobre uma pessoa é indexado por telefone, espalhado por
 * seis superfícies e em DOIS formatos (E.164 com "+" em `phone_org_choice` e
 * `identity_cache`; sem "+" em `memory_facts`, filas e `thread_id`). Esta
 * rota apaga as seis numa TRANSAÇÃO única — apagamento parcial com 500 no
 * meio deixaria a pessoa meio-esquecida sem registro do que saiu.
 *
 * Auth: o mesmo HMAC do `/notify`. Devolve a contagem por tabela — o
 * operador precisa poder REGISTRAR o que foi apagado. `deleted` todo zerado
 * merece atenção: ou o número nunca falou com o Max, ou a forma digitada não
 * é nenhuma das gravadas.
 *
 * **Limite conhecido (registrado, não resolvido):** o apagamento é um retrato
 * do instante. Um turn em voo, um retry do `/notify` ou uma reentrega da
 * Z-API podem recriar linhas segundos depois — o dedupe é as próprias linhas
 * apagadas. Para o caso LGPD real, rode duas vezes com um minuto de
 * intervalo e confirme `deleted` zerado na segunda.
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

  const variants = phoneVariants(parsed.data.phone);
  if (!variants) {
    return NextResponse.json({ error: "invalid_phone" }, { status: 422 });
  }
  const { bare, plus } = variants;

  const client = await db().connect();
  const deleted: Record<string, number> = {};
  try {
    await client.query("BEGIN");

    const del = async (table: string, sql: string, params: unknown[]) => {
      const r = await client.query(sql, params);
      deleted[table] = r.rowCount ?? 0;
    };

    await del("memory_facts", `DELETE FROM memory_facts WHERE phone = ANY($1)`, [bare]);
    await del("phone_org_choice", `DELETE FROM phone_org_choice WHERE phone = ANY($1)`, [plus]);
    await del("identity_cache", `DELETE FROM identity_cache WHERE phone = ANY($1)`, [plus]);
    await del("inbound_queue", `DELETE FROM inbound_queue WHERE from_phone = ANY($1)`, [bare]);
    await del("outbox", `DELETE FROM outbox WHERE phone = ANY($1)`, [bare]);

    // As tabelas do checkpointer são criadas pelo `setup()` do LangGraph, não
    // pelas migrations — num banco onde o grafo nunca rodou elas não existem,
    // e um 42P01 aqui não pode abortar o apagamento das demais.
    for (const t of ["checkpoints", "checkpoint_writes", "checkpoint_blobs"]) {
      const existe = await client.query(`SELECT to_regclass($1) AS r`, [`public.${t}`]);
      if (!existe.rows[0]?.r) {
        deleted[t] = 0;
        continue;
      }
      // thread_id = orgId:telefone — o sufixo pega a pessoa em TODAS as orgs.
      const conds = bare.map((_, i) => `thread_id LIKE '%:' || $${i + 1}`).join(" OR ");
      const r = await client.query(`DELETE FROM ${t} WHERE ${conds}`, bare);
      deleted[t] = r.rowCount ?? 0;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    console.error("[forget] apagamento ABORTADO (rollback, nada saiu):", message);
    return NextResponse.json({ error: "erase_failed" }, { status: 500 });
  } finally {
    client.release();
  }

  console.log(
    `[forget] telefone esquecido (${bare.length} forma(s)) — ` +
      Object.entries(deleted)
        .map(([t, n]) => `${t}:${n}`)
        .join(" ")
  );

  return NextResponse.json({ ok: true, forms: bare.length, deleted });
}
