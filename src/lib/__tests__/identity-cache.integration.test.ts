import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * O cache da varredura de identidade (migration 007), contra o Postgres.
 *
 * O que se protege: (1) a segunda mensagem do mesmo número NÃO paga a
 * varredura de novo; (2) número desconhecido é apresentado UMA vez por ciclo
 * do cache; (3) a escolha salva em `phone_org_choice` continua tendo
 * precedência sobre o cache.
 *
 * O HTTP é mockado (fetch global) — o assunto aqui é o cache, não o ImobPro.
 * Pula sem `DATABASE_URL`, como os demais de integração.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const ORG = {
  orgId: "org-cache-test",
  orgName: "RE/MAX Cache",
  apiToken: "tok",
};

vi.mock("../orgs", () => ({
  listOrgs: vi.fn().mockResolvedValue([
    { orgId: "org-cache-test", orgName: "RE/MAX Cache", apiToken: "tok" },
  ]),
  orgById: vi.fn().mockResolvedValue({
    orgId: "org-cache-test",
    orgName: "RE/MAX Cache",
    apiToken: "tok",
  }),
}));

const { resolveIdentity, markGreeted, clearIdentityCache } = await import(
  "../identity"
);
const { query, db } = await import("../db");

const PHONE = "5511900000077";
const E164 = "+5511900000077";

function mockScan(resposta: { userId?: string; name?: string } | 404) {
  const fn = vi.fn().mockImplementation(async () =>
    resposta === 404
      ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => resposta }
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

d("identity_cache", () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await query(`DELETE FROM identity_cache WHERE phone = $1`, [E164]);
    await query(`DELETE FROM phone_org_choice WHERE phone = $1`, [E164]);
  });

  afterAll(async () => {
    await query(`DELETE FROM identity_cache WHERE phone = $1`, [E164]);
    await query(`DELETE FROM phone_org_choice WHERE phone = $1`, [E164]);
    await db().end();
  });

  it("um candidato: a segunda resolução vem do cache, sem varredura", async () => {
    const fetchMock = mockScan({ userId: "u1", name: "Marcia" });

    const primeira = await resolveIdentity(PHONE);
    expect(primeira.kind).toBe("resolved");
    const chamadasDaVarredura = fetchMock.mock.calls.length;
    expect(chamadasDaVarredura).toBeGreaterThan(0);

    const segunda = await resolveIdentity(PHONE);
    expect(segunda.kind).toBe("resolved");
    // Nenhum fetch a mais: o vínculo veio da identity_cache.
    expect(fetchMock.mock.calls.length).toBe(chamadasDaVarredura);
  });

  it("desconhecido: cacheia negativo e informa se já foi apresentado", async () => {
    const fetchMock = mockScan(404);

    const primeira = await resolveIdentity(PHONE);
    expect(primeira).toMatchObject({ kind: "unknown", alreadyGreeted: false });

    await markGreeted(PHONE);

    const chamadas = fetchMock.mock.calls.length;
    const segunda = await resolveIdentity(PHONE);
    // Sem varredura nova, e com o aviso de que a apresentação já foi feita.
    expect(segunda).toMatchObject({ kind: "unknown", alreadyGreeted: true });
    expect(fetchMock.mock.calls.length).toBe(chamadas);
  });

  it("cache expirado volta a varrer", async () => {
    const fetchMock = mockScan(404);
    await resolveIdentity(PHONE);
    const chamadas = fetchMock.mock.calls.length;

    await query(
      `UPDATE identity_cache SET expires_at = now() - interval '1 minute' WHERE phone = $1`,
      [E164]
    );

    await resolveIdentity(PHONE);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(chamadas);
  });

  it("clearIdentityCache derruba o negativo — org nova enxerga o número", async () => {
    const fetchMock = mockScan(404);
    await resolveIdentity(PHONE);
    const chamadas = fetchMock.mock.calls.length;

    await clearIdentityCache();

    mockScan({ userId: "u1", name: "Marcia" });
    const depois = await resolveIdentity(PHONE);
    expect(depois.kind).toBe("resolved");
    expect(fetchMock.mock.calls.length).toBe(chamadas); // o mock foi trocado; só confere que o antigo parou
  });

  /**
   * O achado mais sério do code review: outage do ImobPro fazia a varredura
   * voltar vazia, o vazio virava negativo de 24h, e o usuário legítimo ficava
   * mudo por um dia mesmo depois de o ImobPro voltar.
   */
  it("varredura degradada (org fora do ar) NÃO grava cache negativo", async () => {
    const caiu = vi.fn().mockRejectedValue(new Error("timeout de 8000ms"));
    vi.stubGlobal("fetch", caiu);

    const durante = await resolveIdentity(PHONE);
    expect(durante.kind).toBe("unknown");

    // O ImobPro volta: a PRÓXIMA mensagem re-varre e resolve — sem esperar TTL.
    mockScan({ userId: "u1", name: "Marcia" });
    const depois = await resolveIdentity(PHONE);
    expect(depois.kind).toBe("resolved");
  });

  it("escolha salva tem precedência: nem cache, nem varredura", async () => {
    const fetchMock = mockScan({ userId: "u1", name: "Marcia" });
    await query(
      `INSERT INTO phone_org_choice (phone, chosen_org_id, candidates, asked_at, chosen_at, updated_at)
       VALUES ($1, $2, $3::jsonb, now(), now(), now())`,
      [
        E164,
        ORG.orgId,
        JSON.stringify([
          { orgId: ORG.orgId, orgName: ORG.orgName, kind: "user", userId: "u1", userName: "Marcia" },
        ]),
      ]
    );

    const r = await resolveIdentity(PHONE);
    expect(r.kind).toBe("resolved");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
