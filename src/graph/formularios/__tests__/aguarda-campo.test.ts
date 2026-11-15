import { describe, expect, it, vi } from "vitest";
import { conduzirFluxo, type ContextoDoTurno, type DepsDoFluxo, type RespostaDoServidor } from "../../fluxos";
import { lerItemDaCaptacao } from "../../captacao";
import { derivarInterativo } from "@/lib/interativo";
import { novoFluxoV2 } from "../estado";
import type { CampoObrigatorio, Pendencia } from "../contrato";
import {
  chaveDaPergunta,
  lerRespostaAoCampo,
  pendenciasIniciais,
  proximaPergunta,
  rascunhoAberto,
  registrarPergunta,
  textoDaOferta,
} from "../proposta-v2";

const agora = 1_000_000;
const CPF_VALIDO = "123.456.789-09"; // sintético, DV válido
const CNPJ_VALIDO = "11.222.333/0001-81"; // sintético, DV válido

const pend = (campo: string, extra: Partial<Pendencia> = {}): Pendencia => ({
  signatario: null,
  campo,
  motivo: "obrigatorio_da_org",
  ...extra,
});

const fluxo = () => novoFluxoV2({ esteira: "venda", agora, schemaType: "compra_venda_v1" });
const comAguarda = (parteRef: string, path: string) => ({ ...fluxo(), aguardaCampo: { parteRef, path } });

describe("proximaPergunta: uma coisa por vez, sem repetir", () => {
  const faltando = [pend("proponente.documento"), pend("proponente.email"), pend("negociacao.valor")];

  it("pergunta só a primeira pendência e diz qual campo a resposta curta vai preencher", () => {
    const p = proximaPergunta(faltando, new Set());
    expect(p).not.toBeNull();
    expect(p!.aguarda).toEqual({ parteRef: "proponente", path: "compradores[0].cpf" });
    expect(p!.pergunta).toMatch(/CPF/i);
    // uma pergunta só: não lista as outras pendências
    expect(p!.pergunta).not.toMatch(/e-mail/i);
    expect(p!.pergunta).not.toMatch(/valor/i);
  });

  it("não repete a que já foi feita: segue para a próxima", () => {
    const feitas = new Set([chaveDaPergunta(faltando[0]!)]);
    const p = proximaPergunta(faltando, feitas);
    expect(p!.aguarda.path).toBe("compradores[0].email");
    const feitas2 = new Set([chaveDaPergunta(faltando[0]!), chaveDaPergunta(faltando[1]!)]);
    expect(proximaPergunta(faltando, feitas2)!.aguarda.path).toBe("negociacao.valor");
  });

  it("tudo já perguntado ou nada faltando: null", () => {
    expect(proximaPergunta([], new Set())).toBeNull();
    expect(proximaPergunta(faltando, new Set(faltando.map(chaveDaPergunta)))).toBeNull();
  });

  it("usa o rótulo do servidor quando o options o traz", () => {
    const obrigatorios: CampoObrigatorio[] = [
      { chave: "corretor.creci", rotulo: "CRECI", grupo: "Corretor da intermediação", esteira: "ambas", tipoCampo: "texto" },
    ];
    const p = proximaPergunta([pend("corretor.creci")], new Set(), obrigatorios);
    expect(p!.pergunta).toContain("CRECI");
  });

  it("o mínimo de testemunhas não é pergunta de campo: pula (é da etapa de assinatura)", () => {
    const f = [pend("testemunhas", { motivo: "minimo_de_testemunhas", minimo: 2, atual: 0 }), pend("negociacao.valor")];
    expect(proximaPergunta(f, new Set())!.aguarda.path).toBe("negociacao.valor");
    expect(proximaPergunta([f[0]!], new Set())).toBeNull();
  });

  it("pessoa da lista: posição e papel viram a referência, e a posição entra no caminho", () => {
    const p = proximaPergunta(
      [pend("proprietarios[].cpf", { signatario: { posicao: 2, papel: "proprietario" }, motivo: "obrigatorio_do_modelo" })],
      new Set()
    );
    expect(p!.aguarda).toEqual({ parteRef: "proprietario:2", path: "proprietarios[1].cpf" });
    expect(p!.pergunta).toMatch(/proprietário 2/i);
  });

  it("a mesma chave em posições diferentes são perguntas diferentes", () => {
    const a = pend("proprietarios[].cpf", { signatario: { posicao: 1, papel: "proprietario" } });
    const b = pend("proprietarios[].cpf", { signatario: { posicao: 2, papel: "proprietario" } });
    expect(chaveDaPergunta(a)).not.toBe(chaveDaPergunta(b));
  });
});

