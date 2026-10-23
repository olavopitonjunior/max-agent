import { afterEach, describe, expect, it, vi } from "vitest";
import { limitarTamanho, SUFIXO_RESTO, TETO_LINHAS_NEWTON, tetoDeLinhas } from "../compose";

const lista = (n: number) =>
  ["6 negócios, 5 em andamento:", ...Array.from({ length: n }, (_, i) => `${i + 1}) Negócio ${i + 1} — Contrato`)].join("\n");

afterEach(() => vi.unstubAllEnvs());

describe("teto de linhas por perfil", () => {
  it("Max: 6 linhas, lista de 6 itens é cortada", () => {
    expect(tetoDeLinhas()).toBe(6);
    const r = limitarTamanho(lista(6));
    expect(r.resto).not.toBeNull();
    expect(r.texto.endsWith(SUFIXO_RESTO)).toBe(true);
  });

  it("Newton: cabeçalho + 10 itens cabem inteiros", () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    expect(tetoDeLinhas()).toBe(TETO_LINHAS_NEWTON);
    const texto = lista(10);
    expect(limitarTamanho(texto)).toEqual({ texto, resto: null });
  });

  it("Newton: passou de 12 linhas, corta e oferece o resto", () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    const r = limitarTamanho(lista(12));
    expect(r.texto.split("\n")).toHaveLength(TETO_LINHAS_NEWTON);
    expect(r.texto.endsWith(SUFIXO_RESTO)).toBe(true);
    expect(r.resto).toContain("12) Negócio 12");
  });

  it("Newton: o teto de caracteres continua 500", () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    const longa = Array.from({ length: 8 }, (_, i) => `${i + 1}) ${"Apartamento com documentação pendente ".repeat(2)}`).join("\n");
    const r = limitarTamanho(longa);
    expect(r.texto.length).toBeLessThanOrEqual(500);
    expect(r.resto).not.toBeNull();
  });
});
