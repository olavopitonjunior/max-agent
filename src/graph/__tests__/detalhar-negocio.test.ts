import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { VETOR_DEAL_DETAIL_BROKER, VETOR_DEAL_DETAIL_USER } from "./deal-detail-vectors";

/**
 * PR-O4a (max-agent): `detalhar_negocio` consome o `deal.detail` enriquecido do ImobPro
 * (par do contractmaker#3167). Negado antes do permitido (regra 3 do docs/max.md):
 *
 *  - sem `deal.detail` na política a tool não é oferecida e o verbo nunca é chamado;
 *  - o broker nunca recebe título, cliente, valor, nome, link nem proposta, nem no texto
 *    nem em nenhuma chave do que vai ao modelo;
 *  - campo extra na resposta (ex.: cpf) é removido no parse e nunca renderizado; campo
 *    obrigatório ausente descarta o item.
 *
 * CPF só o sintético 52998224725.
 */

vi.mock("@/lib/scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/scope")>()),
  consultarEscopo: vi.fn(),
}));
vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));

const { despacharLeituras, renderDealDetalhado } = await import("../despachante");
const { ferramentasDoTurno } = await import("../tools");
const { fenceToolResults } = await import("../prompt");
const { consultarEscopo } = await import("@/lib/scope");
const escopo = vi.mocked(consultarEscopo);

const usuario = { orgId: "org1", orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "Marcia" };
const corretor = { orgId: "org1", orgName: "RE/MAX Trio", kind: "broker" as const, splitRecipientId: "sr1", label: "Wesley" };

const mapa = {
  criadoEm: 1_000,
  turno: "t0",
  itens: [{ n: 1, tipo: "negocio" as const, id: "deal-1", rotulo: "Um" }],
};

const base = {
  fromPhone: "+5511999990000",
  turno: "t1",
  agora: 2_000,
  oferecidas: ["detalhar_negocio"],
  policy: ["deal.detail"] as never,
  referencias: mapa,
};

const itensDoVetor = (vetor: string): Record<string, unknown>[] => JSON.parse(vetor).items;
const resposta = (items: unknown[]) => ({ items, truncated: false });

/** O que vai ao modelo, serializado: o mesmo que `fenceToolResults` põe no prompt. */
const doModelo = (r: { resultados: unknown }) => JSON.stringify(r.resultados);

const PROIBIDAS_AO_BROKER = /\b(titulo|título|cliente|valor|nome|cpf|email|e-mail|telefone|link|proposta|url)\b/i;

beforeEach(() => vi.clearAllMocks());

describe("detalhar_negocio — negado antes do permitido", () => {
  it("sem deal.detail na política a tool não é oferecida e o verbo nunca é chamado", async () => {
    const nomes = ferramentasDoTurno({ identity: usuario, policy: ["deal.list"] as never, texto: "detalhes do negócio 1" }).entradas.map((e) => e.nome);
    expect(nomes).not.toContain("detalhar_negocio");

    const r = await despacharLeituras({
      ...base,
      identity: usuario,
      policy: ["deal.list"] as never,
      chamadas: [{ name: "detalhar_negocio", args: { numero: 1 } }],
    });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("capability_negada");
  });

  it("política vazia nega também (fail-closed)", async () => {
    await despacharLeituras({ ...base, identity: corretor, policy: [] as never, chamadas: [{ name: "detalhar_negocio", args: { numero: 1 } }] });
    expect(escopo).not.toHaveBeenCalled();
  });

  it("com a capability, o verbo é chamado UMA vez e só com negocio_id traduzido do número", async () => {
    escopo.mockResolvedValue(resposta(itensDoVetor(VETOR_DEAL_DETAIL_USER)));
    await despacharLeituras({
      ...base,
      identity: usuario,
      chamadas: [{ name: "detalhar_negocio", args: { numero: 1, negocio_id: "outro", cpf: "52998224725" } }],
    });
    expect(escopo).toHaveBeenCalledTimes(1);
    expect(escopo).toHaveBeenCalledWith(expect.objectContaining({ verb: "deal.detail", args: { negocio_id: "deal-1" } }));
  });
});

