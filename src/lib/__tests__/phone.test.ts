import { describe, it, expect } from "vitest";
import { maskPhone, normalizeBrPhone } from "../phone";

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
});

describe("normalizeBrPhone", () => {
  it("normaliza com e sem DDI", () => {
    expect(normalizeBrPhone("5511987654321")).toBe("+5511987654321");
    expect(normalizeBrPhone("(11) 98765-4321")).toBe("+5511987654321");
    expect(normalizeBrPhone("123")).toBeNull();
  });
});
