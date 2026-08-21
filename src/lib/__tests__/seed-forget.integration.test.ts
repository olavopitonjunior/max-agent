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
  await query(`DELETE FROM conversation_turn WHERE phone = $1`, [PHONE]);
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

  it("forget apaga também a variante sem o 9º dígito — JID da Z-API diverge", async () => {
    vi.stubEnv("MAX_NOTIFY_SECRET", "s-forget");
    const { POST } = await import("@/app/api/admin/forget/route");

    // A pessoa conversou pela forma SEM o 9º dígito (como a Z-API entrega em
    // alguns aparelhos); o operador digita a forma completa do cadastro.
    const semNove = "5511" + PHONE.slice(5); // remove o 9 após o DDD
    await query(
      `INSERT INTO memory_facts (org_id, phone, key, value) VALUES ($1, $2, 'k', 'v')`,
      [ORG, semNove]
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
    const { deleted, forms } = await res.json();
    expect(forms).toBe(2);
    expect(deleted.memory_facts).toBe(1);
    await query(`DELETE FROM memory_facts WHERE phone = $1`, [semNove]);
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

  /**
   * A auditoria de conversa é apagada por INTEIRO, e não anonimizada como faz
   * a poda por TTL. A diferença é deliberada: o TTL quer o custo sem o
   * conteúdo; o esquecimento não pode deixar linha chaveada pelo telefone da
   * pessoa, senão o "apaguei tudo" é falso. A contabilidade não se perde — ela
   * vive no `AIUsage` do ImobPro, outro sistema, sem o telefone.
   */
  it("forget apaga a auditoria de conversa por inteiro", async () => {
    vi.stubEnv("MAX_NOTIFY_SECRET", "s-forget");
    const { POST } = await import("@/app/api/admin/forget/route");
    const { registrarTurn } = await import("../turnlog");

    await registrarTurn({
      orgId: ORG,
      phone: PHONE,
      inboundText: "coisa que a pessoa disse",
      replyText: "coisa que o Max respondeu",
    });

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

    expect((await res.json()).deleted.conversation_turn).toBe(1);
    const sobrou = await query(
      `SELECT id FROM conversation_turn WHERE phone = $1`,
      [PHONE]
    );
    expect(sobrou).toHaveLength(0);
  });

  /**
   * A trava que teria pego a lacuna sozinha.
   *
   * Quando a `conversation_turn` nasceu, o `forget` — que o repo vende como
   * "apaga tudo sobre um telefone" — passou a mentir em silêncio sobre a
   * tabela que guarda literalmente a conversa. Nenhum dos 265 testes pegou,
   * porque nenhum enumerava as superfícies.
   *
   * Este enumera: pergunta ao BANCO quais tabelas têm coluna de telefone e
   * exige um `DELETE FROM` de verdade para cada uma. Tabela nova com telefone
   * que ninguém cobriu quebra o teste no dia em que é criada, não meses depois.
   *
   * **Extrai os alvos de `DELETE FROM`, não faz `includes` do nome.** A
   * primeira versão fazia `rota.includes(tabela)` no fonte inteiro, e isso
   * passava com a tabela citada num comentário — inclusive num `// TODO: o
   * forget ainda não cobre X`, que é exatamente a situação que o teste deveria
   * denunciar (achado do code review).
   */
  it("nenhuma tabela com telefone fica de fora do esquecimento", async () => {
    const { readFileSync } = await import("node:fs");
    const rota = readFileSync(
      "src/app/api/admin/forget/route.ts",
      "utf8"
    );

    // Alvos REAIS de deleção, do SQL — não menções no texto.
    const apagadas = new Set(
      [...rota.matchAll(/DELETE\s+FROM\s+"?(\w+)"?/gi)].map((m) => m[1])
    );
    // O laço das tabelas do checkpointer monta o DELETE por interpolação de
    // nome (`DELETE FROM ${t}`), então elas entram pela lista literal.
    for (const t of ["checkpoints", "checkpoint_writes", "checkpoint_blobs"]) {
      if (rota.includes(`"${t}"`) || rota.includes(`'${t}'`)) apagadas.add(t);
    }

    const comTelefone = await query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name IN ('phone', 'from_phone')
        ORDER BY table_name`
    );
    expect(comTelefone.length).toBeGreaterThan(0);

    const descobertas = comTelefone
      .map((r) => r.table_name)
      .filter((t) => !apagadas.has(t));

    expect(descobertas).toEqual([]);
  });
});
