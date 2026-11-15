import { describe, expect, it, vi } from "vitest";
import { agendarFicha, cancelarFicha, chaveDaFicha, PAUSA_DA_FICHA_MS, type DepsDaPausa } from "../pausa";

/** Uma fila em memória com a mesma regra do outbox: chave única, cancelar derruba só o pendente. */
function filaFalsa() {
  const pendentes = new Map<string, { quando: Date; texto: string }>();
  const deps: DepsDaPausa = {
    agendar: vi.fn(async (p) => {
      if (pendentes.has(p.dedupeKey)) return;
      pendentes.set(p.dedupeKey, { quando: p.quando, texto: p.texto });
    }),
    cancelar: vi.fn(async (prefixo) => {
      for (const k of [...pendentes.keys()]) if (k.startsWith(prefixo)) pendentes.delete(k);
    }),
  };
  return { deps, pendentes };
}

describe("chaveDaFicha", () => {
  it("é ficha:<subjectKey>", () => {
    expect(chaveDaFicha("org1|user1")).toBe("ficha:org1|user1");
  });
});

describe("agendarFicha", () => {
  it("agenda para ultimaEntradaEm + 20 s", async () => {
    const { deps, pendentes } = filaFalsa();
    await agendarFicha(deps, { subjectKey: "s", ultimaEntradaEm: 1_000, texto: "ficha 1" });
    const [item] = [...pendentes.values()];
    expect(item!.quando.getTime()).toBe(1_000 + PAUSA_DA_FICHA_MS);
  });

  it("três mensagens em 10 s: uma ficha só (cada mensagem cancela a anterior)", async () => {
    const { deps, pendentes } = filaFalsa();
    await agendarFicha(deps, { subjectKey: "s", ultimaEntradaEm: 1_000, texto: "ficha 1" });
    await agendarFicha(deps, { subjectKey: "s", ultimaEntradaEm: 5_000, texto: "ficha 2" });
    await agendarFicha(deps, { subjectKey: "s", ultimaEntradaEm: 10_000, texto: "ficha 3" });
    expect(pendentes.size).toBe(1);
    const [item] = [...pendentes.values()];
    expect(item!.texto).toBe("ficha 3");
    expect(item!.quando.getTime()).toBe(10_000 + PAUSA_DA_FICHA_MS);
  });

  it("outro corretor não cancela a ficha do primeiro", async () => {
    const { deps, pendentes } = filaFalsa();
    await agendarFicha(deps, { subjectKey: "a", ultimaEntradaEm: 1_000, texto: "A" });
    await agendarFicha(deps, { subjectKey: "b", ultimaEntradaEm: 2_000, texto: "B" });
    expect(pendentes.size).toBe(2);
  });

  it("subjectKey que é prefixo de outra não cancela a alheia", async () => {
    const { deps, pendentes } = filaFalsa();
    await agendarFicha(deps, { subjectKey: "org1|u1", ultimaEntradaEm: 1_000, texto: "A" });
    await agendarFicha(deps, { subjectKey: "org1|u10", ultimaEntradaEm: 2_000, texto: "B" });
    expect(pendentes.size).toBe(2);
  });

  it("falha da fila nunca derruba o turno (devolve false)", async () => {
    const deps: DepsDaPausa = {
      agendar: vi.fn(async () => {
        throw new Error("db fora");
      }),
      cancelar: vi.fn(async () => undefined),
    };
    await expect(agendarFicha(deps, { subjectKey: "s", ultimaEntradaEm: 1, texto: "x" })).resolves.toBe(false);
  });
});

describe("cancelarFicha", () => {
  it("fluxo que acabou (cancela, enviou, expirou) derruba a ficha pendente", async () => {
    const { deps, pendentes } = filaFalsa();
    await agendarFicha(deps, { subjectKey: "s", ultimaEntradaEm: 1_000, texto: "x" });
    await cancelarFicha(deps, "s");
    expect(pendentes.size).toBe(0);
  });
});
