import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Passo 5 — consultas: detalhe de proposta/negócio e corpo da notificação.
 *
 * Negado antes do permitido (regra 3): cada trava de `detalhar_*` tem o seu caso
 * de recusa isolado. O detalhe nunca recebe id do modelo e nunca assume "a mais
 * recente".
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
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));

const { despacharLeituras } = await import("../despachante");
const { ferramentasDoTurno, DETALHAR_PROPOSTA, DETALHAR_NEGOCIO } = await import("../tools");
const { projetarNotificacao, LIMITE_TEXTO_NOTIFICACAO } = await import("../notificacao-projecao");
const { REFERENCIA_TTL_MS } = await import("../referencias");
const { consultarEscopo } = await import("@/lib/scope");
const escopo = vi.mocked(consultarEscopo);

const gerente = { orgId: "org1", orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "Marcia" };

const mapa = (tipo: "proposta" | "negocio", criadoEm = 1_000) => ({
  criadoEm,
  turno: "t0",
  itens: [
    { n: 1, tipo, id: `${tipo}-id-1`, rotulo: "Um" },
    { n: 2, tipo, id: `${tipo}-id-2`, rotulo: "Dois" },
  ],
});

const base = {
  fromPhone: "+5511999990000",
  identity: gerente,
  turno: "t1",
  agora: 2_000,
};

beforeEach(() => vi.clearAllMocks());

