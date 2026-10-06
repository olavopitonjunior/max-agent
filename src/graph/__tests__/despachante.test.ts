import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * O despachante e o registro de tools (PR 2 do plano de 05/10).
 *
 * Negado antes do permitido (regra 3): cada trava tem o seu caso de recusa
 * ISOLADO — a chamada passa por todas as outras e cai só naquela. Um teste que
 * recusasse por dois motivos ao mesmo tempo não provaria qual trava funciona.
 */

vi.mock("@/lib/scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/scope")>()),
  consultarEscopo: vi.fn(),
}));
vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  criarRascunhoProposta: vi.fn(),
  criarFormularioVenda: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));
vi.mock("@/lib/acao", () => ({
  executarAcao: vi.fn().mockResolvedValue({ status: 200, body: { campos: [], gerente: { obrigatorio: false } } }),
}));

const { autorizarChamada, autorizarPendencia, despacharLeituras, argsDaCriacao } = await import(
  "../despachante"
);
const {
  REGISTRO_DE_TOOLS,
  NOMES_DE_TOOL,
  TOOL_PROPOR_FORM,
  ferramentasDoTurno,
  capabilityDaCriacao,
} = await import("../tools");
const { consultarEscopo } = await import("@/lib/scope");
const escopo = vi.mocked(consultarEscopo);

const gerente = {
  orgId: "org1", orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "Marcia",
};
const corretor = {
  orgId: "org1", orgName: "RE/MAX Trio", kind: "broker" as const, splitRecipientId: "sr1", label: "Wesley",
};
const TUDO = ["deal.list", "deal.pending", "proposal.list", "form.create", "proposal.create"] as const;
const OFERECIDAS = ["propor_criacao", "listar_negocios", "pendencias_do_negocio", "listar_propostas"];

beforeEach(() => vi.clearAllMocks());

// ── O registro ─────────────────────────────────────────────────────────────

describe("registro de tools", () => {
  it("toda entrada declara nome = def.name, tipo, risco e confirmação", () => {
    for (const e of REGISTRO_DE_TOOLS) {
      expect(e.nome, e.nome).toBe(e.def.name);
      expect(["leitura", "escrita"]).toContain(e.tipo);
      expect(["nenhum", "pago", "irreversivel"]).toContain(e.risco);
      expect(typeof e.confirmacao).toBe("boolean");
    }
  });

  /** G3: escrita sem confirmação seria o modelo agindo sozinho no tenant. */
  it("toda escrita exige confirmação; nenhuma leitura exige", () => {
    for (const e of REGISTRO_DE_TOOLS) {
      expect(e.confirmacao, e.nome).toBe(e.tipo === "escrita");
    }
  });

  it("nomes são únicos e o sanitizador conhece todos", () => {
    const nomes = REGISTRO_DE_TOOLS.map((e) => e.nome);
    expect(new Set(nomes).size).toBe(nomes.length);
    expect(NOMES_DE_TOOL).toEqual(nomes);
  });

  it("toda leitura que lista declara o que produz (G2)", () => {
    for (const e of REGISTRO_DE_TOOLS.filter((x) => x.tipo === "leitura")) {
      expect(e.refs?.produz, e.nome).toBeDefined();
    }
  });

  it("criação: proposta exige proposal.create; formulário, form.create", () => {
    expect(capabilityDaCriacao("proposta")).toBe("proposal.create");
    expect(capabilityDaCriacao("venda")).toBe("form.create");
    expect(capabilityDaCriacao("locacao")).toBe("form.create");
    expect(capabilityDaCriacao("aluguel")).toBeNull();
    expect(capabilityDaCriacao(undefined)).toBeNull();
  });
});

// ── As quatro travas, uma por vez ──────────────────────────────────────────

