import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { templateAprovado, applyTemplateStatusUpdate } from "../templates/aprovacao";
import { query } from "../db";

/**
 * `wa_template` (migration 016) contra o Postgres real — é fail-closed o que
 * se prova: ausente da tabela, ou status diferente de APPROVED, nunca é
 * usado. `toEqual` de SQL, não de mock.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const NOME = "teste_aprovacao_2b";

d("templates/aprovacao (Postgres real)", () => {
  beforeEach(async () => {
    await query(`DELETE FROM wa_template WHERE name = $1`, [NOME]);
  });

  afterAll(async () => {
    await query(`DELETE FROM wa_template WHERE name = $1`, [NOME]);
  });

  it("ausente da tabela: não aprovado (fail-closed)", async () => {
    expect(await templateAprovado(NOME)).toBe(false);
  });

  it("PENDING, REJECTED, PAUSED: não aprovado", async () => {
    for (const status of ["PENDING", "REJECTED", "PAUSED"]) {
      await query(
        `INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', $2)
         ON CONFLICT (name) DO UPDATE SET status = $2`,
        [NOME, status]
      );
      expect(await templateAprovado(NOME)).toBe(false);
    }
  });

  it("APPROVED: aprovado", async () => {
    await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'APPROVED')`, [NOME]);
    expect(await templateAprovado(NOME)).toBe(true);
  });

  it("applyTemplateStatusUpdate cria a linha quando o webhook chega antes de qualquer submissão", async () => {
    await applyTemplateStatusUpdate({
      name: NOME,
      lang: "pt_BR",
      status: "APPROVED",
      metaId: "999",
      reason: null,
    });
    const rows = await query<{ status: string; meta_id: string | null }>(
      `SELECT status, meta_id FROM wa_template WHERE name = $1`,
      [NOME]
    );
    expect(rows[0]).toEqual({ status: "APPROVED", meta_id: "999" });
    expect(await templateAprovado(NOME)).toBe(true);
  });

  it("applyTemplateStatusUpdate rebaixa de APPROVED para REJECTED e grava o motivo, sem perder o meta_id", async () => {
    await query(`INSERT INTO wa_template (name, lang, status, meta_id) VALUES ($1, 'pt_BR', 'APPROVED', '777')`, [
      NOME,
    ]);
    await applyTemplateStatusUpdate({
      name: NOME,
      lang: "pt_BR",
      status: "REJECTED",
      metaId: null,
      reason: "INVALID_FORMAT",
    });
    const rows = await query<{ status: string; meta_id: string | null; rejected_reason: string | null }>(
      `SELECT status, meta_id, rejected_reason FROM wa_template WHERE name = $1`,
      [NOME]
    );
    expect(rows[0]).toEqual({ status: "REJECTED", meta_id: "777", rejected_reason: "INVALID_FORMAT" });
    expect(await templateAprovado(NOME)).toBe(false);
  });
});
