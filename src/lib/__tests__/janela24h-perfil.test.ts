import { afterEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../db", () => ({ query: (...a: unknown[]) => query(...a) }));

const { envioLivrePermitido } = await import("../janela24h");

afterEach(() => {
  vi.unstubAllEnvs();
  query.mockReset();
});

describe("envioLivrePermitido (atendimento humano)", () => {
  it("Newton: o bridge não tem janela de 24h, texto livre sai sem consultar o banco", async () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    expect(await envioLivrePermitido("5511900000001")).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it("Max: janela fechada recusa", async () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "");
    query.mockResolvedValue([{ aberta: false }]);
    expect(await envioLivrePermitido("5511900000001")).toBe(false);
  });

  it("Max: janela aberta permite", async () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "");
    query.mockResolvedValue([{ aberta: true }]);
    expect(await envioLivrePermitido("5511900000001")).toBe(true);
  });
});
