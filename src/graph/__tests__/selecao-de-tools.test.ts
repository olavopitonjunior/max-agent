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

// ── 4. AS LEITURAS DO 6b (2026-09-22) ──────────────────────────────────────

describe("pendências e propostas", () => {
  const TODAS: Capability[] = ["deal.list", "deal.detail", "deal.pending", "proposal.list", "proposal.detail"];
  const nomes = (policy: Capability[], texto: string) =>
    selecionarTools({ policy, texto }).tools.map((t) => t.def.name);

  /** Regra 3: o negado antes do permitido — cada tool só com a SUA capability. */
  it("cada tool nova exige a própria capability", () => {
    expect(nomes(["deal.list", "proposal.list"], "o que está pendente?")).not.toContain("pendencias_do_negocio");
    expect(nomes(["deal.list", "deal.pending"], "como estão minhas propostas?")).not.toContain("listar_propostas");
    expect(nomes(["deal.pending"], "o que está pendente?")).toEqual(["pendencias_do_negocio"]);
    expect(nomes(["proposal.list"], "como estão minhas propostas?")).toEqual(["listar_propostas"]);
  });

  /**
   * O corretor comissionado recebe `deal.list` + `deal.pending` pelo padrão —
   * e a pergunta típica dele não aponta negócio nenhum.
   */
  it("o que o corretor comissionado pergunta chega à tool certa", () => {
    expect(nomes(["deal.list", "deal.pending"], "falta alguma coisa nos meus negócios?")).toEqual([
      "listar_negocios",
      "pendencias_do_negocio",
    ]);
  });

  /**
   * Regressão do prefiltro: `normalizar` tira o acento, e `\bcertid\b` nunca
   * casava "certidao"; `\bdocumento\b` não casava o plural. As duas perguntas
   * mais comuns sobre pendência passavam direto pelo filtro.
   */
  it("certidão sem acento e documentos no plural passam o prefiltro", () => {
    for (const texto of ["cadê a certidão?", "saiu a certidao?", "me manda os documentos"]) {
      expect(nomes(TODAS, texto), texto).toContain("pendencias_do_negocio");
      expect(nomes(TODAS, texto), texto).toContain("listar_negocios");
    }
  });

  it("pergunta que não é sobre isso não oferece nada", () => {
    expect(nomes(TODAS, "bom dia, tudo bem?")).toEqual([]);
    expect(nomes(TODAS, "qual o endereço da imobiliária?")).toEqual([]);
  });

  /**
   * Com as leituras todas concedidas o catálogo ainda cabe no teto: o corte
   * por prioridade não age, e `propor_criacao` (fora deste catálogo) não
   * compete por vaga — ela é oferecida à parte, por `podeEscrever`.
   */
  it("todas concedidas e todas pedidas: cabe no teto, nada cortado", () => {
    const r = selecionarTools({
      policy: TODAS,
      texto: "como estão meus negócios, o que falta e as propostas?",
    });
    expect(r.cortadas).toBe(0);
    expect(r.tools.map((t) => t.def.name)).toEqual([
      "listar_negocios",
      "pendencias_do_negocio",
      "listar_propostas",
    ]);
    expect(r.tools.length).toBeLessThanOrEqual(TETO_DE_TOOLS);
    expect(r.tools.map((t) => t.def.name)).not.toContain(TOOL_PROPOR_FORM);
  });

  /** O sanitizador de saída só barra nome de tool que ele conhece. */
  it("todo nome de tool de leitura está no sanitizador", async () => {
    const { NOMES_DE_TOOL } = await import("../tools");
    for (const t of TOOLS_DE_LEITURA) expect(NOMES_DE_TOOL).toContain(t.def.name);
  });
});

describe("criar proposta não é listar proposta", () => {
  /**
   * Medido na eval: com `listar_propostas` oferecida ao lado, o nano deixava
   * de propor a criação (recall da `propor_criacao` 93% → 33%). Em pedido de
   * criação a listagem fica FORA do turn.
   */
  it("pedido de criação não oferece listar_propostas", () => {
    for (const texto of [
      "cria uma proposta pro Carlos",
      "monta um rascunho de proposta pra esse cliente",
      "abre uma proposta nova aí",
      "faz uma proposta de aluguel pro apartamento do centro",
      "gera a proposta do João",
    ]) {
      const r = selecionarTools({ policy: ["proposal.list"], texto });
      expect(r.tools.map((t) => t.def.name), texto).not.toContain("listar_propostas");
    }
  });

  /** "rascunho" sozinho é consulta: fica fora do regex de criação de propósito. */
  it("consulta sobre propostas continua oferecendo a listagem", () => {
    for (const texto of [
      "quantas propostas eu tenho em rascunho?",
      "a proposta do Carlos foi aceita?",
      "como estão minhas propostas?",
    ]) {
      const r = selecionarTools({ policy: ["proposal.list"], texto });
      expect(r.tools.map((t) => t.def.name), texto).toContain("listar_propostas");
    }
  });
});
