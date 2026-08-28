import { describe, it, expect } from "vitest";
import {
  selecionarTools,
  TOOLS_DE_LEITURA,
  TETO_DE_TOOLS,
  LISTAR_NEGOCIOS,
  TOOL_PROPOR_FORM,
  type ToolDef,
} from "../tools";
import type { Capability } from "../policy";

/**
 * A seleção de tools de LEITURA — `catálogo ∩ capabilities ∩ prefiltro`.
 *
 * O que este arquivo protege, em ordem de gravidade:
 *  1. tool de leitura NÃO aparece sem a capability (regra 3: nasce desligada);
 *  2. `propor_criacao` NÃO passa por aqui — gateá-la hoje seria regressão;
 *  3. o teto de 5 corta por prioridade e o corte é contável, não silencioso.
 */

const TEXTO_PEDE = "como estão meus negócios?";
const TEXTO_NAO_PEDE = "bom dia, tudo bem?";

// ── 1. O NEGADO ANTES DO PERMITIDO (regra 3) ───────────────────────────────

describe("capability ausente = tool ausente", () => {
  it("sem capability nenhuma, nada é oferecido — nem com o texto certo", () => {
    expect(selecionarTools({ policy: [], texto: TEXTO_PEDE }).tools).toEqual([]);
  });

  it("com OUTRA capability, a tool de deal.list continua fora", () => {
    const policy: Capability[] = ["proposal.list", "form.create"];
    expect(selecionarTools({ policy, texto: TEXTO_PEDE }).tools).toEqual([]);
  });

  it("com a capability certa E o texto certo, entra", () => {
    const r = selecionarTools({ policy: ["deal.list"], texto: TEXTO_PEDE });
    expect(r.tools.map((t) => t.def.name)).toEqual(["listar_negocios"]);
  });

  it("capability certa mas texto que não pede: fora — o prefiltro corta", () => {
    expect(
      selecionarTools({ policy: ["deal.list"], texto: TEXTO_NAO_PEDE }).tools
    ).toEqual([]);
  });
});

// ── 2. A REGRESSÃO QUE ESTE PR NÃO PODE CAUSAR ─────────────────────────────

describe("propor_criacao fica FORA desta seleção", () => {
  /**
   * Ela é oferecida por `podeEscrever && shouldOfferTools`, sem política.
   * Gateá-la agora a faria exigir `form.create`, que nenhuma org concede — o
   * Max pararia de propor formulário em produção, em silêncio. É o cenário que
   * a mensagem do PR 4 chama de "regressão, não inércia".
   *
   * O gate dela é do PR 6c, junto do editor. Este teste existe para que
   * ninguém a "conserte" para dentro daqui antes disso.
   */
  it("não está no catálogo de leitura", () => {
    expect(TOOLS_DE_LEITURA.map((t) => t.def.name)).not.toContain(TOOL_PROPOR_FORM);
  });

  it("nem com form.create concedida ela aparece na seleção de leitura", () => {
    const r = selecionarTools({
      policy: ["form.create", "deal.list"],
      texto: "me manda o link do formulário",
    });
    expect(r.tools.map((t) => t.def.name)).not.toContain(TOOL_PROPOR_FORM);
  });
});

// ── 3. O TETO ──────────────────────────────────────────────────────────────

describe("teto de 5 definições", () => {
  function falsa(n: number, cap: Capability, prio: number): ToolDef {
    return { ...LISTAR_NEGOCIOS, capability: cap, prioridade: prio,
      def: { ...LISTAR_NEGOCIOS.def, name: `falsa_${n}` } };
  }
  const caps: Capability[] = [
    "deal.list", "deal.detail", "deal.pending", "proposal.list",
    "proposal.detail", "form.create", "notify.manual",
  ];
  const catalogo = caps.map((c, i) => falsa(i, c, i));

  it("acima do teto, corta por PRIORIDADE e conta o corte", () => {
    const r = selecionarTools({ policy: caps, texto: TEXTO_PEDE, catalogo });
    expect(r.tools).toHaveLength(TETO_DE_TOOLS);
    // Corte silencioso viraria "a feature não funciona às vezes".
    expect(r.cortadas).toBe(caps.length - TETO_DE_TOOLS);
    // As de MENOR prioridade numérica sobrevivem, na ordem declarada.
    expect(r.tools.map((t) => t.def.name)).toEqual([
      "falsa_0", "falsa_1", "falsa_2", "falsa_3", "falsa_4",
    ]);
  });

  it("dentro do teto, não corta nada", () => {
    const r = selecionarTools({
      policy: caps.slice(0, 3), texto: TEXTO_PEDE, catalogo: catalogo.slice(0, 3),
    });
    expect(r.tools).toHaveLength(3);
    expect(r.cortadas).toBe(0);
  });
});
