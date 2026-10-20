import { describe, it, expect, beforeEach, afterAll } from "vitest";

/**
 * /api/admin/playground contra o Postgres REAL de teste (.env.test, banco
 * maxtest, ja migrado).
 *
 * Os dois testes mockados (playground.test.ts) nunca tocam banco - o mock de
 * @/lib/db aceita qualquer SQL, inclusive uma coluna que nao existe mais.
 * Este arquivo roda as DUAS consultas que a rota faz (dedupe por message_id e
 * o SELECT do rastro) importando as MESMAS strings de SQL que a rota usa
 * (RASTRO_SELECT_SQL / DEDUPE_SELECT_SQL, de src/lib/playground-sql.ts, as mesmas que a rota usa) contra o
 * schema de verdade - se alguem trocar um nome de coluna na rota (ex.:
 * reply_text -> replyText, ou um campo que a migration 020 nao criou), o
 * Postgres rejeita a query e o teste cai, em vez de passar porque o mock nao
 * sabe a diferenca.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const { RASTRO_SELECT_SQL, DEDUPE_SELECT_SQL } = await import("../../../lib/playground-sql");
const { query, db } = await import("@/lib/db");

const ORG = "org-playground-integration-test";
const MESSAGE_ID = "playground-integration-11111111-1111-1111-1111-111111111111";

async function inserirLinha(overrides: Record<string, unknown> = {}) {
  const base = {
    org_id: ORG,
    phone: "5511900000099",
    message_id: MESSAGE_ID,
    kind: "text",
    inbound_text: "oi",
    transcript: null,
    reply_text: "resposta do max",
    route: "conversa",
    intent_json: JSON.stringify({ intencao: "duvida" }),
    tools_json: JSON.stringify([{ name: "x", args: {}, outcome: "proposta" }]),
    usage_json: JSON.stringify([{ model: "m", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true }]),
    timings_json: JSON.stringify([{ no: "roteador", ms: 12 }]),
    signals_json: JSON.stringify({ repergunta: false }),
    degradado: false,
    latency_ms: 321,
    error: null,
    ...overrides,
  };
  await query(
    `INSERT INTO conversation_turn
       (org_id, phone, message_id, kind, inbound_text, transcript, reply_text,
        route, intent_json, tools_json, usage_json, timings_json, signals_json,
        degradado, latency_ms, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      base.org_id, base.phone, base.message_id, base.kind, base.inbound_text,
      base.transcript, base.reply_text, base.route, base.intent_json,
      base.tools_json, base.usage_json, base.timings_json, base.signals_json,
      base.degradado, base.latency_ms, base.error,
    ]
  );
}

d("SQL real da rota (Postgres de teste, schema migrado)", () => {
  beforeEach(() => query(`DELETE FROM conversation_turn WHERE org_id = $1`, [ORG]));
  afterAll(async () => {
    await query(`DELETE FROM conversation_turn WHERE org_id = $1`, [ORG]);
    await db().end();
  });

  it("DEDUPE_SELECT_SQL acha a linha pelo message_id", async () => {
    await inserirLinha();
    const rows = await query<{ ja_existe: number }>(DEDUPE_SELECT_SQL, [MESSAGE_ID]);
    expect(rows).toHaveLength(1);
  });

  it("DEDUPE_SELECT_SQL nao acha quando o message_id nao existe", async () => {
    const rows = await query<{ ja_existe: number }>(DEDUPE_SELECT_SQL, ["playground-inexistente"]);
    expect(rows).toHaveLength(0);
  });

  it("RASTRO_SELECT_SQL roda contra o schema real e devolve as colunas que a rota usa", async () => {
    await inserirLinha();
    const rows = await query<Record<string, unknown>>(RASTRO_SELECT_SQL, [MESSAGE_ID]);

    expect(rows).toHaveLength(1);
    const [row] = rows;
    // Todas as chaves que a rota le de `row.*` ao montar o rastro.
    expect(Object.keys(row).sort()).toEqual(
      [
        "org_id", "kind", "inbound_text", "transcript", "reply_text",
        "route", "intent_json", "tools_json", "usage_json", "timings_json",
        "signals_json", "degradado", "latency_ms", "error", "created_at",
      ].sort()
    );
    expect(row.org_id).toBe(ORG);
    expect(row.reply_text).toBe("resposta do max");
    expect(row.route).toBe("conversa");
    expect(row.degradado).toBe(false);
    // Requisito 3 do code review: a rota nunca pediu `phone` - a coluna
    // existe na tabela, mas nao pode vir no resultado desta query.
    expect(row).not.toHaveProperty("phone");
  });
});
