import { describe, it, expect } from "vitest";
import { VERBOS_DE_ACAO } from "../acao";
import { catalog } from "../runtime/catalog";

/**
 * Paridade com o contractmaker (formulários WhatsApp v2 / PR-D, `VERBOS_DE_ACAO` e
 * `VERBOS_DE_ESCRITA` em `apps/web/src/lib/max/scope-action.ts`). Regra 1 da governança do Max:
 * vetor fixo dos dois lados.
 *
 * Os literais abaixo são literais de propósito (copiados do CM no PR3 dos formulários v2): derivar
 * da constante deste lado acompanharia uma divergência em silêncio. A lista inteira NÃO é comparada
 * posição a posição, porque os dois lados já agrupam os verbos de modo diferente (o CM tem os
 * verbos do Google/marketing por spread, este lado os escreve inline). Compara-se o conjunto
 * `proposal.*`, que é o que o PR-D consome, e a adjacência de `proposal.witnesses.set`.
 *
 * Modo de falha que isto previne: o verbo ausente no `z.enum` do CM devolve 400 a TODA chamada do
 * fluxo de testemunhas, e nenhum dos repos quebra sozinho.
 */
const PROPOSAL_DO_CM_NA_ORDEM = [
  "proposal.list",
  "proposal.status",
  "proposal.create",
  "proposal.send",
  "proposal.complete",
  "proposal.cancel",
  "proposal.remind",
  "proposal.recreate",
  "proposal.convert",
  "proposal.update",
  "proposal.witnesses.set",
  "proposal.text.suggest",
  "proposal.text.apply",
  "proposal.options",
  "proposal.preflight",
  "proposal.delete",
  "proposal.duplicate",
];

/** Verbos de escrita do CM (`VERBOS_DE_ESCRITA`) do conjunto `proposal.*`, na ordem do CM. */
const PROPOSAL_ESCRITA_DO_CM = [
  "proposal.complete",
  "proposal.create",
  "proposal.send",
  "proposal.cancel",
  "proposal.remind",
  "proposal.recreate",
  "proposal.convert",
  "proposal.update",
  "proposal.witnesses.set",
  "proposal.text.suggest",
  "proposal.text.apply",
  "proposal.delete",
  "proposal.duplicate",
];

/** O CM tem e este lado ainda não usa (PR4 dos formulários v2): lacuna conhecida, não divergência. */
const SO_NO_CM = ["proposal.text.suggest", "proposal.text.apply"];

const proposalAqui = (VERBOS_DE_ACAO as readonly string[]).filter((v) => v.startsWith("proposal."));

describe("paridade dos verbos de ação com o contractmaker (PR-D)", () => {
  it("todo verbo proposal.* daqui existe no CM (senão o z.enum do CM devolve 400)", () => {
    const naoConhecidos = proposalAqui.filter((v) => !PROPOSAL_DO_CM_NA_ORDEM.includes(v));
    expect(naoConhecidos).toEqual([]);
  });

  it("o conjunto proposal.* é o do CM, menos as lacunas declaradas", () => {
    const esperado = PROPOSAL_DO_CM_NA_ORDEM.filter((v) => !SO_NO_CM.includes(v));
    expect([...proposalAqui].sort()).toEqual([...esperado].sort());
  });

  it("proposal.witnesses.set vem logo depois de proposal.update, nos dois lados", () => {
    const cm = PROPOSAL_DO_CM_NA_ORDEM;
    expect(cm.indexOf("proposal.witnesses.set")).toBe(cm.indexOf("proposal.update") + 1);
    expect(proposalAqui.indexOf("proposal.witnesses.set")).toBe(proposalAqui.indexOf("proposal.update") + 1);
  });

  it("proposal.witnesses.set é escrita no CM: aqui o catálogo a trata como escrita com confirmação, na capability proposal.create", () => {
    expect(PROPOSAL_ESCRITA_DO_CM).toContain("proposal.witnesses.set");
    const t = catalog("org1").tools.find((x) => x.id === "proposal.witnesses.set");
    expect(t?.permission).toBe("proposal.create");
    expect(t?.effect).toBe("write");
    expect(t?.confirmation).toBe(true);
  });

  it("toda escrita proposal.* do CM que existe aqui é escrita no catálogo (nunca leitura disfarçada)", () => {
    const tools = catalog("org1").tools;
    for (const v of PROPOSAL_ESCRITA_DO_CM.filter((x) => proposalAqui.includes(x))) {
      expect(tools.find((t) => t.id === v)?.effect, v).toBe("write");
    }
  });

  it("as leituras proposal.* do CM (fora de VERBOS_DE_ESCRITA) não são escrita aqui", () => {
    const tools = catalog("org1").tools;
    for (const v of ["proposal.list", "proposal.status", "proposal.options", "proposal.preflight"]) {
      expect(PROPOSAL_ESCRITA_DO_CM).not.toContain(v);
      const e = tools.find((t) => t.id === v)?.effect;
      if (e !== undefined) expect(e, v).not.toBe("write");
    }
  });
});
