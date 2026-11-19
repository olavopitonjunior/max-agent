import { describe, it, expect, vi } from "vitest";

// O cofre de pendentes da captação usa a mesma chave do cofre de crédito.
process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

/**
 * Mídia de origem (prod 19/11, Max Fincasa): o CM recusa o SIM do envio com
 * `compradores.0.midia: Informe a mídia de origem.` e o Max não sabia coletar.
 * Contrato aditivo do CM: `proposal.options` / `captacao.options` trazem `midias`
 * e a política (`midia`); `proposal.create|update` e `captacao.create` aceitam
 * `midia: "<id>"`; id inválido = 422 `midia_invalida`. Sem `midias` (CM antigo)
 * o comportamento é o de sempre.
 */

const F = await import("../fluxos");
const C = await import("../captacao");
type Fluxo = import("../fluxos").Fluxo;
type FluxoProposta = Extract<Fluxo, { kind: "proposta" }>;

const POLITICA = ["proposal.create", "proposal.send", "form.create"] as const;
const agora = 1_000_000;

const MIDIAS = [
  { id: "instagram", label: "Instagram" },
  { id: "indicacao", label: "Indicação" },
  { id: "site", label: "Site" },
  { id: "google_ads", label: "Google Ads" },
];

const DADOS_OK: import("../fluxos").DadosDaProposta = {
  proponente: { nome: "Letícia Gonçalves Nogueira", telefone: "11999990000", cpf: "12345678909" },
  imovel: { endereco: "Rua Senador Godoi, 606", bairro: "Vila São Geraldo" },
  valor: 1_500_000,
};

/** O pedido precisa trazer os dados por extenso: o Max concilia o que o extrator devolve com o texto. */
const PEDIDO =
  "proposta de compra: comprador Letícia Gonçalves Nogueira, CPF 123.456.789-09, tel 11999990000, imóvel Rua Senador Godoi, 606, Vila São Geraldo, R$ 1.500.000";

const ctx = (texto: string, extra: Partial<import("../fluxos").ContextoDoTurno> = {}) => ({
  texto,
  messageId: `m-${texto.slice(0, 8)}`,
  policy: [...POLITICA],
  agora,
  ...extra,
});

/** O CM simulado: `options` (sem proposta) devolve a política da mídia; o resto é configurável. */
function cm(opts: { midias?: typeof MIDIAS | null; politica?: "required" | "optional" | "hidden"; extra?: Record<string, (args: Record<string, unknown>) => unknown> } = {}) {
  const midias = opts.midias === undefined ? MIDIAS : opts.midias;
  const politica = opts.politica ?? "required";
  return vi.fn().mockImplementation(async (verb: string, args: Record<string, unknown>) => {
    const sobre = opts.extra?.[verb];
    if (sobre) return sobre(args);
    if (verb === "proposal.preflight") return { status: 200, body: { modelo: true, assinatura: true } };
    if (verb === "proposal.options" && !args.proposta_id) {
      return { status: 200, body: midias ? { midias, midia: { proponente: politica, vendedor: "optional" } } : {} };
    }
    if (verb === "proposal.options") {
      return {
        status: 200,
        body: {
          assinaturaConfigurada: true,
          metodos: [{ valor: "email", rotulo: "E-mail" }],
          signatarios: [{ nome: "Letícia Gonçalves Nogueira", papel: "proponente" }],
          ...(midias ? { midias, midia: { proponente: politica, vendedor: "optional" } } : {}),
        },
      };
    }
    if (verb === "proposal.create") return { status: 201, body: { proposal: { id: "p1", codigo: "PROP-1" }, pdf: { link: "https://x/pdf" } } };
    if (verb === "proposal.update") return { status: 200, body: { pdf: { link: "https://x/pdf" } } };
    return null;
  });
}

function deps(acao: ReturnType<typeof vi.fn>, extraido: import("../fluxos").DadosDaProposta = DADOS_OK) {
  return {
    acao,
    extrairProposta: vi.fn().mockResolvedValue(extraido),
    extrairCampos: vi.fn().mockResolvedValue({}),
  };
}

