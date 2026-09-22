import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Migration 016 contra o Postgres real: `kind`/`params` gravados pelo enqueue
 * e o redirecionador `/r/<id>` lendo o destino do BANCO (nunca da URL).
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

vi.mock("@/graph/graph", () => ({ seedNotification: vi.fn().mockResolvedValue(undefined) }));

const { enqueue } = await import("../outbox");
const { GET } = await import("@/app/r/[id]/route");
const { query } = await import("../db");

const ORG = "org-tpl-test";

async function linha(dedupeKey: string, linkUrl: string | null, extra: Record<string, unknown> = {}) {
  const r = await enqueue({
    orgId: ORG,
    dedupeKey,
    audience: "platform_user",
    phone: "5511900002222",
    recipientName: "Ana",
    title: "Status do negócio atualizado",
    body: "corpo",
    linkUrl,
    dealId: null,
    orgName: "RE/MAX Trio",
    ...extra,
  });
  if (r.status !== "queued") throw new Error("não enfileirou");
  return r.id;
}

const abrir = (id: string) => GET(new NextRequest(`https://max.test/r/${id}`), { params: { id } });

d("templates (Postgres real)", () => {
  beforeEach(async () => {
    await query(`DELETE FROM outbox WHERE org_id = $1`, [ORG]);
  });
  afterAll(async () => {
    await query(`DELETE FROM outbox WHERE org_id = $1`, [ORG]);
  });

  it("enqueue grava kind e params; emissor antigo grava nulos", async () => {
    const a = await linha("k-tpl-1", null, { kind: "stage_change", params: { negocio: "Apto 302", etapa: "Assinatura" } });
    const b = await linha("k-tpl-2", null);
    const rows = await query<{ id: string; kind: string | null; params: unknown }>(
      `SELECT id, kind, params FROM outbox WHERE id = ANY($1)`,
      [[a, b]]
    );
    const porId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(porId[a]).toMatchObject({ kind: "stage_change", params: { negocio: "Apto 302", etapa: "Assinatura" } });
    expect(porId[b]).toMatchObject({ kind: null, params: null });
  });

  it("/r/<id>: 302 para o link gravado e registra o PRIMEIRO clique", async () => {
    const id = await linha("k-tpl-r", "https://trio.imobpro.ia.br/deals/cmx1");
    const res = await abrir(id);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://trio.imobpro.ia.br/deals/cmx1");

    const [{ clicked_at: primeiro }] = await query<{ clicked_at: Date }>(
      `SELECT clicked_at FROM outbox WHERE id = $1`,
      [id]
    );
    expect(primeiro).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    await abrir(id);
    const [{ clicked_at: segundo }] = await query<{ clicked_at: Date }>(
      `SELECT clicked_at FROM outbox WHERE id = $1`,
      [id]
    );
    expect(new Date(segundo).getTime()).toBe(new Date(primeiro).getTime());
  });

  /** Destino fora do nosso domínio no banco (dado ruim) vira 404, não redirect. */
  it("/r/<id>: link gravado fora de imobpro.ia.br é 404 e não registra clique", async () => {
    const id = await linha("k-tpl-evil", "https://imobpro.ia.br.evil.com/x");
    const res = await abrir(id);
    expect(res.status).toBe(404);
    const [{ clicked_at }] = await query<{ clicked_at: Date | null }>(
      `SELECT clicked_at FROM outbox WHERE id = $1`,
      [id]
    );
    expect(clicked_at).toBeNull();
  });

  it("/r/<id>: sem link, id inexistente ou id que não é UUID — 404", async () => {
    const semLink = await linha("k-tpl-nolink", null);
    expect((await abrir(semLink)).status).toBe(404);
    expect((await abrir("3f2b8c1e-9a4d-4e2f-8b1a-2c3d4e5f6a7b")).status).toBe(404);
    expect((await abrir("1 OR 1=1")).status).toBe(404);
  });
});
