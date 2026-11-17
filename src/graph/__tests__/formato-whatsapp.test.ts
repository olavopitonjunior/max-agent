import { describe, it, expect } from "vitest";
import { paraWhatsApp } from "../compose";

/**
 * Bug 2 (prod 16/11): o modelo escreve markdown (`**1**`, `**certidões pendentes**`) e o WhatsApp mostra os
 * asteriscos crus. Negrito de WhatsApp é `*x*`, itálico `_x_`. Um passo determinístico, no único ponto
 * por onde o texto do modelo sai (`compose`), troca a sintaxe sem tocar no que já é WhatsApp.
 */
describe("paraWhatsApp", () => {
  it("**x** vira *x* (as strings reais de prod)", () => {
    expect(paraWhatsApp("Negócio **1** tem **certidões pendentes**.")).toBe("Negócio *1* tem *certidões pendentes*.");
  });

  it("__x__ vira _x_", () => {
    expect(paraWhatsApp("Isto é __importante__ mesmo.")).toBe("Isto é _importante_ mesmo.");
  });

  it("tira o marcador de título no começo da linha", () => {
    expect(paraWhatsApp("# Resumo\n## Pendências\nTudo certo.")).toBe("Resumo\nPendências\nTudo certo.");
    expect(paraWhatsApp("### Item")).toBe("Item");
  });

  it("não toca no `*x*` simples nem no `_x_` que já é WhatsApp", () => {
    const t = "Mande *FIM* ou _depois_; 2 * 3 e a*b ficam.";
    expect(paraWhatsApp(t)).toBe(t);
  });

  it("não mexe em `#` no meio da linha nem em id com `__` colado em palavra", () => {
    expect(paraWhatsApp("Negócio #123 e snake__case__nome")).toBe("Negócio #123 e snake__case__nome");
  });

  it("negrito com vários trechos na mesma linha e em linhas diferentes", () => {
    expect(paraWhatsApp("**a** e **b**\n• **c**: ok")).toBe("*a* e *b*\n• *c*: ok");
  });

  it("**** vazio e asteriscos soltos não viram nada estranho", () => {
    expect(paraWhatsApp("**** e ** solto")).toBe("**** e ** solto");
  });
});
