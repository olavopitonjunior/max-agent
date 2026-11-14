import { describe, it, expect } from "vitest";
import { VERBOS_DE_ACAO, timeoutDoVerbo } from "../acao";
import { catalog } from "../runtime/catalog";

/**
 * Paridade da lista literal de verbos com o contractmaker (CLAUDE.md do CM, regra 1
 * do Max): o vetor abaixo é o MESMO em
 * `apps/web/src/lib/max/__tests__/verbos-proposta-paridade.test.ts` do contractmaker.
 * Mexer num lado sem o outro quebra um dos dois.
 *
 * `proposal.send_owner` (plano 14/11/2026) entra logo APÓS `proposal.remind` e
 * antes de `proposal.recreate`, nos dois lados.
 */
const TRECHO_FIXO = ["proposal.remind", "proposal.send_owner", "proposal.recreate"] as const;

describe("paridade do verbo proposal.send_owner com o contractmaker", () => {
  it("a lista literal tem o verbo na posição combinada (remind, send_owner, recreate, contíguos)", () => {
    const lista: readonly string[] = VERBOS_DE_ACAO;
    const i = lista.indexOf("proposal.remind");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(lista.slice(i, i + TRECHO_FIXO.length)).toEqual([...TRECHO_FIXO]);
  });

  it("o verbo aparece UMA vez e reusa a capability proposal.send (sem capability nova)", () => {
    expect(VERBOS_DE_ACAO.filter((v) => v === "proposal.send_owner")).toHaveLength(1);
    const ferramenta = catalog().tools.find((t) => t.id === "proposal.send_owner");
    expect(ferramenta).toMatchObject({
      executor: "scope-action", effect: "write", confirmation: true, policyCapability: "proposal.send", permission: "proposal.send",
      domainScope: expect.stringContaining("PROPOSAL_SEND"),
    });
  });

  it("espera como o envio (cria envelope na ClickSign), não o teto comum", () => {
    expect(timeoutDoVerbo("proposal.send_owner")).toBe(timeoutDoVerbo("proposal.send"));
  });
});
