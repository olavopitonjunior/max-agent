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

const AMBIGUAS = ["claro", "aham", "uhum", "positivo", "com certeza", "isso ai", "cria", "criar", "faz", "fazer", "faz isso", "pode", "manda ver", "manda ai", "ok", "blz", "👍"];

describe("lerConfirmacao", () => {
  it.each(["ok", "OK", "okay", "blz", "beleza", "certo", "perfeito", "ta", "vai", "bora", "pode ser", "👍", "👌"])(
    "%s é vago",
    (t) => expect(lerConfirmacao(t)).toBe("vago")
  );
  it.each(["sim", "SIM", "Sim.", "s", "confirmo", "confirmado", "pode criar", "pode mandar", "pode enviar", "pode fazer", "manda", "isso", "isso mesmo", "Isso mesmo!", "✅"])(
    "%s é sim",
    (t) => expect(lerConfirmacao(t)).toBe("sim")
  );
  // Segurança: lerConfirmacao autoriza envio para assinatura e exclusão. Só a lista
  // curta e explícita vale; o resto da conversa ("claro", "pode", "cria") é vago.
  it.each(AMBIGUAS)("%s NÃO confirma (é vago)", (t) => {
    expect(lerConfirmacao(t)).not.toBe("sim");
    expect(lerConfirmacao(t)).toBe("vago");
  });
  it.each(["Claro!", "AHAM", "Pode.", "Manda ver!", "Com certeza.", "Cria", "FAZ"])("variação %s também não confirma", (t) => {
    expect(lerConfirmacao(t)).not.toBe("sim");
  });
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

describe("fluxos de gestão, assinatura, atividades e captação: ambíguo não executa", () => {
  const VAGAS = ["claro", "aham", "cria", "faz", "pode", "manda ver", "com certeza", "ok", "blz", "👍"];
  const politica = ["proposal.list", "proposal.create", "proposal.send", "proposal.delete", "activity.list", "activity.write", "captacao.create", "captacao.list", "captacao.autorizacao.pedir", "captacao.autorizacao.decidir"] as never;
  const c = (texto: string) => ({ texto, messageId: `m-${texto}`, policy: politica, agora, orgName: "Imob" });

  it.each(VAGAS)("gestão (excluir proposta): '%s' reapresenta o resumo e não exclui", async (t) => {
    const { conduzirGestao } = await import("../gestao");
    const d = deps();
    const f = { kind: "gestao" as const, operacao: "excluir" as const, etapa: "confirmacao" as const, alvo: { id: "p1", codigo: "PROP-2026-0001" }, atualizadoEm: agora };
    const r = await conduzirGestao(f, c(t), d);
    expect(d.acao).not.toHaveBeenCalled();
    expect("fluxo" in r && r.fluxo).toBeTruthy();
    expect(r.reply).toContain("PROP-2026-0001");
  });

  it.each(VAGAS)("assinatura (cancelar/lembrar): '%s' não envia nem cancela", async (t) => {
    const { conduzirAssinatura } = await import("../assinatura");
    for (const operacao of ["lembrar", "cancelar"] as const) {
      const d = deps();
      const alvo = { id: "p1", codigo: "PROP-2026-0031", titulo: "Rua X, 100", estado: "Enviada", status: "enviada", assinaturas: [{ nome: "Ana", status: "pendente", canal: "email" as const }] };
      const f = { kind: "assinatura" as const, operacao, etapa: "confirmacao" as const, alvo, atualizadoEm: agora, ...(operacao === "cancelar" ? { motivo: "desistiu" } : {}) };
      const r = await conduzirAssinatura(f, c(t), d);
      expect(d.acao).not.toHaveBeenCalled();
      expect("fluxo" in r && r.fluxo).toBeTruthy();
    }
  });

  it.each(VAGAS)("atividades (concluir): '%s' reapresenta o resumo e não escreve", async (t) => {
    const { iniciarAtividade, conduzirAtividade } = await import("../atividades");
    const d = deps();
    const f = iniciarAtividade({ operacao: "concluir", alvo: { id: "atv_1", rotulo: "Ligar para o João" } }, c("")).fluxo as import("../atividades").FluxoAtividade;
    const r = await conduzirAtividade(f, c(t), d);
    expect(d.acao).not.toHaveBeenCalled();
    expect("fluxo" in r && r.fluxo).toBeTruthy();
  });

  it.each(VAGAS)("captação (pedir autorização): '%s' repete a pergunta e não pede", async (t) => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const { conduzirCaptacao } = await import("../captacao");
    const d = deps();
    const f: import("../captacao").FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_oferta", captacaoId: "cap-1", version: 3,
      autorizacaoPedido: { tipo: "proprietario", ref: "p1" }, tentativas: 0, atualizadoEm: agora,
    };
    const r = await conduzirCaptacao(f, c(t), d, true);
    delete process.env.MAX_CAPTACAO_AUTORIZACAO;
    expect(d.acao).not.toHaveBeenCalled();
    expect(r.reply).toMatch(/responda \*sim\*/);
  });

  it.each(VAGAS)("captação (decidir autorização): '%s' repete a pergunta e não decide", async (t) => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const { conduzirCaptacao } = await import("../captacao");
    const d = deps();
    const f: import("../captacao").FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_confirmar", tentativas: 0, atualizadoEm: agora,
      autorizacaoDecisao: { autorizacaoId: "aut-1", tipo: "proprietario", decisao: "aprovar", codigo: "CAP-2026-0007", solicitante: "Ana Souza", documento: "***.456.789-**" },
    };
    const r = await conduzirCaptacao(f, c(t), d, true);
    delete process.env.MAX_CAPTACAO_AUTORIZACAO;
    expect(d.acao).not.toHaveBeenCalled();
    expect(r.reply).toMatch(/responda \*sim\*/);
  });
});
