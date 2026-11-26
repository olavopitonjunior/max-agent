import { describe, expect, it, vi } from "vitest";

/**
 * Prod 26/11 (Fincasa, dados TESTE): "comprador TESTE Comprador Smoke" virou o nome
 * "Comprador TESTE Comprador Smoke" no card. O rótulo do INÍCIO sai por código, depois do extrator.
 */

const F = await import("../fluxos");
type Fluxo = import("../fluxos").Fluxo;

const agora = 1_000_000;
const TUDO = ["proposal.create", "proposal.send", "form.create"] as const;

const PEDIDO_REAL =
  "Quero fazer uma proposta de compra: comprador TESTE Comprador Smoke, CPF 392.769.438-03, tel 11 99906-3228, email teste@exemplo.com, imóvel Apto TESTE Rua Teste 30, bairro Bela Vista, São Paulo/SP, R$ 500.000 à vista, mídia de origem Instagram";

const nomeLido = (nome: string, texto: string, papel: "proponente" | "vendedor" = "proponente") =>
  F.conferirDitado(F.sanearDados({ [papel]: { nome } }), texto)[papel]?.nome;

describe("rótulo grudado no início do nome", () => {
  it("frase real: 'Comprador TESTE Comprador Smoke' vira 'TESTE Comprador Smoke'", () => {
    expect(nomeLido("Comprador TESTE Comprador Smoke", PEDIDO_REAL)).toBe("TESTE Comprador Smoke");
  });

  it("o card da proposta mostra o nome sem o rótulo", async () => {
    const d = {
      acao: vi.fn().mockResolvedValue(null),
      extrairProposta: vi.fn().mockResolvedValue({
        proponente: { nome: "Comprador TESTE Comprador Smoke", cpf: "39276943803", telefone: "11999063228", email: "teste@exemplo.com" },
        imovel: { endereco: "Apto TESTE Rua Teste 30", bairro: "Bela Vista", cidade: "São Paulo", uf: "SP" },
        valor: 500000,
      }),
      extrairCampos: vi.fn().mockResolvedValue({}),
    };
    const p = await F.iniciarFluxo({ tipo: "proposta", natureza: "venda", pedido: PEDIDO_REAL, policy: [...TUDO], agora }, d);
    const dados = (p.fluxo as Extract<Fluxo, { kind: "proposta" }>).dados;
    expect(dados.proponente?.nome).toBe("TESTE Comprador Smoke");
    expect(p.reply).not.toContain("Comprador TESTE");
  });

  it.each([
    ["Comprador Maria Souza", "comprador Maria Souza", "Maria Souza"],
    ["comprador: Maria Souza", "comprador: Maria Souza", "Maria Souza"],
    ["COMPRADORA Maria Souza", "compradora Maria Souza", "Maria Souza"],
    ["Vendedor João Lima", "vendedor João Lima", "João Lima"],
    ["Vendedora: Ana Lima", "vendedora Ana Lima", "Ana Lima"],
    ["Locatário Pedro Alves", "locatário Pedro Alves", "Pedro Alves"],
    ["Locatária Rita Alves", "locatária Rita Alves", "Rita Alves"],
    ["Proprietário Caio Dias", "proprietário Caio Dias", "Caio Dias"],
    ["Proprietária Bia Dias", "proprietária Bia Dias", "Bia Dias"],
    ["Nome: Lúcia Prado", "nome Lúcia Prado", "Lúcia Prado"],
    ["nome Lúcia Prado", "nome Lúcia Prado", "Lúcia Prado"],
  ])("tira o rótulo inicial: %s", (extraido, texto, esperado) => {
    expect(nomeLido(extraido, texto)).toBe(esperado);
  });

  it.each([
    ["TESTE Comprador Smoke", "comprador TESTE Comprador Smoke"],
    ["Maria Comprador Souza", "comprador Maria Comprador Souza"],
    ["Letícia Gonçalves Nogueira", "comprador Letícia Gonçalves Nogueira"],
    ["Nomeado Silva", "comprador Nomeado Silva"],
  ])("só o rótulo do INÍCIO sai; %s fica intacto", (nome, texto) => {
    expect(nomeLido(nome, texto)).toBe(nome);
  });

  it("vale também para o vendedor", () => {
    expect(nomeLido("Vendedor João Lima", "vendedor João Lima", "vendedor")).toBe("João Lima");
  });
});
