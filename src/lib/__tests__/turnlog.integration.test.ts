import { describe, it, expect, beforeEach, afterAll } from "vitest";

/**
 * Auditoria de conversa.
 *
 * O que estes testes protegem são as três promessas que fazem a tabela valer a
 * pena, e nenhuma é sobre formato:
 *
 * 1. **Nunca derruba o turn.** Auditoria que lança troca uma conversa por um
 *    registro que ninguém vai ler.
 * 2. **A chave do telefone é a mesma da conversa.** Investigar um turn e achar
 *    a thread dele não pode depender do formato de entrada — foi assim que a
 *    mesma pessoa acabou com duas memórias em 21/08.
 * 3. **A poda apaga TEXTO, não a linha.** O conteúdo tem prazo; o custo não.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const { registrarTurn, pruneOldTurns } = await import("../turnlog");
const { query, db } = await import("../db");

const ORG = "org-turnlog-test";

async function linhas() {
  return query<Record<string, unknown>>(
    `SELECT * FROM conversation_turn WHERE org_id = $1 ORDER BY created_at`,
    [ORG]
  );
}

d("conversation_turn (Postgres real)", () => {
  beforeEach(() => query(`DELETE FROM conversation_turn WHERE org_id = $1`, [ORG]));
  afterAll(async () => {
    await query(`DELETE FROM conversation_turn WHERE org_id = $1`, [ORG]);
    await db().end();
  });

  it("grava o turn com consumo e trilha de ferramenta", async () => {
    await registrarTurn({
      orgId: ORG,
      phone: "5511900000001",
      messageId: "M1",
      inboundText: "me manda o formulário",
      replyText: "Posso criar. Confirma?",
      tools: [{ name: "propor_criacao", args: { tipo: "venda" }, outcome: "proposta" }],
      usage: [
        { model: "m", promptTokens: 100, completionTokens: 10, latencyMs: 200, success: true },
        { model: "m", promptTokens: 50, completionTokens: 5, latencyMs: 100, success: true },
      ] as never,
      latencyMs: 1234,
    });

    const [t] = await linhas();
    expect(t.message_id).toBe("M1");
    expect(t.latency_ms).toBe(1234);
    // Lista, não soma: é preciso enxergar QUAL chamada pesa.
    expect(t.usage_json).toHaveLength(2);
    expect((t.tools_json as { outcome: string }[])[0].outcome).toBe("proposta");
  });

  /**
   * A promessa que justifica o `try/catch` largo: um turn respondido não pode
   * virar um turn perdido porque a auditoria tropeçou.
   */
  it("NUNCA lança — nem com dado que o banco recusa", async () => {
    // `org_id` é NOT NULL e é o único campo sem coalescência no `registrarTurn`
    // (o `kind`, por exemplo, tem `?? "text"` e não serviria para forçar erro).
    // Este é o caminho que prova o `try/catch`: o INSERT falha de verdade.
    await expect(
      registrarTurn({
        orgId: null as unknown as string,
        phone: "5511900000002",
        inboundText: "oi",
      })
    ).resolves.toBeUndefined();

    // E nada foi gravado pela metade.
    expect(await linhas()).toHaveLength(0);
  });

  /** Mesmo bug de 21/08, mesma cerca: a forma do telefone não pode importar. */
  it("normaliza o telefone pela chave de conversa", async () => {
    await registrarTurn({ orgId: ORG, phone: "+5511900000003", inboundText: "a" });
    await registrarTurn({ orgId: ORG, phone: "(11) 90000-0003", inboundText: "b" });

    const rows = await linhas();
    expect(new Set(rows.map((r) => r.phone))).toEqual(new Set(["5511900000003"]));
  });

  describe("poda por idade", () => {
    it("apaga o TEXTO e preserva a métrica", async () => {
      await registrarTurn({
        orgId: ORG,
        phone: "5511900000004",
        inboundText: "coisa antiga",
        replyText: "resposta antiga",
        latencyMs: 999,
        usage: [{ model: "m", promptTokens: 7, completionTokens: 1, latencyMs: 1, success: true }] as never,
      });
      await query(
        `UPDATE conversation_turn SET created_at = now() - interval '200 days'
          WHERE org_id = $1`,
        [ORG]
      );

      expect(await pruneOldTurns()).toBeGreaterThan(0);

      const [t] = await linhas();
      // A linha sobrevive: o histórico de consumo não tem prazo para expirar.
      expect(t.inbound_text).toBeNull();
      expect(t.reply_text).toBeNull();
      expect(t.latency_ms).toBe(999);
      expect(t.usage_json).toHaveLength(1);
    });

    it("não toca no que está dentro do prazo", async () => {
      await registrarTurn({ orgId: ORG, phone: "5511900000005", inboundText: "recente" });

      await pruneOldTurns();

      expect((await linhas())[0].inbound_text).toBe("recente");
    });

    it("`off` desliga de propósito; valor inválido cai no default", async () => {
      await registrarTurn({ orgId: ORG, phone: "5511900000006", inboundText: "antiga" });
      await query(
        `UPDATE conversation_turn SET created_at = now() - interval '200 days'
          WHERE org_id = $1`,
        [ORG]
      );

      process.env.CONVERSATION_TTL_DAYS = "off";
      expect(await pruneOldTurns()).toBe(0);
      expect((await linhas())[0].inbound_text).toBe("antiga");

      // Inválido NÃO pode virar "poda desligada em silêncio".
      process.env.CONVERSATION_TTL_DAYS = "banana";
      expect(await pruneOldTurns()).toBeGreaterThan(0);
      delete process.env.CONVERSATION_TTL_DAYS;
    });
  });
});
