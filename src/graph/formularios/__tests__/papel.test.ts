import { describe, expect, it, vi } from "vitest";
import {
  camposSemPapel,
  derivarPapel,
  gravarLidos,
  lidosDoCofre,
  registrarLidos,
  textoDeConferencia,
} from "../midia";
import { novoFluxoV2 } from "../estado";

/**
 * Rodada 1, I4 — de QUEM e o documento.
 *
 * O servidor decide para onde o dado vai pelo `papel_sugerido`/`posicao`; sem eles ele assume
 * "comprador 1". Mandar so isso despejava o documento de um vendedor, de uma testemunha ou do
 * 2o comprador em `compradores[0]` e, no "sim", sobrescrevia o comprador JA salvo. Aqui:
 *  - o papel e a posicao saem da legenda (ou do campo que o fluxo aguarda);
 *  - sem papel nenhum, a leitura entra como "sem papel": a ficha pergunta de quem e, e NADA
 *    e gravado ate alguem dizer (o dado nunca vai para uma parte por omissao).
 */

process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

const THREAD = "thread-papel";
const CPF = "52998224725";

describe("derivarPapel: legenda primeiro, depois o campo aguardado", () => {
  it.each([
    ["RG do vendedor", { papel: "vendedor" }],
    ["rg da proprietária", { papel: "vendedor" }],
    ["documento do comprador", { papel: "proponente" }],
    ["RG do proponente", { papel: "proponente" }],
    ["CNH do locatário", { papel: "proponente" }],
    ["rg do inquilino", { papel: "proponente" }],
    ["RG da esposa", { papel: "conjuge" }],
    ["certidão do cônjuge", { papel: "conjuge" }],
    ["RG do marido", { papel: "conjuge" }],
    ["RG da testemunha", { papel: "testemunha" }],
    ["matrícula do imóvel", { papel: "imovel" }],
    ["IPTU 2026", { papel: "imovel" }],
    ["escritura", { papel: "imovel" }],
  ])("%s", (legenda, esperado) => {
    expect(derivarPapel(legenda, undefined)).toMatchObject(esperado);
  });

  it.each([
    ["RG do segundo comprador", { papel: "proponente", posicao: 2 }],
    ["RG do 2º comprador", { papel: "proponente", posicao: 2 }],
    ["comprador 2", { papel: "proponente", posicao: 2 }],
    ["rg da terceira testemunha", { papel: "testemunha", posicao: 3 }],
    ["vendedora 2", { papel: "vendedor", posicao: 2 }],
  ])("posicao 1-based dentro do papel: %s", (legenda, esperado) => {
    expect(derivarPapel(legenda, undefined)).toEqual(esperado);
  });

  it("legenda ambigua nao chuta: mais de um papel, ou papel de posicoes diferentes", () => {
    expect(derivarPapel("RG do comprador e do vendedor", undefined)).toEqual({});
    expect(derivarPapel("RG da esposa do comprador", undefined)).toEqual({});
    expect(derivarPapel("comprador 1 e comprador 2", undefined)).toEqual({});
  });

  it("legenda ambigua NAO cai no campo aguardado (o conflito e do corretor, nao do fluxo)", () => {
    expect(derivarPapel("RG do comprador e do vendedor", { parteRef: "vendedor:1", path: "vendedores[0].cpf" })).toEqual({});
  });

  it("sem legenda util, o papel e a posicao do campo que o fluxo aguarda", () => {
    expect(derivarPapel(undefined, { parteRef: "comprador:2", path: "compradores[1].cpf" })).toEqual({ papel: "proponente", posicao: 2 });
    expect(derivarPapel("segue a foto", { parteRef: "vendedor:1", path: "vendedores[0].cpf" })).toEqual({ papel: "vendedor", posicao: 1 });
    expect(derivarPapel("", { parteRef: "conjuge:1", path: "x" })).toEqual({ papel: "conjuge", posicao: 1 });
    expect(derivarPapel(undefined, { parteRef: "imovel", path: "imoveis[0].matricula" })).toEqual({ papel: "imovel" });
  });

  it("a legenda vence o campo aguardado", () => {
    expect(derivarPapel("RG do vendedor", { parteRef: "comprador:1", path: "compradores[0].cpf" })).toEqual({ papel: "vendedor" });
  });

  it("nem legenda nem campo de pessoa: indeterminado (nada de padrao silencioso)", () => {
    expect(derivarPapel(undefined, undefined)).toEqual({});
    expect(derivarPapel("segue a foto", undefined)).toEqual({});
    expect(derivarPapel(undefined, { parteRef: "negociacao", path: "negociacao.valor" })).toEqual({});
    expect(derivarPapel(undefined, { parteRef: "corretor", path: "corretor.nome" })).toEqual({});
  });
});

