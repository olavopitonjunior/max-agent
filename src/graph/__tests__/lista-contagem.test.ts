import { describe, expect, it } from "vitest";
import { fenceToolResults } from "../prompt";
import { corrigirContagemMostrada, linhasListadas } from "../lista-contagem";

const item = (n: number, extra = "") => ({ n, title: `Atividade ${n}`, descricao: extra });

describe("contagem da lista que o modelo recebe", () => {
  it("página completa e com mais: declara mostrados e total desconhecido, e manda citar só esses números", () => {
    const f = fenceToolResults([
      { tool: "listar_atividades", items: [1, 2, 3, 4, 5].map((n) => item(n)), truncated: true, hasMore: true },
    ]);
    expect(f).toContain('mostrados="5"');
    expect(f).toContain('total="desconhecido"');
    expect(f).toContain('ha_mais="true"');
    // Prod 26/11: o modelo repetiu o rótulo ("*mostrando 5*") na resposta. A instrução não oferece mais esse texto.
    expect(f).not.toMatch(/mostrando/i);
    expect(f).toContain("mais de 5");
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

describe("atributos da cerca (já existentes: mostrados = exibidos, total, ha_mais)", () => {
  it("expõe os itens no bloco, total e ha_mais", () => {
    const f = fenceToolResults([
      { tool: "listar_atividades", items: [1, 2, 3, 4, 5].map((n) => item(n)), truncated: true, hasMore: true },
    ]);
    expect(f).toContain('mostrados="5"');
    expect(f).toContain('total="desconhecido"');
    expect(f).toContain('ha_mais="true"');
  });
});

describe("guarda: 'mostrando N' = linhas realmente listadas", () => {
  it("caso de prod: modelo disse 'mostrando 5… há mais' e listou 4", () => {
    const texto = "Mostrando 5 atividades, há mais:\n1. Ligar para Ana\n2. Visita Rua X\n3. Enviar proposta\n4. Cobrar certidão\n\nQuer ver mais?";
    const r = corrigirContagemMostrada(texto);
    expect(r).toContain("Mostrando 4 atividades");
    expect(r).toContain("há mais");
    expect(r).toContain("4. Cobrar certidão");
  });
  it("lista com marcadores", () => {
    expect(corrigirContagemMostrada("Estou mostrando 3:\n• a\n• b")).toBe("Estou mostrando 2:\n• a\n• b");
  });
  it("negativo: contagem já bate, o texto não muda", () => {
    const texto = "Mostrando 3 atividades:\n1. a\n2. b\n3. c";
    expect(corrigirContagemMostrada(texto)).toBe(texto);
  });
  it("negativo: sem lista no texto, não reescreve", () => {
    const texto = "Estou mostrando 5, mas listo depois.";
    expect(corrigirContagemMostrada(texto)).toBe(texto);
  });
  it("não conta subitens recuados", () => {
    expect(linhasListadas("1. a\n   - detalhe\n2. b")).toBe(2);
  });
});
