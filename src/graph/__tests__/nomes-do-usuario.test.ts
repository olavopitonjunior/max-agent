import { describe, it, expect, vi } from "vitest";

/**
 * Regra do Olavo (13/10): o nome de negócios e propostas é o que a PESSOA
 * escreveu. Nunca sintético ("Negocio - cmuzkv16", "Proposta — X").
 * O servidor e o extrator são dublês; o que se testa é a máquina de estado.
 */

const F = await import("../fluxos");

const TUDO = ["proposal.create", "proposal.send", "form.create"] as const;
const agora = 1_000_000;
type Passo = import("../fluxos").PassoDoFluxo;

function deps(over: Partial<import("../fluxos").DepsDoFluxo> = {}) {
  return {
    acao: vi.fn().mockResolvedValue(null),
    extrairProposta: vi.fn().mockResolvedValue({}),
    extrairCampos: vi.fn().mockResolvedValue({}),
    ...over,
  };
}

const ctx = (texto: string, extra: Partial<import("../fluxos").ContextoDoTurno> = {}) => ({
  texto,
  messageId: `m-${texto.slice(0, 8)}`,
  policy: [...TUDO],
  agora,
  ...extra,
});

const SEM_PADRAO = { status: 200, body: { campos: [{ chave: "endereco", rotulo: "Endereço", obrigatorio: true }] } };
const SEM_CAMPOS = { status: 200, body: { campos: [] } };
const COM_PADRAO = { status: 200, body: { campos: [{ chave: "titleParts.endereco", rotulo: "Endereço", obrigatorio: true }] } };
const CRIADO = { status: 201, body: { formulario: { link: "https://imobpro.ia.br/f/t/x" } } };
const acaoCom = (opcoes: unknown) =>
  vi.fn().mockImplementation(async (verbo: string) => (verbo === "form.options" ? opcoes : CRIADO));

