import { describe, it, expect } from "vitest";
import { corrigirVocativo } from "../compose";
import { buildSystemPrompt } from "../prompt";

/**
 * Prod 10/11/2026 (Max Fincasa, Olavo): "Perfeito, João" — João da Silva era o
 * cliente de um negócio, não quem escreve.
 */
const OLAVO = { nomeDaPessoa: "Olavo Piton", contexto: "TESTE assinatura 4 João da Silva comprador" };

describe("corrigirVocativo", () => {
  it('"Perfeito, João, ..." para o Olavo perde o nome do cliente', () => {
    expect(corrigirVocativo("Perfeito, João, enviei o formulário.", OLAVO)).toBe("Perfeito, enviei o formulário.");
    expect(corrigirVocativo("Perfeito, João! Segue o link.", OLAVO)).toBe("Perfeito! Segue o link.");
    expect(corrigirVocativo("Certo, João. Abri o negócio.", OLAVO)).toBe("Certo. Abri o negócio.");
  });

  it("interjeição + nome que está no contexto do turno (outro nome, não o dela) perde o nome", () => {
    expect(corrigirVocativo("Beleza, Carlos, já vi aqui.", { nomeDaPessoa: "Olavo", contexto: "o comprador Carlos Souza" })).toBe("Beleza, já vi aqui.");
  });

  it('interjeição + palavra que não é nome de ninguém do turno fica ("Ok, Feito!")', () => {
    expect(corrigirVocativo("Ok, Feito! Abri o formulário.", { nomeDaPessoa: "Olavo", contexto: "" })).toBe("Ok, Feito! Abri o formulário.");
    expect(corrigirVocativo("Beleza, Carlos, já vi aqui.", { nomeDaPessoa: "Olavo", contexto: "" })).toBe("Beleza, Carlos, já vi aqui.");
    expect(corrigirVocativo("Pronto, Enviado. Confere aí.", OLAVO)).toBe("Pronto, Enviado. Confere aí.");
    // a palavra aparece no contexto, mas em minúscula (não é nome de ninguém)
    expect(corrigirVocativo("Ok, Feito! Abri.", { nomeDaPessoa: "Olavo", contexto: "já está feito?" })).toBe("Ok, Feito! Abri.");
  });

  it('"João, não consigo..." (nome de cliente do contexto) perde o vocativo e capitaliza', () => {
    expect(corrigirVocativo("João, não consigo mostrar pendências por aqui.", OLAVO)).toBe("Não consigo mostrar pendências por aqui.");
  });

  it("o nome DA PESSOA fica (primeiro nome ou sobrenome, com ou sem acento)", () => {
    expect(corrigirVocativo("Perfeito, Olavo, enviei.", OLAVO)).toBe("Perfeito, Olavo, enviei.");
    expect(corrigirVocativo("Olavo, não achei esse negócio.", OLAVO)).toBe("Olavo, não achei esse negócio.");
    expect(corrigirVocativo("Perfeito, José, feito.", { nomeDaPessoa: "José Silva", contexto: "José" })).toBe("Perfeito, José, feito.");
    expect(corrigirVocativo("Perfeito, Jose, feito.", { nomeDaPessoa: "José Silva", contexto: "" })).toBe("Perfeito, Jose, feito.");
  });

  it("palavra de conversa não é nome", () => {
    for (const t of [
      "Infelizmente, não consigo ver isso.",
      "Resumindo, são 3 pendências.",
      "Primeiro, preciso do CPF.",
      "Sim, o formulário foi enviado.",
      "Então, vamos ao próximo passo.",
    ]) {
      expect(corrigirVocativo(t, { nomeDaPessoa: "Olavo", contexto: "infelizmente resumindo primeiro sim então" })).toBe(t);
    }
  });

  it("palavra capitalizada que não é nome de ninguém do turno fica", () => {
    expect(corrigirVocativo("Atenção, o prazo vence hoje.", OLAVO)).toBe("Atenção, o prazo vence hoje.");
    expect(corrigirVocativo("Fincasa, não é isso.", OLAVO)).toBe("Fincasa, não é isso.");
  });

  it("sem nome conhecido da pessoa não mexe (não há como saber)", () => {
    expect(corrigirVocativo("Perfeito, João, feito.", { nomeDaPessoa: null, contexto: "João" })).toBe("Perfeito, João, feito.");
  });

  it("só a abertura: nome no meio do texto não é tocado", () => {
    const t = "Perfeito. O comprador é João da Silva, e o contato é do João.";
    expect(corrigirVocativo(t, OLAVO)).toBe(t);
  });
});

describe("prompt: quem é a pessoa", () => {
  it("manda tratar só pelo nome do cadastro e diz que os outros são de terceiros", () => {
    const p = buildSystemPrompt({ orgName: "FINCasa", userName: "Olavo", hits: [] }).replace(/\s+/g, " ");
    expect(p).toContain("Trate a pessoa só por esse nome");
    expect(p).toContain("são de clientes ou de terceiros");
  });
});
