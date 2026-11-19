import { describe, it, expect, vi } from "vitest";

/**
 * Decisão do Olavo (18/11/2026): o CPF de quem faz a proposta é exigido antes do SIM.
 * O smoke de prod mostrou o card com SIM sem CPF ("comprador X, tel …, imóvel …, R$ …").
 * Ligada a um lead de crédito, o CPF vem do lead (`proposal.create`, contractmaker #1580).
 */

const F = await import("../fluxos");
type Fluxo = import("../fluxos").Fluxo;

const agora = 1_000_000;
const ctx = (texto: string) => ({ texto, messageId: `m-${texto.slice(0, 8)}`, policy: ["proposal.create", "proposal.send", "form.create"] as const, agora });

const SEM_CPF: import("../fluxos").DadosDaProposta = {
  proponente: { nome: "TESTE Comprador Smoke", telefone: "11999990000" },
  imovel: { endereco: "Rua Teste 30", cidade: "São Paulo", uf: "SP" },
  valor: 500_000,
  pagamento: { forma: "à vista" },
};

function deps(extraido: Record<string, unknown> = {}) {
  return {
    acao: vi.fn().mockResolvedValue({ status: 200, body: { modelo: true, assinatura: true } }),
    extrairProposta: vi.fn().mockResolvedValue(extraido),
    extrairCampos: vi.fn().mockResolvedValue({}),
  };
}

describe("CPF obrigatório antes do SIM", () => {
  it("faltandoNaProposta pede o CPF quando não veio", () => {
    expect(F.faltandoNaProposta(SEM_CPF)).toContain("CPF de quem faz a proposta");
  });

  it("com lead de crédito o CPF vem do lead: não pede", () => {
    expect(F.faltandoNaProposta(SEM_CPF, { temLead: true })).not.toContain("CPF de quem faz a proposta");
  });

  it("pedido inicial sem CPF: sem card de SIM, pede o CPF", async () => {
    const pedido = "Quero fazer uma proposta de compra: comprador TESTE Comprador Smoke, tel 11999990000, imóvel Rua Teste 30, São Paulo/SP, R$ 500.000 à vista";
    const p = await F.iniciarProposta("venda", pedido, agora, deps({ ...SEM_CPF }));
    expect(p.reply).not.toMatch(/Responda \*SIM\*/);
    expect(p.reply).toMatch(/CPF de quem faz a proposta/);
    expect(p.fluxo).toMatchObject({ etapa: "coleta" });
  });

  it("o CPF dito em seguida fecha o card", async () => {
    const f: Fluxo = { kind: "proposta", etapa: "coleta", natureza: "venda", dados: SEM_CPF, atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("o CPF dele é 392.769.438-03"), deps({ proponente: { cpf: "39276943803" } }));
    expect(p.reply ?? "").toMatch(/Responda \*SIM\*/);
    expect(p.fluxo).toMatchObject({ etapa: "revisao" });
  });

  it("'sim' na coleta sem CPF não gera rascunho", async () => {
    const f: Fluxo = { kind: "proposta", etapa: "coleta", natureza: "venda", dados: SEM_CPF, atualizadoEm: agora };
    const d = deps({});
    const p = await F.conduzirFluxo(f, ctx("sim"), d);
    expect(p.reply ?? "").toMatch(/CPF de quem faz a proposta/);
    expect(d.acao).not.toHaveBeenCalledWith("proposal.create", expect.anything(), expect.anything());
  });
});