describe("nome do negócio", () => {
  it.each([
    'Quero criar um novo negócio de venda com o título TESTE QA MAX. Pode preparar para eu conferir?',
    'Crie um negócio de venda. título: TESTE QA MAX',
    'Abrir venda com o título "TESTE QA MAX"',
    'Vamos cadastrar uma venda com o nome "TESTE QA MAX"?',
  ])('retém o título explícito do pedido sem perguntar novamente: %s', async (pedido) => {
    const acao=acaoCom(SEM_CAMPOS),d=deps({acao});
    const p=await F.iniciarFluxo({tipo:'venda',pedido,policy:[...TUDO],agora},d);
    expect(p.reply).toContain('Nome: TESTE QA MAX');
    expect(p.reply).not.toContain('Que nome');
    await F.conduzirFluxo(p.fluxo!,ctx('sim',{messageId:'explicit-title'}),d);
    expect(acao).toHaveBeenLastCalledWith('form.create',{tipo:'venda',campos:{title:'TESTE QA MAX'}},'explicit-title');
  });

  it('extrai a declaração do título sem incluir a frase explicativa',async()=>{
    const acao=acaoCom(SEM_CAMPOS),d=deps({acao});
    let p: Passo=await F.iniciarFluxo({tipo:'venda',policy:[...TUDO],agora},d);
    p=await F.conduzirFluxo(p.fluxo!,ctx('O título que já informei é TESTE QA MAX.'),d);
    expect(p.reply).toContain('Nome: TESTE QA MAX');
    expect(p.reply).not.toContain('Nome: O título');
  });

  it('não escolhe entre dois títulos explícitos nem usa título livre sobre titleParts',async()=>{
    const d=deps({acao:acaoCom(SEM_CAMPOS)});
    const p=await F.iniciarFluxo({tipo:'venda',pedido:'Criar venda com o título "Casa A" ou título "Casa B"',policy:[...TUDO],agora},d);
    expect(p.reply).toContain('Que nome');
    const acao=acaoCom(COM_PADRAO),d2=deps({acao,extrairCampos:vi.fn().mockResolvedValue({'titleParts.endereco':'Rua A, 10'})});
    let q: Passo=await F.iniciarFluxo({tipo:'venda',pedido:'Criar venda com o título "Livre"',policy:[...TUDO],agora},d2);
    q=await F.conduzirFluxo(q.fluxo!,ctx('nome: Outro'),d2);
    expect(q.reply).not.toContain('Nome: Outro');
    await F.conduzirFluxo(q.fluxo!,ctx('sim',{messageId:'pattern'}),d2);
    expect(acao).toHaveBeenLastCalledWith('form.create',{tipo:'venda',campos:{titleParts:{endereco:'Rua A, 10'}}},'pattern');
  });
  it("nome do cliente do pedido vai como `title`, verbatim, e aparece no resumo", async () => {
    const acao = acaoCom(SEM_CAMPOS);
    const d = deps({ acao });
    let p: Passo = await F.iniciarFluxo({ tipo: "venda", nomeCliente: "Letícia Gonçalves", policy: [...TUDO], agora }, d);
    expect(p.reply).toContain("Nome: Letícia Gonçalves");
    expect(p.reply).toContain("Posso criar?");
    p = await F.conduzirFluxo(p.fluxo!, ctx("sim", { messageId: "s1" }), d);
    expect(acao).toHaveBeenLastCalledWith("form.create", { tipo: "venda", campos: { title: "Letícia Gonçalves" } }, "s1");
  });

  it("endereço: com padrão de título da org ele sai do endereço (titleParts) e não se pergunta nome", async () => {
    const acao = acaoCom(COM_PADRAO);
    const d = deps({ acao, extrairCampos: vi.fn().mockResolvedValue({ "titleParts.endereco": "Rua A, 10" }) });
    let p: Passo = await F.iniciarFluxo({ tipo: "venda", policy: [...TUDO], agora }, d);
    p = await F.conduzirFluxo(p.fluxo!, ctx("Rua A, 10"), d);
    expect(p.reply).toContain("Posso criar?");
    expect(p.reply).not.toContain("Que nome");
    await F.conduzirFluxo(p.fluxo!, ctx("sim", { messageId: "s2" }), d);
    expect(acao).toHaveBeenLastCalledWith("form.create", { tipo: "venda", campos: { titleParts: { endereco: "Rua A, 10" } } }, "s2");
  });

  it("endereço sem padrão: o endereço dito como nome vira o título, sem prefixo", async () => {
    const acao = acaoCom(SEM_CAMPOS);
    const d = deps({ acao });
    let p: Passo = await F.iniciarFluxo({ tipo: "locacao", policy: [...TUDO], agora }, d);
    expect(p.reply).toBe("Que nome dou a esse negócio?");
    p = await F.conduzirFluxo(p.fluxo!, ctx("Rua Senador Godoi, 606"), d);
    await F.conduzirFluxo(p.fluxo!, ctx("sim", { messageId: "s3" }), d);
    expect(acao).toHaveBeenLastCalledWith("form.create", { tipo: "locacao", campos: { title: "Rua Senador Godoi, 606" } }, "s3");
  });

  it("sem nome: coleta os campos, PERGUNTA uma vez, e a resposta vira o título", async () => {
    const acao = acaoCom(SEM_PADRAO);
    const d = deps({ acao, extrairCampos: vi.fn().mockResolvedValue({ endereco: "Rua B, 5" }) });
    let p: Passo = await F.iniciarFluxo({ tipo: "venda", policy: [...TUDO], agora }, d);
    p = await F.conduzirFluxo(p.fluxo!, ctx("Rua B, 5"), d);
    expect(p.reply).toBe("Que nome dou a esse negócio?");
    expect(acao).toHaveBeenCalledTimes(1); // nada foi criado antes de perguntar
    p = await F.conduzirFluxo(p.fluxo!, ctx("sim"), d); // "sim" não é nome
    expect(p.reply).toBe("Que nome dou a esse negócio?");
    p = await F.conduzirFluxo(p.fluxo!, ctx("Casa da Praia"), d);
    expect(p.reply).toContain("Nome: Casa da Praia");
    await F.conduzirFluxo(p.fluxo!, ctx("sim", { messageId: "s4" }), d);
    expect(acao).toHaveBeenLastCalledWith(
      "form.create",
      { tipo: "venda", campos: { endereco: "Rua B, 5", title: "Casa da Praia" } },
      "s4"
    );
  });

  it("a pessoa corrige o nome no resumo", async () => {
    const d = deps({ acao: acaoCom(SEM_CAMPOS) });
    let p: Passo = await F.iniciarFluxo({ tipo: "venda", nomeCliente: "Ana", policy: [...TUDO], agora }, d);
    p = await F.conduzirFluxo(p.fluxo!, ctx("nome: Ana Paula Souza"), d);
    expect(p.reply).toContain("Nome: Ana Paula Souza");
  });

  it("o nome do pedido sobrevive à pergunta 'proposta ou negócio?'", async () => {
    const d = deps({ acao: acaoCom(SEM_CAMPOS) });
    let p: Passo = await F.iniciarFluxo({ tipo: "proposta", natureza: "venda", nomeCliente: "Carlos", policy: [...TUDO], agora }, d);
    expect(p.fluxo).toMatchObject({ kind: "escolha", nomeCliente: "Carlos" });
    p = await F.conduzirFluxo(p.fluxo!, ctx("2"), d);
    expect(p.reply).toContain("Nome: Carlos");
  });

  it("o nome do pedido sobrevive à pergunta 'venda ou locação?'", async () => {
    const d = deps({ acao: acaoCom(SEM_CAMPOS) });
    let p: Passo = await F.iniciarFluxo({ tipo: "proposta", nomeCliente: "Carlos", policy: ["form.create"], agora }, d);
    expect(p.fluxo).toMatchObject({ kind: "negocio", etapa: "tipo" });
    p = await F.conduzirFluxo(p.fluxo!, ctx("venda"), d);
    expect(p.reply).toContain("Nome: Carlos");
    expect(p.reply).not.toContain("Que nome");
  });

  it("pergunta na etapa do nome não vira nome", async () => {
    const d = deps({ acao: acaoCom(SEM_CAMPOS) });
    let p: Passo = await F.iniciarFluxo({ tipo: "venda", policy: [...TUDO], agora }, d);
    p = await F.conduzirFluxo(p.fluxo!, ctx("pode ser o endereço?"), d);
    expect(p.reply).toBe("Que nome dou a esse negócio?");
    expect(p.fluxo).toMatchObject({ etapa: "nome" });
  });
});

describe("nome da proposta", () => {
  it("título = nome escrito pela pessoa, sem prefixo", () => {
    const dados = { proponente: { nome: "Letícia Gonçalves Nogueira" } };
    expect(F.argsDaProposta({ natureza: "venda", dados }).title).toBe("Letícia Gonçalves Nogueira");
  });
  it("sem nome do proponente, usa o endereço escrito", () => {
    const dados = { imovel: { endereco: "Rua Senador Godoi, 606" } };
    expect(F.argsDaProposta({ natureza: "venda", dados }).title).toBe("Rua Senador Godoi, 606");
  });
});
