import { describe, expect, it } from "vitest";
import { conduzirFluxo, conferirDitado, resumoDaProposta, sanearDados, type ContextoDoTurno, type DadosDaProposta, type Fluxo } from "../fluxos";
import { ecoDoImovel, lerImovel, lerNumeros, lerPessoa } from "../captacao";
import { juntarTelefone, telefoneDuvidoso } from "@/lib/phone";

/**
 * Defeitos do reteste em produção (17/11/2026): card da proposta (endereço,
 * pagamento), correção de nome ignorada, complemento da captação e telefone
 * ditado em áudio.
 */

const base: DadosDaProposta = {
  proponente: { nome: "TESTE Comprador Reteste", telefone: "(11) 90000-0006" },
  imovel: { endereco: "Rua Haddock Lobo, 300", numero: "300", complemento: "apto 41", cidade: "São Paulo", uf: "SP" },
  valor: 950000,
  pagamento: { sinal: 95000, forma: "restante financiado" },
};

describe("D2 — endereço do card sem cidade repetida", () => {
  it("cidade já no texto livre e cidade == estado por extenso: uma só vez, no formato Cidade/UF", () => {
    const r = resumoDaProposta({
      natureza: "venda",
      dados: sanearDados({ ...base, imovel: { endereco: "Rua Haddock Lobo, 300, apto 41, São Paulo", cidade: "São Paulo", uf: "SP" } }),
    });
    expect(r).toContain("Imóvel: Rua Haddock Lobo, 300, apto 41, São Paulo/SP\n");
    expect(r).not.toMatch(/São Paulo, São Paulo/);
  });

  it("estado por extenso no lugar da cidade repetida", () => {
    const r = resumoDaProposta({
      natureza: "venda",
      dados: sanearDados({ ...base, imovel: { endereco: "Rua Haddock Lobo, 300, apto 41, São Paulo, São Paulo", cidade: "São Paulo", uf: "SP" } }),
    });
    expect(r).toContain("Imóvel: Rua Haddock Lobo, 300, apto 41, São Paulo/SP\n");
  });

  it("endereço estruturado normal continua igual, agora como Cidade/UF", () => {
    const r = resumoDaProposta({ natureza: "venda", dados: sanearDados(base) });
    expect(r).toContain("Imóvel: Rua Haddock Lobo, 300, apto 41, São Paulo/SP\n");
  });

  it("não quebra endereço com bairro", () => {
    const r = resumoDaProposta({
      natureza: "venda",
      dados: sanearDados({ ...base, imovel: { endereco: "Rua Haddock Lobo", numero: "300", complemento: "apto 41", bairro: "Cerqueira César", cidade: "São Paulo", uf: "SP" } }),
    });
    expect(r).toContain("Imóvel: Rua Haddock Lobo, 300, apto 41, Cerqueira César, São Paulo/SP\n");
  });
});

describe("D3 — linha de pagamento", () => {
  it("sinal e restante legíveis: 'sinal R$ 95.000,00; restante financiado'", () => {
    const r = resumoDaProposta({ natureza: "venda", dados: sanearDados({ ...base, pagamento: { sinal: 95000, forma: "financiado, restante" } }) });
    expect(r).toMatch(/Pagamento: sinal R\$\s95\.000,00; restante financiado\n/);
  });

  it("forma já bem escrita só troca o separador", () => {
    const r = resumoDaProposta({ natureza: "venda", dados: sanearDados(base) });
    expect(r).toMatch(/Pagamento: sinal R\$\s95\.000,00; restante financiado\n/);
  });

  it("sem sinal: só a forma", () => {
    const r = resumoDaProposta({ natureza: "venda", dados: sanearDados({ ...base, pagamento: { forma: "à vista" } }) });
    expect(r).toContain("Pagamento: à vista\n");
  });
});