describe("camposSemPapel: so conta se o documento traz dado de PESSOA", () => {
  const pessoa = [{ path: "compradores[0].nome", valor: "Maria Teste", confianca: 0.9 }];
  const imovel = [{ path: "imoveis[0].matricula", valor: "12345", confianca: 0.9 }];

  it("sem papel + dado de pessoa = incerto", () => {
    expect(camposSemPapel(pessoa, undefined)).toBe(true);
    expect(camposSemPapel([...imovel, ...pessoa], undefined)).toBe(true);
  });
  it("com papel, ou so dado do imovel (o servidor manda sempre ao imovel) = certo", () => {
    expect(camposSemPapel(pessoa, "vendedor")).toBe(false);
    expect(camposSemPapel(imovel, undefined)).toBe(false);
  });
});

describe("leitura sem papel nunca vira escrita", () => {
  const LIDOS = [
    { path: "compradores[0].nome", valor: "Maria Teste da Silva", confianca: 0.9 },
    { path: "compradores[0].cpf", valor: CPF, confianca: 0.9 },
  ];

  function fluxoSemPapel() {
    const base = { ...novoFluxoV2({ esteira: "venda", agora: 1_000, schemaType: "venda_padrao" }), proposalId: "prop-1" };
    const r = registrarLidos(base, { ref: "wamid.RG1", campos: LIDOS, semPapel: true }, THREAD);
    if (!r.ok) throw new Error("registrarLidos falhou");
    return r.fluxo;
  }

  it("a marca vive no cofre cifrado, nao no checkpoint em claro", () => {
    const f = fluxoSemPapel();
    expect(f.lidosPendentes).toEqual([
      { path: "compradores[0].nome", ref: "wamid.RG1" },
      { path: "compradores[0].cpf", ref: "wamid.RG1" },
    ]);
    expect(lidosDoCofre(f, THREAD).every((c) => c.semPapel === true)).toBe(true);
    expect(JSON.stringify(f)).not.toContain("semPapel");
    expect(JSON.stringify(f)).not.toContain(CPF);
  });

  it("mesmo com o 'sim', gravarLidos recusa: nenhuma chamada ao servidor e os lidos seguem pendentes", async () => {
    const acao = vi.fn();
    const f = fluxoSemPapel();

    const r = await gravarLidos({ acao }, f, THREAD, { messageIdDoSim: "wamid.SIM1" });

    expect(acao).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro).toBe("papel_indefinido");
    expect(r.fluxo.lidosPendentes).toHaveLength(2);
  });

  it("uma leitura COM papel grava mesmo havendo outra sem papel: so a sem papel fica de fora", async () => {
    const acao = vi.fn().mockResolvedValue({ status: 200, body: { proposta: { id: "prop-1", codigo: "P" }, faltando: [] } });
    const base = fluxoSemPapel();
    const r2 = registrarLidos(base, { ref: "wamid.RG2", campos: [{ path: "vendedores[0].nome", valor: "Joao Vendedor", confianca: 0.9 }] }, THREAD);
    if (!r2.ok) throw new Error("registrarLidos falhou");

    const r = await gravarLidos({ acao }, r2.fluxo, THREAD, { messageIdDoSim: "wamid.SIM2" });

    expect(acao).toHaveBeenCalledTimes(1);
    const corpo = acao.mock.calls[0]![1] as Record<string, unknown>;
    expect(corpo).toMatchObject({ vendedores: [{ nome: "Joao Vendedor" }] });
    expect(corpo).not.toHaveProperty("compradores");
    expect(r.ok).toBe(true);
    expect(r.fluxo.lidosPendentes.map((l) => l.path)).toEqual(["compradores[0].nome", "compradores[0].cpf"]);
  });
});

describe("a ficha pergunta de quem e o documento", () => {
  const leitura = {
    documentType: "rg",
    confianca: 0.9,
    campos: [{ path: "compradores[0].nome", valor: "Maria Teste", confianca: 0.9 }],
    ignorados: 0,
  };

  it("sem papel: pergunta de quem e e nao pede confirmacao dos valores", () => {
    const t = textoDeConferencia({ ...leitura, papelIncerto: true });
    expect(t).toMatch(/de quem é esse documento/i);
    expect(t).not.toMatch(/me diga se está certo/i);
    expect(t).toMatch(/nada foi anotado/i);
  });

  it("com papel: a ficha de sempre", () => {
    const t = textoDeConferencia(leitura);
    expect(t).not.toMatch(/de quem é/i);
    expect(t).toMatch(/Confira e me diga se está certo/);
  });
});
