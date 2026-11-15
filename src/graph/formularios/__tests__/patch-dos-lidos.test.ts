import { describe, expect, it, vi } from "vitest";
import { caminhoGravavel, gravarLidos, lidosDoCofre, registrarLidos, type CampoLido } from "../midia";
import { novoFluxoV2 } from "../estado";

/**
 * O PATCH dos lidos (do documento E do que o corretor escreveu): destinos novos
 * (imóvel, negociação, corretor, observações), M1 (sem posição vazia), M2 (o que
 * não cabe é descartado e dito) e N1 (nunca sobrescrever uma parte já gravada em silêncio).
 */

process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

const THREAD = "thread-patch";
const OK = { status: 200, body: { proposta: { id: "prop-1", codigo: "PROP-1" }, faltando: [] } };

function fluxoCom(campos: CampoLido[], extra: { proposalId?: string } = { proposalId: "prop-1" }) {
  const base = { ...novoFluxoV2({ esteira: "venda", agora: 1_000, schemaType: "compra_venda_v1" }), ...extra };
  const r = registrarLidos(base, { ref: "wamid.TXT", campos }, THREAD);
  if (!r.ok) throw new Error("registrarLidos falhou");
  return r.fluxo;
}
const L = (path: string, valor: string): CampoLido => ({ path, valor, confianca: 0.9 });

describe("destinos novos do patch", () => {
  it("imóvel, negociação (número), corretor e observações vão ao proposal.update", async () => {
    const acao = vi.fn().mockResolvedValue(OK);
    const f = fluxoCom([
      L("imovel.cidade", "Santos"),
      L("negociacao.valor", "500000"),
      L("negociacao.prazo_meses", "12"),
      L("negociacao.modalidade", "financiamento"),
      L("corretor.creci", "12345"),
      L("observacoes", "entrada em 3x"),
    ]);
    const r = await gravarLidos({ acao }, f, THREAD, { messageIdDoSim: "wamid.SIM" });
    expect(r.ok).toBe(true);
    const corpo = acao.mock.calls[0]![1] as Record<string, unknown>;
    expect(corpo).toMatchObject({
      imovel: { cidade: "Santos" },
      negociacao: { valor: 500000, prazo_meses: 12, modalidade: "financiamento" },
      corretor: { creci: "12345" },
      observacoes: "entrada em 3x",
    });
    expect(r.fluxo.lidosPendentes).toEqual([]);
  });

  it("valor não numérico em campo numérico não vai ao servidor", async () => {
    const acao = vi.fn().mockResolvedValue(OK);
    const f = fluxoCom([L("negociacao.valor", "muito dinheiro")]);
    const r = await gravarLidos({ acao }, f, THREAD, { messageIdDoSim: "wamid.SIM" });
    expect(acao).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
  });
});

describe("M1: nunca manda posição vazia que o servidor recusa", () => {
  it("só o comprador 2 lido e ninguém gravado: não escreve, o dado segue pendente", async () => {
    const acao = vi.fn();
    const f = fluxoCom([L("compradores[1].nome", "Joao Teste")]);
    const r = await gravarLidos({ acao }, f, THREAD, { messageIdDoSim: "wamid.SIM" });
    expect(acao).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.fluxo.lidosPendentes).toHaveLength(1);
  });

  it("com o comprador 1 já existente no servidor, a posição 1 vai (a 0 sai como {} = sem mudança)", async () => {
    const acao = vi.fn().mockResolvedValue(OK);
    const f = fluxoCom([L("compradores[1].nome", "Joao Teste")]);
    const r = await gravarLidos({ acao }, f, THREAD, {
      messageIdDoSim: "wamid.SIM",
      partes: { compradores: ["Maria Teste da Silva"], vendedores: [] },
    });
    expect(r.ok).toBe(true);
    expect((acao.mock.calls[0]![1] as { compradores: unknown[] }).compradores).toEqual([{}, { nome: "Joao Teste" }]);
  });

  it("posições contíguas a partir de 0 vão sem informação extra", async () => {
    const acao = vi.fn().mockResolvedValue(OK);
    const f = fluxoCom([L("compradores[0].nome", "Maria"), L("compradores[1].nome", "Joao")]);
    const r = await gravarLidos({ acao }, f, THREAD, { messageIdDoSim: "wamid.SIM" });
    expect(r.ok).toBe(true);
    expect((acao.mock.calls[0]![1] as { compradores: unknown[] }).compradores).toEqual([{ nome: "Maria" }, { nome: "Joao" }]);
  });
});

