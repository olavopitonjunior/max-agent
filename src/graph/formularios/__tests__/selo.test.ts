import { describe, expect, it } from "vitest";
import { abrirCorpo, estaSelado, PREFIXO_DO_SELO, selarCorpo, seloDisponivel } from "../selo";

process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

const AAD = "org1|5511999990000";
const FICHA = "Lido do documento: *Maria Teste da Silva*, CPF ***.456.789-**";

describe("selo da ficha no outbox (I5)", () => {
  it("o corpo selado não contém nenhum valor do texto, e é reconhecido como selado", () => {
    const s = selarCorpo(FICHA, AAD);
    expect(estaSelado(s)).toBe(true);
    expect(s.startsWith(PREFIXO_DO_SELO)).toBe(true);
    expect(s).not.toContain("Maria");
    expect(s).not.toContain("456.789");
    expect(estaSelado(FICHA)).toBe(false);
  });

  it("abre de volta com o mesmo AAD", () => {
    expect(abrirCorpo(selarCorpo(FICHA, AAD), AAD)).toBe(FICHA);
  });

  it("dois selos do mesmo texto diferem (iv aleatório)", () => {
    expect(selarCorpo(FICHA, AAD)).not.toBe(selarCorpo(FICHA, AAD));
  });

  it("negados: outro AAD (outro telefone/org) não abre", () => {
    const s = selarCorpo(FICHA, AAD);
    expect(() => abrirCorpo(s, "org1|5511888880000")).toThrow();
    expect(() => abrirCorpo(s, "org2|5511999990000")).toThrow();
  });

  it("negados: corpo adulterado, truncado ou sem o prefixo não abre", () => {
    const s = selarCorpo(FICHA, AAD);
    expect(() => abrirCorpo(s.slice(0, -4), AAD)).toThrow();
    expect(() => abrirCorpo(PREFIXO_DO_SELO + "a.b", AAD)).toThrow();
    expect(() => abrirCorpo(FICHA, AAD)).toThrow();
  });

  it("sem chave (ou chave de tamanho errado) não sela: lança, e seloDisponivel é false", () => {
    const antes = process.env.MAX_ENCRYPTION_KEY;
    try {
      delete process.env.MAX_ENCRYPTION_KEY;
      expect(seloDisponivel()).toBe(false);
      expect(() => selarCorpo(FICHA, AAD)).toThrow();
      process.env.MAX_ENCRYPTION_KEY = Buffer.alloc(8, 1).toString("base64");
      expect(seloDisponivel()).toBe(false);
      expect(() => selarCorpo(FICHA, AAD)).toThrow();
    } finally {
      process.env.MAX_ENCRYPTION_KEY = antes;
    }
    expect(seloDisponivel()).toBe(true);
  });

  it("chave rotacionada: não abre o que foi selado com a anterior", () => {
    const antes = process.env.MAX_ENCRYPTION_KEY;
    const s = selarCorpo(FICHA, AAD);
    try {
      process.env.MAX_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
      expect(() => abrirCorpo(s, AAD)).toThrow();
    } finally {
      process.env.MAX_ENCRYPTION_KEY = antes;
    }
  });
});
