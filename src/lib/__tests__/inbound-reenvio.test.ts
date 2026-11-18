import { describe, expect, it, vi } from "vitest";

// inbound.ts importa o grafo e o banco; aqui só importa a função pura do texto de reenvio.
vi.mock("../db", () => ({ query: vi.fn() }));
vi.mock("@/graph/graph", () => ({ runTurn: vi.fn() }));

const { textoDeReenvioSensivel, TEXTO_REENVIO_SENSIVEL, TEXTO_REENVIO_DOCUMENTO } = await import("../inbound");
const { MARCADOR_DOCUMENTO_LIDO } = await import("@/graph/formularios/midia");

describe("texto de reenvio de turno sensível (N3)", () => {
  it("turno de documento lido: a frase manda reenviar o documento ou digitar, sem citar RESUMO nem valor", () => {
    const t = textoDeReenvioSensivel(MARCADOR_DOCUMENTO_LIDO);
    expect(t).toBe(TEXTO_REENVIO_DOCUMENTO);
    expect(t).not.toMatch(/RESUMO/);
    expect(t).toMatch(/documento/i);
    expect(t).toMatch(/digit/i);
  });

  it("turno de crédito (reply_text redigido): segue a frase de sempre, com RESUMO", () => {
    expect(textoDeReenvioSensivel("Anotei: renda ⟨VALOR⟩.")).toBe(TEXTO_REENVIO_SENSIVEL);
    expect(textoDeReenvioSensivel(null)).toBe(TEXTO_REENVIO_SENSIVEL);
    expect(TEXTO_REENVIO_SENSIVEL).toMatch(/RESUMO/);
  });
});
