import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * `/api/admin/conversations` — a superfície mais sensível que este serviço
 * expõe: ela LÊ conversa de gente real, num repositório público.
 *
 * O que estes testes protegem não é o formato da resposta. É a lista de coisas
 * que, se quebrarem, quebram em silêncio:
 *
 *  · assinatura recusada de verdade (e o formato legado NÃO aceito);
 *  · sem `orgId` não se lê tudo por acidente;
 *  · um tenant não enxerga o outro;
 *  · a paginação não perde linha empatada no mesmo instante — o defeito que o
 *    code review encontrou, e o motivo de o cursor carregar `id`.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const { registrarTurn } = await import("@/lib/turnlog");
const { query, db } = await import("@/lib/db");
const { sign } = await import("@/lib/hmac");

const SECRET = "s-conversas";
const ORG_A = "org-conversas-a";
const ORG_B = "org-conversas-b";

function chamar(qs: string) {
  const path = `/api/admin/conversations${qs}`;
  const ts = String(Date.now());
  return {
    req: new NextRequest(`http://max.test${path}`, {
      headers: {
        "x-max-timestamp": ts,
        "x-max-signature": sign(ts, `GET.${path}`, SECRET),
      },
    }),
  };
}

d("GET /api/admin/conversations", () => {
  beforeEach(async () => {
    vi.stubEnv("MAX_NOTIFY_SECRET", SECRET);
    await query(`DELETE FROM conversation_turn WHERE org_id = ANY($1)`, [
      [ORG_A, ORG_B],
    ]);
  });

  afterAll(async () => {
    await query(`DELETE FROM conversation_turn WHERE org_id = ANY($1)`, [
      [ORG_A, ORG_B],
    ]);
    await db().end();
  });

  it("recusa sem assinatura", async () => {
    const { GET } = await import("@/app/api/admin/conversations/route");
    const res = await GET(
      new NextRequest("http://max.test/api/admin/conversations?orgId=x")
    );
    expect(res.status).toBe(401);
  });

  /**
   * O `/admin/status` aceita o formato antigo (`ts.""`) enquanto o cliente do
   * Contractmaker não migra. Esta rota é nova: aceitar o legado aqui seria
   * criar dívida no dia do parto, e reabriria o replay cross-tenant que o
   * formato com query fechou.
   */
  it("NÃO aceita o formato legado de assinatura", async () => {
    const { GET } = await import("@/app/api/admin/conversations/route");
    const ts = String(Date.now());
    const res = await GET(
      new NextRequest("http://max.test/api/admin/conversations?orgId=x", {
        headers: {
          "x-max-timestamp": ts,
          "x-max-signature": sign(ts, "", SECRET),
        },
      })
    );
    expect(res.status).toBe(401);
  });

  it("sem orgId exige scope=all explícito", async () => {
    const { GET } = await import("@/app/api/admin/conversations/route");

    const semNada = await GET(chamar("").req);
    expect(semNada.status).toBe(400);

    const comScope = await GET(chamar("?scope=all").req);
    expect(comScope.status).toBe(200);
  });

  it("um tenant não enxerga o outro", async () => {
    const { GET } = await import("@/app/api/admin/conversations/route");
    await registrarTurn({ orgId: ORG_A, phone: "5511900000011", inboundText: "de A" });
    await registrarTurn({ orgId: ORG_B, phone: "5511900000012", inboundText: "de B" });

    const res = await GET(chamar(`?orgId=${ORG_A}`).req);
    const { turns } = await res.json();

    expect(turns).toHaveLength(1);
    expect(turns[0].inboundText).toBe("de A");
  });

  it("mascara o telefone na resposta", async () => {
    const { GET } = await import("@/app/api/admin/conversations/route");
    await registrarTurn({ orgId: ORG_A, phone: "5511987654321", inboundText: "oi" });

    const { turns } = await (await GET(chamar(`?orgId=${ORG_A}`).req)).json();
    expect(turns[0].phone).toBe("5511***4321");
  });

  /**
   * O achado do code review. Com o cursor só de tempo, linhas gravadas no
   * MESMO instante caíam uma de cada lado da fronteira da página e a seguinte
   * (`created_at < cursor`) excluía todas — a linha sumia da investigação sem
   * erro nenhum. O cursor carrega `id` justamente para desempatar.
   */
  it("paginação não perde linha empatada no mesmo instante", async () => {
    const { GET } = await import("@/app/api/admin/conversations/route");

    for (let i = 0; i < 4; i++) {
      await registrarTurn({ orgId: ORG_A, phone: "5511900000013", inboundText: `t${i}` });
    }
    // Empata TODAS no mesmo timestamp: o pior caso, e o que o cursor de tempo
    // puro não sobrevive.
    await query(
      `UPDATE conversation_turn SET created_at = '2026-08-21T12:00:00Z'
        WHERE org_id = $1`,
      [ORG_A]
    );

    const vistos: string[] = [];
    let cursor: string | null = null;
    for (let pagina = 0; pagina < 5; pagina++) {
      const sufixo: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const qs: string = `?orgId=${ORG_A}&limit=2${sufixo}`;
      const body: { turns: { inboundText: string }[]; nextCursor: string | null } =
        await (await GET(chamar(qs).req)).json();
      vistos.push(...body.turns.map((t) => t.inboundText));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    // As quatro aparecem, sem repetição.
    expect(new Set(vistos)).toEqual(new Set(["t0", "t1", "t2", "t3"]));
    expect(vistos).toHaveLength(4);
  });

  it("cursor malformado é 400, não 500", async () => {
    const { GET } = await import("@/app/api/admin/conversations/route");
    const res = await GET(chamar(`?orgId=${ORG_A}&cursor=banana`).req);
    expect(res.status).toBe(400);
  });
});