describe("antes de existir rascunho: aguardaCampo desde o primeiro turno", () => {
  it("sem rascunho, as pendências iniciais são os obrigatórios da org, na ordem do servidor", () => {
    const obrigatorios: CampoObrigatorio[] = [
      { chave: "proponente.documento", rotulo: "CPF / CNPJ", grupo: "Comprador / locatário", esteira: "ambas", tipoCampo: "cpf_cnpj" },
      { chave: "negociacao.valor", rotulo: "Valor", grupo: "Negociação", esteira: "ambas", tipoCampo: "moeda" },
    ];
    expect(pendenciasIniciais(obrigatorios)).toEqual([pend("proponente.documento"), pend("negociacao.valor")]);
  });

  it("registrarPergunta grava só caminho e referência no fluxo, nunca valor", () => {
    const p = proximaPergunta([pend("proponente.documento")], new Set())!;
    const f = registrarPergunta(fluxo(), p);
    expect(f.aguardaCampo).toEqual({ parteRef: "proponente", path: "compradores[0].cpf" });
    expect(f.perguntados).toEqual([chaveDaPergunta(pend("proponente.documento"))]);
    expect(JSON.stringify(f)).not.toMatch(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);
  });

  it("resposta curta '123.456.789-09' preenche o campo aguardado, sem existir rascunho", () => {
    const f = comAguarda("proponente", "proponente.documento");
    expect(f.proposalId).toBeUndefined();
    const r = lerRespostaAoCampo(f, CPF_VALIDO);
    expect(r).toEqual({
      tipo: "preenche",
      campo: { parteRef: "proponente", path: "compradores[0].cpf" },
      patch: { compradores: [{ cpf: "12345678909" }] },
    });
  });

  it("CNPJ válido vai no campo cnpj; contraparte vira vendedores", () => {
    const r = lerRespostaAoCampo(comAguarda("contraparte", "contraparte.documento"), `é ${CNPJ_VALIDO}`);
    expect(r).toMatchObject({ tipo: "preenche", patch: { vendedores: [{ cnpj: "11222333000181" }] } });
  });

  it("e-mail, telefone, valor e data caem no campo certo", () => {
    expect(lerRespostaAoCampo(comAguarda("proponente", "proponente.email"), "maria@exemplo.com")).toMatchObject({
      tipo: "preenche", patch: { compradores: [{ email: "maria@exemplo.com" }] },
    });
    expect(lerRespostaAoCampo(comAguarda("proponente", "proponente.telefone"), "(11) 98888-7777")).toMatchObject({
      tipo: "preenche", patch: { compradores: [{ telefone: "11988887777" }] },
    });
    expect(lerRespostaAoCampo(comAguarda("negociacao", "negociacao.valor"), "520 mil")).toMatchObject({
      tipo: "preenche", patch: { negociacao: { valor: 520000 } },
    });
    expect(lerRespostaAoCampo(comAguarda("proponente", "proponente.nascimento"), "31/01/1990")).toMatchObject({
      tipo: "preenche", patch: { compradores: [{ data_nascimento: "1990-01-31" }] },
    });
    expect(lerRespostaAoCampo(comAguarda("corretor", "corretor.creci"), "12345-F")).toMatchObject({
      tipo: "preenche", patch: { corretor: { creci: "12345-F" } },
    });
  });

  it("opção: grava o id, nunca o rótulo (L8)", () => {
    const obrigatorios: CampoObrigatorio[] = [
      {
        chave: "negociacao.modalidade", rotulo: "Modalidade", grupo: "Negociação", esteira: "venda", tipoCampo: "opcao",
        opcoes: [{ id: "a_vista", rotulo: "À vista (recursos próprios)" }, { id: "financiamento", rotulo: "Financiamento bancário" }],
      },
    ];
    const f = comAguarda("negociacao", "negociacao.modalidade");
    expect(lerRespostaAoCampo(f, "financiamento bancário", obrigatorios)).toMatchObject({
      tipo: "preenche", patch: { negociacao: { modalidade: "financiamento" } },
    });
    expect(lerRespostaAoCampo(f, "é à vista", obrigatorios)).toMatchObject({
      tipo: "preenche", patch: { negociacao: { modalidade: "a_vista" } },
    });
    // resposta que não casa nenhuma opção não vira valor inventado
    expect(lerRespostaAoCampo(f, "pensando ainda", obrigatorios).tipo).toBe("liberar");
  });

  it("CPF inválido: pede de novo, sem preencher e sem 'anotei'", () => {
    const r = lerRespostaAoCampo(comAguarda("proponente", "proponente.documento"), "111.111.111-11");
    expect(r.tipo).toBe("invalida");
    if (r.tipo !== "invalida") return;
    expect(r.reply).toMatch(/CPF/);
    expect(r.reply.toLowerCase()).not.toContain("anotei");
  });

  it("caminho indexado do estado (compradores[1].cpf) também preenche, por posição", () => {
    const r = lerRespostaAoCampo(comAguarda("comprador:2", "compradores[1].cpf"), CPF_VALIDO);
    expect(r).toMatchObject({ tipo: "preenche", patch: { compradores: [{}, { cpf: "12345678909" }] } });
  });
});

