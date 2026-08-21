import { describe, it, expect } from "vitest";
import { conversationKey, maskPhone, normalizeBrPhone } from "../phone";

/**
 * `maskPhone` existe porque log da Vercel é retido fora do nosso controle de
 * acesso — telefone completo ali é PII vazando. Os 4 finais bastam para
 * correlacionar com a linha da fila.
 */
describe("maskPhone", () => {
  it("mantém DDI+DDD e os 4 finais", () => {
    expect(maskPhone("5511987654321")).toBe("5511***4321");
    expect(maskPhone("+5511987654321")).toBe("5511***4321");
  });

  it("curto demais vira só asteriscos — nada a correlacionar", () => {
    expect(maskPhone("123456")).toBe("***");
    expect(maskPhone("")).toBe("***");
  });

  it("7-8 dígitos também: prefixo+sufixo devolveria o número quase inteiro", () => {
    expect(maskPhone("12345678")).toBe("***");
    expect(maskPhone("1234567")).toBe("***");
  });
});

describe("normalizeBrPhone", () => {
  it("normaliza com e sem DDI", () => {
    expect(normalizeBrPhone("5511987654321")).toBe("+5511987654321");
    expect(normalizeBrPhone("(11) 98765-4321")).toBe("+5511987654321");
    expect(normalizeBrPhone("123")).toBeNull();
  });
});

/**
 * O bug que esta função corrige aconteceu de verdade, em 21/08, no primeiro dia
 * de conversa em produção: a mesma pessoa apareceu em DUAS threads e DUAS
 * memórias porque o webhook da Z-API entrega `5511…` e um chamador que
 * normalizava antes entregava `+5511…`. Nada falhou, nada logou — só existiam
 * dois Olavos.
 *
 * Por isso o teste central aqui não é "formata certo", é **"formas diferentes
 * da mesma pessoa colapsam na mesma chave"**.
 */
describe("conversationKey", () => {
  it("toda forma de escrever o mesmo número dá a MESMA chave", () => {
    const esperado = "5511987654321";
    for (const forma of [
      "5511987654321",
      "+5511987654321",
      "11987654321",
      "(11) 98765-4321",
      " +55 11 98765-4321 ",
    ]) {
      expect(conversationKey(forma)).toBe(esperado);
    }
  });

  it("números diferentes continuam diferentes", () => {
    expect(conversationKey("+5511987654321")).not.toBe(
      conversationKey("+5511987654322")
    );
  });

  it("é a mesma forma que a Z-API entrega — a semeadura depende disso", () => {
    // `outbox.phone` e `inbound_queue.from_phone` são gravados sem "+". Se a
    // chave divergisse, `seedNotification` semearia uma thread que a conversa
    // nunca lê — a falha mais silenciosa possível.
    expect(conversationKey("+5511987654321")).toBe("5511987654321");
  });

  it("número que não normaliza vira dígitos crus, nunca vazio", () => {
    // Determinismo importa mais que formato: um número que o
    // `normalizeBrPhone` recusa não resolve identidade e não chega a abrir
    // thread — mas a chave ainda não pode colidir entre pessoas diferentes,
    // nem virar string vazia (que colidiria com TODOS eles).
    expect(conversationKey("+44 20 7946 0958")).toBe("442079460958");
    expect(conversationKey("")).toBe("");
  });

  /**
   * Comportamento HERDADO do `normalizeBrPhone`, documentado aqui porque
   * surpreende: um número estrangeiro de 11 dígitos tem o mesmo comprimento de
   * um celular BR, então ele é adotado como brasileiro e ganha `55` na frente.
   *
   * Não é bug desta função e não afeta o que ela promete — a chave continua
   * determinística e distinta por número. Fica registrado para quem investigar
   * "por que o telefone do gringo virou DDD 14": o lugar é `normalizeBrPhone`,
   * não aqui.
   */
  it("estrangeiro de 11 dígitos é indistinguível de celular BR (herdado)", () => {
    expect(conversationKey("+1 415 555 0100")).toBe("5514155550100");
  });
});
