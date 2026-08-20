import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Fase 4B contra o Postgres: o seed do thread (notificação vira contexto),
 * a poda por TTL da memória e o direito ao esquecimento.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const { seedNotification, buildGraph, getCheckpointer, threadIdFor } =
  await import("@/graph/graph");
const { pruneOldFacts, saveFacts, loadFacts } = await import("../memory");
const { query, db } = await import("../db");
const { sign } = await import("../hmac");

const ORG = "org-seed";
const PHONE = "5511900000099";
const E164 = "+5511900000099";

async function limpar() {
  await query(`DELETE FROM memory_facts WHERE phone = $1`, [PHONE]);
  await query(`DELETE FROM phone_org_choice WHERE phone = $1`, [E164]);
  await query(`DELETE FROM identity_cache WHERE phone = $1`, [E164]);
  await query(`DELETE FROM inbound_queue WHERE from_phone = $1`, [PHONE]);
  await query(`DELETE FROM outbox WHERE phone = $1`, [PHONE]);
  for (const t of ["checkpoints", "checkpoint_writes", "checkpoint_blobs"]) {
    await query(`DELETE FROM ${t} WHERE thread_id LIKE '%:' || $1`, [PHONE]);
  }
}

d("fase 4B", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    await limpar();
  });
  afterAll(async () => {
    await limpar();
    await db().end();
  });

  it("seedNotification põe a notificação no thread como fala do assistente", async () => {
    await seedNotification(ORG, PHONE, "Oi, Marcia! *Proposta assinada* …");

    const app = buildGraph().compile({ checkpointer: await getCheckpointer() });
    const state = await app.getState({
      configurable: { thread_id: threadIdFor(ORG, PHONE) },
    });
    const messages = (state.values as { messages?: Array<{ role: string; content: string }> })
      .messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("Proposta assinada"),
    });

    // Semeadura seguinte ACRESCENTA — não substitui o histórico.
    await seedNotification(ORG, PHONE, "Segundo aviso");
    const depois = await app.getState({
      configurable: { thread_id: threadIdFor(ORG, PHONE) },
    });
    expect(
      (depois.values as { messages: unknown[] }).messages
    ).toHaveLength(2);
  });

  it("pruneOldFacts apaga só o que venceu", async () => {
    await saveFacts(ORG, PHONE, { imovel_interesse: "apto 2q" });
    // Um fato antigo, plantado direto: updated_at além do TTL.
    await query(
      `INSERT INTO memory_facts (org_id, phone, key, value, updated_at)
       VALUES ($1, $2, 'fato_velho', 'x', now() - interval '200 days')`,
      [ORG, PHONE]
    );

    const podados = await pruneOldFacts();
    expect(podados).toBeGreaterThanOrEqual(1);

    const restantes = await loadFacts(ORG, PHONE);
    expect(restantes.fato_velho).toBeUndefined();
    expect(restantes.imovel_interesse).toBe("apto 2q");
  });

  it("forget apaga as seis superfícies e devolve as contagens", async () => {
    vi.stubEnv("MAX_NOTIFY_SECRET", "s-forget");
    const { POST } = await import("@/app/api/admin/forget/route");

    await saveFacts(ORG, PHONE, { a: "1" });
    await seedNotification(ORG, PHONE, "notificação");
    await query(
      `INSERT INTO identity_cache (phone, negative, greeted, expires_at)
       VALUES ($1, true, true, now() + interval '1 day')`,
      [E164]
    );

    const rawBody = JSON.stringify({ phone: PHONE });
    const ts = String(Date.now());
    const res = await POST(
      new NextRequest("http://max.test/api/admin/forget", {
        method: "POST",
        body: rawBody,
        headers: {
          "x-max-timestamp": ts,
          "x-max-signature": sign(ts, rawBody, "s-forget"),
        },
      })
    );

    expect(res.status).toBe(200);
    const { deleted } = await res.json();
    expect(deleted.memory_facts).toBe(1);
    expect(deleted.identity_cache).toBe(1);
    expect(deleted.checkpoints).toBeGreaterThanOrEqual(1);

    expect(await loadFacts(ORG, PHONE)).toEqual({});
    const app = buildGraph().compile({ checkpointer: await getCheckpointer() });
    const state = await app.getState({
      configurable: { thread_id: threadIdFor(ORG, PHONE) },
    });
    expect(
      ((state.values as { messages?: unknown[] }).messages ?? []).length
    ).toBe(0);
  });
});