describe("o fluxo não sequestra a conversa", () => {
  it("sem campo aguardado, nada a preencher: libera", () => {
    expect(lerRespostaAoCampo(fluxo(), CPF_VALIDO).tipo).toBe("liberar");
  });

  it.each([
    "qual a previsão do tempo amanhã?",
    "e o João, já assinou a outra proposta dele?",
    "me explica como funciona o rateio da comissão entre os corretores da equipe",
    "bom dia",
  ])("texto fora do assunto libera: %s", (texto) => {
    expect(lerRespostaAoCampo(comAguarda("proponente", "proponente.documento"), texto).tipo).toBe("liberar");
    expect(lerRespostaAoCampo(comAguarda("negociacao", "negociacao.valor"), texto).tipo).toBe("liberar");
  });

  it("campo de texto livre não engole pergunta nem texto longo", () => {
    expect(lerRespostaAoCampo(comAguarda("corretor", "corretor.nome"), "quanto custa isso?").tipo).toBe("liberar");
    expect(lerRespostaAoCampo(comAguarda("corretor", "corretor.nome"), "x".repeat(300)).tipo).toBe("liberar");
  });

  it("conduzirFluxo continua liberando o turno de um fluxo v2 (o condutor é do PR-C)", async () => {
    const f = comAguarda("proponente", "proponente.documento");
    const ctx: ContextoDoTurno = { texto: "qual a previsão do tempo?", messageId: "m1", policy: [], agora };
    const deps = { acao: vi.fn() } as unknown as DepsDoFluxo;
    const passo = await conduzirFluxo(f, ctx, deps);
    expect(passo.liberar).toBe(true);
    expect(deps.acao).not.toHaveBeenCalled();
  });

  it("M4: o stub só libera e limpa: não cria fluxo v1 (coleta) que ninguém pediu", async () => {
    const f = comAguarda("proponente", "proponente.documento");
    const ctx: ContextoDoTurno = { texto: "oi", messageId: "m1", policy: [], agora };
    const passo = await conduzirFluxo(f, ctx, { acao: vi.fn() } as unknown as DepsDoFluxo);
    expect(passo).toMatchObject({ liberar: true, fluxo: null, evento: "fluxo_v2_sem_condutor" });
  });
});

function depsDeLista(resposta: RespostaDoServidor | null) {
  return { acao: vi.fn(async (_v: string, _a: Record<string, unknown>) => resposta) };
}

