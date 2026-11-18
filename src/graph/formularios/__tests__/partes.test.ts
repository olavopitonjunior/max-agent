import { describe, expect, it } from "vitest";
import type { OptionsV2 } from "../contrato";
import { contagemDePartes, signatariosPorLado, PAPEL_COMPRADOR, PAPEL_VENDEDOR } from "../partes";

const com = (signatarios: Array<{ nome: string; papel?: string }>) => ({ signatarios }) as unknown as OptionsV2;

describe("partes: uma definição de papel e de contagem (M1)", () => {
  it("sem signatários, a primeira parte de cada lado sempre existe", () => {
    expect(contagemDePartes(com([]))).toEqual({ compradores: 1, vendedores: 1 });
    expect(contagemDePartes({} as OptionsV2)).toEqual({ compradores: 1, vendedores: 1 });
  });

  it("papéis da esteira de locação e de venda caem no lado certo, ignorando caixa e acento", () => {
    const por = signatariosPorLado(
      com([
        { nome: "A", papel: "Comprador" },
        { nome: "B", papel: "locatário" },
        { nome: "C", papel: "VENDEDOR" },
        { nome: "D", papel: "Proprietário" },
      ])
    );
    expect(por.compradores.map((p) => p.nome)).toEqual(["A", "B"]);
    expect(por.vendedores.map((p) => p.nome)).toEqual(["C", "D"]);
  });

  it("papel desconhecido ou ausente não conta (negado)", () => {
    const o = com([{ nome: "X", papel: "testemunha" }, { nome: "Y" }, { nome: "Z", papel: "" }]);
    expect(signatariosPorLado(o)).toEqual({ compradores: [], vendedores: [] });
    expect(contagemDePartes(o)).toEqual({ compradores: 1, vendedores: 1 });
  });

  it("a contagem é o número de signatários do lado (piso), na ordem recebida", () => {
    const o = com([{ nome: "A", papel: "comprador" }, { nome: "B", papel: "comprador" }, { nome: "C", papel: "vendedor" }]);
    expect(contagemDePartes(o)).toEqual({ compradores: 2, vendedores: 1 });
  });

  it("os conjuntos de papel não se cruzam", () => {
    for (const p of PAPEL_COMPRADOR) expect(PAPEL_VENDEDOR.has(p)).toBe(false);
  });
});