describe("detalhar_proposta / detalhar_negocio — o despachante", () => {
  const prop = { ...base, oferecidas: ["detalhar_proposta"], policy: ["proposal.detail"] as never, referencias: mapa("proposta") };
  const neg = { ...base, oferecidas: ["detalhar_negocio"], policy: ["deal.detail"] as never, referencias: mapa("negocio") };

  it("NEGADO: sem a capability a chamada não chega ao servidor", async () => {
    const r = await despacharLeituras({ ...prop, policy: ["proposal.list"] as never, chamadas: [{ name: "detalhar_proposta", args: { numero: 1 } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("capability_negada");
  });

  it("NEGADO: tool não oferecida no turno", async () => {
    const r = await despacharLeituras({ ...neg, oferecidas: [], chamadas: [{ name: "detalhar_negocio", args: { numero: 1 } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.trilha[0].outcome).toBe("nao_oferecida");
  });

  it.each([
    ["sem número", {}],
    ["número em texto não numérico", { numero: "a mais recente" }],
    ["número decimal", { numero: 1.5 }],
    ["número fora da lista", { numero: 9 }],
    ["id interno no lugar do número", { numero: "proposta-id-1" }],
    ["id passado direto", { proposta_id: "proposta-id-1" }],
  ])("NEGADO: %s -> referencia_invalida, sem consulta", async (_t, args) => {
    const r = await despacharLeituras({ ...prop, chamadas: [{ name: "detalhar_proposta", args }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("referencia_invalida");
  });

  it("NEGADO: sem lista vigente não existe 'a mais recente'", async () => {
    const r = await despacharLeituras({ ...prop, referencias: null, chamadas: [{ name: "detalhar_proposta", args: { numero: 1 } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.trilha[0].outcome).toBe("referencia_invalida");
  });

  it("NEGADO: lista vencida (TTL)", async () => {
    const r = await despacharLeituras({
      ...prop,
      referencias: mapa("proposta", 0),
      agora: REFERENCIA_TTL_MS + 10,
      chamadas: [{ name: "detalhar_proposta", args: { numero: 1 } }],
    });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.trilha[0].outcome).toBe("referencia_invalida");
  });

  it("NEGADO: número de outro tipo (negócio apontado como proposta)", async () => {
    const r = await despacharLeituras({ ...prop, referencias: mapa("negocio"), chamadas: [{ name: "detalhar_proposta", args: { numero: 1 } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.trilha[0].outcome).toBe("referencia_invalida");
  });

  it("proposta: traduz o número em proposta_id, manda só isso e devolve o MESMO n sem id", async () => {
    escopo.mockResolvedValue({ items: [{ id: "proposta-id-2", codigo: "PROP-2026-0034", estado: "enviada" }], truncated: false });
    const r = await despacharLeituras({ ...prop, chamadas: [{ name: "detalhar_proposta", args: { numero: 2, proposta_id: "outra", extra: 1 } }] });
    expect(escopo).toHaveBeenCalledWith(expect.objectContaining({ verb: "proposal.detail", args: { proposta_id: "proposta-id-2" } }));
    expect(r.resultados[0].items).toEqual([{ n: 2, codigo: "PROP-2026-0034", estado: "enviada" }]);
    expect(JSON.stringify(r.resultados)).not.toContain("proposta-id-2");
    expect(r.trilha[0].outcome).toBe("ok");
  });

  it("negócio: traduz o número em negocio_id", async () => {
    escopo.mockResolvedValue({ items: [{ id: "negocio-id-1", titulo: "Rua A", etapa: "Docs" }], truncated: false });
    const r = await despacharLeituras({ ...neg, chamadas: [{ name: "detalhar_negocio", args: { numero: "1" } }] });
    expect(escopo).toHaveBeenCalledWith(expect.objectContaining({ verb: "deal.detail", args: { negocio_id: "negocio-id-1" } }));
    expect(r.resultados[0].items).toEqual([{ n: 1, titulo: "Rua A", etapa: "Docs" }]);
  });

  it("servidor sem resposta: falha_na_consulta (não finge dado)", async () => {
    escopo.mockResolvedValue(null);
    const r = await despacharLeituras({ ...prop, chamadas: [{ name: "detalhar_proposta", args: { numero: 1 } }] });
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("falha_na_consulta");
  });

  it("não mexe nas referências da lista (detalhe não renumera)", async () => {
    escopo.mockResolvedValue({ items: [{ id: "proposta-id-1", codigo: "X" }], truncated: false });
    const r = await despacharLeituras({ ...prop, chamadas: [{ name: "detalhar_proposta", args: { numero: 1 } }] });
    expect(r.referencias).toEqual(prop.referencias);
  });
});

describe("detalhar_* — seleção no turno", () => {
  const user = gerente;
  const nomes = (texto: string, policy: string[]) => ferramentasDoTurno({ identity: user, policy: policy as never, texto }).entradas.map((e) => e.nome);

  it("NEGADO: sem a capability não é oferecida", () => {
    expect(nomes("detalhes da proposta 2", ["proposal.list"])).not.toContain("detalhar_proposta");
    expect(nomes("detalhes do negócio 2", ["deal.list"])).not.toContain("detalhar_negocio");
  });

  it("NEGADO: pedido de criação não dispara o detalhe", () => {
    expect(nomes("crie uma proposta para o João", ["proposal.detail", "proposal.create"])).not.toContain("detalhar_proposta");
  });

  it("oferecida com a capability e o pedido de detalhe", () => {
    expect(nomes("me mostra os detalhes da proposta 2", ["proposal.detail", "proposal.list"])).toContain("detalhar_proposta");
    expect(nomes("detalhes do negócio 1", ["deal.detail", "deal.list"])).toContain("detalhar_negocio");
  });

  it("as duas tools são só leitura, sem confirmação e sem produzir referência", () => {
    for (const t of [DETALHAR_PROPOSTA, DETALHAR_NEGOCIO]) {
      expect(t.tipo).toBe("leitura");
      expect(t.confirmacao).toBe(false);
      expect(t.refs?.produz).toBeUndefined();
      expect(t.def.parameters.required).toEqual(["numero"]);
    }
  });
});

describe("notification.list — projeção do corpo", () => {
  it("formato antigo intacto quando título/corpo/link não vêm", () => {
    const antigo = { id: "n1", tipo: "charge_paid", lida: false, criadoEm: "2026-10-20T10:00:00Z" };
    expect(projetarNotificacao(antigo)).toEqual(antigo);
  });

  it("null em título/corpo = formato antigo (sem _untrusted)", () => {
    expect(projetarNotificacao({ id: "n1", tipo: "t", lida: true, criadoEm: "x", titulo: null, corpo: null })).toEqual({ id: "n1", tipo: "t", lida: true, criadoEm: "x" });
  });

  it("mostra título e corpo marcados como dado de terceiros", () => {
    const r = projetarNotificacao({ id: "n1", tipo: "t", lida: false, criadoEm: "x", titulo: "Cobrança paga", corpo: "João pagou" }) as Record<string, unknown>;
    expect(r).toMatchObject({ titulo: "Cobrança paga", corpo: "João pagou", _untrusted: true });
  });

  it("campo desconhecido do servidor não chega ao modelo (whitelist)", () => {
    const r = projetarNotificacao({ id: "n1", tipo: "t", lida: false, criadoEm: "x", userId: "u9", orgId: "o9", segredo: "s" }) as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(["criadoEm", "id", "lida", "tipo"]);
  });

  it("tira bidi e zero-width (\\p{Cf}) que esconderiam texto do modelo", () => {
    const r = projetarNotificacao({ id: "n", tipo: "t", lida: false, criadoEm: "x", titulo: "Pago\u202Eoculto\u200B\u2066x" }) as { titulo: string };
    expect(r.titulo).not.toMatch(/[\u200B\u202E\u2066]/);
  });
  it("corta em 280, tira quebras de linha e caracteres de controle", () => {
    const r = projetarNotificacao({ id: "n", tipo: "t", lida: false, criadoEm: "x", corpo: `a\n\n\u0000b\t${"z".repeat(500)}` }) as { corpo: string };
    expect(r.corpo.length).toBeLessThanOrEqual(LIMITE_TEXTO_NOTIFICACAO);
    expect(r.corpo).not.toMatch(/[\u0000-\u001f]/);
    expect(r.corpo.startsWith("a b z")).toBe(true);
  });

  it("título só com espaços vira ausente", () => {
    const r = projetarNotificacao({ id: "n", tipo: "t", lida: false, criadoEm: "x", titulo: "   \n ", corpo: 42 }) as Record<string, unknown>;
    expect(r.titulo).toBeUndefined();
    expect(r.corpo).toBeUndefined();
    expect(r._untrusted).toBeUndefined();
  });

  describe("link", () => {
    const comLink = (link: unknown) => (projetarNotificacao({ id: "n", tipo: "t", lida: false, criadoEm: "x", link }) as Record<string, unknown>).link;

    it.each([
      ["outro host", "https://evil.example/x"],
      ["http simples", "http://imobpro.ia.br/x"],
      ["javascript:", "javascript:alert(1)"],
      ["protocolo relativo", "//evil.example/x"],
      ["credenciais na URL", "https://user:pw@imobpro.ia.br/x"],
      ["com espaço", "https://imobpro.ia.br/a b"],
      ["não string", 42],
      ["gigante", `https://imobpro.ia.br/${"a".repeat(400)}`],
    ])("NEGADO: %s", (_t, link) => {
      expect(comLink(link)).toBeUndefined();
    });

    it("caminho relativo vira URL da base do ImobPro", () => {
      const l = comLink("/negocios/abc");
      expect(typeof l).toBe("string");
      expect(String(l)).toMatch(/^https:\/\/.+\/negocios\/abc$/);
    });
  });
});

describe("notification.list — pelo despachante", () => {
  it("projeta cada item antes de ir ao modelo", async () => {
    escopo.mockResolvedValue({
      items: [{ id: "n1", tipo: "charge_paid", lida: false, criadoEm: "x", titulo: "Pago", corpo: "ok", userId: "u9" }],
      truncated: false,
    });
    vi.stubEnv("MAX_EXTENDED_QUERIES", "true");
    const r = await despacharLeituras({
      ...base,
      oferecidas: ["listar_notificacoes"],
      policy: ["notification.list"] as never,
      referencias: null,
      chamadas: [{ name: "listar_notificacoes", args: {} }],
    });
    vi.unstubAllEnvs();
    const dump = JSON.stringify(r.resultados);
    expect(dump).toContain("Pago");
    expect(dump).not.toContain("u9");
    expect(dump).not.toContain('"id":"n1"');
  });
});
