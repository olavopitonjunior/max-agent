import { describe, expect, it } from "vitest";
import { paraFormatoWhatsapp } from "../whatsapp-formato";

describe("paraFormatoWhatsapp", () => {
  it("**x** vira *x*", () => {
    expect(paraFormatoWhatsapp("O **TESTE assinatura 2** está em **Formulário**.")).toBe("O *TESTE assinatura 2* está em *Formulário*.");
  });

  it("não mexe em *x* (já é WhatsApp), lista, asterisco solto nem texto sem asterisco", () => {
    const original = "*já negrito*\n* item com asterisco\n2 * 3 = 6\ntexto normal";
    expect(paraFormatoWhatsapp(original)).toBe(original);
  });

  it("não atravessa linhas nem junta pares distintos", () => {
    expect(paraFormatoWhatsapp("**a\nb**")).toBe("**a\nb**");
    expect(paraFormatoWhatsapp("**a** e **b**")).toBe("*a* e *b*");
  });

  it("par vazio ou com espaço colado fica como está", () => {
    expect(paraFormatoWhatsapp("**** e ** x **")).toBe("**** e ** x **");
  });

  it("a URL ao lado do negrito segue igual", () => {
    expect(paraFormatoWhatsapp("**Link:** https://imobpro.ia.br/f/abc/joao")).toBe("*Link:* https://imobpro.ia.br/f/abc/joao");
  });
});
