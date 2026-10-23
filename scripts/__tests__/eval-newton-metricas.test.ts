import { describe, expect, it } from "vitest";
import { SUFIXO_RESTO } from "../../src/graph/compose";
import {
  CUSTO_ESTIMADO_POR_CHAMADA_USD, EVAL_MAX_USD_PADRAO, criarOrcamento, lerTetoDeCusto, numerosSemTool, percentil,
  resumoNewton, sinaisDePersona, type TurnoNewton,
} from "../eval-quality";

const turno = (over: Partial<TurnoNewton> = {}): TurnoNewton => ({
  caseId: "c1", fala: "quais meus negócios?", resposta: "Você tem 2 negócios abertos.",
  esperados: { todos: ["deal.list"], algum: [] }, leituras: ["deal.list"], escritas: [],
  argsOk: true, filtrosNaoPedidos: [], ...over,
});
const gate = (r: ReturnType<typeof resumoNewton>, id: string) => r.gates.find((g) => g.id === id)!;

describe("sinaisDePersona", () => {
  it("conta emoji, bullet e lista numerada", () => {
    const s = sinaisDePersona("Achei:\n- Apto 302\n- Casa Jardim\n1. um\n2) dois 😊👍");
    expect(s.emojis).toBe(2);
    expect(s.bullets).toBe(2);
    expect(s.numerados).toBe(2);
  });
  it("detecta oferta final de ajuda, com e sem acento", () => {
    for (const t of ["Tem 2 negócios. Posso ajudar em mais alguma coisa?", "Pronto. Fico à disposição.", "Feito. Se precisar de algo, é só me chamar.", "Ok. Algo mais?"]) {
      expect(sinaisDePersona(t).ofertaFinal, t).toBe(true);
    }
    expect(sinaisDePersona("Você tem 2 negócios em Documentação.").ofertaFinal).toBe(false);
  });
  it("detecta narração de tool, mas não a resposta direta", () => {
    for (const t of ["Vou consultar seus negócios agora.", "Um instante, estou verificando.", "Deixa eu buscar isso."]) {
      expect(sinaisDePersona(t).narracaoDeTool, t).toBe(true);
    }
    expect(sinaisDePersona("São 2 negócios em Documentação.").narracaoDeTool).toBe(false);
  });
  it("trata o sufixo de resto como CONTINUAÇÃO, nunca como oferta final", () => {
    const s = sinaisDePersona(`Você tem 6 negócios: A, B, C. ${SUFIXO_RESTO}`);
    expect(s.continuacao).toBe(true);
    expect(s.ofertaFinal).toBe(false);
    expect(sinaisDePersona("Você tem 2 negócios.").continuacao).toBe(false);
  });
  it("oferta de ajuda continua sendo oferta mesmo ao lado do sufixo de resto", () => {
    const s = sinaisDePersona(`Lista. ${SUFIXO_RESTO} Posso ajudar em mais alguma coisa?`);
    expect(s.continuacao).toBe(true);
    expect(s.ofertaFinal).toBe(true);
  });
});

describe("numerosSemTool", () => {
  it("número na resposta sem nenhuma tool é fabricação", () => {
    expect(numerosSemTool("O valor é R$ 450.000 e são 3 vagas.", "qual o valor?", 0)).toEqual(["450.000", "3"]);
  });
  it("com tool chamada no turno, não acusa", () => {
    expect(numerosSemTool("São 6 negócios.", "quantos?", 1)).toEqual([]);
  });
  it("número que a pessoa escreveu e voltou no texto não conta", () => {
    expect(numerosSemTool("Não achei o negócio 3.", "e o negócio 3?", 0)).toEqual([]);
  });
});

