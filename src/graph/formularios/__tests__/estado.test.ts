import { describe, expect, it } from "vitest";
import { contarEntradaDoFluxo, novoFluxoV2 } from "../estado";

describe("marco de abertura do fluxo (I3)", () => {
  it("o fluxo nasce sem mensagens anteriores: a que o abriu é a atual", () => {
    expect(novoFluxoV2({ esteira: "venda", agora: 1 }).mensagensDoFluxo).toBe(0);
  });

  it("cada turno tratado conta uma entrada; checkpoint antigo (sem o campo) começa em 0", () => {
    const f = novoFluxoV2({ esteira: "venda", agora: 1 });
    expect(contarEntradaDoFluxo(contarEntradaDoFluxo(f)).mensagensDoFluxo).toBe(2);
    const { mensagensDoFluxo: _omitido, ...antigo } = f;
    expect(contarEntradaDoFluxo(antigo).mensagensDoFluxo).toBe(1);
  });

  it("o marco é só um número: nada de texto de mensagem no checkpoint", () => {
    const f = contarEntradaDoFluxo(novoFluxoV2({ esteira: "venda", agora: 1 }));
    expect(typeof f.mensagensDoFluxo).toBe("number");
  });
});
