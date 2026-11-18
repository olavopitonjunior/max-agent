import { describe, expect, it } from "vitest";
import { comFalaNoCofre, historicoDoCorretor } from "../../graph";
import { falasDoCofre, guardarFala } from "../midia";
import { novoFluxoV2 } from "../estado";

/**
 * F1 (PII): a fala do corretor na proposta v2 não vai em claro para o checkpoint. O histórico guarda o
 * marcador; o texto vai CIFRADO para `cofreFalas`, de onde a janela de extração o lê.
 */
process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

const THREAD = "org1|5511900000001";
const CPF = "529.982.247-25";

describe("cofre de falas do fluxo v2", () => {
  const f0 = novoFluxoV2({ esteira: "venda", agora: 1 });

  it("a fala volta aberta na mesma thread e nunca aparece em claro no fluxo", () => {
    const f = guardarFala(f0, `comprador Ana CPF ${CPF}`, THREAD);
    expect(JSON.stringify(f)).not.toContain("529");
    expect(JSON.stringify(f)).not.toContain("Ana");
    expect(falasDoCofre(f, THREAD)).toEqual([`comprador Ana CPF ${CPF}`]);
  });

  it("NEGADO: outra thread não abre o cofre", () => {
    const f = guardarFala(f0, `CPF ${CPF}`, THREAD);
    expect(falasDoCofre(f, "org1|5511900000002")).toEqual([]);
  });

  it("guarda só as últimas 7 falas, na ordem", () => {
    let f = f0;
    for (let i = 1; i <= 10; i++) f = guardarFala(f, `fala ${i}`, THREAD);
    expect(falasDoCofre(f, THREAD)).toEqual(["fala 4", "fala 5", "fala 6", "fala 7", "fala 8", "fala 9", "fala 10"]);
  });

  it("NEGADO: sem a chave do cofre nada é guardado em claro (a janela fica sem anteriores)", () => {
    const comCofre = guardarFala(f0, "primeira", THREAD);
    const antiga = process.env.MAX_ENCRYPTION_KEY;
    process.env.MAX_ENCRYPTION_KEY = "";
    try {
      const f = guardarFala(comCofre, `CPF ${CPF}`, THREAD);
      expect(f.cofreFalas).toBeUndefined();
      expect(JSON.stringify(f)).not.toContain("529");
    } finally {
      process.env.MAX_ENCRYPTION_KEY = antiga;
    }
  });
});

describe("histórico do corretor por tipo de fluxo", () => {
  it("proposta v2, crédito e captação: só o marcador", () => {
    expect(historicoDoCorretor("proposta_v2", `CPF ${CPF}`)).toBe("(resposta da ficha de proposta)");
    expect(historicoDoCorretor("credito", `CPF ${CPF}`)).toBe("(resposta da ficha de crédito)");
    expect(historicoDoCorretor("captacao", `CPF ${CPF}`)).toBe("(resposta da ficha de captação)");
  });

  it("v1 idêntico (flag OFF): a fala e o fluxo da proposta v1 passam intactos", () => {
    expect(historicoDoCorretor("proposta", "valor 500 mil")).toBe("valor 500 mil");
    const v1 = { kind: "proposta", etapa: "coleta" };
    expect(comFalaNoCofre(v1, "valor 500 mil", THREAD)).toBe(v1);
    expect(comFalaNoCofre(null, "x", THREAD)).toBeNull();
  });
});
