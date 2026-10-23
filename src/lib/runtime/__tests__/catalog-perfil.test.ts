import { afterEach, describe, expect, it, vi } from "vitest";
import { catalog } from "../catalog";

/** O admin separa Max e Newton pelo que o catálogo de cada deploy declara. */
afterEach(() => vi.unstubAllEnvs());

describe("catálogo × perfil", () => {
  it("sem perfil: Max, prompt max.system e canal da Meta (como antes)", () => {
    const c = catalog();
    expect(c).toMatchObject({ agentKey: "max", agentName: "Max" });
    expect(c.agents[0].id).toBe("max");
    expect(c.prompts.map((p) => p.id)).toEqual(["max.system"]);
    expect(c.adapters.map((a) => a.id)).toContain("whatsapp.meta");
  });

  it("newton: agente, prompt e canal do Newton, sem nada de Max nem Meta", () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    const c = catalog();
    expect(c).toMatchObject({ agentKey: "newton", agentName: "Newton" });
    expect(c.agents[0].id).toBe("newton");
    expect(c.prompts.map((p) => p.id)).toEqual(["newton.system"]);
    const adapters = c.adapters.map((a) => a.id);
    expect(adapters).toContain("whatsapp.newton-bridge");
    expect(adapters).not.toContain("whatsapp.meta");
    expect(c.agents.map((a) => a.id)).not.toContain("max");
  });
});
