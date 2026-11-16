import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VETOR_CHARGE_STATUS_USER } from "./cobranca-vectors";

/**
 * PR-O4d-MA — `status_cobranca` (par do contractmaker PR-O4d-CM, `docs/max.md` §19.6).
 *
 * Negado antes do permitido (regra 3): cada trava tem o seu caso de recusa isolado, e a leitura só
 * existe para quem a política concede E é usuário da plataforma. O corretor comissionado nunca
 * recebe o verbo (o servidor responde `{"items":[]}` mesmo se a política o concedesse), então a tool
 * nem é oferecida a ele. É domínio de dinheiro: SÓ LEITURA. A tool não oferece emitir, cobrar,
 * reenviar nem gerar boleto/PIX, e o resumo nunca tem link, `**` nem id cru.
 *
 * O parse é ESTRITO (R54): campo desconhecido, forma errada, enum fora do mapa fechado ou `valor`
 * que não seja inteiro ≥ 0 em QUALQUER item derruba a resposta inteira (`falha_na_consulta`).
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

const { despacharLeituras, autorizarChamada } = await import("../despachante");
const { ferramentasDoTurno, REGISTRO_DE_TOOLS } = await import("../tools");
const { lerCobranca, formatarReais, renderCobrancas, CHAVES_DE_COBRANCA, ESTADOS_DE_COBRANCA, SEM_COBRANCAS } = await import("../cobranca");
const { VERBOS_DE_LEITURA } = await import("../scope-contract");
const { consultarEscopo } = await import("@/lib/scope");
const { CAPABILITIES_RESERVADAS, catalog, executableTool } = await import("@/lib/runtime/catalog");
const escopo = vi.mocked(consultarEscopo);

const gerente = { orgId: "org1", orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "Marcia" };
const corretor = { orgId: "org1", orgName: "RE/MAX Trio", kind: "broker" as const, splitRecipientId: "sr1", label: "Rui" };

const mapa = (tipo: "proposta" | "negocio") => ({
  criadoEm: 1_000,
  turno: "t0",
  itens: [
    { n: 1, tipo, id: `${tipo}-id-1`, rotulo: "Um" },
    { n: 2, tipo, id: `${tipo}-id-2`, rotulo: "Dois" },
  ],
});

const base = { fromPhone: "+5511999990000", identity: gerente, turno: "t1", agora: 2_000 };
const neg = { ...base, oferecidas: ["status_cobranca"], policy: ["charge.status"] as never, referencias: mapa("negocio") };

const vetor = JSON.parse(VETOR_CHARGE_STATUS_USER) as { items: Array<Record<string, unknown>>; truncated: boolean };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** O texto que o modelo recebe (o `resumo` único do resultado). */
function resumoDe(r: Awaited<ReturnType<typeof despacharLeituras>>): string {
  const item = r.resultados[0].items?.[0] as { resumo?: string } | undefined;
  return item?.resumo ?? "";
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

function ligar(): void {
  vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ org1: ["queries"] }));
  vi.stubEnv("MAX_EXTENDED_QUERIES", "true");
}

