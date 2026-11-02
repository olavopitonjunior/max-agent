import { describe, expect, it } from "vitest";
import { fenceToolResults } from "../prompt";

const item = (n: number, extra = "") => ({ n, title: `Atividade ${n}`, descricao: extra });

describe("contagem da lista que o modelo recebe", () => {
  it("página completa e com mais: declara mostrados e total desconhecido, e manda citar só esses números", () => {
    const f = fenceToolResults([
      { tool: "listar_atividades", items: [1, 2, 3, 4, 5].map((n) => item(n)), truncated: true, hasMore: true },
    ]);
    expect(f).toContain('mostrados="5"');
    expect(f).toContain('total="desconhecido"');
    expect(f).toContain('ha_mais="true"');
    expect(f).toMatch(/mostrando 5/);
  });

  it("total == página: mostrados e total iguais, sem 'há mais'", () => {
    const f = fenceToolResults([
      { tool: "listar_atividades", items: [1, 2, 3].map((n) => item(n)), truncated: false, hasMore: false },
    ]);
    expect(f).toContain('mostrados="3"');
    expect(f).toContain('total="3"');
    expect(f).toContain('ha_mais="false"');
    expect(f).not.toContain('truncado="true"');
  });

  it("corte por tamanho remove item inteiro e mostrados conta só os que aparecem", () => {
    const grande = "x".repeat(1500);
    const f = fenceToolResults([
      { tool: "listar_atividades", items: [1, 2, 3, 4, 5].map((n) => item(n, grande)), truncated: false, hasMore: false },
    ]);
    const mostrados = Number(/mostrados="(\d+)"/.exec(f)?.[1]);
    expect(mostrados).toBeLessThan(5);
    // Cada "n" citado no corpo está inteiro e a contagem bate com eles.
    expect(f.match(/"n": \d+/g)).toHaveLength(mostrados);
    expect(f).toContain('total="desconhecido"');
    expect(f).toContain('ha_mais="true"');
    expect(f).not.toContain('"n": 5,');
  });
});