describe("percentil", () => {
  it("lista vazia não tem percentil", () => expect(percentil([], 0.9)).toBeNull());
  it("método do posto mais próximo, sem interpolar", () => {
    expect(percentil([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9)).toBe(90);
    expect(percentil([5], 0.9)).toBe(5);
    expect(percentil([30, 10, 20], 0.5)).toBe(20);
  });
});

describe("resumoNewton", () => {
  it("sem turnos nada passa: métrica sem denominador é não medida", () => {
    const r = resumoNewton([]);
    expect(r.gatePassed).toBe(false);
    expect(r.gates.every((g) => !g.ok)).toBe(true);
  });
  it("turnos limpos aprovam todos os gates", () => {
    const r = resumoNewton([turno(), turno({ caseId: "c2" })]);
    expect(r.gates.filter((g) => !g.ok).map((g) => g.id)).toEqual([]);
    expect(r.gatePassed).toBe(true);
    expect(r.tools).toMatchObject({ recall: 1, precisao: 1, args: 1 });
  });
  it("sem nenhum turno que confira argumentos, args_corretos fica não medido e reprova", () => {
    const r = resumoNewton([turno({ argsOk: null })]);
    expect(gate(r, "args_corretos").ok).toBe(false);
    expect(r.tools.args).toBeNull();
  });
  it("turno livre não pontua recall nem precisão", () => {
    const r = resumoNewton([turno({ esperados: null, leituras: ["deal.list", "activity.list"] })]);
    expect(r.tools.esperados).toBe(0);
    expect(r.tools.recall).toBeNull();
    expect(gate(r, "recall_de_tool").ok).toBe(false);
  });
  it("emoji, oferta final e narração reprovam seus gates", () => {
    expect(gate(resumoNewton([turno({ resposta: "Tem 2 negócios 😊" })]), "emoji").ok).toBe(false);
    expect(gate(resumoNewton([turno({ resposta: "Tem 2 negócios. Posso ajudar em mais alguma coisa?" })]), "oferta_final").ok).toBe(false);
    expect(gate(resumoNewton([turno({ resposta: "Vou consultar. Tem 2 negócios." })]), "narracao_de_tool").ok).toBe(false);
  });
  it("sufixo de resto não reprova oferta_final, mas conta como continuação", () => {
    const r = resumoNewton([turno({ resposta: `Tem 6 negócios. ${SUFIXO_RESTO}` })]);
    expect(gate(r, "oferta_final").ok).toBe(true);
    expect(r.continuacoes.turnos).toBe(1);
    expect(gate(r, "continuacoes").ok).toBe(false);
  });
  it("continuações até 5% passam: 1 em 20", () => {
    const limpos = Array.from({ length: 19 }, (_, i) => turno({ caseId: `l${i}` }));
    const r = resumoNewton([...limpos, turno({ caseId: "x", resposta: `Tem 6. ${SUFIXO_RESTO}` })]);
    expect(r.continuacoes.taxa).toBe(0.05);
    expect(gate(r, "continuacoes").ok).toBe(true);
  });
  it("P90 de caracteres acima de 350 reprova", () => {
    const longo = "x".repeat(400);
    const r = resumoNewton(Array.from({ length: 10 }, (_, i) => turno({ caseId: `p${i}`, resposta: i < 2 ? longo : "ok" })));
    expect(r.chars.p90).toBe(400);
    expect(gate(r, "p90_chars").ok).toBe(false);
  });
  it("recall abaixo de 85% reprova e verbo esperado ausente conta", () => {
    const r = resumoNewton([turno({ leituras: [] }), turno({ caseId: "b" })]);
    expect(r.tools.recall).toBe(0.5);
    expect(gate(r, "recall_de_tool").ok).toBe(false);
  });
  it("ouVerbos: basta um e conta uma vez; chamada fora do aceito reduz a precisão", () => {
    const ok = resumoNewton([turno({ esperados: { todos: [], algum: ["deal.pending", "deal.list"] }, leituras: ["deal.list"] })]);
    expect(ok.tools).toMatchObject({ esperados: 1, recall: 1, precisao: 1 });
    const extra = resumoNewton([turno({ leituras: ["deal.list", "property.list"] })]);
    expect(extra.tools.precisao).toBe(0.5);
    expect(gate(extra, "precisao_de_tool").ok).toBe(false);
  });
  it("filtro não pedido, fabricação e escrita indevida reprovam", () => {
    expect(gate(resumoNewton([turno({ filtrosNaoPedidos: ["deal.list: estado=venda"] })]), "filtros_nao_pedidos").ok).toBe(false);
    const fab = resumoNewton([turno({ resposta: "O valor é 450.000", fala: "qual o valor?", leituras: [], esperados: null })]);
    expect(gate(fab, "fabricacao_de_numero").ok).toBe(false);
    expect(fab.casosComFabricacao[0]).toContain("c1");
    expect(gate(resumoNewton([turno({ escritas: ["activity.create"] })]), "escrita_indevida").ok).toBe(false);
  });
});

describe("teto de custo (EVAL_MAX_USD)", () => {
  it("padrão 0.50 quando não informado", () => {
    expect(EVAL_MAX_USD_PADRAO).toBe(0.5);
    expect(lerTetoDeCusto(undefined)).toBe(0.5);
    expect(lerTetoDeCusto("  ")).toBe(0.5);
    expect(lerTetoDeCusto("1.25")).toBe(1.25);
  });
  it("valor inválido ou não positivo lança, em vez de desligar o teto", () => {
    for (const v of ["abc", "0", "-1", "NaN", "Infinity"]) expect(() => lerTetoDeCusto(v), v).toThrow(/EVAL_MAX_USD inválido/);
  });
  it("aborta ao atingir o teto, não só ao passar", () => {
    const o = criarOrcamento(0.01);
    o.gastar([0.004]);
    expect(() => o.conferir()).not.toThrow();
    o.gastar([0.006]);
    expect(o.gasto).toBeCloseTo(0.01);
    expect(() => o.conferir()).toThrow(/EVAL_MAX_USD excedido/);
  });
  it("custo desconhecido é estimado, nunca zero", () => {
    const o = criarOrcamento(1);
    o.gastar([null, undefined, Number.NaN]);
    expect(o.gasto).toBeCloseTo(3 * CUSTO_ESTIMADO_POR_CHAMADA_USD);
  });
});
