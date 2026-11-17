import { describe, expect, it } from "vitest";

/**
 * W45–W46 (gate reprovado duas semanas): o modelo PROMETE o que o turno não fez —
 * "ajusto o complemento", "vou ajustar", "já atualizo", "eu te atualizo por aqui" —
 * e nada foi gravado. `travarCriacaoFalsa` só pegava "criei/enviei". Sem escrita
 * no turno, promessa em presente/futuro vira texto honesto de template.
 */

const { travarCriacaoFalsa, promessaSemEfeito, TEXTO_SEM_AVISO_POSTERIOR, TEXTO_NADA_ALTERADO_PERGUNTE } =
  await import("../compose");
const { sanitizar } = await import("../compose");

const SEM_ESCRITA = { houveLeitura: false, podeCriar: true, podeEnviar: true, houveEscrita: false };

describe("promessa em presente/futuro sem escrita no turno", () => {
  it.each([
    "Perfeito, ajusto o complemento.",
    "Vou ajustar o complemento para apartamento 1.",
    "Já atualizo o valor da proposta.",
    "Será ajustado o complemento do imóvel.",
    "Assim que tiver o status, eu te atualizo por aqui.",
    "Eu te aviso quando mudar.",
    "Vou te avisar assim que sair.",
    "Beleza, já corrijo o telefone.",
    "Ajusto o valor e te aviso.",
  ])("reconhece: %s", (texto) => {
    expect(promessaSemEfeito(texto)).toBe(true);
  });

  it.each([
    "Quer que eu ajuste o complemento?",
    "Se você confirmar, eu mostro o resumo.",
    "A proposta está em rascunho.",
    "Vou te mostrar a lista.",
    "Posso ajustar o valor se você me disser o novo.",
    "Ainda não alterei nada por aqui.",
    "Atualizei o rascunho há pouco, veja a tela.",
  ])("não pega conversa, pergunta ou oferta: %s", (texto) => {
    expect(promessaSemEfeito(texto)).toBe(false);
  });

  it("alvo claro de correção: pergunta concreta que leva ao fluxo", () => {
    const r = travarCriacaoFalsa("Perfeito, ajusto o complemento.", SEM_ESCRITA);
    expect(r.travou).toBe(true);
    expect(r.texto).toMatch(/Quer que eu altere o complemento\?/);
    expect(r.texto).toMatch(/novo valor/);
    expect(r.texto).not.toMatch(/ajusto/);
  });

  it("promessa de aviso posterior: diz o que o Max NÃO faz sozinho e onde ver o status", () => {
    const r = travarCriacaoFalsa("Assim que tiver o status, eu te atualizo por aqui.", SEM_ESCRITA);
    expect(r.travou).toBe(true);
    expect(r.texto).toBe(TEXTO_SEM_AVISO_POSTERIOR);
    expect(r.texto).toMatch(/não/i);
    expect(r.texto).toMatch(/status/i);
    expect(r.texto).not.toMatch(/te atualizo/);
  });

  it("sem alvo nem aviso: diz que nada foi alterado e pede o que mudar", () => {
    const r = travarCriacaoFalsa("Vou ajustar isso.", SEM_ESCRITA);
    expect(r.travou).toBe(true);
    expect(r.texto).toBe(TEXTO_NADA_ALTERADO_PERGUNTE);
  });

  it("troca só a frase da promessa e preserva o resto da resposta", () => {
    const r = travarCriacaoFalsa("A proposta está em rascunho. Já atualizo o valor.", SEM_ESCRITA);
    expect(r.travou).toBe(true);
    expect(r.texto.startsWith("A proposta está em rascunho.")).toBe(true);
    expect(r.texto).toMatch(/Quer que eu altere o valor\?/);
  });

  it("também vale quando o turno LEU dados (leitura não é escrita)", () => {
    const r = travarCriacaoFalsa("Vi o status. Vou ajustar o complemento.", { ...SEM_ESCRITA, houveLeitura: true });
    expect(r.travou).toBe(true);
    expect(r.texto).toMatch(/Quer que eu altere o complemento\?/);
  });

  it("com escrita executada no turno, a frase passa", () => {
    const texto = "Perfeito, ajusto o complemento.";
    expect(travarCriacaoFalsa(texto, { ...SEM_ESCRITA, houveEscrita: true })).toEqual({ texto, travou: false });
  });

  it("a troca respeita o teto: ≤500 caracteres, ≤6 linhas, sem **", () => {
    for (const t of ["Perfeito, ajusto o complemento.", "Eu te aviso depois.", "Vou ajustar."]) {
      const r = travarCriacaoFalsa(t, SEM_ESCRITA);
      expect(r.texto.length).toBeLessThanOrEqual(500);
      expect(r.texto.split("\n").length).toBeLessThanOrEqual(6);
      expect(r.texto).not.toContain("**");
      expect(sanitizar(r.texto).bloqueios).toEqual([]);
    }
  });

  it("o padrão antigo (criei/enviei) segue valendo, sem regressão", () => {
    expect(travarCriacaoFalsa("Gerei a proposta.", { houveLeitura: false, podeCriar: false }).travou).toBe(true);
  });
});

// ── Caso real W46: "complemento é apartamento 1" na revisão da proposta ─────────
// A correção de campo é do FLUXO (extrator + resumo remontado), não do modelo.

const F = await import("../fluxos");

const DADOS = {
  proponente: { nome: "TESTE QA", telefone: "11999063228" },
  valor: 500000,
  imovel: { endereco: "Rua de Teste QA, 100", cidade: "São Paulo", uf: "SP" },
};

