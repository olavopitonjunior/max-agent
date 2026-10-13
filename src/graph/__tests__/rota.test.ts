import { describe, expect, it } from "vitest";
import { rotaDoTurn } from "../rota";

const caminho = (...nos: string[]) => nos.map((no) => ({ no, ms: 1 }));
const fluxo = (kind: string) => ({ name: "fluxo", args: { kind }, outcome: "ok" });

describe("rotaDoTurn", () => {
  it("halt vence tudo", () => {
    expect(rotaDoTurn(caminho("gate", "compose"), [], "deny_list")).toBe("halt");
  });

  it("o modelo respondeu (com ou sem tools)", () => {
    expect(rotaDoTurn(caminho("gate", "continuar", "conduzir", "confirm", "retrieve", "answer", "compose"), [])).toBe("modelo");
    expect(
      rotaDoTurn(caminho("gate", "continuar", "conduzir", "confirm", "retrieve", "answer", "tools", "answer", "compose"), [
        { name: "listar_negocios", args: {}, outcome: "ok" },
      ])
    ).toBe("modelo");
  });

  it("fluxo que liberou para o modelo conta como modelo, não como fluxo", () => {
    expect(
      rotaDoTurn(caminho("gate", "continuar", "conduzir", "confirm", "retrieve", "answer", "compose"), [fluxo("proposta")])
    ).toBe("modelo");
  });

  it("fluxo determinístico respondeu: leva o kind", () => {
    expect(rotaDoTurn(caminho("gate", "continuar", "conduzir", "compose"), [fluxo("consulta")])).toBe("fluxo:consulta");
    expect(rotaDoTurn(caminho("gate", "continuar", "conduzir", "compose"), [])).toBe("fluxo");
  });

  it("confirmação de escrita e continuação", () => {
    expect(rotaDoTurn(caminho("gate", "continuar", "conduzir", "confirm", "compose"), [])).toBe("confirmacao");
    expect(rotaDoTurn(caminho("gate", "continuar", "compose"), [])).toBe("continuar");
  });

  it("sem caminho, sem rota", () => {
    expect(rotaDoTurn([], [])).toBeNull();
  });
});