describe("M2: o que não cabe na proposta é descartado e dito, não fica pendente para sempre", () => {
  it("caminhoGravavel diz o que o PATCH aceita", () => {
    expect(caminhoGravavel("compradores[0].cpf")).toBe(true);
    expect(caminhoGravavel("compradores[0].conjuge.nome")).toBe(true);
    expect(caminhoGravavel("imovel.cidade")).toBe(true);
    expect(caminhoGravavel("negociacao.valor")).toBe(true);
    expect(caminhoGravavel("compradores[0].profissao")).toBe(false);
    expect(caminhoGravavel("testemunhas[0].nome")).toBe(false);
  });

  it("depois do sim, o que não cabe sai do cofre e vem em `descartados`", async () => {
    const acao = vi.fn().mockResolvedValue(OK);
    const f = fluxoCom([L("compradores[0].nome", "Maria"), L("compradores[0].profissao", "médica"), L("testemunhas[0].nome", "Ana")]);
    const r = await gravarLidos({ acao }, f, THREAD, { messageIdDoSim: "wamid.SIM" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.descartados.sort()).toEqual(["compradores[0].profissao", "testemunhas[0].nome"]);
    expect(r.fluxo.lidosPendentes).toEqual([]);
    expect(lidosDoCofre(r.fluxo, THREAD)).toEqual([]);
  });

  it("só dado que não cabe: nada a gravar, e o cofre é limpo (não retém para sempre)", async () => {
    const acao = vi.fn();
    const f = fluxoCom([L("compradores[0].profissao", "médica")]);
    const r = await gravarLidos({ acao }, f, THREAD, { messageIdDoSim: "wamid.SIM" });
    expect(acao).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.fluxo.lidosPendentes).toEqual([]);
  });
});

