import { afterEach, describe, expect, it, vi } from "vitest";
import { lerIntencaoDeFormulario, normalizarParaIntencao } from "../intencao";
import { ehPedidoDeCriacao } from "../../tools";
import { pedeConsulta } from "../../consulta";
import { pedeEdicao, pedeGestao } from "../../gestao";

const ORG = "org-piloto";

afterEach(() => vi.unstubAllEnvs());

describe("normalizarParaIntencao", () => {
  it("minúsculas, sem acento, espaços colapsados", () => {
    expect(normalizarParaIntencao("  Cria  uma PROPOSTA ")).toBe("cria uma proposta");
    expect(normalizarParaIntencao("captação")).toBe("captacao");
  });

  it.each([
    ["propsta", "proposta"],
    ["porposta", "proposta"],
    ["proposa", "proposta"],
    ["captaçao", "captacao"],
    ["capitação", "captacao"],
    ["formulaio", "formulario"],
    ["propostas", "propostas"],
    ["porpostas", "propostas"],
  ])("%s vira %s (distância <= 1)", (entrada, esperado) => {
    expect(normalizarParaIntencao(entrada)).toBe(esperado);
  });

  it("é idempotente", () => {
    const uma = normalizarParaIntencao("cria uma porposta pro João");
    expect(normalizarParaIntencao(uma)).toBe(uma);
  });

  it("palavra real que fica a 1 edição não é trocada", () => {
    expect(normalizarParaIntencao("foi proposto um valor")).toBe("foi proposto um valor");
    expect(normalizarParaIntencao("preciso do contato dele")).toBe("preciso do contato dele");
  });

  it("não confunde propósito com proposta (distância 2)", () => {
    expect(normalizarParaIntencao("propósito")).toBe("proposito");
    expect(normalizarParaIntencao("qual o propósito disso")).toBe("qual o proposito disso");
  });

  it("palavra curta nunca é corrigida", () => {
    // "ficha" tem 5 letras: nem é candidata.
    expect(normalizarParaIntencao("ficho")).toBe("ficho");
  });
});

describe("lerIntencaoDeFormulario: negados primeiro", () => {
  it.each([
    "qual o propósito dessa conversa?",
    "o propósito de criar isso é outro",
    "foi proposto um valor de 500 mil",
    "tem proposta nova?",
    "faz quanto tempo a proposta foi enviada?",
    "bom dia",
    "",
  ])("não é intenção de formulário: %s", (t) => {
    expect(lerIntencaoDeFormulario(t)).toBeNull();
  });

  it("'corrige' sem alvo reconhecível não é intenção", () => {
    expect(lerIntencaoDeFormulario("corrige isso aí")).toBeNull();
  });

  it("propósito não vira criar proposta mesmo com verbo de criação", () => {
    expect(lerIntencaoDeFormulario("cria um propósito pro João")).toBeNull();
  });
});

describe("lerIntencaoDeFormulario: criar", () => {
  it.each(["propsta", "porposta", "proposa", "captaçao", "capitação"])("tolera erro de digitação: cria uma %s", (palavra) => {
    const r = lerIntencaoDeFormulario(`cria uma ${palavra} pro João`);
    expect(r).not.toBeNull();
    expect(r?.tipo).toBe("criar");
    expect(r?.alvo).toBe(palavra.startsWith("cap") ? "captacao" : "proposta");
  });

  it("grafia certa continua valendo", () => {
    expect(lerIntencaoDeFormulario("Cria uma proposta pro Carlos")).toEqual({ tipo: "criar", alvo: "proposta" });
    expect(lerIntencaoDeFormulario("Quero fazer uma captação")).toEqual({ tipo: "criar", alvo: "captacao" });
  });

  it("lê a esteira quando o texto a diz", () => {
    expect(lerIntencaoDeFormulario("faz uma porposta de venda")).toEqual({ tipo: "criar", alvo: "proposta", esteira: "venda" });
    expect(lerIntencaoDeFormulario("preciso de uma propsta de aluguel")).toEqual({ tipo: "criar", alvo: "proposta", esteira: "locacao" });
  });

  it("criação sem verbo no começo do texto", () => {
    expect(lerIntencaoDeFormulario("nova porposta pro João")).toEqual({ tipo: "criar", alvo: "proposta" });
  });
});