function ctx(texto: string) {
  return { texto, messageId: "m-w46", agora: 2, policy: ["proposal.create" as const] };
}
const deps = (extraido: unknown) => ({
  acao: async () => {
    throw new Error("correção aguarda confirmação: nenhuma escrita aqui");
  },
  extrairProposta: async () => extraido as never,
  extrairCampos: async () => null,
});

describe("W46: 'complemento é apartamento 1' na revisão da proposta vai para o fluxo", () => {
  it("o extrator não devolve nada, mas o fluxo aplica o complemento e remonta o resumo", async () => {
    const dados = F.sanearDados(DADOS);
    const r = await F.conduzirFluxo(
      { kind: "proposta", etapa: "revisao", natureza: "venda", dados, atualizadoEm: 1 },
      ctx("complemento é apartamento 1"),
      deps({}),
    );
    expect("liberar" in r && r.liberar).toBeFalsy();
    expect(r.reply).toContain("Imóvel: Rua de Teste QA, 100, apartamento 1, São Paulo/SP");
    expect(r.reply).toContain("SIM");
    expect(r.fluxo).toMatchObject({ etapa: "revisao", dados: { imovel: { complemento: "apartamento 1" } } });
  });

  it.each([
    "o complemento é apartamento 1",
    "Complemento: apartamento 1",
    "complemento para apartamento 1",
    "complemento do imóvel é apartamento 1.",
  ])("variações de redação: %s", async (texto) => {
    const dados = F.sanearDados(DADOS);
    const r = await F.conduzirFluxo(
      { kind: "proposta", etapa: "revisao", natureza: "venda", dados, atualizadoEm: 1 },
      ctx(texto),
      deps({}),
    );
    expect(r.reply).toContain("apartamento 1");
    expect(r.fluxo).toMatchObject({ dados: { imovel: { complemento: "apartamento 1" } } });
  });

  it("vale o que a pessoa escreveu, não o complemento antigo que o extrator copiou", async () => {
    const dados = F.sanearDados({ ...DADOS, imovel: { ...DADOS.imovel, complemento: "apartamento 9" } });
    const r = await F.conduzirFluxo(
      { kind: "proposta", etapa: "revisao", natureza: "venda", dados, atualizadoEm: 1 },
      ctx("complemento é apartamento 1"),
      deps({ imovel: { complemento: "apartamento 9" } }),
    );
    expect(r.fluxo).toMatchObject({ dados: { imovel: { complemento: "apartamento 1" } } });
  });

  it("depois do rascunho (ajustes): vira resumo do ajuste, que espera o SIM", async () => {
    const dados = F.sanearDados(DADOS);
    const r = await F.conduzirFluxo(
      { kind: "proposta", etapa: "ajustes", natureza: "venda", propostaId: "p1", codigo: "PROP-1", dados, atualizadoEm: 1 },
      ctx("complemento é apartamento 1"),
      deps({}),
    );
    expect(r.fluxo).toMatchObject({ etapa: "revisao_ajuste", ajustePendente: true });
    expect(r.reply).toContain("apartamento 1");
  });

  it("frase que só cita a palavra complemento não vira ajuste", async () => {
    const dados = F.sanearDados(DADOS);
    const r = await F.conduzirFluxo(
      { kind: "proposta", etapa: "revisao", natureza: "venda", dados, atualizadoEm: 1 },
      ctx("o que é complemento?"),
      deps({}),
    );
    expect(r.fluxo).toMatchObject({ dados: { imovel: { endereco: "Rua de Teste QA, 100" } } });
    expect(JSON.stringify((r.fluxo as { dados: unknown }).dados)).not.toContain("complemento");
  });
});

const { houveEscritaNoTurno } = await import("../escrita-do-turno");
const { TOOL_PROPOR_FORM, buscarNoRegistro } = await import("../tools");

describe("houveEscritaNoTurno: tool de escrita que falhou não conta", () => {
  const ehEscrita = (n: string) => buscarNoRegistro(n)?.tipo === "escrita";

  it("a escrita registrada (proposta ou feita) conta", () => {
    expect(houveEscritaNoTurno([{ name: TOOL_PROPOR_FORM, outcome: "proposta" }], ehEscrita)).toBe(true);
    expect(houveEscritaNoTurno([{ name: TOOL_PROPOR_FORM, outcome: "criado" }], ehEscrita)).toBe(true);
  });

  it.each(["falhou", "modulo_desligado", "descartada", "capability_negada", "identidade_nao_escreve", "nao_oferecida", "tipo_invalido", "fluxo_em_andamento", "negocio_existente"])(
    "escrita com desfecho '%s' não conta",
    (outcome) => {
      expect(houveEscritaNoTurno([{ name: TOOL_PROPOR_FORM, outcome }], ehEscrita)).toBe(false);
    }
  );

  it("leitura não conta, e uma escrita boa ao lado de uma falha ainda conta", () => {
    expect(houveEscritaNoTurno([{ name: "listar_negocios", outcome: "ok" }], ehEscrita)).toBe(false);
    expect(houveEscritaNoTurno([{ name: TOOL_PROPOR_FORM, outcome: "falhou" }, { name: TOOL_PROPOR_FORM, outcome: "criado" }], ehEscrita)).toBe(true);
  });

  it("com a escrita falha, a promessa vazia é travada", () => {
    const houveEscrita = houveEscritaNoTurno([{ name: TOOL_PROPOR_FORM, outcome: "falhou" }], ehEscrita);
    expect(travarCriacaoFalsa("Perfeito, ajusto o complemento.", { ...SEM_ESCRITA, houveEscrita }).travou).toBe(true);
  });
});