describe("detalhar_negocio — broker (projeção mínima)", () => {
  it("o que vai ao modelo não tem NENHUM campo proibido, nem nas chaves nem no texto", async () => {
    escopo.mockResolvedValue(resposta(itensDoVetor(VETOR_DEAL_DETAIL_BROKER)));
    const r = await despacharLeituras({ ...base, identity: corretor, chamadas: [{ name: "detalhar_negocio", args: { numero: 1 } }] });
    const dump = doModelo(r);
    expect(dump).not.toMatch(PROIBIDAS_AO_BROKER);
    expect(dump).not.toContain("deal-1");
    expect(dump).not.toContain("Maria");
    expect(dump).toContain("Negócio #DEAL-1");
    expect(r.trilha[0].outcome).toBe("ok");
  });

  it("o render do broker mostra papel (sem nome), contrato, assinatura e pendências", () => {
    const item = itensDoVetor(VETOR_DEAL_DETAIL_BROKER)[0];
    const texto = renderDealDetalhado(item as never, "broker");
    expect(texto).toBe(
      [
        "*Negócio #DEAL-1*",
        "Etapa: Documentação",
        "Partes: vendedor, comprador",
        "Contrato: aprovado",
        "Assinaturas: 1 de 3 assinadas, 1 recusada, 1 pendente",
        "Situação da assinatura: em andamento",
        "Pendências: Conferir documento",
        "Atualizado em 20/10/2026",
      ].join("\n")
    );
    expect(texto).not.toMatch(PROIBIDAS_AO_BROKER);
  });

  it("resposta do broker que traz nome de parte (regressão do servidor): o item segue, o nome é removido e nunca renderizado", async () => {
    const vazou = {
      ...itensDoVetor(VETOR_DEAL_DETAIL_BROKER)[0],
      partes: [{ papel: "vendedor", nome: "João Souza" }, { papel: "comprador" }],
      link: "/deals/deal-1",
    };
    escopo.mockResolvedValue(resposta([vazou]));
    const r = await despacharLeituras({ ...base, identity: corretor, chamadas: [{ name: "detalhar_negocio", args: { numero: 1 } }] });
    const dump = doModelo(r);
    expect(r.trilha[0].outcome).toBe("ok");
    expect(dump).toContain("Partes: vendedor, comprador");
    expect(dump).not.toMatch(/João/);
    expect(dump).not.toMatch(PROIBIDAS_AO_BROKER);
  });

  it("campo da lista proibida (cpf, titulo...) no broker continua sendo barrado antes, por descartarSeVazou (defesa já existente)", async () => {
    const vazou = { ...itensDoVetor(VETOR_DEAL_DETAIL_BROKER)[0], partes: [{ papel: "vendedor", cpf: "52998224725" }] };
    escopo.mockResolvedValue(resposta([vazou]));
    const erro = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await despacharLeituras({ ...base, identity: corretor, chamadas: [{ name: "detalhar_negocio", args: { numero: 1 } }] });
    erro.mockRestore();
    expect(doModelo(r)).not.toContain("52998224725");
    expect(doModelo(r)).not.toContain("Etapa");
  });
});