describe("N1: parte já gravada nunca é sobrescrita em silêncio", () => {
  const MARIA = { compradores: ["Maria Teste da Silva"], vendedores: [] as string[] };

  it("nome diferente na mesma posição: não escreve e devolve o conflito; Maria continua gravada", async () => {
    const acao = vi.fn();
    const f = fluxoCom([L("compradores[0].nome", "João Outro de Souza"), L("compradores[0].cpf", "52998224725")]);
    const r = await gravarLidos({ acao }, f, THREAD, { messageIdDoSim: "wamid.SIM", partes: MARIA });
    expect(acao).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erro).toBe("conflito_de_parte");
    expect(r.conflito).toEqual({ grupo: "compradores", posicao: 0, nomeAtual: "Maria Teste da Silva" });
    expect(r.fluxo.lidosPendentes).toHaveLength(2);
  });

  it("mesmo nome (caixa e acento à parte): grava normalmente", async () => {
    const acao = vi.fn().mockResolvedValue(OK);
    const f = fluxoCom([L("compradores[0].nome", "MARIA TESTE DA SILVA"), L("compradores[0].cpf", "52998224725")]);
    const r = await gravarLidos({ acao }, f, THREAD, { messageIdDoSim: "wamid.SIM", partes: MARIA });
    expect(r.ok).toBe(true);
    expect(acao).toHaveBeenCalledTimes(1);
  });

  it("'é um novo': o dado vai para a próxima posição livre, a 0 fica intacta", async () => {
    const acao = vi.fn().mockResolvedValue(OK);
    const f = fluxoCom([L("compradores[0].nome", "João Outro de Souza")]);
    const r = await gravarLidos({ acao }, f, THREAD, {
      messageIdDoSim: "wamid.SIM",
      partes: MARIA,
      comoNovaParte: { grupo: "compradores", posicao: 0 },
    });
    expect(r.ok).toBe(true);
    expect((acao.mock.calls[0]![1] as { compradores: unknown[] }).compradores).toEqual([{}, { nome: "João Outro de Souza" }]);
  });

  it("'é o mesmo, troca': escreve com substituir:true (R38), só quando o corretor disse", async () => {
    const acao = vi.fn().mockResolvedValue(OK);
    const f = fluxoCom([L("compradores[0].nome", "João Outro de Souza")]);
    const r = await gravarLidos({ acao }, f, THREAD, {
      messageIdDoSim: "wamid.SIM",
      partes: MARIA,
      substituir: { grupo: "compradores", posicao: 0 },
    });
    expect(r.ok).toBe(true);
    expect((acao.mock.calls[0]![1] as { compradores: unknown[] }).compradores).toEqual([
      { nome: "João Outro de Souza", substituir: true },
    ]);
  });

  // I1: o documento também é identidade. Um CPF/CNPJ sem nome, numa posição ocupada e que ninguém
  // perguntou, não diz de QUEM é: conflito (nada escrito), como o nome diferente.
  it("I1: só CPF numa posição ocupada que ninguém perguntou: conflito, nada escrito", async () => {
    const acao = vi.fn().mockResolvedValue(OK);
    const f = fluxoCom([L("compradores[0].cpf", "52998224725")]);
    const r = await gravarLidos({ acao }, f, THREAD, { messageIdDoSim: "wamid.SIM", partes: MARIA });
    expect(r).toMatchObject({ ok: false, erro: "conflito_de_parte", conflito: { grupo: "compradores", posicao: 0 } });
    expect(acao).not.toHaveBeenCalled();
  });

  it("I1: o mesmo CPF como RESPOSTA ao campo perguntado (`perguntado`) grava", async () => {
    const acao = vi.fn().mockResolvedValue(OK);
    const f = fluxoCom([{ ...L("compradores[0].cpf", "52998224725"), perguntado: true }]);
    const r = await gravarLidos({ acao }, f, THREAD, { messageIdDoSim: "wamid.SIM", partes: MARIA });
    expect(r.ok).toBe(true);
  });

  it("I1: CNPJ também vale como identidade (mesma regra do CPF)", async () => {
    const acao = vi.fn().mockResolvedValue(OK);
    const f = fluxoCom([L("compradores[0].cnpj", "11222333000181")]);
    const r = await gravarLidos({ acao }, f, THREAD, { messageIdDoSim: "wamid.SIM", partes: MARIA });
    expect(r).toMatchObject({ ok: false, erro: "conflito_de_parte" });
  });

  it("I1: CPF do CÔNJUGE numa posição ocupada não é a identidade do titular (sem conflito)", async () => {
    const acao = vi.fn().mockResolvedValue(OK);
    const f = fluxoCom([L("compradores[0].conjuge.cpf", "52998224725")]);
    const r = await gravarLidos({ acao }, f, THREAD, { messageIdDoSim: "wamid.SIM", partes: MARIA });
    expect(r.ok).toBe(true);
  });

  it("I1/M9: troca confirmada só com documento não manda `substituir` (o servidor exige nome novo)", async () => {
    const acao = vi.fn().mockResolvedValue(OK);
    const f = fluxoCom([L("compradores[0].cpf", "52998224725")]);
    const r = await gravarLidos({ acao }, f, THREAD, {
      messageIdDoSim: "wamid.SIM",
      partes: MARIA,
      substituir: { grupo: "compradores", posicao: 0 },
    });
    expect(r.ok).toBe(true);
    expect((acao.mock.calls[0]![1] as { compradores: unknown[] }).compradores).toEqual([{ cpf: "52998224725" }]);
  });
});
