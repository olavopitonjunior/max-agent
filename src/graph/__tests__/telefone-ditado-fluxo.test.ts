import { describe, expect, it, vi } from "vitest";
import { conduzirFluxo, iniciarFluxo, sanearDados, type ContextoDoTurno, type DadosDaProposta, type DepsDoFluxo, type Fluxo } from "../fluxos";
import { conduzirCaptacao, type FluxoCaptacao } from "../captacao";

/**
 * Rodada 3 (reteste de 17/11/2026): o telefone ditado ("11, 9000-0002") chegava cru ao card porque o
 * valor do EXTRATOR entrava no rascunho sem passar por `juntarTelefone`/`telefoneDuvidoso`. Os testes
 * conduzem o fluxo inteiro (mesma função que monta o card), com o extrator dublê devolvendo o valor como
 * o modelo o devolveu em produção: a sequência ditada, crua.
 */

const agora = 1_000_000;
const TUDO = ["proposal.create", "proposal.send", "form.create"] as const;

function deps(extraido: DadosDaProposta): DepsDoFluxo {
  return {
    acao: vi.fn().mockResolvedValue(null),
    extrairProposta: vi.fn().mockResolvedValue(extraido),
    extrairCampos: vi.fn().mockResolvedValue(null),
  };
}

const imovel = { endereco: "Rua Augusta, 500", numero: "500", cidade: "São Paulo", uf: "SP" };
const completo = (telefone: string): DadosDaProposta => ({
  proponente: { nome: "TESTE Newton Ditado", telefone },
  imovel,
  valor: 600000,
  pagamento: { forma: "à vista" },
});

describe("A — primeira mensagem (iniciarFluxo)", () => {
  const pedido =
    "proposta de compra: comprador TESTE Newton Ditado, telefone 11, 9000-0002, imóvel Rua Augusta, 500, São Paulo/SP, valor R$ 600.000 à vista";

  it("telefone de 10 dígitos que não fecha celular: pergunta, não mostra card", async () => {
    const d = deps(completo("11, 9000-0002"));
    const p = await iniciarFluxo({ tipo: "proposta", pedido, policy: [...TUDO], agora }, d);
    expect(p.reply).not.toContain("11, 9000-0002 ·");
    expect(p.reply).not.toContain("Comprador:");
    expect(p.reply).toMatch(/telefone/i);
    expect(p.reply).toContain("(11) 90000-0000");
    expect(p.evento).toBe("telefone_duvidoso");
  });

  it("o valor do extrator que não fecha também pergunta, mesmo com o texto limpo", async () => {
    const d = deps(completo("11, 9000-0002"));
    const p = await iniciarFluxo(
      { tipo: "proposta", pedido: pedido.replace("telefone 11, 9000-0002, ", ""), policy: [...TUDO], agora }, d);
    expect(p.evento).toBe("telefone_duvidoso");
  });

  it("telefone ditado que fecha sai juntado e formatado no card", async () => {
    const d = deps(completo("11, 90000-0002"));
    const p = await iniciarFluxo({ tipo: "proposta", pedido: pedido.replace("9000-0002", "90000-0002"), policy: [...TUDO], agora }, d);
    expect(p.reply).toContain("Comprador: TESTE Newton Ditado · (11) 90000-0002");
  });
});

describe("B — correção com o card aberto (conduzirFluxo)", () => {
  const aberto = (): Fluxo => ({
    kind: "proposta", etapa: "revisao", natureza: "venda",
    dados: sanearDados(completo("(11) 90000-0003")), atualizadoEm: 1,
  });
  const ctx = (texto: string): ContextoDoTurno => ({ texto, messageId: "m-r3", agora: 2, policy: ["proposal.create"] });

  it("nome e telefone ditados: o telefone sai juntado e formatado", async () => {
    const r = await conduzirFluxo(
      aberto(),
      ctx("o nome é TESTE Comprador Corrigido e o telefone é 11, 90000-0004"),
      deps({ proponente: { nome: "TESTE Comprador Corrigido", telefone: "11, 90000-0004" } }),
    );
    expect(r.reply).toContain("Comprador: TESTE Comprador Corrigido · (11) 90000-0004");
    expect(r.reply).not.toContain("11, 90000-0004");
  });

  it("telefone de 10 dígitos: pergunta e não troca", async () => {
    const f = aberto();
    const r = await conduzirFluxo(
      f, ctx("o telefone é 11, 9000-0004"),
      deps({ proponente: { telefone: "11, 9000-0004" } }),
    );
    expect(r.evento).toBe("telefone_duvidoso");
    if (!r.fluxo || r.fluxo.kind !== "proposta") throw new Error("fluxo");
    expect(r.fluxo.dados.proponente?.telefone).toBe("(11) 90000-0003");
  });

  it("valor do extrator que não fecha, com o texto sem rótulo: pergunta e não troca", async () => {
    const r = await conduzirFluxo(
      aberto(), ctx("corrige: ela é a TESTE Comprador Corrigida"),
      deps({ proponente: { nome: "TESTE Comprador Corrigida", telefone: "11, 9000-0004" } }),
    );
    expect(r.evento).toBe("telefone_duvidoso");
  });
});

describe("telefones válidos continuam como vieram", () => {
  it.each(["(11) 90000-0003", "11 90000-0003", "+55 11 90000-0003", "+351 912 345 678"])("%s", (t) => {
    expect(sanearDados({ proponente: { nome: "A B", telefone: t } }).proponente?.telefone).toBe(t);
  });
  it("sequência ditada que fecha vira (DD) NNNNN-NNNN", () => {
    expect(sanearDados({ proponente: { nome: "A B", telefone: "11, 90000-0004" } }).proponente?.telefone).toBe("(11) 90000-0004");
    expect(sanearDados({ proponente: { nome: "A B", telefone: "11 9 0000 0004" } }).proponente?.telefone).toBe("(11) 90000-0004");
  });
});

describe("C — captação, etapa de proprietários: frases de parada", () => {
  const fluxo = (): FluxoCaptacao => ({ kind: "captacao", etapa: "proprietarios", tentativas: 0, atualizadoEm: 1 });
  const d: DepsDoFluxo = { acao: vi.fn().mockResolvedValue(null), extrairProposta: async () => null, extrairCampos: async () => null };
  const ctx = (texto: string): ContextoDoTurno => ({ texto, messageId: "m-c", agora: 2, policy: ["captacao.create"] });

  it.each(["para por aqui, não envia nada", "pare", "não envia nada", "deixa pra lá", "para por aqui"])(
    "encerra: %s", async (texto) => {
      const r = await conduzirCaptacao(fluxo(), ctx(texto), d, true);
      expect(r.fluxo).toBeNull();
      expect(r.evento).toBe("captacao_cancelado");
    });

  it("'para' dentro de outra frase não cancela", async () => {
    const r = await conduzirCaptacao(fluxo(), ctx("venda para João da Silva"), d, true);
    expect(r.evento).not.toBe("captacao_cancelado");
  });
});
