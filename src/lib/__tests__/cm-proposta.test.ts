import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * `criarRascunhoProposta` — o corpo HTTP de verdade.
 *
 * Os testes do grafo mockam `@/lib/cm` inteiro, então o corpo desta função
 * nunca rodava lá: dava para esquecer o `responsibleUserId` no JSON e todo
 * teste do fluxo continuaria verde. Sem ele, o rascunho nasce só do usuário de
 * serviço e o corretor recebe um link que não abre (cm#889).
 */

vi.mock("../orgs", () => ({ orgById: vi.fn() }));

const { orgById } = await import("../orgs");
const { criarRascunhoProposta } = await import("../cm");

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CM_BASE_URL ??= "https://imobpro.test";
  vi.mocked(orgById).mockResolvedValue({ orgId: "org1", orgName: "Trio", apiToken: "cmt_abc" } as never);
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ proposal: { id: "prop1" } }), { status: 201 })
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const corpo = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

describe("criarRascunhoProposta", () => {
  it("manda o responsável quando há quem pediu", async () => {
    await criarRascunhoProposta("org1", {
      title: "Proposta — Carlos",
      schemaType: "compra_venda_v1",
      idempotencyKey: "m1",
      responsibleUserId: "u1",
    });
    expect(corpo()).toEqual({
      title: "Proposta — Carlos",
      schemaType: "compra_venda_v1",
      dataJson: {},
      responsibleUserId: "u1",
    });
  });

  /** Nome livre é 403 para o Max no ImobPro: esta função nunca o manda. */
  it("sem responsável, o campo nem vai — e responsibleName nunca vai", async () => {
    await criarRascunhoProposta("org1", {
      title: "Proposta (criada pelo Max)",
      schemaType: "locacao_residencial_v1",
      idempotencyKey: "m2",
    });
    expect(corpo()).not.toHaveProperty("responsibleUserId");
    expect(corpo()).not.toHaveProperty("responsibleName");
  });
});
