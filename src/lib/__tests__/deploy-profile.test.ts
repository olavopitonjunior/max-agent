import { describe, it, expect, afterEach } from "vitest";
import { deployProfile, nomeDoAgente, PERFIS } from "../deploy-profile";

/**
 * Perfil de deploy: o mesmo motor sobe como Max (RE/MAX, Meta) ou Newton
 * (Newcore, bridge). Ausente ⇒ Max idêntico ao de hoje. Valor desconhecido
 * derruba — cair em `max` em silêncio poria o Max atendendo quem não devia.
 */
const ORIGINAL = process.env.AGENT_DEPLOY_PROFILE;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.AGENT_DEPLOY_PROFILE;
  else process.env.AGENT_DEPLOY_PROFILE = ORIGINAL;
});

describe("deployProfile", () => {
  it("env ausente → max, idêntico a PERFIS.max", () => {
    delete process.env.AGENT_DEPLOY_PROFILE;
    expect(deployProfile()).toEqual(PERFIS.max);
    expect(PERFIS.max).toEqual({ agentKey: "max", agentName: "Max", transport: "meta", toolPacks: [] });
  });

  it("vazio ou só espaço → max", () => {
    process.env.AGENT_DEPLOY_PROFILE = "  ";
    expect(deployProfile().agentKey).toBe("max");
    process.env.AGENT_DEPLOY_PROFILE = "";
    expect(deployProfile().agentKey).toBe("max");
  });

  it("normaliza caixa e espaço", () => {
    process.env.AGENT_DEPLOY_PROFILE = " Newton ";
    expect(deployProfile().agentKey).toBe("newton");
    process.env.AGENT_DEPLOY_PROFILE = " Max ";
    expect(deployProfile().agentKey).toBe("max");
  });

  it("perfil newton usa o bridge", () => {
    process.env.AGENT_DEPLOY_PROFILE = "newton";
    expect(deployProfile()).toEqual({ agentKey: "newton", agentName: "Newton", transport: "newton-bridge", toolPacks: [] });
  });

  it("valor desconhecido lança, nunca cai em max", () => {
    process.env.AGENT_DEPLOY_PROFILE = "remax";
    expect(() => deployProfile()).toThrow("deploy_profile_invalido");
  });

  it("nomeDoAgente segue o perfil", () => {
    delete process.env.AGENT_DEPLOY_PROFILE;
    expect(nomeDoAgente()).toBe("Max");
    process.env.AGENT_DEPLOY_PROFILE = "newton";
    expect(nomeDoAgente()).toBe("Newton");
  });
});