describe("D5 — correção de nome no card aberto", () => {
  const fluxoAberto = (): Fluxo => ({ kind: "proposta", etapa: "revisao", natureza: "venda", dados: sanearDados(base), atualizadoEm: 1 });
  const deps = (extraido: DadosDaProposta) => ({
    acao: async () => { throw new Error("correção aguarda confirmação"); },
    extrairProposta: async () => extraido,
    extrairCampos: async () => null,
  });
  const ctx = (texto: string): ContextoDoTurno => ({ texto, messageId: "m-d5", agora: 2, policy: ["proposal.create"] });

  it("aplica o nome mesmo quando o extrator só devolve a outra correção", async () => {
    const r = await conduzirFluxo(fluxoAberto(), ctx("o nome é TESTE Comprador Áudio com maiúsculas e é financiado"),
      deps({ pagamento: { forma: "financiado" } }));
    expect(r.reply).toContain("Comprador: TESTE Comprador Áudio");
    expect(r.reply).toMatch(/Pagamento: sinal R\$\s95\.000,00; financiado/);
    if (!r.fluxo || r.fluxo.kind !== "proposta") throw new Error("fluxo");
    expect(r.fluxo.dados.proponente?.nome).toBe("TESTE Comprador Áudio");
    // a identidade do comprador não herda o resto da correção
    expect(r.fluxo.dados.proponente?.telefone).toBe("(11) 90000-0006");
  });

  it.each([
    ["nome do comprador é Maria de Souza Lima", "Maria de Souza Lima"],
    ["corrige o nome para Maria de Souza Lima", "Maria de Souza Lima"],
    ["o nome correto é Maria de Souza Lima.", "Maria de Souza Lima"],
  ])("lê '%s'", async (texto, nome) => {
    const r = await conduzirFluxo(fluxoAberto(), ctx(texto), deps({}));
    if (!r.fluxo || r.fluxo.kind !== "proposta") throw new Error("fluxo");
    expect(r.fluxo.dados.proponente?.nome).toBe(nome);
    expect(r.reply).toContain(`Comprador: ${nome}`);
  });

  it("nome do vendedor não vira nome do comprador", async () => {
    const r = await conduzirFluxo(fluxoAberto(), ctx("o nome do vendedor é João da Silva Prado"), deps({}));
    if (r.fluxo && r.fluxo.kind === "proposta") expect(r.fluxo.dados.proponente?.nome).toBe("TESTE Comprador Reteste");
  });
});

describe("D4 — complemento da captação", () => {
  const texto = "o apartamento na Rua Haddock Lobo, 300, apto 41, Cerqueira César, São Paulo/SP";
  const semComplemento = async () => ({ rua: "Rua Haddock Lobo", numero: "300", bairro: "Cerqueira César", cidade: "São Paulo", uf: "SP" });

  it("recupera o complemento do texto quando o extrator o deixa de fora", async () => {
    const r = await lerImovel(texto, semComplemento);
    expect(r.dados.complemento).toBe("apto 41");
  });

  it("'apartamento na Rua…' não vira complemento", async () => {
    const r = await lerImovel("apartamento na Rua Haddock Lobo, 300, São Paulo/SP", async () => ({ rua: "Rua Haddock Lobo", numero: "300", cidade: "São Paulo", uf: "SP" }));
    expect(r.dados.complemento).toBeUndefined();
  });

  it("o resumo mostra o complemento", () => {
    expect(ecoDoImovel({ rua: "Rua Haddock Lobo", numero: "300", complemento: "apto 41", bairro: "Cerqueira César", cidade: "São Paulo", uf: "SP" }))
      .toBe("Rua Haddock Lobo, 300, apto 41, Cerqueira César, São Paulo/SP");
  });
});

