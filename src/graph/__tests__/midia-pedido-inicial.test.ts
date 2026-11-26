import { describe, it, expect, vi } from "vitest";

/**
 * Prod 26/11 (Fincasa, dados TESTE): o corretor escreveu "mídia de origem Instagram" no PRIMEIRO pedido e,
 * depois do SIM do envio, o Max perguntou "Como o cliente chegou até a imobiliária?". A origem dita no pedido
 * tem de acompanhar o fluxo até o create (ou até a gravação antes do envio), sem nova pergunta.
 */

const F = await import("../fluxos");
type Fluxo = import("../fluxos").Fluxo;
type FluxoProposta = Extract<Fluxo, { kind: "proposta" }>;
type DadosDaProposta = import("../fluxos").DadosDaProposta;

const POLITICA = ["proposal.create", "proposal.send", "form.create"] as const;
const agora = 1_000_000;

const MIDIAS = [
  { id: "instagram", label: "Instagram" },
  { id: "indicacao", label: "Indicação" },
  { id: "site", label: "Site" },
  { id: "google_ads", label: "Google Ads" },
];

const ctx = (texto: string, messageId: string) => ({ texto, messageId, policy: [...POLITICA], agora });

/** O CM simulado: options sem proposta devolvem catálogo + política; com proposta, o cartão de envio. */
function cm(extra: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  return vi.fn().mockImplementation(async (verb: string, args: Record<string, unknown>) => {
    const sobre = extra[verb];
    if (sobre) return sobre(args);
    if (verb === "proposal.preflight") return { status: 200, body: { modelo: true, assinatura: true } };
    if (verb === "proposal.options" && !args.proposta_id) {
      return { status: 200, body: { midias: MIDIAS, midia: { proponente: "required", vendedor: "optional" } } };
    }
    if (verb === "proposal.options") {
      return {
        status: 200,
        body: {
          assinaturaConfigurada: true,
          metodos: [{ valor: "email", rotulo: "E-mail" }],
          signatarios: [{ nome: "TESTE Comprador Smoke", papel: "proponente" }],
          midias: MIDIAS,
          midia: { proponente: "required", vendedor: "optional" },
        },
      };
    }
    if (verb === "proposal.create") return { status: 201, body: { proposal: { id: "p1", codigo: "PROP-1" }, pdf: { link: "https://x/pdf" } } };
    if (verb === "proposal.update") return { status: 200, body: { pdf: { link: "https://x/pdf" } } };
    return null;
  });
}

const deps = (acao: ReturnType<typeof vi.fn>, extraido: DadosDaProposta) => ({
  acao,
  extrairProposta: vi.fn().mockResolvedValue(extraido),
  extrairCampos: vi.fn().mockResolvedValue({}),
});
const chamadas = (acao: ReturnType<typeof vi.fn>, verbo: string) => acao.mock.calls.filter((c) => c[0] === verbo);

const PEDIDO_REAL =
  "Quero fazer uma proposta de compra: comprador TESTE Comprador Smoke, CPF 392.769.438-03, tel 11 99906-3228, email teste@exemplo.com, imóvel Apto TESTE Rua Teste 30, bairro Bela Vista, São Paulo/SP, R$ 500.000 à vista, mídia de origem Instagram";
const COMPLETO: DadosDaProposta = {
  proponente: { nome: "TESTE Comprador Smoke", telefone: "11999063228", cpf: "39276943803", email: "teste@exemplo.com" },
  imovel: { endereco: "Apto TESTE Rua Teste 30", bairro: "Bela Vista", cidade: "São Paulo", uf: "SP" },
  valor: 500000,
};
const SEM_CPF: DadosDaProposta = { ...COMPLETO, proponente: { nome: "TESTE Comprador Smoke", telefone: "11999063228", email: "teste@exemplo.com" } };