describe("status_cobranca — a oferta (negado primeiro)", () => {
  const TEXTO = "como está a cobrança do negócio 2?";
  const oferta = (identity: typeof gerente | typeof corretor, policy: string[], texto = TEXTO): string[] =>
    ferramentasDoTurno({ policy: policy as never, texto, identity }).entradas.map((e) => e.nome);

  it("NEGADO: sem a capability charge.status a tool não é oferecida", () => {
    ligar();
    expect(oferta(gerente, [])).not.toContain("status_cobranca");
    expect(oferta(gerente, ["deal.list", "deal.detail", "contract.status", "certidao.status", "document.list"])).not.toContain("status_cobranca");
  });

  it("NEGADO: o corretor comissionado não recebe a tool, mesmo com a capability na política", () => {
    ligar();
    expect(oferta(corretor, ["charge.status"])).not.toContain("status_cobranca");
  });

  it("NEGADO: sem MAX_EXTENDED_QUERIES (nasce desligada) não há oferta", () => {
    expect(oferta(gerente, ["charge.status"])).not.toContain("status_cobranca");
    vi.stubEnv("MAX_EXTENDED_QUERIES", "true");
    expect(oferta(gerente, ["charge.status"])).not.toContain("status_cobranca");
  });

  it("NEGADO: frase que não fala de cobrança não a oferece", () => {
    ligar();
    expect(oferta(gerente, ["charge.status"], "quais são meus negócios?")).not.toContain("status_cobranca");
  });

  it("permitido: usuário + capability + flag + frase de cobrança", () => {
    ligar();
    expect(oferta(gerente, ["charge.status"])).toContain("status_cobranca");
    expect(oferta(gerente, ["charge.status"], "já pagaram a comissão? tem boleto vencido no negócio 1?")).toContain("status_cobranca");
    expect(oferta(gerente, ["charge.status"], "qual o vencimento da fatura do negócio 2?")).toContain("status_cobranca");
  });

  it("pedido de ação ('manda o boleto', 'cobra ele') também cai na tool de CONSULTA: não existe outra, e a resposta leva para a tela", () => {
    ligar();
    const nomes = oferta(gerente, ["charge.status"], "manda o boleto do negócio 1 pra ele / cobra ele de novo");
    // Só a consulta; nunca uma tool de emitir, cobrar, reenviar ou gerar.
    expect(nomes).toEqual(["status_cobranca"]);
  });

  it("a tool vem do verbo charge.status, no fim da lista de verbos de leitura, sem produzir lista", () => {
    expect(VERBOS_DE_LEITURA[VERBOS_DE_LEITURA.length - 1]).toBe("charge.status");
    const e = REGISTRO_DE_TOOLS.find((x) => x.nome === "status_cobranca");
    expect(e).toMatchObject({ tipo: "leitura", capability: "charge.status", verb: "charge.status", risco: "nenhum", confirmacao: false, soUsuario: true });
    // Não numera nada: o "n" da lista de negócios continua valendo no turno seguinte.
    expect((e as { refs?: unknown }).refs).toBeUndefined();
  });

  it("o modelo nunca vê id, cursor nem filtro: o parâmetro é só `numero`", () => {
    const e = REGISTRO_DE_TOOLS.find((x) => x.nome === "status_cobranca");
    const props = Object.keys((e!.def.parameters as { properties: Record<string, unknown> }).properties);
    expect(props).toEqual(["numero"]);
    expect((e!.def.parameters as { required: string[] }).required).toEqual(["numero"]);
    expect((e!.def.parameters as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });

  it("a descrição diz que é só leitura e NÃO contém verbo de emitir, cobrar, reenviar, gerar, enviar ou baixar", () => {
    const e = REGISTRO_DE_TOOLS.find((x) => x.nome === "status_cobranca");
    const d = e!.def.description;
    expect(d).toMatch(/somente leitura|s[oó] leitura/i);
    expect(d).toMatch(/tela/i);
    expect(d).not.toMatch(/\b(emit\w*|cobr(ar|a|e|am|ando)|reenvi\w*|ger(ar|a|e|am)|envi(ar|a|e|am)|mand(ar|a|e|am)|baix(ar|a|e|am)|dispar\w*|criar|cria)\b/i);
    expect(d).not.toMatch(/https?:|\*\*/);
  });
});

describe("status_cobranca — o catálogo", () => {
  it("charge.status saiu de CAPABILITIES_RESERVADAS: não resta nenhuma reservada", () => {
    expect([...CAPABILITIES_RESERVADAS]).toEqual([]);
  });

  it("charge.status é leitura, atrás de MAX_EXTENDED_QUERIES (nasce desligada), com a capability de mesmo nome", () => {
    const t = catalog("org1").tools.find((x) => x.id === "charge.status");
    expect(t).toMatchObject({
      executor: "scope-query",
      effect: "read",
      flag: "MAX_EXTENDED_QUERIES",
      permission: "charge.status",
      policyCapability: "charge.status",
      confirmation: false,
    });
    vi.stubEnv("MAX_EXTENDED_QUERIES", "false");
    expect(executableTool("charge.status", "scope-query", "org1")).toBeUndefined();
  });
});

describe("status_cobranca — o despachante (negado primeiro)", () => {
  it("NEGADO: sem a capability a chamada não chega ao servidor", async () => {
    const r = await despacharLeituras({ ...neg, policy: ["deal.detail"] as never, chamadas: [{ name: "status_cobranca", args: { numero: 1 } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("capability_negada");
  });

  it("NEGADO: tool não oferecida no turno", async () => {
    const r = await despacharLeituras({ ...neg, oferecidas: [], chamadas: [{ name: "status_cobranca", args: { numero: 1 } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.trilha[0].outcome).toBe("nao_oferecida");
  });

  it("NEGADO: corretor comissionado, mesmo oferecida e com a capability, nem chega ao servidor", async () => {
    const r = await despacharLeituras({ ...neg, identity: corretor, chamadas: [{ name: "status_cobranca", args: { numero: 1 } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("identidade_nao_le");
  });

  it("autorizarChamada: usuário passa, corretor é recusado antes da capability", () => {
    const chamada = { name: "status_cobranca", args: { numero: 1 } };
    expect(autorizarChamada({ chamada, oferecidas: ["status_cobranca"], policy: ["charge.status"] as never, identity: gerente })).toMatchObject({ ok: true });
    expect(autorizarChamada({ chamada, oferecidas: ["status_cobranca"], policy: ["charge.status"] as never, identity: corretor })).toMatchObject({ ok: false, motivo: "identidade_nao_le" });
  });

  it.each([
    ["sem número", {}],
    ["número em texto não numérico", { numero: "o mais recente" }],
    ["número decimal", { numero: 1.5 }],
    ["número fora da lista", { numero: 9 }],
    ["id interno no lugar do número", { numero: "negocio-id-1" }],
    ["id cru passado direto (negocio_id)", { negocio_id: "negocio-id-1" }],
    ["id cru passado direto (proposta_id)", { proposta_id: "proposta-id-1" }],
    ["id cru da cobrança", { cobranca_id: "ch-1" }],
  ])("NEGADO: %s -> referencia_invalida, sem consulta", async (_t, args) => {
    const r = await despacharLeituras({ ...neg, chamadas: [{ name: "status_cobranca", args }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("referencia_invalida");
  });

  it("NEGADO: número de PROPOSTA (lista de propostas na mão) não vira consulta: cobrança é só de negócio", async () => {
    const r = await despacharLeituras({ ...neg, referencias: mapa("proposta"), chamadas: [{ name: "status_cobranca", args: { numero: 1 } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.trilha[0].outcome).toBe("referencia_invalida");
  });

  it("NEGADO: `de:'proposta'` não existe nesta tool (e com lista de negócios resolve só o negócio)", async () => {
    escopo.mockResolvedValue({ items: [], truncated: false });
    await despacharLeituras({ ...neg, chamadas: [{ name: "status_cobranca", args: { numero: 1, de: "proposta" } }] });
    expect(escopo.mock.calls[0][0].args).toEqual({ negocio_id: "negocio-id-1" });
  });

  it("o servidor recebe EXATAMENTE negocio_id, e nada que o modelo inventou", async () => {
    escopo.mockResolvedValue({ items: [], truncated: false });
    await despacharLeituras({
      ...neg,
      chamadas: [{ name: "status_cobranca", args: { numero: 2, mais: true, estado: "paga", cursor: "c", limite: 999, proposta_id: "p9", provedor: "asaas" } }],
    });
    expect(escopo).toHaveBeenCalledTimes(1);
    expect(escopo.mock.calls[0][0]).toMatchObject({ verb: "charge.status" });
    expect(escopo.mock.calls[0][0].args).toEqual({ negocio_id: "negocio-id-2" });
  });
});

describe("status_cobranca — parse estrito (R54): forma errada vira falha_na_consulta", () => {
  const falha = async (items: unknown[], truncated = false): Promise<Awaited<ReturnType<typeof despacharLeituras>>> => {
    escopo.mockResolvedValue({ items, truncated });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    return despacharLeituras({ ...neg, chamadas: [{ name: "status_cobranca", args: { numero: 1 } }] });
  };
  const comItem = (mexe: (it: Record<string, unknown>) => void, i = 0): unknown[] => {
    const v = clone(vetor);
    mexe(v.items[i]);
    return v.items;
  };

  it.each([
    ["campo extra no item (invoiceUrl)", (it: Record<string, unknown>) => { it.invoiceUrl = "https://pay.example/i/1"; }],
    ["campo extra no item (bankSlipUrl)", (it: Record<string, unknown>) => { it.bankSlipUrl = "https://pay.example/b/1"; }],
    ["campo extra no item (pagador)", (it: Record<string, unknown>) => { it.pagador = "Fulano"; }],
    ["campo extra no item (valorLiquido)", (it: Record<string, unknown>) => { it.valorLiquido = 100; }],
    ["campo faltando (valor)", (it: Record<string, unknown>) => { delete it.valor; }],
    ["campo faltando (pagoEm)", (it: Record<string, unknown>) => { delete it.pagoEm; }],
    ["campo faltando (provedor)", (it: Record<string, unknown>) => { delete it.provedor; }],
    ["campo faltando (negocioId)", (it: Record<string, unknown>) => { delete it.negocioId; }],
    ["id vazio", (it: Record<string, unknown>) => { it.id = "  "; }],
    ["id numérico", (it: Record<string, unknown>) => { it.id = 7; }],
    ["negocioId nulo", (it: Record<string, unknown>) => { it.negocioId = null; }],
    ["valor decimal (12000.5)", (it: Record<string, unknown>) => { it.valor = 12000.5; }],
    ["valor float de reais (120.5)", (it: Record<string, unknown>) => { it.valor = 120.5; }],
    ["valor negativo", (it: Record<string, unknown>) => { it.valor = -100; }],
    ["valor em texto", (it: Record<string, unknown>) => { it.valor = "1200050"; }],
    ["valor NaN", (it: Record<string, unknown>) => { it.valor = Number.NaN; }],
    ["valor Infinity", (it: Record<string, unknown>) => { it.valor = Number.POSITIVE_INFINITY; }],
    ["valor acima do inteiro seguro", (it: Record<string, unknown>) => { it.valor = 2 ** 60; }],
    ["valor booleano", (it: Record<string, unknown>) => { it.valor = true; }],
    ["estado fora do enum (valor cru do provedor)", (it: Record<string, unknown>) => { it.estado = "PENDING"; }],
    ["estado fora do enum (rascunho)", (it: Record<string, unknown>) => { it.estado = "rascunho"; }],
    ["estado vazio", (it: Record<string, unknown>) => { it.estado = ""; }],
    ["estado nulo", (it: Record<string, unknown>) => { it.estado = null; }],
    ["estado com a chave do protótipo", (it: Record<string, unknown>) => { it.estado = "constructor"; }],
    ["tipo fora do enum", (it: Record<string, unknown>) => { it.tipo = "commission"; }],
    ["provedor fora do enum", (it: Record<string, unknown>) => { it.provedor = "superlogica"; }],
    ["vencimento que não é data", (it: Record<string, unknown>) => { it.vencimento = "ontem"; }],
    ["vencimento só dia (sem instante)", (it: Record<string, unknown>) => { it.vencimento = "2026-11-25"; }],
    ["vencimento nulo", (it: Record<string, unknown>) => { it.vencimento = null; }],
    ["vencimento impossível (mês 13)", (it: Record<string, unknown>) => { it.vencimento = "2026-13-45T00:00:00.000Z"; }],
    ["vencimento numérico (epoch)", (it: Record<string, unknown>) => { it.vencimento = 1_795_000_000_000; }],
    ["pagoEm que não é data", (it: Record<string, unknown>) => { it.pagoEm = "hoje"; }],
    ["pagoEm vazio (string)", (it: Record<string, unknown>) => { it.pagoEm = ""; }],
    ["canceladoEm que não é data", (it: Record<string, unknown>) => { it.canceladoEm = "ontem"; }],
    ["estornadoEm numérico", (it: Record<string, unknown>) => { it.estornadoEm = 0; }],
  ])("NEGADO: %s", async (_t, mexe) => {
    const r = await falha(comItem(mexe));
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("falha_na_consulta");
    expect(JSON.stringify(r.resultados)).not.toContain("1.200,50");
  });

  it.each([
    ["item que não é objeto", ["ch-1"]],
    ["item nulo", [null]],
    ["item array", [[]]],
    ["item número", [5]],
  ])("NEGADO: %s", async (_t, items) => {
    const r = await falha(items);
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("falha_na_consulta");
  });

  it("NEGADO: UM item inválido entre bons derruba a resposta inteira (nada parcial)", async () => {
    const v = clone(vetor);
    (v.items[1] as Record<string, unknown>).invoiceUrl = "https://x/y";
    const r = await falha(v.items);
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("falha_na_consulta");
  });

  it("falha_na_consulta não loga o conteúdo do item (dado de terceiros)", async () => {
    const espiao = vi.spyOn(console, "error").mockImplementation(() => undefined);
    escopo.mockResolvedValue({ items: comItem((it) => { it.invoiceUrl = "https://segredo.example/x"; }), truncated: false });
    await despacharLeituras({ ...neg, chamadas: [{ name: "status_cobranca", args: { numero: 1 } }] });
    expect(espiao).toHaveBeenCalled();
    expect(JSON.stringify(espiao.mock.calls)).not.toContain("segredo.example");
    expect(JSON.stringify(espiao.mock.calls)).not.toContain("ch-2");
  });

  it("o parser devolve nulo para forma errada e um objeto novo (campo a campo) para a certa", () => {
    expect(lerCobranca({ ...vetor.items[0], extra: 1 })).toBeNull();
    const ok = lerCobranca(vetor.items[0]);
    expect(ok).toEqual(vetor.items[0]);
    expect(ok).not.toBe(vetor.items[0]);
  });

  it("valor nulo é aceito (o servidor manda null se o número gravado não for finito); zero também", () => {
    expect(lerCobranca({ ...vetor.items[0], valor: null })).not.toBeNull();
    expect(lerCobranca({ ...vetor.items[0], valor: 0 })).not.toBeNull();
  });

  it("todo valor do enum fechado de estado é aceito (incluindo 'outro')", () => {
    for (const estado of ESTADOS_DE_COBRANCA) expect(lerCobranca({ ...vetor.items[0], estado }), estado).not.toBeNull();
    expect(ESTADOS_DE_COBRANCA).toHaveLength(12);
  });

  it("a ordem das chaves é a do CM e o vetor inteiro passa pelo parse estrito (os 2 itens)", () => {
    for (const it of vetor.items) {
      expect(Object.keys(it)).toEqual([...CHAVES_DE_COBRANCA]);
      expect(lerCobranca(it)).not.toBeNull();
    }
    expect(vetor.items).toHaveLength(2);
    expect(Object.keys(vetor)).toEqual(["items", "truncated"]);
  });
});

describe("status_cobranca — o texto (WhatsApp)", () => {
  const rodar = async (items: unknown[] = vetor.items, truncated = false): Promise<Awaited<ReturnType<typeof despacharLeituras>>> => {
    escopo.mockResolvedValue({ items, truncated });
    return despacharLeituras({ ...neg, chamadas: [{ name: "status_cobranca", args: { numero: 1 } }] });
  };

  it("vetor do CM -> uma linha por cobrança: tipo, estado, valor em R$, vencimento, paga em e provedor", async () => {
    const r = await rodar();
    expect(r.trilha[0].outcome).toBe("ok");
    const t = resumoDe(r);
    expect(t.startsWith("Cobranças do negócio:")).toBe(true);
    expect(t.split("\n").filter((l) => l.startsWith("- "))).toEqual([
      "- Comissão — paga — R$ 12.000,50 — vence em 25/11/2026 — paga em 24/11/2026 — Asaas",
      "- Cobrança avulsa — pendente — R$ 350,00 — vence em 18/11/2026 — Rinne",
    ]);
  });

  it("o vencimento é DIA, lido em UTC: 00:00Z não vira o dia anterior (Brasília seria 21h do dia 24)", async () => {
    expect(resumoDe(await rodar([vetor.items[0]]))).toContain("vence em 25/11/2026");
    const v = clone(vetor.items[1]);
    v.vencimento = "2026-11-18T12:00:00.000Z";
    expect(resumoDe(await rodar([v]))).toContain("vence em 18/11/2026");
  });

  it("o pagamento é instante: no fuso de Brasília, 02h UTC ainda é o dia anterior", async () => {
    const v = clone(vetor.items[0]);
    v.pagoEm = "2026-11-24T02:00:00.000Z";
    expect(resumoDe(await rodar([v]))).toContain("paga em 23/11/2026");
  });

  it("'paga em' só aparece quando há pagoEm", async () => {
    const t = resumoDe(await rodar());
    const [paga, pendente] = t.split("\n").filter((l) => l.startsWith("- "));
    expect(paga).toContain("paga em 24/11/2026");
    expect(pendente).not.toContain("paga em");
  });

  it.each([
    [123456, "R$ 1.234,56"],
    [1200050, "R$ 12.000,50"],
    [35000, "R$ 350,00"],
    [0, "R$ 0,00"],
    [5, "R$ 0,05"],
    [99, "R$ 0,99"],
    [100, "R$ 1,00"],
    [100000, "R$ 1.000,00"],
    [99999999, "R$ 999.999,99"],
    [100000000, "R$ 1.000.000,00"],
    [123456789012, "R$ 1.234.567.890,12"],
  ])("formatarReais(%i) = %s (inteiros, sem float impreciso)", (centavos, esperado) => {
    expect(formatarReais(centavos)).toBe(esperado);
  });

  it("o valor do item sai formatado em R$ (123456 -> 'R$ 1.234,56'); nulo vira 'valor não informado'", async () => {
    const a = clone(vetor.items[0]);
    a.valor = 123456;
    expect(resumoDe(await rodar([a]))).toContain("R$ 1.234,56");
    const n = clone(vetor.items[0]);
    n.valor = null;
    const t = resumoDe(await rodar([n]));
    expect(t).toContain("valor não informado");
    expect(t).not.toMatch(/R\$ (null|NaN)/);
  });

  it.each([
    ["aguardando", "pendente"],
    ["em_analise", "em análise"],
    ["confirmada", "confirmada"],
    ["paga", "paga"],
    ["paga_em_dinheiro", "paga em dinheiro"],
    ["vencida", "vencida"],
    ["estorno_em_andamento", "estorno em andamento"],
    ["estornada", "estornada"],
    ["cancelada", "cancelada"],
    ["contestada", "contestada"],
    ["em_negativacao", "em negativação"],
    ["outro", "situação não identificada"],
  ])("estado %s sai como '%s' (nunca o código)", async (estado, legivel) => {
    const v = clone(vetor.items[1]);
    v.estado = estado;
    const t = resumoDe(await rodar([v]));
    expect(t).toContain(` — ${legivel} — `);
    if (estado.includes("_")) expect(t).not.toContain(estado);
  });

  it.each([
    ["comissao", "Comissão"],
    ["avulsa", "Cobrança avulsa"],
    ["aluguel", "Aluguel"],
    ["outros", "Outros"],
    ["outro", "Cobrança"],
  ])("tipo %s sai como '%s'", async (tipo, legivel) => {
    const v = clone(vetor.items[1]);
    v.tipo = tipo;
    expect(resumoDe(await rodar([v]))).toContain(`- ${legivel} — `);
  });

  it("não filtra por provedor: asaas, rinne e 'outro' aparecem juntos, com nome legível", async () => {
    const a = clone(vetor.items[0]);
    const b = clone(vetor.items[1]);
    const c = clone(vetor.items[1]);
    c.provedor = "outro";
    const t = resumoDe(await rodar([a, b, c]));
    expect(t).toContain("— Asaas");
    expect(t).toContain("— Rinne");
    expect(t).toContain("— outro provedor");
    expect(t.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
  });

  it("o resumo nunca tem http, **, id cru, boleto/pix nem código interno", async () => {
    const t = resumoDe(await rodar());
    expect(t).not.toMatch(/https?:/i);
    expect(t).not.toContain("**");
    expect(t).not.toMatch(/[*_~`]/);
    for (const proibido of ["ch-1", "ch-2", "deal-1", "negocio-id", "\"id\"", "negocioId", "pagoEm", "canceladoEm", "estornadoEm", "boleto", "pix", "invoice", "link"]) {
      expect(t.toLowerCase(), proibido).not.toContain(proibido.toLowerCase());
    }
  });

  it("o rodapé leva qualquer ação para a tela do negócio, sem oferecer nada", async () => {
    const t = resumoDe(await rodar());
    expect(t.split("\n").pop()).toBe("Isso é só a consulta: qualquer ação sobre a cobrança é feita no sistema, na tela do negócio.");
  });

  it("truncated: acrescenta 'Mostrando as N mais recentes.'", async () => {
    const t = resumoDe(await rodar(vetor.items, true));
    expect(t).toContain("Mostrando as 2 mais recentes.");
    expect(resumoDe(await rodar(vetor.items, false))).not.toContain("Mostrando");
  });

  it("aceita as duas formas do corpo: {items:[...]} (sem truncated) e {items:[...],truncated:bool}", async () => {
    // O executor (`consultarEscopo`) normaliza a ausência de `truncated` para false.
    expect(renderCobrancas(vetor.items.map((i) => lerCobranca(i)!), false)).not.toContain("Mostrando");
    expect(renderCobrancas(vetor.items.map((i) => lerCobranca(i)!), true)).toContain("Mostrando as 2 mais recentes.");
  });

  it("lista vazia (negado = vazio = inexistente) vira a frase única, sem distinguir o motivo", async () => {
    for (const truncated of [false, true]) {
      const r = await rodar([], truncated);
      expect(r.trilha[0].outcome).toBe("ok");
      expect(resumoDe(r)).toBe("Não encontrei cobrança visível para você nesse negócio.");
    }
    expect(SEM_COBRANCAS).toBe("Não encontrei cobrança visível para você nesse negócio.");
  });

  it("o resultado é UM resumo marcado como dado de terceiros (_untrusted), sem os itens do servidor", async () => {
    const r = await rodar();
    expect(r.resultados[0].items).toHaveLength(1);
    expect(r.resultados[0].items?.[0]).toEqual({ resumo: expect.any(String), _untrusted: true });
    expect(JSON.stringify(r.resultados)).not.toContain("1200050");
  });
});