describe("lerIntencaoDeFormulario: corrigir", () => {
  it("'corrige o contrato' do negócio é só a intenção, sem link nem resposta (T17 é outro PR)", () => {
    expect(lerIntencaoDeFormulario("corrige o contrato")).toEqual({ tipo: "corrigir_redacao", alvo: "contrato_do_negocio" });
    expect(lerIntencaoDeFormulario("Max, corrige o contrato do João")).toEqual({ tipo: "corrigir_redacao", alvo: "contrato_do_negocio" });
  });

  it("corrigir dado da proposta e da captação", () => {
    expect(lerIntencaoDeFormulario("corrige o nome na proposta")).toEqual({ tipo: "corrigir_dado", alvo: "proposta" });
    expect(lerIntencaoDeFormulario("troca o valor da porposta")).toEqual({ tipo: "corrigir_dado", alvo: "proposta" });
    expect(lerIntencaoDeFormulario("ajusta o endereço da captação")).toEqual({ tipo: "corrigir_dado", alvo: "captacao" });
  });

  it("corrigir redação quando fala do texto", () => {
    expect(lerIntencaoDeFormulario("corrige a redação da proposta")).toEqual({ tipo: "corrigir_redacao", alvo: "proposta" });
  });
});

describe("v1 mantém o regex de hoje (feature desligada)", () => {
  it("ehPedidoDeCriacao padrão não tolera erro de digitação", () => {
    expect(ehPedidoDeCriacao("cria uma propsta pro João")).toBe(false);
    expect(ehPedidoDeCriacao("cria uma porposta")).toBe(false);
    expect(ehPedidoDeCriacao("cria uma proposta pro João")).toBe(true);
    expect(ehPedidoDeCriacao("tem proposta nova?")).toBe(false);
  });

  it("com tolerante, o erro de digitação vira pedido de criação; consulta continua fora", () => {
    expect(ehPedidoDeCriacao("cria uma propsta pro João", { tolerante: true })).toBe(true);
    expect(ehPedidoDeCriacao("Cria uma porposta", { tolerante: true })).toBe(true);
    expect(ehPedidoDeCriacao("preciso de um formulaio", { tolerante: true })).toBe(true);
    expect(ehPedidoDeCriacao("tem proposta nova?", { tolerante: true })).toBe(false);
    expect(ehPedidoDeCriacao("foi proposto um valor", { tolerante: true })).toBe(false);
  });

  it("os guardas de consulta e de gestão não mudam sem tolerante", () => {
    expect(pedeConsulta("nova proposta do João")).toBe(false);
    expect(pedeEdicao("adiciona uma proposta do João")).toBe(false);
    expect(pedeGestao("adiciona uma proposta do João")).toBeNull();
  });

  it("os guardas aceitam tolerante sem quebrar o caso de grafia certa", () => {
    expect(pedeConsulta("nova proposta do João", { tolerante: true })).toBe(false);
    expect(pedeEdicao("adiciona uma proposta do João", { tolerante: true })).toBe(false);
    expect(pedeGestao("adiciona uma proposta do João", { tolerante: true })).toBeNull();
  });
});

describe("feature formularios_v2 decide quem passa tolerante", () => {
  it("helper de rollout: org fora do piloto fica no regex de hoje", async () => {
    const { toleranteNaOrg } = await import("../intencao");
    vi.stubEnv("MAX_FORMULARIOS_V2", "true");
    vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ [ORG]: ["formularios_v2"] }));
    expect(toleranteNaOrg(ORG)).toBe(true);
    expect(toleranteNaOrg("outra-org")).toBe(false);
    expect(toleranteNaOrg(undefined)).toBe(false);
    vi.stubEnv("MAX_FORMULARIOS_V2", "false");
    expect(toleranteNaOrg(ORG)).toBe(false);
  });
});