describe("rascunhoAberto: retomada de rascunho", () => {
  it("proposta: chama proposal.list com os filtros novos e somente_abertas, e lê o casouPor", async () => {
    const d = depsDeLista({
      status: 200,
      body: { items: [{ id: "prop-1", codigo: "PROP-2026-1", titulo: "Proposta Maria Teste", casouPor: ["cliente"] }], total: 1 },
    });
    const r = await rascunhoAberto(d, "proposta", { cliente: "Maria Teste", imovel: "Rua Exemplo 10" });
    expect(d.acao).toHaveBeenCalledWith("proposal.list", { cliente: "Maria Teste", imovel: "Rua Exemplo 10", somente_abertas: true });
    expect(r.itens).toEqual([
      expect.objectContaining({ id: "prop-1", codigo: "PROP-2026-1", casouPor: ["cliente"] }),
    ]);
    expect(r.itens[0]!.resumo).toContain("PROP-2026-1");
  });

  it("sem pista nenhuma não chama o servidor (a lista inteira não é 'o mesmo cliente')", async () => {
    const d = depsDeLista({ status: 200, body: { items: [] } });
    expect((await rascunhoAberto(d, "proposta", {})).itens).toEqual([]);
    expect((await rascunhoAberto(d, "proposta", { cliente: "   ", imovel: "" })).itens).toEqual([]);
    expect(d.acao).not.toHaveBeenCalled();
  });

  it("só manda a pista que existe e corta em 80 caracteres (acima disso o servidor recusa)", async () => {
    const d = depsDeLista({ status: 200, body: { items: [] } });
    await rascunhoAberto(d, "proposta", { imovel: "r".repeat(120) });
    const args = d.acao.mock.calls[0]![1];
    expect(args).not.toHaveProperty("cliente");
    expect((args.imovel as string).length).toBeLessThanOrEqual(80);
  });

  it("proposal.list truncado vem sinalizado: o Max não afirma 'só esse'", async () => {
    const d = depsDeLista({ status: 200, body: { items: [{ id: "p", codigo: "P-1", titulo: "t", casouPor: ["imovel"] }], truncado: true } });
    expect((await rascunhoAberto(d, "proposta", { imovel: "Rua Exemplo" })).truncado).toBe(true);
  });

  it("403 fluxo_desligado: sem itens e marcado, para o chamador ficar no v1", async () => {
    const d = depsDeLista({ status: 403, body: { error: "fluxo_desligado" } });
    expect(await rascunhoAberto(d, "proposta", { cliente: "Maria" })).toMatchObject({ itens: [], desligado: true });
  });

  it("sem resposta, ou resposta que não é 200: sem itens e sem afirmar nada", async () => {
    expect((await rascunhoAberto(depsDeLista(null), "proposta", { cliente: "Maria" })).itens).toEqual([]);
    expect((await rascunhoAberto(depsDeLista({ status: 500, body: {} }), "proposta", { cliente: "Maria" })).itens).toEqual([]);
  });

  it("captação: captacao.list com os mesmos filtros, item lido pelo leitor da captação", async () => {
    const d = depsDeLista({
      status: 200,
      body: {
        items: [{ id: "cap-1", codigo: "CAP-1", nome: "Captação Rua Exemplo", estado: "Rascunho", endereco: "Rua Exemplo, 10", casouPor: ["imovel"] }],
        total: 1,
      },
    });
    const r = await rascunhoAberto(d, "captacao", { imovel: "Rua Exemplo" });
    expect(d.acao).toHaveBeenCalledWith("captacao.list", { imovel: "Rua Exemplo", somente_abertas: true });
    expect(r.itens).toEqual([expect.objectContaining({ id: "cap-1", casouPor: ["imovel"] })]);
    expect(r.itens[0]!.resumo).toContain("CAP-1");
  });

  it("o leitor de item da captação preserva casouPor e descarta valor desconhecido", () => {
    const item = lerItemDaCaptacao({ id: "c", codigo: "C-1", nome: "n", casouPor: ["cliente", "imovel", "outro"] });
    expect(item?.casouPor).toEqual(["cliente", "imovel"]);
    expect(lerItemDaCaptacao({ id: "c", codigo: "C-1", nome: "n" })).not.toHaveProperty("casouPor");
  });
});

