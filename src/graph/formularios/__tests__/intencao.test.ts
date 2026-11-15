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

// F5: tolerância ampliada (até 2 edições em proposta/captação, 7+ letras, mesma letra inicial) e a palavra-chave
// sozinha. Os NEGADOS vêm primeiro: palavra comum parecida nunca vira proposta nem captação.
describe("F5: erro de digitação, negados primeiro (palavra comum não vira proposta/captação)", () => {
  const COMUNS = [
    "resposta", "respostas", "aposta", "apostas", "capacitação", "capacitações", "propósito", "propósitos",
    "adaptação", "adaptações", "formulação", "formulações", "preposta", "prepostos", "disposta", "composta",
    "exposta", "posposta", "captador", "captadora", "proposto", "proposital", "capturar", "contrato", "contato",
  ];

  it.each(COMUNS)("%s fica como está na normalização", (palavra) => {
    const sem = palavra.normalize("NFD").replace(/\p{Diacritic}/gu, "");
    expect(normalizarParaIntencao(palavra)).toBe(sem);
  });

  it.each(COMUNS)("%s sozinha não é intenção", (palavra) => {
    expect(lerIntencaoDeFormulario(palavra)).toBeNull();
  });

  it.each(["resposta", "aposta", "capacitação", "propósito", "adaptação", "formulação"])("cria uma %s não é pedido de proposta nem de captação", (palavra) => {
    expect(lerIntencaoDeFormulario(`cria uma ${palavra} pro João`)).toBeNull();
  });

  it("frases comuns com a palavra sozinha no meio não viram intenção", () => {
    expect(lerIntencaoDeFormulario("qual a resposta dele?")).toBeNull();
    expect(lerIntencaoDeFormulario("fez uma aposta alta")).toBeNull();
    expect(lerIntencaoDeFormulario("fiz a capacitação ontem")).toBeNull();
  });

  it("a palavra-chave sozinha só vale no singular, sem mais nada na frase", () => {
    expect(lerIntencaoDeFormulario("proposta de novo?")).toBeNull();
    expect(lerIntencaoDeFormulario("propostas")).toBeNull();
    expect(lerIntencaoDeFormulario("a proposta do João")).toBeNull();
  });
});

describe("F5: erro de digitação ampliado", () => {
  it.each([
    ["porposa", "proposta"],
    ["propsota", "proposta"],
    ["prposta", "proposta"],
    ["capitaao", "captacao"],
    ["captacão", "captacao"],
    ["capitacao", "captacao"],
  ])("%s vira %s", (entrada, esperado) => {
    expect(normalizarParaIntencao(entrada)).toBe(esperado);
  });

  it.each(["propsta", "porposta", "proposa", "porposa", "captaçao", "capitação", "captacão", "capitaao"])(
    "a palavra sozinha, com erro (%s), é pedido de criação",
    (palavra) => {
      expect(lerIntencaoDeFormulario(palavra)).toMatchObject({ tipo: "criar", alvo: palavra.startsWith("cap") ? "captacao" : "proposta" });
    }
  );

  it.each(["uma propsta", "Propsta!", "nova porposa", "uma captaçao"])("com artigo ou 'nova' (%s)", (texto) => {
    expect(lerIntencaoDeFormulario(texto)).toMatchObject({ tipo: "criar" });
  });

  it("com verbo e 2 edições", () => {
    expect(lerIntencaoDeFormulario("quero criar uma porposa de venda")).toEqual({ tipo: "criar", alvo: "proposta", esteira: "venda" });
    expect(lerIntencaoDeFormulario("faz uma capitaao")).toEqual({ tipo: "criar", alvo: "captacao" });
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

  // P4 (M2 do PR-A): o verbo de correção casava pergunta e negação.
  it.each([
    "não corrige a proposta",
    "nao troca o valor da proposta",
    "não precisa mudar nada na proposta",
    "nunca altera a proposta do João",
    "a proposta corrige?",
    "corrige a proposta?",
    "como corrige a proposta",
    "como eu corrijo a proposta?",
    "por que troca o valor da proposta",
    "a proposta foi corrigida ontem",
    "quando o Max corrige a proposta",
  ])("negação ou pergunta sobre o verbo não é pedido de correção: %s", (t) => {
    expect(lerIntencaoDeFormulario(t)).toBeNull();
  });

  it.each([
    ["pode corrigir a proposta?", "proposta"],
    ["consegue trocar o valor da proposta?", "proposta"],
    ["corrige a proposta, não o contrato", "proposta"],
  ])("pedido educado ou com negação de outro objeto continua sendo correção: %s", (t, alvo) => {
    expect(lerIntencaoDeFormulario(t)).toMatchObject({ tipo: "corrigir_dado", alvo });
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
    expect(toleranteNaOrg(ORG, { fluxoV2: true })).toBe(true);
    expect(toleranteNaOrg("outra-org", { fluxoV2: true })).toBe(false);
    expect(toleranteNaOrg(undefined, { fluxoV2: true })).toBe(false);
    vi.stubEnv("MAX_FORMULARIOS_V2", "false");
    expect(toleranteNaOrg(ORG, { fluxoV2: true })).toBe(false);
  });

  it("M3: feature ligada mas servidor sem o v2 (fluxoV2 false) ou options não consultado: sem tolerância", async () => {
    const { toleranteNaOrg } = await import("../intencao");
    vi.stubEnv("MAX_FORMULARIOS_V2", "true");
    vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ [ORG]: ["formularios_v2"] }));
    expect(toleranteNaOrg(ORG, { fluxoV2: false })).toBe(false);
    expect(toleranteNaOrg(ORG, { fluxoV2: null })).toBe(false);
    expect(toleranteNaOrg(ORG, {})).toBe(false);
    expect(toleranteNaOrg(ORG)).toBe(false);
  });
});
