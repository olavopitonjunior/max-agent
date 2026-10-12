import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 403 `ORG_SUSPENSA` do ImobPro (`lib/auth/org-suspensa.ts` lá): corpo
 * `{ error: "ORG_SUSPENSA", reason }`. É fato estruturado — o Max o reconhece e
 * responde com frase fixa, sem modelo. 403 de outra natureza segue como erro
 * genérico (comportamento antigo).
 */

vi.mock("../orgs", () => ({ orgById: vi.fn() }));

const { orgById } = await import("../orgs");
const { fetchProfile, criarFormularioVenda } = await import("../cm");
const { OrgSuspensaError, ehOrgSuspensa, TEXTO_ORG_SUSPENSA } = await import("../org-suspensa");

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CM_BASE_URL ??= "https://imobpro.test";
  vi.mocked(orgById).mockResolvedValue({ orgId: "org1", orgName: "Trio", apiToken: "cmt_abc" } as never);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const suspensa = () =>
  new Response(JSON.stringify({ error: "ORG_SUSPENSA", reason: "suspenso" }), { status: 403 });

describe("ehOrgSuspensa", () => {
  it("reconhece só 403 com error ORG_SUSPENSA", () => {
    expect(ehOrgSuspensa(403, JSON.stringify({ error: "ORG_SUSPENSA" }))).toBe(true);
    expect(ehOrgSuspensa(403, JSON.stringify({ error: "FORBIDDEN" }))).toBe(false);
    expect(ehOrgSuspensa(403, "não é json")).toBe(false);
    expect(ehOrgSuspensa(500, JSON.stringify({ error: "ORG_SUSPENSA" }))).toBe(false);
  });
});

describe("cliente HTTP do ImobPro", () => {
  it("GET com 403 ORG_SUSPENSA lança OrgSuspensaError", async () => {
    fetchMock.mockResolvedValue(suspensa());
    await expect(fetchProfile("org1")).rejects.toBeInstanceOf(OrgSuspensaError);
  });

  it("GET com 403 genérico segue Error comum (comportamento antigo)", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 }));
    const err = await fetchProfile("org1").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OrgSuspensaError);
    expect(err.message).toContain("403");
  });

  it("criação de formulário com 403 ORG_SUSPENSA lança OrgSuspensaError", async () => {
    fetchMock.mockResolvedValue(suspensa());
    await expect(
      criarFormularioVenda("org1", { idempotencyKey: "m1" } as never)
    ).rejects.toBeInstanceOf(OrgSuspensaError);
  });

  it("a frase fixa diz o que fazer", () => {
    expect(TEXTO_ORG_SUSPENSA).toContain("suspenso");
    expect(TEXTO_ORG_SUSPENSA).toContain("administrador");
  });
});
