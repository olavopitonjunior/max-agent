import { describe, expect, it } from "vitest";
import { filtrarPorNomes, lerOnly } from "@/lib/templates/only";

const CAT = [{ name: "max_a" }, { name: "max_b" }, { name: "max_c" }];

describe("lerOnly", () => {
  it("sem --only: null (sem filtro)", () => {
    expect(lerOnly(["node", "x.ts", "--apply"])).toBeNull();
  });
  it("--only com espaço e lista", () => {
    expect(lerOnly(["--apply", "--only", "max_a, max_c"])).toEqual(["max_a", "max_c"]);
  });
  it("--only=…", () => {
    expect(lerOnly(["--only=max_b"])).toEqual(["max_b"]);
  });
  it("--only sem valor lança (não vira 'sem filtro')", () => {
    expect(() => lerOnly(["--only"])).toThrow(/precisa de nome/);
    expect(() => lerOnly(["--only", "--apply"])).toThrow(/precisa de nome/);
    expect(() => lerOnly(["--only="])).toThrow(/precisa de nome/);
  });
});

describe("filtrarPorNomes", () => {
  it("null devolve o catálogo inteiro", () => {
    expect(filtrarPorNomes(CAT, null).map((d) => d.name)).toEqual(["max_a", "max_b", "max_c"]);
  });
  it("mantém só os pedidos, na ordem do catálogo", () => {
    expect(filtrarPorNomes(CAT, ["max_c", "max_a"]).map((d) => d.name)).toEqual(["max_a", "max_c"]);
  });
  it("nome fora do catálogo lança e nomeia o typo", () => {
    expect(() => filtrarPorNomes(CAT, ["max_a", "max_zz"])).toThrow(/max_zz/);
  });
});