describe("textoDaOferta: continuar o rascunho aberto (botões)", () => {
  const item = (casouPor: Array<"cliente" | "imovel">, n = 1) => ({
    id: `prop-${n}`, codigo: `PROP-2026-${n}`, resumo: `PROP-2026-${n} — Proposta Maria Teste`, casouPor,
  });

  it("um rascunho do mesmo cliente: oferece continuar e vira botões SIM/NÃO", () => {
    const t = textoDaOferta([item(["cliente"])], { truncado: false });
    expect(t).toMatch(/mesmo cliente/);
    expect(t).toContain("PROP-2026-1");
    const ui = derivarInterativo(t);
    expect(ui?.tipo).toBe("botoes");
    expect(ui?.opcoes.map((o) => o.titulo)).toEqual(["SIM", "NÃO"]);
  });

  it("do mesmo imóvel, e dos dois", () => {
    expect(textoDaOferta([item(["imovel"])], { truncado: false })).toMatch(/mesmo imóvel/);
    const dois = textoDaOferta([item(["cliente", "imovel"])], { truncado: false });
    expect(dois).toMatch(/mesmo cliente/);
    expect(dois).toMatch(/mesmo imóvel/);
  });

  it("vários: lista numerada para escolher, com NÃO para criar outro", () => {
    const t = textoDaOferta([item(["cliente"], 1), item(["cliente"], 2)], { truncado: false });
    expect(t).toMatch(/1\) .*PROP-2026-1/);
    expect(t).toMatch(/2\) .*PROP-2026-2/);
    expect(derivarInterativo(t)?.tipo).toBe("lista");
  });

  it("truncado: avisa que só olhou as mais recentes", () => {
    expect(textoDaOferta([item(["cliente"])], { truncado: true })).toMatch(/mais recentes/);
  });

  it("sem itens: texto vazio, nada a oferecer", () => {
    expect(textoDaOferta([], { truncado: false })).toBe("");
  });
});

describe("C1: o caminho do campo aguardado tem UMA forma, a do estado", () => {
  const comprador2 = pend("proponente.documento", { signatario: { posicao: 2, papel: "comprador" } });

  it("o CPF do 2º comprador vira compradores[1].cpf (a chave do catálogo é convertida na entrada)", () => {
    const p = proximaPergunta([comprador2], new Set())!;
    expect(p.aguarda).toEqual({ parteRef: "comprador:2", path: "compradores[1].cpf" });
    expect(p.pergunta).toMatch(/comprador 2/i);
  });

  it("a resposta grava em compradores[1] e NÃO toca compradores[0]", () => {
    const f = registrarPergunta(fluxo(), proximaPergunta([comprador2], new Set())!);
    const r = lerRespostaAoCampo(f, CPF_VALIDO);
    expect(r.tipo).toBe("preenche");
    if (r.tipo !== "preenche") return;
    const compradores = (r.patch as { compradores?: Array<Record<string, unknown>> }).compradores!;
    expect(compradores).toHaveLength(2);
    expect(compradores[0]).toEqual({});
    expect(compradores[1]).toEqual({ cpf: "12345678909" });
  });

  it("checkpoint com a chave do catálogo e parteRef com posição também grava na posição certa", () => {
    const r = lerRespostaAoCampo(comAguarda("comprador:2", "proponente.documento"), CPF_VALIDO);
    expect(r).toMatchObject({ tipo: "preenche", patch: { compradores: [{}, { cpf: "12345678909" }] } });
  });

  it("vendedor 3 (papel proprietario) vira vendedores[2]; contraparte sem signatário vira vendedores[0]", () => {
    const p = proximaPergunta([pend("contraparte.email", { signatario: { posicao: 3, papel: "vendedor" } })], new Set())!;
    expect(p.aguarda.path).toBe("vendedores[2].email");
    expect(proximaPergunta([pend("contraparte.email")], new Set())!.aguarda.path).toBe("vendedores[0].email");
  });

  it("CNPJ no campo cpf do comprador 2 vai como cnpj", () => {
    const r = lerRespostaAoCampo(comAguarda("comprador:2", "compradores[1].cpf"), CNPJ_VALIDO);
    expect(r).toMatchObject({ tipo: "preenche", patch: { compradores: [{}, { cnpj: "11222333000181" }] } });
  });

  it("o tipo do campo vem do options mesmo com o índice de outra posição", () => {
    const obrigatorios: CampoObrigatorio[] = [
      { chave: "proponente.nascimento", rotulo: "Nascimento", grupo: "Comprador", esteira: "ambas", tipoCampo: "data" },
    ];
    const r = lerRespostaAoCampo(comAguarda("comprador:2", "compradores[1].data_nascimento"), "31/01/1990", obrigatorios);
    expect(r).toMatchObject({ tipo: "preenche", patch: { compradores: [{}, { data_nascimento: "1990-01-31" }] } });
  });
});