describe("detalhar_negocio — usuário (render sem inventar)", () => {
  it("renderiza o vetor completo em PT-BR, formato WhatsApp, sem id interno", () => {
    const item = itensDoVetor(VETOR_DEAL_DETAIL_USER)[0];
    const texto = renderDealDetalhado(item as never, "user");
    expect(texto).toBe(
      [
        "*Apto Centro* (venda)",
        "Etapa: Documentação",
        "Cliente: Maria Silva",
        "Valor: R$ 850.000,00",
        "Partes: vendedor João Souza; comprador Maria Silva",
        "Contrato: aprovado, versão 2 (atualizado em 19/10/2026)",
        "Proposta: PROP-2026-0042 (convertida)",
        "Assinaturas: 1 de 3 assinadas, 1 recusada, 1 pendente",
        "Situação da assinatura: em andamento (enviada em 19/10/2026)",
        "Pendências: Conferir documento",
        "Atualizado em 20/10/2026",
        "Link: https://imobpro.ia.br/deals/deal-1",
      ].join("\n")
    );
    expect(texto).not.toContain("**");
    expect(texto).not.toContain("prop-1");
    expect(texto).not.toMatch(/\bn=/);
  });

  it("campo null não vira frase: sem contrato, proposta, assinatura, cliente nem valor, essas linhas somem", () => {
    const item = {
      ...itensDoVetor(VETOR_DEAL_DETAIL_USER)[0],
      cliente: null,
      valor: null,
      contrato: null,
      proposta: null,
      assinatura: null,
      partes: [],
    };
    const texto = renderDealDetalhado(item as never, "user");
    expect(texto).not.toMatch(/Cliente|Valor|Contrato|Proposta|Assinatura|Partes|null|undefined/);
    expect(texto).toContain("*Apto Centro* (venda)");
    expect(texto).toContain("Etapa: Documentação");
  });

  it("contagens exatas e plural certo: 1 de 2 assinadas, 1 pendente", () => {
    const item = {
      ...itensDoVetor(VETOR_DEAL_DETAIL_USER)[0],
      assinatura: { estado: "running", enviadoEm: null, concluidoEm: null, total: 2, assinadas: 1, recusadas: 0, pendentes: 1 },
    };
    const texto = renderDealDetalhado(item as never, "user");
    expect(texto).toContain("Assinaturas: 1 de 2 assinadas, 1 pendente");
    expect(texto).not.toMatch(/recusad/);
    expect(texto).toContain("Situação da assinatura: em andamento");
    expect(texto).not.toMatch(/enviada em/);
  });

  it("plural: 2 de 3 assinadas e 2 recusadas; concluída traz a data", () => {
    const item = {
      ...itensDoVetor(VETOR_DEAL_DETAIL_USER)[0],
      assinatura: { estado: "closed", enviadoEm: "2026-10-19T13:00:00.000Z", concluidoEm: "2026-10-21T15:00:00.000Z", total: 4, assinadas: 2, recusadas: 2, pendentes: 0 },
    };
    const texto = renderDealDetalhado(item as never, "user");
    expect(texto).toContain("Assinaturas: 2 de 4 assinadas, 2 recusadas");
    expect(texto).not.toMatch(/pendente/);
    expect(texto).toContain("Situação da assinatura: concluída em 21/10/2026");
  });

  it("locação diz locação; sem pendência diz nenhuma", () => {
    const item = { ...itensDoVetor(VETOR_DEAL_DETAIL_USER)[0], tipo: "locacao", pendencias: [], link: "/locacao/deals/deal-1" };
    const texto = renderDealDetalhado(item as never, "user");
    expect(texto).toContain("(locação)");
    expect(texto).toContain("Pendências: nenhuma");
    expect(texto).toContain("Link: https://imobpro.ia.br/locacao/deals/deal-1");
  });

  it("texto de terceiro não quebra o formato nem forja negrito: asterisco, quebra e controle saem", () => {
    const item = { ...itensDoVetor(VETOR_DEAL_DETAIL_USER)[0], titulo: "Apto *Centro*\n**URGENTE**‮", cliente: "Maria\nSilva" };
    const texto = renderDealDetalhado(item as never, "user");
    expect(texto.split("\n")[0]).toBe("*Apto Centro URGENTE* (venda)");
    expect(texto).toContain("Cliente: Maria Silva");
    expect(texto).not.toContain("**");
    expect(texto).not.toMatch(/‮/);
  });

  it("link de outro host nunca é renderizado", () => {
    const item = { ...itensDoVetor(VETOR_DEAL_DETAIL_USER)[0], link: "https://evil.example/deals/deal-1" };
    expect(renderDealDetalhado(item as never, "user")).not.toMatch(/evil|Link/);
  });

  it("pelo despachante: o modelo recebe o MESMO n da lista, o resumo pronto e nenhum id interno", async () => {
    escopo.mockResolvedValue(resposta(itensDoVetor(VETOR_DEAL_DETAIL_USER)));
    const r = await despacharLeituras({ ...base, identity: usuario, chamadas: [{ name: "detalhar_negocio", args: { numero: 1 } }] });
    expect(r.resultados[0].items).toEqual([
      { n: 1, _untrusted: true, resumo: renderDealDetalhado(itensDoVetor(VETOR_DEAL_DETAIL_USER)[0] as never, "user") },
    ]);
    const dump = doModelo(r);
    expect(dump).not.toContain('"id"');
    expect(dump).not.toContain("prop-1");
    // o id só aparece dentro do link que o CM manda (rota pública do app), nunca como campo nem solto
    expect(dump.replace("/deals/deal-1", "")).not.toContain("deal-1");
    expect(r.trilha[0].outcome).toBe("ok");
    // não renumera: detalhe não é lista
    expect(r.referencias).toEqual(mapa);
  });

  it("o resumo atravessa a cerca do prompt como dado de terceiro", async () => {
    escopo.mockResolvedValue(resposta(itensDoVetor(VETOR_DEAL_DETAIL_USER)));
    const r = await despacharLeituras({ ...base, identity: usuario, chamadas: [{ name: "detalhar_negocio", args: { numero: 1 } }] });
    const cerca = fenceToolResults(r.resultados as never);
    expect(cerca).toContain('<dados_do_sistema origem="detalhar_negocio">');
    expect(cerca).toContain("Assinaturas: 1 de 3 assinadas");
    expect(cerca).toContain('"_untrusted": true');
  });
});