const chamadas = (acao: ReturnType<typeof vi.fn>, verbo: string) => acao.mock.calls.filter((c) => c[0] === verbo);

describe("lerMidia / midiaNoTexto", () => {
  it("lê por número e por nome", () => {
    expect(F.lerMidia("2", MIDIAS)?.id).toBe("indicacao");
    expect(F.lerMidia("instagram", MIDIAS)?.id).toBe("instagram");
    expect(F.lerMidia("foi pelo Google Ads", MIDIAS)?.id).toBe("google_ads");
    expect(F.lerMidia("indicacao", MIDIAS)?.id).toBe("indicacao");
    expect(F.lerMidia("9", MIDIAS)).toBeNull();
    expect(F.lerMidia("sei lá", MIDIAS)).toBeNull();
  });
  it("aproveita o que o corretor escreveu, só com sinal de origem", () => {
    expect(F.midiaNoTexto("o cliente veio pelo Instagram", MIDIAS)?.id).toBe("instagram");
    expect(F.midiaNoTexto("mídia de origem do comprador: Instagram", MIDIAS)?.id).toBe("instagram");
    expect(F.midiaNoTexto("foi uma indicação", MIDIAS)?.id).toBe("indicacao");
    expect(F.midiaNoTexto("o imóvel está no site da construtora", MIDIAS)).toBeNull();
    expect(F.midiaNoTexto("valor 500 mil", MIDIAS)).toBeNull();
  });
});

describe("proposta v1 — mídia obrigatória antes do SIM do rascunho", () => {
  it("já dita no pedido: entra no card e vai no create", async () => {
    const acao = cm();
    const p = await F.iniciarProposta("venda", `${PEDIDO}, o cliente veio pelo Instagram`, agora, deps(acao), undefined, undefined, undefined);
    expect(p.reply).toContain("Mídia de origem: Instagram");
    expect(p.fluxo).toMatchObject({ etapa: "revisao" });
    const c = await F.conduzirFluxo(p.fluxo!, ctx("sim", { messageId: "k1" }), deps(acao));
    expect(c.evento).toBe("proposta_criada");
    expect(chamadas(acao, "proposal.create")[0]![1]).toMatchObject({ midia: "instagram" });
  });

  it("não dita: pergunta com lista numerada, lê por número e mostra no card", async () => {
    const acao = cm();
    const p = await F.iniciarProposta("venda", PEDIDO, agora, deps(acao), undefined, undefined, undefined);
    expect(p.reply).toContain("Como o cliente chegou até a imobiliária?");
    expect(p.reply).toContain("1. Instagram");
    expect(p.reply).toContain("2. Indicação");
    expect(p.reply).not.toContain("Está correto?");
    expect(chamadas(acao, "proposal.create")).toHaveLength(0);

    const d = deps(acao);
    const r = await F.conduzirFluxo(p.fluxo!, ctx("2"), d);
    expect(d.extrairProposta).not.toHaveBeenCalled();
    expect(r.reply).toContain("Mídia de origem: Indicação");
    expect(r.reply).toContain("SIM");
    expect(r.fluxo).toMatchObject({ etapa: "revisao" });

    const c = await F.conduzirFluxo(r.fluxo!, ctx("sim", { messageId: "k2" }), d);
    expect(c.evento).toBe("proposta_criada");
    expect(chamadas(acao, "proposal.create")[0]![1]).toMatchObject({ midia: "indicacao" });
  });

  it("resposta que não é da lista repete a lista", async () => {
    const acao = cm();
    const p = await F.iniciarProposta("venda", PEDIDO, agora, deps(acao), undefined, undefined, undefined);
    const r = await F.conduzirFluxo(p.fluxo!, ctx("hmm"), deps(acao));
    expect(r.reply).toContain("1. Instagram");
    expect(r.fluxo).toMatchObject({ aguardaMidia: true });
  });

  it("opcional: não pergunta; só grava se o corretor disser", async () => {
    const acao = cm({ politica: "optional" });
    const p = await F.iniciarProposta("venda", PEDIDO, agora, deps(acao), undefined, undefined, undefined);
    expect(p.reply).not.toContain("Como o cliente chegou");
    expect(p.reply).not.toContain("Mídia de origem");
    expect(p.fluxo).toMatchObject({ etapa: "revisao" });
    const d = deps(acao, {});
    const r = await F.conduzirFluxo(p.fluxo!, ctx("ah, ele veio pelo site"), d);
    expect(r.reply).toContain("Mídia de origem: Site");
    const c = await F.conduzirFluxo(r.fluxo!, ctx("sim", { messageId: "k3" }), d);
    expect(chamadas(acao, "proposal.create")[0]![1]).toMatchObject({ midia: "site" });
    expect(c.evento).toBe("proposta_criada");
  });

  it("CM antigo (sem midias nas options): comportamento de sempre, sem campo midia", async () => {
    const acao = cm({ midias: null });
    const p = await F.iniciarProposta("venda", PEDIDO, agora, deps(acao), undefined, undefined, undefined);
    expect(p.reply).toContain("Está correto?");
    expect(p.reply).not.toContain("Mídia");
    const c = await F.conduzirFluxo(p.fluxo!, ctx("sim", { messageId: "k4" }), deps(acao));
    expect(chamadas(acao, "proposal.create")[0]![1]).not.toHaveProperty("midia");
    expect(c.evento).toBe("proposta_criada");
  });

  it("422 midia_invalida no create: repete a lista (com o catálogo novo)", async () => {
    const acao = cm({
      extra: { "proposal.create": () => ({ status: 422, body: { error: "midia_invalida", midias: [{ id: "tv", label: "TV" }, { id: "radio", label: "Rádio" }] } }) },
    });
    const f: FluxoProposta = {
      kind: "proposta", etapa: "revisao", natureza: "venda", dados: { ...DADOS_OK, midia: "instagram" },
      midias: MIDIAS, midiaPolitica: "required", atualizadoEm: agora,
    };
    const r = await F.conduzirFluxo(f, ctx("sim"), deps(acao));
    expect(r.reply).toContain("Como o cliente chegou até a imobiliária?");
    expect(r.reply).toContain("1. TV");
    expect(r.reply).toContain("2. Rádio");
    expect(r.reply).not.toContain("midia_invalida");
    expect(r.fluxo).toMatchObject({ aguardaMidia: true });
    expect((r.fluxo as FluxoProposta).dados.midia).toBeUndefined();
  });
});