describe("I4: comando, verbo de fluxo, sim/não e saudação não viram resposta de campo livre", () => {
  it.each([
    "espera um pouco",
    "manda o link",
    "cancela",
    "cancelar",
    "para",
    "sim",
    "não",
    "ok",
    "bom dia",
    "pera aí",
    "me manda o resumo",
    "deixa pra lá",
  ])("%s libera em campo de texto", (texto) => {
    for (const path of ["corretor.nome", "imovel.endereco", "observacoes", "corretor.creci"]) {
      expect(lerRespostaAoCampo(comAguarda(path.split(".")[0]!, path), texto).tipo).toBe("liberar");
    }
  });

  it("nome que só começa parecido continua valendo (Pereira, Paraná)", () => {
    expect(lerRespostaAoCampo(comAguarda("corretor", "corretor.nome"), "Pereira Teste")).toMatchObject({ tipo: "preenche" });
    expect(lerRespostaAoCampo(comAguarda("imovel", "imovel.endereco"), "Paraná, 100")).toMatchObject({ tipo: "preenche" });
  });
});

describe("I5: captação, caminho proprietarios[n].campo com a posição dentro do papel", () => {
  it("proprietarios[1].cpf preenche a 2ª posição da lista e deixa a 1ª quieta", () => {
    const r = lerRespostaAoCampo(comAguarda("proprietario:2", "proprietarios[1].cpf"), CPF_VALIDO);
    expect(r).toMatchObject({
      tipo: "preenche",
      campo: { parteRef: "proprietario:2", path: "proprietarios[1].cpf" },
    });
    if (r.tipo !== "preenche") return;
    const lista = (r.patch as { proprietarios?: Array<Record<string, unknown>> }).proprietarios!;
    expect(lista[0]).toEqual({});
    expect(lista[1]).toEqual({ cpf: "12345678909" });
  });

  it("conjuge e representante têm a própria lista, com posição dentro do papel", () => {
    const c = lerRespostaAoCampo(comAguarda("conjuge:1", "conjuges[0].cpf"), CPF_VALIDO);
    expect(c).toMatchObject({ tipo: "preenche", patch: { conjuges: [{ cpf: "12345678909" }] } });
    const r = lerRespostaAoCampo(comAguarda("representante:2", "representantes[1].email"), "rep@exemplo.com");
    expect(r).toMatchObject({ tipo: "preenche", patch: { representantes: [{}, { email: "rep@exemplo.com" }] } });
  });

  it("a pendência da captação (proprietarios[].cpf + signatário) vira o caminho indexado pelo papel", () => {
    const p = proximaPergunta([pend("proprietarios[].cpf", { signatario: { posicao: 2, papel: "conjuge" } })], new Set())!;
    expect(p.aguarda).toEqual({ parteRef: "conjuge:2", path: "conjuges[1].cpf" });
  });

  it("campo do imóvel da captação (imovel.matricula) também preenche", () => {
    expect(lerRespostaAoCampo(comAguarda("imovel", "imovel.matricula"), "12345")).toMatchObject({
      tipo: "preenche", patch: { imovel: { matricula: "12345" } },
    });
  });

  it("CPF inválido do proprietário pede de novo", () => {
    expect(lerRespostaAoCampo(comAguarda("proprietario:1", "proprietarios[0].cpf"), "111.111.111-11").tipo).toBe("invalida");
  });
});

describe("M7: valor em reais exige marca de dinheiro", () => {
  it.each(["são 2 compradores", "quero 3 vias", "moro no 12", "2"])("%s não é valor", (texto) => {
    expect(lerRespostaAoCampo(comAguarda("negociacao", "negociacao.valor"), texto).tipo).toBe("liberar");
  });

  it.each([
    ["R$ 520.000,00", 520000],
    ["520 mil", 520000],
    ["1.500.000", 1500000],
    ["520000", 520000],
    ["1,5 milhão", 1500000],
  ])("%s é valor", (texto, valor) => {
    expect(lerRespostaAoCampo(comAguarda("negociacao", "negociacao.valor"), texto)).toMatchObject({
      tipo: "preenche", patch: { negociacao: { valor } },
    });
  });
});

describe("M8: a oferta diz quantos ficaram de fora", () => {
  it("mais de 5 rascunhos: lista 5 e diz 'e mais N'", () => {
    const itens = Array.from({ length: 8 }, (_, n) => ({
      id: `p${n}`, codigo: `PROP-${n}`, resumo: `PROP-${n} — Proposta`, casouPor: ["cliente" as const],
    }));
    const t = textoDaOferta(itens, { truncado: false });
    expect(t).toMatch(/e mais 3/);
    expect(t).not.toMatch(/6\) /);
    expect(derivarInterativo(t)?.tipo).toBe("lista");
  });
});
