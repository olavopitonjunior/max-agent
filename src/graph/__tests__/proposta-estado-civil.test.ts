import { describe, it, expect, vi } from "vitest";

/**
 * Prod 18/11/2026 (Max Fincasa, smoke do item 8): a proposta v1 não tem estado
 * civil (o PATCH do Max só toca proponente nome/CPF/telefone/e-mail, imóvel,
 * valor…). "comprador X, casado, …" descartava o "casado" calado, e "ele é
 * casado" virava `proposta_liberada`: o modelo respondia "anotei como casado"
 * sem gravar nada. O caminho honesto é determinístico: estado civil se completa
 * na tela da proposta.
 */

const F = await import("../fluxos");
type Fluxo = import("../fluxos").Fluxo;

const agora = 1_000_000;
const ctx = (texto: string) => ({ texto, messageId: `m-${texto.slice(0, 8)}`, policy: ["proposal.create", "proposal.send", "form.create"] as const, agora });

const DADOS: import("../fluxos").DadosDaProposta = {
  proponente: { nome: "TESTE Comprador Smoke", telefone: "11999990000" },
  imovel: { endereco: "Rua Teste 30", complemento: "Apto TESTE", cidade: "São Paulo", uf: "SP" },
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

describe("estado civil na proposta v1", () => {
  it.each(["ele é casado", "o comprador é solteiro", "ela é divorciada", "estado civil: casado", "vive em união estável"])(
    "'%s' na revisão: diz que é pela tela, não libera para o modelo, nada é gravado",
    async (texto) => {
      const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS, atualizadoEm: agora };
      const d = deps({});
      const p = await F.conduzirFluxo(f, ctx(texto), d);
      expect("liberar" in p && p.liberar).toBeFalsy();
      expect(p.reply ?? "").toMatch(/estado civil/i);
      expect(p.reply ?? "").toMatch(/tela da proposta/i);
      expect(p.reply ?? "").not.toMatch(/anotei|anotado/i);
      // o card continua na mão: o SIM ainda gera o rascunho
      expect(p.reply ?? "").toContain("SIM");
      expect(p.fluxo).toMatchObject({ kind: "proposta", etapa: "revisao", dados: DADOS });
      expect(d.acao).not.toHaveBeenCalled();
    }
  );

  it("pedido inicial com 'casado': o card avisa que o estado civil fica para a tela", async () => {
    const pedido = "Quero fazer uma proposta de compra: comprador TESTE Comprador Smoke, casado, tel 11999990000, imóvel Rua Teste 30, Apto TESTE, São Paulo/SP, R$ 500.000 à vista";
    const d = deps({ ...DADOS });
    const p = await F.iniciarProposta("venda", pedido, agora, d);
    expect(p.reply).toMatch(/estado civil \(casado\)/i);
    expect(p.reply).toMatch(/tela da proposta/i);
  });

  it("pedido inicial sem estado civil: nenhum aviso", async () => {
    const pedido = "Quero fazer uma proposta de compra: comprador TESTE Comprador Smoke, tel 11999990000, imóvel Rua Teste 30, São Paulo/SP, R$ 500.000 à vista";
    const p = await F.iniciarProposta("venda", pedido, agora, deps({ ...DADOS }));
    expect(p.reply).not.toMatch(/estado civil/i);
  });

  it("palavras parecidas não disparam: 'casa', 'casamento do imóvel'? não; 'separado' fica de fora", async () => {
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS, atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("a casa tem garagem separada?"), deps({}));
    expect(p.reply ?? "").not.toMatch(/estado civil/i);
  });

  it("depois do rascunho: 'ele é casado' cai no caminho da tela (não no modelo)", async () => {
    const f: Fluxo = { kind: "proposta", etapa: "ajustes", natureza: "venda", dados: DADOS, propostaId: "p1", codigo: "PROP-2026-0099", atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("ele é casado"), deps({}));
    expect("liberar" in p && p.liberar).toBeFalsy();
    expect(p.reply ?? "").toMatch(/Estado civil não dá para ajustar pelo WhatsApp/);
  });

  it("dado novo junto: grava o CPF e avisa do estado civil", async () => {
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS, atualizadoEm: agora };
    const texto = "o CPF dele é 392.769.438-03 e ele é casado";
    const p = await F.conduzirFluxo(f, ctx(texto), deps({ proponente: { cpf: "39276943803" } }));
    expect(p.reply ?? "").toMatch(/Estado civil \(casado\)/);
    expect(p.reply ?? "").toContain("SIM");
    expect((p.fluxo as { dados: { proponente: { cpf?: string } } }).dados.proponente.cpf).toBe("39276943803");
  });
});