describe("proposta — pendência de mídia no envio (prod 19/11)", () => {
  const PENDENCIA = {
    status: 422,
    body: { error: "pendencias", faltando: [{ campo: "documento", motivo: "compradores.0.midia: Informe a mídia de origem.", signatario: null }] },
  };
  const rascunho: FluxoProposta = {
    kind: "proposta", etapa: "envio", natureza: "venda", dados: DADOS_OK, propostaId: "p1", codigo: "PROP-1",
    metodo: { valor: "email", rotulo: "E-mail" }, assinantes: [{ nome: "Letícia Gonçalves Nogueira", papel: "proponente" }],
    midias: MIDIAS, atualizadoEm: agora,
  };

  it("não expõe o caminho técnico; entra no ajuste pedindo a mídia (lista)", async () => {
    const acao = cm({ extra: { "proposal.send": () => PENDENCIA } });
    const r = await F.conduzirFluxo(rascunho, ctx("sim"), deps(acao));
    expect(r.reply).not.toContain("compradores.0");
    expect(r.reply).not.toContain("dados do documento");
    expect(r.reply).toContain("Como o cliente chegou até a imobiliária?");
    expect(r.reply).toContain("1. Instagram");
    expect(r.fluxo).toMatchObject({ etapa: "ajustes", aguardaMidia: true, voltarAoEnvio: true });
  });

  it("com a resposta: atualiza o rascunho com a mídia e volta ao cartão de envio", async () => {
    const acao = cm({ extra: { "proposal.send": () => PENDENCIA } });
    const d = deps(acao);
    const p = await F.conduzirFluxo(rascunho, ctx("sim"), d);
    const r = await F.conduzirFluxo(p.fluxo!, ctx("1", { messageId: "k5" }), d);
    const up = chamadas(acao, "proposal.update");
    expect(up).toHaveLength(1);
    expect(up[0]![1]).toMatchObject({ proposta_id: "p1", midia: "instagram" });
    expect(r.reply).toContain("Instagram");
    expect(r.reply).toContain("Confirma? Responda *SIM* para enviar");
    expect(r.fluxo).toMatchObject({ etapa: "envio" });
  });

  it("rascunho retomado (sem natureza): o PATCH leva só a mídia", async () => {
    const acao = cm({ extra: { "proposal.send": () => PENDENCIA } });
    const d = deps(acao);
    const retomado: FluxoProposta = { ...rascunho, natureza: undefined, dados: {} };
    const p = await F.conduzirFluxo(retomado, ctx("sim"), d);
    expect(p.fluxo).toMatchObject({ aguardaMidia: true });
    await F.conduzirFluxo(p.fluxo!, ctx("indicação", { messageId: "k6" }), d);
    expect(chamadas(acao, "proposal.update")[0]![1]).toEqual({ proposta_id: "p1", midia: "indicacao" });
  });

  it("midia_invalida no update: repete a lista", async () => {
    const acao = cm({
      extra: {
        "proposal.send": () => PENDENCIA,
        "proposal.update": () => ({ status: 422, body: { error: "midia_invalida", midias: MIDIAS.slice(0, 2) } }),
      },
    });
    const d = deps(acao);
    const p = await F.conduzirFluxo(rascunho, ctx("sim"), d);
    const r = await F.conduzirFluxo(p.fluxo!, ctx("3", { messageId: "k7" }), d);
    expect(r.reply).toContain("Como o cliente chegou até a imobiliária?");
    expect(r.fluxo).toMatchObject({ aguardaMidia: true });
  });

  it("sem catálogo no estado, busca em proposal.options antes de perguntar", async () => {
    const acao = cm({ extra: { "proposal.send": () => PENDENCIA } });
    const r = await F.conduzirFluxo({ ...rascunho, midias: undefined }, ctx("sim"), deps(acao));
    expect(r.reply).toContain("1. Instagram");
  });

  it("outra pendência com motivo: frase de corretor, nunca o caminho técnico", async () => {
    const acao = cm({
      extra: {
        "proposal.send": () => ({
          status: 422,
          body: { error: "pendencias", faltando: [{ campo: "documento", motivo: "compradores.0.estadoCivil: Informe o estado civil.", signatario: null }] },
        }),
      },
    });
    const r = await F.conduzirFluxo(rascunho, ctx("sim"), deps(acao));
    expect(r.reply).not.toContain("compradores.0");
    expect(r.reply).not.toContain("dados do documento");
    expect(r.reply?.toLowerCase()).toContain("estado civil");
  });
});

