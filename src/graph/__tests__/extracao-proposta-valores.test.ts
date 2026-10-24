import { describe, expect, it } from "vitest";
import { argsDaProposta, argsDoAjuste, mesclarDados, sanearDados } from "../fluxos";
import { destokenizarArgs, tokenizar } from "@/lib/pii";

describe("proposta — valores monetários destokenizados", () => {
  it.each([
    ["R$ 500.000,00", 500000],
    ["R$1500", 1500],
    ["1500 reais", 1500],
    ["R$ 2 mil", 2000],
    ["R$ 1,5 milhão", 1500000],
  ])("preserva %s até o payload numérico", (original, esperado) => {
    const { texto, mapa } = tokenizar(`valor ${original}`);
    expect(texto).toContain("⟨VALOR_1⟩");
    expect(texto).not.toContain(original);
    const dados = sanearDados(destokenizarArgs({ valor: "⟨VALOR_1⟩", pagamento: { sinal: "⟨VALOR_1⟩" }, comissao: { valor: "⟨VALOR_1⟩" } }, mapa));
    expect(argsDaProposta({ dados })).toMatchObject({ valor: esperado, pagamento: { sinal: esperado }, comissao: { valor: esperado } });
  });

  it.each(["⟨VALOR_99⟩", "500 mil talvez", "R$ 1.2.3", "-500", "0", "Infinity", "500\nValor: 1"])("rejeita valor ambíguo ou inválido: %s", (valor) => {
    expect(sanearDados({ valor }).valor).toBeUndefined();
  });

  it("mantém percentual estritamente numérico", () => {
    expect(sanearDados({ comissao: { percentual: "R$ 5" } }).comissao?.percentual).toBeUndefined();
  });
});

describe("proposta — complemento do imóvel", () => {
  it("não repete número já informado no endereço após corrigir apartamento", async () => {
    const dados = sanearDados({ proponente: { nome: "TESTE QA", telefone: "11999063228" }, valor: 500000,
      imovel: { endereco: "Rua de Teste QA, 100", numero: "100", complemento: "apartamento 1", cidade: "São Paulo", uf: "SP" } });
    const { conduzirFluxo } = await import("../fluxos");
    const resultado = await conduzirFluxo({ kind: "proposta", etapa: "revisao", natureza: "venda", dados, atualizadoEm: 1 }, {
      texto: "Corrija o complemento para apartamento 2.", messageId: "qa-numero-repetido", agora: 2, policy: ["proposal.create"],
    }, {
      acao: async () => { throw new Error("Correção aguarda confirmação"); },
      extrairProposta: async () => ({ imovel: { complemento: "apartamento 2" } }),
      extrairCampos: async () => null,
    });
    expect(resultado.reply).toContain("Imóvel: Rua de Teste QA, 100, apartamento 2, São Paulo, SP");
    const corrigido = mesclarDados(dados, sanearDados({ imovel: { complemento: "apartamento 2" } }));
    expect(argsDaProposta({ dados: corrigido }).imovel).toMatchObject({ endereco: "Rua de Teste QA, apartamento 2", numero: "100" });
    expect(argsDoAjuste(corrigido).imovel).toMatchObject({ endereco: "Rua de Teste QA, apartamento 2", numero: "100" });
  });

  it.each(["Rua 100", "Rua Teste, 1000", "Rua Teste, apartamento 100"])("preserva número distinto do logradouro ou unidade: %s", (endereco) => {
    expect(argsDaProposta({ dados: sanearDados({ imovel: { endereco, numero: "100" } }) }).imovel).toMatchObject({ numero: "100" });
  });

  it("correção de número não deixa o valor antigo no endereço do checkpoint", () => {
    const dados = mesclarDados({ imovel: { endereco: "Rua de Teste QA, 100", numero: "100", complemento: "apartamento 2" } }, sanearDados({ imovel: { numero: "200" } }));
    expect(argsDoAjuste(dados).imovel).toMatchObject({ endereco: "Rua de Teste QA, apartamento 2", numero: "200" });
  });

  it("leva apartamento no endereço suportado pelo backend", () => {
    const dados = sanearDados({ imovel: { endereco: "Rua de Teste QA, 100", complemento: "apartamento 1", cidade: "São Paulo", uf: "SP" } });
    expect(argsDaProposta({ dados }).imovel).toEqual({ endereco: "Rua de Teste QA, 100, apartamento 1", numero: undefined, bairro: undefined, cidade: "São Paulo", uf: "SP", matricula: undefined });
  });

  it("não substitui a rua por complemento isolado", () => {
    expect(sanearDados({ imovel: { complemento: "apartamento 1" } }).imovel).toMatchObject({ endereco: undefined, complemento: "apartamento 1" });
  });

  it("não duplica complemento já incluído no endereço", () => {
    expect(argsDaProposta({ dados: sanearDados({ imovel: { endereco: "Rua de Teste QA, 100, apartamento 1", complemento: "apartamento 1" } }) }).imovel).toMatchObject({ endereco: "Rua de Teste QA, 100, apartamento 1" });
  });
});