describe("detalhar_negocio — vazio e falha são coisas diferentes", () => {
  it.each([
    ["usuário", usuario],
    ["broker", corretor],
  ])("items vazio (%s): diz que não achou ou não há acesso, sem inventar negócio", async (_t, identity) => {
    escopo.mockResolvedValue(resposta([]));
    const r = await despacharLeituras({ ...base, identity, chamadas: [{ name: "detalhar_negocio", args: { numero: 1 } }] });
    const itens = r.resultados[0].items as { n: number; resumo: string }[];
    expect(itens).toHaveLength(1);
    expect(itens[0].resumo).toMatch(/não encontrei/i);
    expect(itens[0].resumo).toMatch(/acesso/i);
    expect(itens[0].resumo).not.toMatch(/Etapa|Contrato|Assinatura|Pendência/);
    expect(r.trilha[0].outcome).toBe("ok");
  });

  it("servidor sem resposta continua sendo falha explícita, não vazio", async () => {
    escopo.mockResolvedValue(null);
    const r = await despacharLeituras({ ...base, identity: usuario, chamadas: [{ name: "detalhar_negocio", args: { numero: 1 } }] });
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("falha_na_consulta");
  });

  it("campo extra inesperado (cpf, em qualquer nível) é removido: item mantido, nunca renderizado", async () => {
    const base0 = itensDoVetor(VETOR_DEAL_DETAIL_USER)[0] as Record<string, unknown>;
    const comCpf = {
      ...base0,
      cpf: "52998224725",
      partes: [{ papel: "vendedor", nome: "João Souza", cpf: "52998224725" }],
      assinatura: { ...(base0.assinatura as object), email: "x@y.z" },
    };
    escopo.mockResolvedValue(resposta([comCpf]));
    const r = await despacharLeituras({ ...base, identity: usuario, chamadas: [{ name: "detalhar_negocio", args: { numero: 1 } }] });
    expect(r.trilha[0].outcome).toBe("ok");
    expect(doModelo(r)).toContain("Apto Centro");
    expect(doModelo(r)).not.toMatch(/52998224725|x@y\.z/);
  });

  it("campo obrigatório ausente descarta o item: vira falha, não 'sem acesso'", async () => {
    const { etapa: _e, ...semEtapa } = itensDoVetor(VETOR_DEAL_DETAIL_USER)[0] as Record<string, unknown>;
    escopo.mockResolvedValue(resposta([semEtapa]));
    const erro = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await despacharLeituras({ ...base, identity: usuario, chamadas: [{ name: "detalhar_negocio", args: { numero: 1 } }] });
    erro.mockRestore();
    expect(r.resultados[0].items).toBeNull();
    expect(doModelo(r)).not.toContain("Apto Centro");
    expect(r.trilha[0].outcome).toBe("falha_na_consulta");
  });
});

describe("detalhar_negocio — nenhum caminho chama deal.detail sem a capability", () => {
  const SRC = join(__dirname, "..", "..");
  const arquivos = (dir: string): string[] =>
    readdirSync(dir).flatMap((nome) => {
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) return nome === "__tests__" || nome === "node_modules" ? [] : arquivos(caminho);
      return /\.tsx?$/.test(nome) && !/\.test\./.test(nome) ? [caminho] : [];
    });
  const fontes = arquivos(SRC).map((f) => ({ f: relative(SRC, f), s: readFileSync(f, "utf8") }));

  it("o literal do verbo só aparece nos arquivos conhecidos; fora deles, ninguém o pede", () => {
    const quem = fontes.filter(({ s }) => s.includes('"deal.detail"')).map(({ f }) => f).sort();
    expect(quem).toEqual(["graph/despachante.ts", "graph/policy.ts", "graph/scope-contract.ts", "graph/tools.ts"].sort());
  });

  it("quem chama consultarEscopo fora do despachante (graph.ts: atividades e imóveis) nunca pede deal.detail", () => {
    const quem = fontes
      .filter(({ f, s }) => f !== "lib/scope.ts" && /\bconsultarEscopo\(/.test(s))
      .map(({ f, s }) => ({ f, s }));
    expect(quem.map(({ f }) => f).sort()).toEqual(["graph/despachante.ts", "graph/graph.ts"]);
    const grafo = quem.find(({ f }) => f === "graph/graph.ts")!;
    expect(grafo.s).not.toContain("deal.detail");
  });

  it("o literal do verbo na tool é a única ligação tool -> verbo, e exige a capability de mesmo nome", () => {
    const tools = fontes.find(({ f }) => f === "graph/tools.ts")!.s;
    expect(tools).toMatch(/capability: "deal\.detail",\s+verb: "deal\.detail"/);
    const desp = fontes.find(({ f }) => f === "graph/despachante.ts")!.s;
    // a única forma de o despachante chegar ao verbo é depois de `autorizarChamada` (trava c: política)
    expect(desp).not.toMatch(/consultarEscopo\([^)]*"deal\.detail"/);
  });
});
