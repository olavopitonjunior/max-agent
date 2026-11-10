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

  it("máscaras de documento ficam intactas (CPF e CNPJ mascarados)", () => {
    expect(paraFormatoWhatsapp("CPF ***.***.789-01")).toBe("CPF ***.***.789-01");
    expect(paraFormatoWhatsapp("CPF ***.456.789-**")).toBe("CPF ***.456.789-**");
    expect(paraFormatoWhatsapp("CNPJ **.***.***/0001-**")).toBe("CNPJ **.***.***/0001-**");
    expect(paraFormatoWhatsapp("**João** CPF ***.***.789-01, **ok**")).toBe("*João* CPF ***.***.789-01, *ok*");
  });

  it("potência e asteriscos colados em palavra ficam como estão", () => {
    expect(paraFormatoWhatsapp("2**3 e 2**10")).toBe("2**3 e 2**10");
  });

  it("URL com ** no caminho não é reescrita", () => {
    expect(paraFormatoWhatsapp("veja https://x.com/a**b**c")).toBe("veja https://x.com/a**b**c");
  });
});