// ─── Captação ──────────────────────────────────────────────────────────────

const POLITICA_CAP = ["captacao.create", "captacao.send", "captacao.list"] as const;

function cmCaptacao(opts: { midias?: typeof MIDIAS | null; politica?: "required" | "optional" | "hidden"; preflight?: unknown } = {}) {
  const midias = opts.midias === undefined ? MIDIAS : opts.midias;
  return vi.fn().mockImplementation(async (verb: string) => {
    if (verb === "captacao.options") {
      return { status: 200, body: { modelos: [{ id: "m1", nome: "Padrão" }], ...(midias ? { midias, midia: opts.politica ?? "required" } : {}) } };
    }
    if (verb === "captacao.create") return { status: 201, body: { captacao: { id: "c1", codigo: "CAP-1", version: 1 } } };
    if (verb === "captacao.preflight") return { status: 200, body: opts.preflight ?? { pronto: true, faltantes: [], bloqueios: [], version: 1 } };
    return null;
  });
}

function depsCap(acao: ReturnType<typeof vi.fn>) {
  return { acao, extrairProposta: vi.fn().mockResolvedValue({}), extrairCampos: vi.fn().mockResolvedValue({}) };
}
const ctxCap = (texto: string, extra: Partial<import("../fluxos").ContextoDoTurno> = {}) => ({
  texto, messageId: `c-${texto.slice(0, 8)}`, policy: [...POLITICA_CAP], agora, ...extra,
});

