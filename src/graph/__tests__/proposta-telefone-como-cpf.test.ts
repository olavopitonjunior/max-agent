import { describe, it, expect, vi } from "vitest";

/**
 * Prod 18/11/2026 (smoke do CPF obrigatório, Max Fincasa): "comprador X, tel 11999990000, …" sem CPF no texto.
 * O extrator pôs os 11 dígitos em `cpf`; o `conferirDitado` tirou o CPF (o texto rotula o número como
 * telefone) e o telefone sumiu junto: "ainda falta: telefone do comprador". O rótulo escrito decide.
 */

const F = await import("../fluxos");

const PEDIDO = "Quero fazer uma proposta de compra: comprador TESTE Comprador Smoke, tel 11999990000, imóvel Apto TESTE Rua Teste 30, São Paulo/SP, R$ 500.000 à vista";

describe("telefone rotulado que o extrator pôs como CPF", () => {
  it("vai para o telefone, e o CPF fica faltando", () => {
    const d = F.conferirDitado(F.sanearDados({ proponente: { nome: "TESTE Comprador Smoke", cpf: "11999990000" } }), PEDIDO);
    expect(d.proponente).toEqual({ nome: "TESTE Comprador Smoke", telefone: "11999990000" });
  });

  it("com telefone já extraído, não sobrescreve: o CPF errado só sai", () => {
    const d = F.conferirDitado(
      F.sanearDados({ proponente: { nome: "TESTE Comprador Smoke", telefone: "11999990000", cpf: "11999990000" } }),
      PEDIDO
    );
    expect(d.proponente).toEqual({ nome: "TESTE Comprador Smoke", telefone: "11999990000" });
  });

  it("CPF rotulado como CPF continua CPF", () => {
    const texto = "comprador TESTE Comprador Smoke, CPF 392.769.438-03, tel 11 98888-7777";
    const d = F.conferirDitado(F.sanearDados({ proponente: { nome: "TESTE Comprador Smoke", cpf: "39276943803", telefone: "11988887777" } }), texto);
    expect(d.proponente?.cpf).toBe("39276943803");
    expect(d.proponente?.telefone).toBe("11988887777");
  });

  it("no pedido inicial: só falta o CPF (o telefone não se perde)", async () => {
    const deps = {
      acao: vi.fn().mockResolvedValue({ status: 200, body: { modelo: true, assinatura: true } }),
      extrairProposta: vi.fn().mockResolvedValue({
        proponente: { nome: "TESTE Comprador Smoke", cpf: "11999990000" },
        imovel: { endereco: "Rua Teste 30", complemento: "Apto TESTE", cidade: "São Paulo", uf: "SP" },
        valor: 500_000,
        pagamento: { forma: "à vista" },
      }),
      extrairCampos: vi.fn().mockResolvedValue({}),
    };
    const p = await F.iniciarProposta("venda", PEDIDO, 1_000_000, deps);
    expect(p.reply).toMatch(/ainda falta: CPF de quem faz a proposta\.$/);
    expect(p.reply).not.toMatch(/telefone do comprador/);
  });
});