describe("autorizarChamada — recusas isoladas", () => {
  const base = { oferecidas: OFERECIDAS, policy: [...TUDO], identity: gerente };

  it("(a) nome fora do registro → tool_desconhecida", () => {
    const r = autorizarChamada({ ...base, chamada: { name: "apagar_tudo", args: {} } });
    expect(r).toMatchObject({ ok: false, motivo: "tool_desconhecida" });
  });

  it("(b) tool do registro que não foi oferecida neste turn → nao_oferecida", () => {
    const r = autorizarChamada({
      ...base,
      oferecidas: ["listar_negocios"],
      chamada: { name: "listar_propostas", args: {} },
    });
    expect(r).toMatchObject({ ok: false, motivo: "nao_oferecida" });
  });

  /**
   * (c) ISOLADA: oferecida, identidade válida, só a política não concede.
   * É o caso que a oferta sozinha não cobre — política que mudou no meio do
   * laço, ou chamada injetada por um resultado anterior.
   */
  it("(c) leitura oferecida sem a capability → capability_negada", () => {
    const r = autorizarChamada({
      ...base,
      policy: ["deal.list"],
      chamada: { name: "listar_propostas", args: {} },
    });
    expect(r).toMatchObject({ ok: false, motivo: "capability_negada" });
  });

  it("(c) escrita: form.create não cobre proposta → capability_negada", () => {
    const r = autorizarChamada({
      ...base,
      policy: ["form.create"],
      chamada: { name: TOOL_PROPOR_FORM, args: { tipo: "proposta" } },
    });
    expect(r).toMatchObject({ ok: false, motivo: "capability_negada" });
  });

  it("(c) escrita: proposal.create não cobre formulário → capability_negada", () => {
    const r = autorizarChamada({
      ...base,
      policy: ["proposal.create"],
      chamada: { name: TOOL_PROPOR_FORM, args: { tipo: "venda" } },
    });
    expect(r).toMatchObject({ ok: false, motivo: "capability_negada" });
  });

  it("(d) corretor sem login chamando escrita → identidade_nao_escreve", () => {
    const r = autorizarChamada({
      ...base,
      identity: corretor,
      chamada: { name: TOOL_PROPOR_FORM, args: { tipo: "venda" } },
    });
    expect(r).toMatchObject({ ok: false, motivo: "identidade_nao_escreve" });
  });

  it("argumento fora do enum → tipo_invalido, nunca o mais parecido", () => {
    const r = autorizarChamada({
      ...base,
      chamada: { name: TOOL_PROPOR_FORM, args: { tipo: "aluguel" } },
    });
    expect(r).toMatchObject({ ok: false, motivo: "tipo_invalido" });
  });

  // E o permitido, depois do negado.
  it("tudo certo → ok, com a capability da chamada", () => {
    expect(
      autorizarChamada({ ...base, chamada: { name: TOOL_PROPOR_FORM, args: { tipo: "proposta" } } })
    ).toMatchObject({ ok: true, capability: "proposal.create" });
    expect(
      autorizarChamada({ ...base, chamada: { name: "listar_negocios", args: {} } })
    ).toMatchObject({ ok: true, capability: "deal.list" });
  });
});

describe("autorizarPendencia — o turn do SIM", () => {
  const pend = (tipo: string) =>
    ({ kind: "criar_documento", args: { tipo }, askedAt: 0, askedForMessageId: "m0" }) as never;

  it("política de agora sem a capability → recusa", () => {
    expect(autorizarPendencia({ pending: pend("venda"), policy: [], identity: gerente })).toEqual({
      ok: false,
      motivo: "capability_negada",
    });
  });
  it("corretor sem login → recusa", () => {
    expect(
      autorizarPendencia({ pending: pend("venda"), policy: ["form.create"], identity: corretor })
    ).toEqual({ ok: false, motivo: "identidade_nao_escreve" });
  });
  it("concedida → ok", () => {
    expect(
      autorizarPendencia({ pending: pend("proposta"), policy: ["proposal.create"], identity: gerente })
    ).toEqual({ ok: true });
  });
});

describe("argsDaCriacao", () => {
  it("corta o nome em 80 e descarta valor fora do enum", () => {
    const a = argsDaCriacao({ tipo: "locacao", nome_cliente: "x".repeat(200), finalidade: "industrial" });
    expect(a?.nomeCliente).toHaveLength(80);
    expect(a?.finalidade).toBeUndefined();
    expect(argsDaCriacao({ tipo: "form" })).toBeNull();
  });
});

// ── A oferta (G4) ──────────────────────────────────────────────────────────

describe("ferramentasDoTurno — o que o modelo VÊ", () => {
  const texto = "me manda o link do formulário pro João";
  const nomes = (policy: string[], identity: typeof gerente | typeof corretor = gerente) =>
    ferramentasDoTurno({ policy: policy as never, texto, identity }).entradas.map((e) => e.nome);

  it("sem política nenhuma: sem escrita (fail-closed)", () => {
    expect(nomes([])).not.toContain(TOOL_PROPOR_FORM);
  });
  it("corretor sem login: sem escrita, mesmo com a capability", () => {
    expect(nomes(["form.create", "proposal.create"], corretor)).not.toContain(TOOL_PROPOR_FORM);
  });
  it("basta UMA das capabilities de criação para oferecer", () => {
    expect(nomes(["form.create"])).toContain(TOOL_PROPOR_FORM);
    expect(nomes(["proposal.create"])).toContain(TOOL_PROPOR_FORM);
  });
  it("texto que não pede escrita: fora, mesmo com tudo concedido", () => {
    expect(
      ferramentasDoTurno({ policy: [...TUDO], texto: "bom dia", identity: gerente }).entradas
    ).toEqual([]);
  });
});

// ── O executor de leitura passa pelas travas ───────────────────────────────

