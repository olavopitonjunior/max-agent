import { describe, it, expect, vi } from "vitest";

/**
 * "ok", "blz", "👍" não são SIM em escrita (W46: "ok" depois do resultado de
 * crédito abriu a proposta de locação). Só o SIM explícito autoriza; o vago
 * mantém o estado e devolve "Para confirmar, responda SIM." sem executar.
 */

process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

const { lerConfirmacao, TEXTO_PARA_CONFIRMAR } = await import("../tools");
const F = await import("../fluxos");
const { conduzirCredito } = await import("../credito");
type Fluxo = import("../fluxos").Fluxo;

const TUDO = ["proposal.create", "proposal.send", "form.create", "credit.read", "credit.request"] as const;
const agora = 1_000_000;

function deps() {
  return {
    acao: vi.fn().mockResolvedValue(null),
    extrairProposta: vi.fn().mockResolvedValue({}),
    extrairCampos: vi.fn().mockResolvedValue({}),
  };
}
const ctx = (texto: string) => ({ texto, messageId: `m-${texto}`, policy: [...TUDO], agora });

const DADOS_OK: import("../fluxos").DadosDaProposta = {
  proponente: { nome: "Letícia Gonçalves Nogueira", telefone: "11999990000", cpf: "12345678909" },
  imovel: { endereco: "Rua Senador Godoi, 606", bairro: "Vila São Geraldo" },
  valor: 1_500_000,
  pagamento: { forma: "à vista" },
};

describe("lerConfirmacao", () => {
  it.each(["ok", "OK", "okay", "blz", "beleza", "certo", "perfeito", "ta", "vai", "bora", "pode ser", "👍", "👌"])(
    "%s é vago",
    (t) => expect(lerConfirmacao(t)).toBe("vago")
  );
  it.each(["sim", "SIM", "Sim.", "s", "confirmo", "pode criar", "pode enviar", "manda", "isso mesmo", "✅"])(
    "%s é sim",
    (t) => expect(lerConfirmacao(t)).toBe("sim")
  );
  it.each(["não", "cancela", "deixa pra lá"])("%s é não", (t) => expect(lerConfirmacao(t)).toBe("nao"));
  it("o que só contém um ok segue 'nenhum'", () => {
    expect(lerConfirmacao("ok, mas muda o valor")).toBe("nenhum");
  });
});

describe("fluxos de escrita: vago não executa", () => {
  it.each(["ok", "blz", "beleza", "👍"])("proposta em revisão: '%s' pede SIM e mantém a etapa", async (t) => {
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS_OK, atualizadoEm: agora };
    const d = deps();
    const p = await F.conduzirFluxo(f, ctx(t), d);
    expect(p.reply).toBe(TEXTO_PARA_CONFIRMAR);
    expect(p.fluxo).toMatchObject({ kind: "proposta", etapa: "revisao" });
    expect(d.acao).not.toHaveBeenCalled();
  });

  it("proposta em revisao_ajuste: 'ok' pede SIM e não atualiza o rascunho", async () => {
    const f: Fluxo = { kind: "proposta", etapa: "revisao_ajuste", natureza: "venda", dados: DADOS_OK, propostaId: "p1", atualizadoEm: agora };
    const d = deps();
    const p = await F.conduzirFluxo(f, ctx("ok"), d);
    expect(p.reply).toBe(TEXTO_PARA_CONFIRMAR);
    expect(p.fluxo).toMatchObject({ etapa: "revisao_ajuste" });
    expect(d.acao).not.toHaveBeenCalled();
  });

  it("envio de proposta: 'blz' não envia para assinatura", async () => {
    const f: Fluxo = { kind: "proposta", etapa: "envio", natureza: "venda", dados: DADOS_OK, propostaId: "p1", atualizadoEm: agora };
    const d = deps();
    const p = await F.conduzirFluxo(f, ctx("blz"), d);
    expect(p.reply).toBe(TEXTO_PARA_CONFIRMAR);
    expect(p.fluxo).toMatchObject({ etapa: "envio" });
    expect(d.acao).not.toHaveBeenCalled();
  });

  it("formulário de negócio em revisão: 'ok' não cria", async () => {
    const f: Fluxo = { kind: "negocio", etapa: "revisao", tipo: "venda", campos: [], valores: {}, atualizadoEm: agora };
    const d = deps();
    const p = await F.conduzirFluxo(f, ctx("ok"), d);
    expect(p.reply).toBe(TEXTO_PARA_CONFIRMAR);
    expect(p.fluxo).toMatchObject({ kind: "negocio", etapa: "revisao" });
    expect(d.acao).not.toHaveBeenCalled();
  });

  it("controle: o SIM explícito segue funcionando na revisão da proposta", async () => {
    const f: Fluxo = {
      kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS_OK,
      chave: { verbo: "proposal.create", valor: "k" }, atualizadoEm: agora,
    };
    const d = deps();
    await F.conduzirFluxo(f, ctx("sim"), d);
    expect(d.acao).toHaveBeenCalled();
  });
});

describe("crédito aprovado: 'ok' não abre a proposta de locação (W46)", () => {
  const f = { kind: "credito" as const, etapa: "resultado" as const, leaseClientId: "lc1", decisao: "aprovado", tentativas: 0, atualizadoEm: agora };

  it.each(["ok", "blz", "👍"])("'%s' repete a pergunta com SIM e mantém o fluxo", async (t) => {
    const d = deps();
    const p = await conduzirCredito(f, ctx(t), d);
    expect(p.reply).toMatch(/responda SIM/);
    expect(p.fluxo).toMatchObject({ etapa: "resultado" });
    expect(d.acao).not.toHaveBeenCalled();
  });
});