describe("captação — mídia obrigatória antes de criar", () => {
  async function ateOImovel(acao: ReturnType<typeof vi.fn>, pedido = "cria uma captação de venda chamada Casa da Maria") {
    const d = depsCap(acao);
    return { d, p: await C.iniciarCaptacao(ctxCap(pedido), d, true) };
  }

  it("pergunta a mídia (lista) antes do captacao.create e manda midia no create", async () => {
    const acao = cmCaptacao();
    const { d, p } = await ateOImovel(acao);
    let passo = p;
    // imóvel (PULAR) → condições (PULAR) → cria
    passo = (await C.conduzirCaptacao(passo.fluxo as import("../captacao").FluxoCaptacao, ctxCap("pular"), d, true)) as typeof p;
    passo = (await C.conduzirCaptacao(passo.fluxo as import("../captacao").FluxoCaptacao, ctxCap("pular"), d, true)) as typeof p;
    expect(passo.reply).toContain("Como o cliente chegou até a imobiliária?");
    expect(passo.reply).toContain("1. Instagram");
    expect(acao.mock.calls.filter((c) => c[0] === "captacao.create")).toHaveLength(0);
    const r = await C.conduzirCaptacao(passo.fluxo as import("../captacao").FluxoCaptacao, ctxCap("2", { messageId: "mid-2" }), d, true);
    const create = acao.mock.calls.filter((c) => c[0] === "captacao.create");
    expect(create).toHaveLength(1);
    expect(create[0]![1]).toMatchObject({ tipo: "venda", midia: "indicacao" });
    expect(r.reply).toContain("Criei o rascunho");
  });

  it("opcional ou sem catálogo: não pergunta e não manda midia", async () => {
    for (const cfg of [{ politica: "optional" as const }, { midias: null }]) {
      const acao = cmCaptacao(cfg);
      const { d, p } = await ateOImovel(acao);
      let passo = p;
      passo = (await C.conduzirCaptacao(passo.fluxo as import("../captacao").FluxoCaptacao, ctxCap("pular"), d, true)) as typeof p;
      passo = (await C.conduzirCaptacao(passo.fluxo as import("../captacao").FluxoCaptacao, ctxCap("pular"), d, true)) as typeof p;
      expect(passo.reply).not.toContain("Como o cliente chegou");
      const create = acao.mock.calls.filter((c) => c[0] === "captacao.create");
      expect(create).toHaveLength(1);
      expect(create[0]![1]).not.toHaveProperty("midia");
    }
  });

  it("pendência de mídia no preflight (rascunho da tela): pergunta a lista e grava", async () => {
    const acao = cmCaptacao({
      preflight: {
        pronto: false, version: 1, bloqueios: [],
        faltantes: [{ path: "midia", rotulo: "Mídia de origem", nivel: "envio", opcoes: MIDIAS.map((m) => ({ valor: m.id, label: m.label })) }],
      },
    });
    const d = depsCap(acao);
    const base: import("../captacao").FluxoCaptacao = {
      kind: "captacao", etapa: "verificar", tipo: "venda", captacaoId: "c1", codigo: "CAP-1", version: 1, tentativas: 0, atualizadoEm: agora,
    };
    const p = await C.conduzirCaptacao(base, ctxCap("pronto"), d, true);
    expect(p.reply).toContain("Como o cliente chegou até a imobiliária?");
    expect(p.reply).toContain("1. Instagram");
    const r = await C.conduzirCaptacao(p.fluxo as import("../captacao").FluxoCaptacao, ctxCap("3", { messageId: "mid-3" }), d, true);
    const create = acao.mock.calls.filter((c) => c[0] === "captacao.create");
    expect(create[0]![1]).toMatchObject({ captacaoId: "c1", midia: "site" });
    expect(r.reply).toBeTruthy();
  });
});
