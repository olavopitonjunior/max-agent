import { afterEach, describe, expect, it } from "vitest";
import { type Sessao, verificarTransversais } from "./harness";
import { rodarConversa } from "./rodar-conversa";
import { CONVERSAS_MASCARADAS, type RascunhoFinalEsperado } from "../../../../../scripts/fixtures/formularios-v2/conversas-mascaradas";

/**
 * Conversas reais do golden set (Max e Newton), mascaradas. Cada uma roda pelo grafo real com o modelo e o
 * servidor simulados; as transversais T1-T4 valem em todas.
 */
function confereRascunho(s: Sessao, esperado: RascunhoFinalEsperado | undefined): void {
  if (!esperado) return;
  const r = s.servidor.rascunho;
  expect(r, "o rascunho final existe no servidor").not.toBeNull();
  for (const campo of ["compradores", "vendedores", "imovel", "negociacao"] as const) {
    if (esperado[campo]) expect(r![campo], campo).toMatchObject(esperado[campo] as never);
  }
}

describe("eval fv2: conversas reais mascaradas", () => {
  let s: Sessao | undefined;
  afterEach(async () => {
    if (s) await verificarTransversais(s);
    s = undefined;
  });

  it.each(CONVERSAS_MASCARADAS.map((c) => [c.id, c] as const))("%s", async (_id, conversa) => {
    s = await rodarConversa(conversa);
    confereRascunho(s, conversa.rascunhoFinal);
  });

  it("cobre Max e Newton, com pelo menos 5 conversas", () => {
    expect(CONVERSAS_MASCARADAS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(CONVERSAS_MASCARADAS.map((c) => c.bot))).toEqual(new Set(["max", "newton"]));
  });
});
