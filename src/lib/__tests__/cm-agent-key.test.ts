import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * O agentKey que o motor manda ao ImobPro vem do perfil de deploy. Sem perfil,
 * é "max" como sempre foi; no deploy Newton, "newton" — o perfil, a base de
 * conhecimento e o consumo de IA ficam separados por agente lá.
 */
vi.mock("../orgs", () => ({ orgById: vi.fn() }));

const { orgById } = await import("../orgs");
const { fetchProfile, searchKnowledge } = await import("../cm");

const fetchMock = vi.fn();
const ORIGINAL = process.env.AGENT_DEPLOY_PROFILE;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CM_BASE_URL ??= "https://imobpro.test";
  vi.mocked(orgById).mockResolvedValue({ orgId: "org1", orgName: "Org", apiToken: "cmt_abc" } as never);
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ enabled: true, results: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL === undefined) delete process.env.AGENT_DEPLOY_PROFILE;
  else process.env.AGENT_DEPLOY_PROFILE = ORIGINAL;
});

const urlChamada = () => String(fetchMock.mock.calls[0][0]);
const bodyChamado = () => JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));

describe("agentKey do perfil no cliente do ImobPro", () => {
  it("sem perfil: fetchProfile pede agentKey=max", async () => {
    delete process.env.AGENT_DEPLOY_PROFILE;
    await fetchProfile("org1");
    expect(urlChamada()).toContain("/api/agents/profile?agentKey=max");
  });

  it("perfil newton: fetchProfile pede agentKey=newton", async () => {
    process.env.AGENT_DEPLOY_PROFILE = "newton";
    await fetchProfile("org1");
    expect(urlChamada()).toContain("/api/agents/profile?agentKey=newton");
  });

  it("searchKnowledge leva o agentKey do perfil no body", async () => {
    delete process.env.AGENT_DEPLOY_PROFILE;
    await searchKnowledge("org1", "pergunta");
    expect(bodyChamado().agentKey).toBe("max");
    fetchMock.mockClear();
    process.env.AGENT_DEPLOY_PROFILE = "newton";
    await searchKnowledge("org1", "pergunta");
    expect(bodyChamado().agentKey).toBe("newton");
  });
});