it("correção incremental troca apartamento sem perder rua e número", () => {
  const inicial = sanearDados({ imovel: { endereco: "Rua de Teste QA", numero: "100", complemento: "apartamento 1" } });
  const dados = mesclarDados(inicial, sanearDados({ imovel: { complemento: "apartamento 2" } }));
  expect(dados.imovel).toMatchObject({ endereco: "Rua de Teste QA", numero: "100", complemento: "apartamento 2" });
  expect(argsDaProposta({ dados }).imovel).toMatchObject({ endereco: "Rua de Teste QA, apartamento 2", numero: "100" });
  expect(argsDoAjuste(dados).imovel).not.toHaveProperty("complemento");
});

it("checkpoint legado troca complemento final explícito sem duplicar apartamento", () => {
  const dados = mesclarDados({ imovel: { endereco: "Rua de Teste QA, 100, apartamento 1" } }, sanearDados({ imovel: { complemento: "apartamento 2" } }));
  expect(argsDaProposta({ dados }).imovel).toMatchObject({ endereco: "Rua de Teste QA, 100, apartamento 2" });
});

it("não confunde apartamento 1 com apartamento 10", () => {
  const dados = sanearDados({ imovel: { endereco: "Rua de Teste QA, 100, apartamento 10", complemento: "apartamento 1" } });
  expect(argsDaProposta({ dados }).imovel).toMatchObject({ endereco: "Rua de Teste QA, 100, apartamento 1" });
});

it("pede endereço completo quando uma retomada só conhece ID e recebe complemento", async () => {
  const { conduzirFluxo } = await import("../fluxos");
  const resultado = await conduzirFluxo({ kind: "proposta", etapa: "ajustes", propostaId: "qa-proposta", dados: {}, atualizadoEm: 1 }, {
    texto: "troque para apartamento 2", messageId: "qa-sem-base", agora: 2, policy: ["proposal.create"],
  }, {
    acao: async () => { throw new Error("Não deve escrever sem endereço conhecido"); },
    extrairProposta: async () => ({ imovel: { complemento: "apartamento 2" } }),
    extrairCampos: async () => null,
  });
  expect(resultado.reply).toContain("endereço completo");
  expect(resultado.fluxo).toMatchObject({ dados: {} });
});

it("preserva bloco e apartamento em saneamento, mesclas e payloads repetidos", () => {
  let dados = sanearDados({ imovel: { endereco: "Rua de Teste QA, 100, bloco A, apartamento 1" } });
  for (let i = 0; i < 3; i++) {
    dados = mesclarDados(sanearDados(dados), {});
    expect(argsDaProposta({ dados }).imovel).toMatchObject({ endereco: "Rua de Teste QA, 100, bloco A, apartamento 1" });
  }
  const corrigido = mesclarDados(dados, sanearDados({ imovel: { complemento: "apartamento 2" } }));
  expect(argsDaProposta({ dados: corrigido }).imovel).toMatchObject({ endereco: "Rua de Teste QA, 100, bloco A, apartamento 2" });
});