describe("despacharLeituras", () => {
  const ctx = {
    oferecidas: ["listar_negocios"],
    policy: ["deal.list"] as never,
    identity: gerente,
    fromPhone: "+5511999990000",
    referencias: null,
    turno: "m1",
    agora: 1_000,
  };

  it("chamada recusada NÃO chega ao servidor, e volta como FALHA ao modelo", async () => {
    const r = await despacharLeituras({
      ...ctx,
      chamadas: [{ name: "listar_propostas", args: {} }],
    });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados).toEqual([{ tool: "listar_propostas", items: null, truncated: false }]);
    expect(r.trilha[0].outcome).toBe("nao_oferecida");
  });

  it("escrita no laço de leitura não executa", async () => {
    const r = await despacharLeituras({
      ...ctx,
      oferecidas: [TOOL_PROPOR_FORM],
      policy: ["form.create"] as never,
      chamadas: [{ name: TOOL_PROPOR_FORM, args: { tipo: "venda" } }],
    });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0].items).toBeNull();
  });

  it("autorizada: consulta, numera e tira o id do que vai ao modelo", async () => {
    escopo.mockResolvedValue({
      items: [
        { id: "cdeal00000000000000000001", titulo: "Rua A, 10", etapa: "Docs" },
        { id: "cdeal00000000000000000002", titulo: "Rua B, 20", etapa: "Assinatura" },
      ],
      truncated: false,
    });
    const r = await despacharLeituras({ ...ctx, chamadas: [{ name: "listar_negocios", args: {} }] });

    expect(escopo).toHaveBeenCalledTimes(1);
    expect(r.resultados[0].items).toEqual([
      { n: 1, titulo: "Rua A, 10", etapa: "Docs" },
      { n: 2, titulo: "Rua B, 20", etapa: "Assinatura" },
    ]);
    expect(JSON.stringify(r.resultados)).not.toContain("cdeal");
    expect(r.referencias?.itens.map((i) => [i.n, i.id])).toEqual([
      [1, "cdeal00000000000000000001"],
      [2, "cdeal00000000000000000002"],
    ]);
  });
});

// ── No grafo: a escrita recusada não vira pendência ────────────────────────

describe("no grafo: escrita pelo despachante", () => {
  const uso = { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true };

  async function rodar(texto: string, identity: typeof gerente | typeof corretor, args: Record<string, unknown>) {
    const { buildGraph } = await import("../graph");
    const { complete } = await import("@/lib/llm");
    vi.mocked(complete).mockResolvedValue({
      text: "", toolCalls: [{ name: TOOL_PROPOR_FORM, args }], usage: uso,
    } as never);
    return buildGraph().compile().invoke({
      inbound: { fromPhone: "+5511999990000", text: texto, messageId: "m1" },
      identity,
    } as never);
  }

  beforeEach(async () => {
    const { fetchProfile } = await import("@/lib/cm");
    vi.mocked(fetchProfile).mockResolvedValue({
      enabled: true, model: "x",
      // Só formulário: proposta NÃO está concedida.
      maxPolicy: { byRole: { "*": ["form.create"] }, brokerDefault: ["form.create"] },
    } as never);
  });

  it("proposta sem proposal.create: recusa por template, sem pendência", async () => {
    const r = await rodar("cria uma proposta pro Carlos", gerente, { tipo: "proposta" });
    expect(r.pendingAction).toBeNull();
    expect(r.reply).toContain("não está liberado");
    expect(r.reply).toContain("Nada foi criado");
    expect(r.toolLog.map((t: { outcome: string }) => t.outcome)).toContain("capability_negada");
  });

  it("formulário com form.create: abre o fluxo de negócio (o permitido)", async () => {
    const r = await rodar("cria um formulário de venda", gerente, { tipo: "venda" });
    expect(r.fluxo?.kind).toBe("negocio");
    expect(r.pendingAction).toBeNull();
  });

  /**
   * Corretor sem login nem recebe a tool — mas se o modelo emitir a chamada
   * assim mesmo (alucinação, injeção), antes ela virava pendência. Agora não.
   */
  it("chamada de escrita NÃO oferecida (corretor) é recusada, sem pendência", async () => {
    // Texto que NÃO é pedido explícito (esse sai por template, sem modelo —
    // ver "B1" abaixo): aqui o modelo roda e emite a chamada assim mesmo.
    const r = await rodar("me manda o link do formulário de venda", corretor, { tipo: "venda" });
    expect(r.pendingAction).toBeNull();
    expect(r.toolLog.map((t: { outcome: string }) => t.outcome)).toContain("nao_oferecida");
  });

  it("nome inventado pelo modelo fica na trilha como tool_desconhecida", async () => {
    const { buildGraph } = await import("../graph");
    const { complete } = await import("@/lib/llm");
    vi.mocked(complete).mockResolvedValue({
      text: "Certo.", toolCalls: [{ name: "apagar_negocio", args: { id: "x" } }], usage: uso,
    } as never);
    const r = await buildGraph().compile().invoke({
      inbound: { fromPhone: "+5511999990000", text: "apaga o negócio 2", messageId: "m1" },
      identity: gerente,
    } as never);
    expect(r.toolLog.map((t: { outcome: string }) => t.outcome)).toEqual(["tool_desconhecida"]);
    expect(r.pendingAction).toBeNull();
  });
});