describe("mídia dita no PRIMEIRO pedido não é perguntada de novo (prod 26/11)", () => {
  it("pedido completo: a mídia vai no card e no create", async () => {
    const acao = cm();
    const p = await F.iniciarProposta("venda", PEDIDO_REAL, agora, deps(acao, COMPLETO), undefined, undefined);
    expect(p.reply).not.toContain("Como o cliente chegou");
    expect(p.reply).toContain("Mídia de origem: Instagram");
    await F.conduzirFluxo(p.fluxo!, ctx("sim", "r1"), deps(acao, COMPLETO));
    expect(chamadas(acao, "proposal.create")[0]![1]).toMatchObject({ midia: "instagram" });
  });

  it("pedido incompleto, completado no turno seguinte: a mídia do 1º pedido segue valendo", async () => {
    const acao = cm();
    const p = await F.iniciarProposta("venda", PEDIDO_REAL, agora, deps(acao, SEM_CPF), undefined, undefined);
    expect(p.fluxo).toMatchObject({ etapa: "coleta" });
    const d = deps(acao, { proponente: { cpf: "39276943803" } });
    const r = await F.conduzirFluxo(p.fluxo!, ctx("CPF 392.769.438-03", "r2"), d);
    expect(r.reply).not.toContain("Como o cliente chegou");
    expect(r.reply).toContain("Mídia de origem: Instagram");
    expect(r.fluxo).toMatchObject({ etapa: "revisao" });
    await F.conduzirFluxo(r.fluxo!, ctx("sim", "r3"), d);
    expect(chamadas(acao, "proposal.create")[0]![1]).toMatchObject({ midia: "instagram" });
  });

  it("catálogo indisponível no início e exigido no envio: usa a origem do pedido, grava e não pergunta", async () => {
    const PENDENCIA = {
      status: 422,
      body: { error: "pendencias", faltando: [{ campo: "documento", motivo: "compradores.0.midia: Informe a mídia de origem.", signatario: null }] },
    };
    const base = cm({ "proposal.send": () => PENDENCIA });
    // Sem proposta, as options não respondem (nada de catálogo no início); com proposta, respondem.
    const acao = vi.fn().mockImplementation(async (verb: string, args: Record<string, unknown>) =>
      verb === "proposal.options" && !args.proposta_id ? null : base(verb, args));
    const d = deps(acao, COMPLETO);
    const p = await F.iniciarProposta("venda", PEDIDO_REAL, agora, d, undefined, undefined);
    expect(p.fluxo).toMatchObject({ etapa: "revisao" });
    const c = await F.conduzirFluxo(p.fluxo!, ctx("sim", "r4"), d);
    expect(c.evento).toBe("proposta_criada");
    const envio = await F.conduzirFluxo(
      { ...(c.fluxo as FluxoProposta), etapa: "envio", metodo: { valor: "email", rotulo: "E-mail" }, assinantes: [] },
      ctx("sim", "r5"),
      d
    );
    expect(envio.reply).not.toContain("Como o cliente chegou");
    expect(chamadas(acao, "proposal.update")[0]![1]).toMatchObject({ proposta_id: "p1", midia: "instagram" });
    expect(envio.reply).toContain("Registrei a mídia de origem: Instagram");
  });

  it("origem NÃO dita no pedido: segue perguntando (nada é inventado)", async () => {
    const acao = cm();
    const semOrigem = PEDIDO_REAL.replace(", mídia de origem Instagram", "");
    const p = await F.iniciarProposta("venda", semOrigem, agora, deps(acao, COMPLETO), undefined, undefined);
    expect(p.reply).toContain("Como o cliente chegou");
  });
});

describe("dicaDeMidiaDoPedido", () => {
  it("guarda só o trecho da origem, sem CPF nem o resto do pedido", () => {
    const d = F.dicaDeMidiaDoPedido("comprador TESTE Smoke, CPF 392.769.438-03, R$ 500.000 à vista, mídia de origem Instagram");
    expect(d).toBe("mídia de origem Instagram");
  });
  it("'assinatura via WhatsApp' não vira origem do cliente", () => {
    expect(F.dicaDeMidiaDoPedido("proposta de compra, assinatura via WhatsApp, R$ 500.000")).toBeUndefined();
  });
});