describe("D6 — telefone ditado", () => {
  it.each([
    "11, 90000-0002",
    "11 9 0000 0002",
    "(11) 9 0000-0002",
    "(11) 90000-0002",
    "+55 11 90000-0002",
  ])("junta os dígitos de '%s'", (t) => {
    expect(lerNumeros(`telefone ${t}`).telefones).toEqual(["11900000002"]);
    expect(juntarTelefone(t)).toBe("11900000002");
  });

  it("conferirDitado aceita a sequência com vírgula e corrige o que o extrator errou", () => {
    const d = conferirDitado({ proponente: { nome: "A B", telefone: "11, 9000-0002" } }, "o telefone é 11, 90000-0002");
    expect(d.proponente?.telefone).toBeTruthy();
    expect(d.proponente?.telefone?.replace(/\D/g, "")).toBe("11900000002");
  });

  it.each(["11, 9000-002", "11 9 0000 00", "telefone 11, 9000-0002"])("total que não fecha: pergunta, não grava (%s)", (t) => {
    const texto = /telefone/.test(t) ? t : `telefone ${t}`;
    expect(telefoneDuvidoso(texto)).toBeTruthy();
    expect(lerNumeros(texto).telefones).toEqual([]);
  });

  it("número correto não levanta dúvida e endereço com vírgula também não", () => {
    expect(telefoneDuvidoso("telefone (11) 90000-0006, para o imóvel da Rua Haddock Lobo, 300, apto 41")).toBeNull();
    expect(telefoneDuvidoso("Rua Haddock Lobo, 300, apto 41, 01310-100")).toBeNull();
  });

  it("captação: telefone malformado do proprietário vira pergunta", async () => {
    const r = await lerPessoa("Maria Silva, telefone 11, 9000-002", async () => ({ nome: "Maria Silva" }));
    expect(r.telefone).toBeUndefined();
    expect(r.erro).toMatch(/telefone/i);
  });

  it("proposta: pergunta em vez de anotar o telefone errado", async () => {
    const f: Fluxo = { kind: "proposta", etapa: "coleta", natureza: "venda", dados: {}, atualizadoEm: 1 };
    const r = await conduzirFluxo(f, { texto: "comprador Maria de Souza Lima, telefone 11, 9000-002", messageId: "m-d6", agora: 2, policy: ["proposal.create"] } satisfies ContextoDoTurno, {
      acao: async () => { throw new Error("sem escrita"); },
      extrairProposta: async () => ({ proponente: { nome: "Maria de Souza Lima", telefone: "11, 9000-002" } }),
      extrairCampos: async () => null,
    });
    expect(r.reply).toMatch(/telefone/i);
    expect(r.reply).toMatch(/DDD/);
    if (r.fluxo && r.fluxo.kind === "proposta") expect(r.fluxo.dados.proponente?.telefone).toBeUndefined();
  });
});

// ─── Rodada 2 do review ──────────────────────────────────────────────────────

describe("R2.1 — telefone ditado em resposta avulsa (aguardaCampo)", () => {
  const fluxoEsperando = (): Fluxo => ({
    kind: "proposta", etapa: "ajustes", natureza: "venda", propostaId: "p1", codigo: "PROP-1",
    dados: sanearDados(base), aguardaCampo: { pessoa: "proponente", campo: "telefone" }, atualizadoEm: 1,
  });
  const deps = (extraido: DadosDaProposta) => ({
    acao: async () => { throw new Error("sem escrita"); },
    extrairProposta: async () => extraido,
    extrairCampos: async () => null,
  });

  it("'11, 9000-0002' (10 dígitos com 9 logo após o DDD) pergunta de novo e não grava", async () => {
    const r = await conduzirFluxo(fluxoEsperando(), { texto: "11, 9000-0002", messageId: "m-r21", agora: 2, policy: ["proposal.create"] } satisfies ContextoDoTurno, deps({}));
    expect(r.reply).toMatch(/telefone/i);
    expect(r.reply).toMatch(/DDD/);
    if (r.fluxo && r.fluxo.kind === "proposta") expect(r.fluxo.dados.proponente?.telefone).toBe("(11) 90000-0006");
  });

  it("'11, 90000-0002' fecha e é gravado", async () => {
    const r = await conduzirFluxo(fluxoEsperando(), { texto: "11, 90000-0002", messageId: "m-r21b", agora: 2, policy: ["proposal.create"] } satisfies ContextoDoTurno, deps({}));
    if (!r.fluxo || r.fluxo.kind !== "proposta") throw new Error("fluxo");
    expect(String(r.fluxo.dados.proponente?.telefone).replace(/\D/g, "")).toBe("11900000002");
  });
});

describe("R2.2 — nomeCorrigido não captura demais", () => {
  const fluxoAberto = (): Fluxo => ({ kind: "proposta", etapa: "revisao", natureza: "venda", dados: sanearDados(base), atualizadoEm: 1 });
  const deps = {
    acao: async () => { throw new Error("correção aguarda confirmação"); },
    extrairProposta: async () => ({}) as DadosDaProposta,
    extrairCampos: async () => null,
  };
  const nomeApos = async (texto: string) => {
    const r = await conduzirFluxo(fluxoAberto(), { texto, messageId: "m-r22", agora: 2, policy: ["proposal.create"] } satisfies ContextoDoTurno, deps);
    return r.fluxo && r.fluxo.kind === "proposta" ? r.fluxo.dados.proponente?.nome : undefined;
  };

  it.each([
    "o nome e o CPF estão certos, só muda o valor",
    "nome do comprador e telefone: Maria Silva, (11) 90000-0001",
    "vendedor: o nome é João Prado",
    "nome pra assinatura é Maria Lima",
  ])("não renomeia o comprador: '%s'", async (texto) => {
    expect(await nomeApos(texto)).toBe("TESTE Comprador Reteste");
  });

  it.each([
    "o nome é TESTE Comprador Áudio e é financiado",
    "o nome é TESTE Comprador Áudio e financiado",
    "nome do comprador é TESTE Comprador Áudio",
    "corrige o nome para TESTE Comprador Áudio",
  ])("renomeia exatamente: '%s'", async (texto) => {
    expect(await nomeApos(texto)).toBe("TESTE Comprador Áudio");
  });
});

describe("R2.3 — telefoneDuvidoso só olha dígitos colados ao rótulo", () => {
  it.each([
    "telefone não tem, CPF 529.982.247-25",
    "sem telefone, matrícula 123.456",
    "telefone ok, sinal 100.000",
    "celular: não sei, cpf 529.982.247-25",
  ])("não marca: '%s'", (t) => {
    expect(telefoneDuvidoso(t)).toBeNull();
  });

  it.each(["telefone +351 912 345 678", "celular +1 305 555 1234"])("estrangeiro com + aceito como está: '%s'", (t) => {
    expect(telefoneDuvidoso(t)).toBeNull();
  });

  it("rótulo com número colado continua pegando o que não fecha", () => {
    expect(telefoneDuvidoso("telefone 11 9876 54")).toBeTruthy();
    expect(telefoneDuvidoso("telefone do vendedor: 11, 9000-0002")).toBeTruthy();
  });
});

describe("R2.4 — formaLegivel só reescreve '<palavra>, restante'", () => {
  const pag = (forma: string) =>
    resumoDaProposta({ natureza: "venda", dados: sanearDados({ ...base, pagamento: { sinal: 95000, forma } }) });

  it("'financiado, restante' vira 'restante financiado'", () => {
    expect(pag("financiado, restante")).toMatch(/Pagamento: sinal R\$\s95\.000,00; restante financiado\n/);
  });
  it.each([
    "30% de entrada e o restante",
    "FGTS e financiamento do restante",
    "R$ 200 mil financiado, restante",
  ])("não mexe em '%s'", (forma) => {
    expect(pag(forma)).toContain(`; ${forma}\n`);
  });
});

describe("R2.5 — unidade no texto da captação", () => {
  const extrator = async () => ({ rua: "Rua X", numero: "10", cidade: "São Paulo", uf: "SP" });
  const comp = async (t: string) => (await lerImovel(t, extrator)).dados.complemento;

  it.each([
    "cobertura 2 suítes", "cobertura 2 suites", "sala 2 ambientes", "apto 3 banheiros", "loja 200m", "loja 200 m²", "apto 2 quartos",
    "torre e o parque", "apartamento 3 dormitórios",
  ])("não grava complemento em '%s'", async (frase) => {
    expect(await comp(`${frase}, na Rua X, 10, São Paulo/SP`)).toBeUndefined();
  });

  it.each([
    ["apto 41", "apto 41"],
    ["apto 41 bloco B", "apto 41"],
    ["sala 1203", "sala 1203"],
    ["conj. 52", "conj. 52"],
    ["bloco B", "bloco B"],
    ["torre 2", "torre 2"],
  ])("mantém '%s'", async (frase, esperado) => {
    expect(await comp(`o imóvel na Rua X, 10, ${frase}, São Paulo/SP`)).toContain(esperado);
  });
});

describe("R2.6 — endereço livre já terminado em 'Cidade/UF' ou 'Cidade - UF'", () => {
  it.each(["Rua Haddock Lobo, 300, São Paulo/SP", "Rua Haddock Lobo, 300, São Paulo - SP", "Rua Haddock Lobo, 300, São Paulo-SP"])(
    "não repete a cidade: '%s'",
    (endereco) => {
      const r = resumoDaProposta({ natureza: "venda", dados: sanearDados({ ...base, imovel: { endereco, cidade: "São Paulo", uf: "SP" } }) });
      expect(r).toContain("Imóvel: Rua Haddock Lobo, 300, São Paulo/SP\n");
    },
  );
});
