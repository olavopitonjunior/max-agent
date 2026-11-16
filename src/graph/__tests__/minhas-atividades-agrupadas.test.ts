import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * "Minhas atividades" agrupada (PR-O3-MA, tarefa 6; decisão D4 do plano): sem mudança no CM, a visão é montada aqui com
 * 3 leituras `activity.list { filtro: "minhas", estado: atrasadas | hoje | 7d }`. `7d` INCLUI hoje no servidor
 * (`list-filters.ts::window`), então o bloco "semana" tira os ids que já estão em "atrasadas" e "hoje".
 *
 * Negado antes do permitido (regra 3): sem `activity.list` nada é chamado; com a flag desligada o comportamento é o de antes.
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
vi.mock("@/lib/acao", () => ({ executarAcao: vi.fn() }));

const { despacharLeituras } = await import("../despachante");
const { resolverReferencia } = await import("../referencias");
const { fenceToolResults } = await import("../prompt");
const { iniciarAtividade } = await import("../atividades");
const { consultarEscopo } = await import("@/lib/scope");
const escopo = vi.mocked(consultarEscopo);

const gerente = { orgId: "org1", orgName: "Imob", kind: "user" as const, userId: "u1", userName: "Marcia" };
const OFERECIDAS = ["listar_atividades", "ver_atividade", "reagendar_atividade"];
const AGORA = Date.parse("2026-11-15T15:00:00Z");

type Estado = "atrasadas" | "hoje" | "7d";
const atv = (id: string, titulo: string, vencimento = "2026-11-16T12:00:00.000Z") => ({ id, titulo, vencimento, temHorario: true, status: "aberta" });

function servidor(porEstado: Partial<Record<Estado, { items: unknown[]; truncated?: boolean; nextCursor?: string } | null>>) {
  escopo.mockImplementation((async (p: { args: Record<string, unknown> }) => {
    const r = porEstado[p.args.estado as Estado];
    return r ? { items: r.items, truncated: r.truncated ?? false, ...(r.nextCursor ? { nextCursor: r.nextCursor } : {}) } : null;
  }) as never);
}

function despachar(args: Record<string, unknown> = { filtro: "minhas" }, over: { policy?: string[]; nome?: string } = {}) {
  return despacharLeituras({
    chamadas: [{ name: over.nome ?? "listar_atividades", args }],
    oferecidas: OFERECIDAS,
    policy: (over.policy ?? ["activity.list", "activity.write"]) as never,
    identity: gerente,
    fromPhone: "5511999990000",
    referencias: null,
    turno: "m1",
    agora: AGORA,
  });
}

const chamadasAoServidor = () => escopo.mock.calls.map((c) => c[0] as { verb: string; args: Record<string, unknown> });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MAX_EXTENDED_QUERIES", "true");
});
afterEach(() => vi.unstubAllEnvs());

// ─── NEGADO primeiro ──────────────────────────────────────────────────────

describe("minhas atividades agrupada: negados", () => {
  it("sem activity.list na política nada é chamado e o resultado é FALHA (nunca 'nenhuma')", async () => {
    servidor({ atrasadas: { items: [] }, hoje: { items: [] }, "7d": { items: [] } });
    const r = await despachar({ filtro: "minhas" }, { policy: ["deal.list"] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados).toEqual([{ tool: "listar_atividades", items: null, truncated: false }]);
    expect(r.trilha[0]?.outcome).toBe("capability_negada");
  });

  it("MAX_EXTENDED_QUERIES desligado: o comportamento de antes (UMA chamada, sem estado, sem blocos)", async () => {
    vi.stubEnv("MAX_EXTENDED_QUERIES", "false");
    escopo.mockResolvedValue({ items: [atv("a1", "Ligar")], truncated: false } as never);
    const r = await despachar({ filtro: "minhas" });
    expect(chamadasAoServidor()).toHaveLength(1);
    expect(chamadasAoServidor()[0]).toMatchObject({ verb: "activity.list", args: { filtro: "minhas", limite: 5 } });
    expect(chamadasAoServidor()[0]?.args).not.toHaveProperty("estado");
    expect(r.resultados[0]?.blocos).toBeUndefined();
    expect(r.resultados[0]?.items).toHaveLength(1);
  });

  it("com a flag ligada mas pedindo OUTRO recorte, vale a consulta única de antes", async () => {
    escopo.mockResolvedValue({ items: [atv("a1", "Ligar")], truncated: false } as never);
    for (const args of [{ filtro: "atrasadas" }, { filtro: "hoje" }, { estado: "concluidas" }, { filtro: "minhas", estado: "abertas" }, {}]) {
      escopo.mockClear();
      const r = await despachar(args);
      expect(escopo, JSON.stringify(args)).toHaveBeenCalledTimes(1);
      expect(r.resultados[0]?.blocos, JSON.stringify(args)).toBeUndefined();
    }
  });

  it("'mais' não pagina a visão agrupada: sem continuação válida, falha e nenhuma chamada", async () => {
    servidor({ atrasadas: { items: [] }, hoje: { items: [] }, "7d": { items: [] } });
    const r = await despachar({ filtro: "minhas", mais: true });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0]?.items).toBeNull();
    expect(r.trilha[0]?.outcome).toBe("continuacao_invalida");
  });

  it("se UMA das três consultas falha, o resultado é FALHA explícita (sem 'nenhuma' inventada) e a numeração não muda", async () => {
    servidor({ atrasadas: { items: [atv("a1", "Ligar")] }, hoje: null, "7d": { items: [] } });
    const r = await despachar();
    expect(r.resultados[0]?.items).toBeNull();
    expect(r.resultados[0]?.blocos).toBeUndefined();
    expect(r.trilha[0]?.outcome).toBe("falha_na_consulta");
    expect(r.referencias).toBeNull();
  });
});

// ─── Permitidos ───────────────────────────────────────────────────────────

describe("minhas atividades agrupada: a visão", () => {
  it("faz 3 chamadas activity.list com filtro minhas e estado atrasadas, hoje e 7d (limite 5, sem cursor)", async () => {
    servidor({ atrasadas: { items: [] }, hoje: { items: [] }, "7d": { items: [] } });
    await despachar();
    const chamadas = chamadasAoServidor();
    expect(chamadas).toHaveLength(3);
    expect(chamadas.map((c) => c.verb)).toEqual(["activity.list", "activity.list", "activity.list"]);
    expect(chamadas.map((c) => c.args)).toEqual([
      { filtro: "minhas", estado: "atrasadas", limite: 5 },
      { filtro: "minhas", estado: "hoje", limite: 5 },
      { filtro: "minhas", estado: "7d", limite: 5 },
    ]);
  });

  it("a semana EXCLUI o que já está em hoje (7d inclui hoje) e em atrasadas", async () => {
    servidor({
      atrasadas: { items: [atv("a1", "Atrasada 1")] },
      hoje: { items: [atv("h1", "Hoje 1"), atv("h2", "Hoje 2")] },
      "7d": { items: [atv("h1", "Hoje 1"), atv("s1", "Semana 1"), atv("h2", "Hoje 2"), atv("a1", "Atrasada 1"), atv("s2", "Semana 2")] },
    });
    const r = await despachar();
    const blocos = r.resultados[0]?.blocos ?? [];
    expect(blocos.map((b) => [b.bloco, b.items.length])).toEqual([["atrasadas", 1], ["hoje", 2], ["semana", 2]]);
    const titulos = blocos.flatMap((b) => b.items.map((i) => (i as { titulo: string }).titulo));
    expect(titulos).toEqual(["Atrasada 1", "Hoje 1", "Hoje 2", "Semana 1", "Semana 2"]);
  });

  it("bloco vazio é declarado como 'nenhuma' no que o modelo recebe, e o vazio não é falha", async () => {
    servidor({ atrasadas: { items: [] }, hoje: { items: [atv("h1", "Hoje 1")] }, "7d": { items: [atv("h1", "Hoje 1")] } });
    const r = await despachar();
    const res = r.resultados[0]!;
    expect(res.items).not.toBeNull();
    const vazios = (res.blocos ?? []).filter((b) => b.items.length === 0).map((b) => b.bloco);
    expect(vazios).toEqual(["atrasadas", "semana"]);
    const texto = fenceToolResults([res]);
    expect(texto).toMatch(/Atrasadas[^\n]*nenhuma/i);
    expect(texto).toMatch(/Semana[^\n]*nenhuma/i);
    expect(texto).not.toMatch(/Hoje[^\n]*nenhuma/i);
  });

  it("a numeração é CONTÍNUA entre os blocos e o id nunca chega ao modelo", async () => {
    servidor({
      atrasadas: { items: [atv("a1", "A1"), atv("a2", "A2")] },
      hoje: { items: [atv("h1", "H1")] },
      "7d": { items: [atv("h1", "H1"), atv("s1", "S1")] },
    });
    const r = await despachar();
    const res = r.resultados[0]!;
    expect((res.items ?? []).map((i) => (i as { n: number }).n)).toEqual([1, 2, 3, 4]);
    expect(JSON.stringify(res)).not.toMatch(/"id"|a1|a2|h1|s1/);
    expect(r.referencias?.itens.map((i) => [i.n, i.id])).toEqual([[1, "a1"], [2, "a2"], [3, "h1"], [4, "s1"]]);
  });

  it("a numeração alimenta ver_atividade (activity.get com o id certo) e reagendar_atividade", async () => {
    servidor({
      atrasadas: { items: [atv("a1", "A1")] },
      hoje: { items: [atv("h1", "H1")] },
      "7d": { items: [atv("h1", "H1"), atv("s1", "Enviar contrato")] },
    });
    const lista = await despachar();
    // O 3 é o primeiro (e único) da semana.
    const alvo = resolverReferencia(lista.referencias, 3, { agora: AGORA, tipo: "atividade" });
    expect(alvo).toMatchObject({ ok: true, item: { id: "s1", rotulo: expect.stringContaining("Enviar contrato") } });

    // ver_atividade 3 → activity.get com o id interno, vindo do mapa.
    escopo.mockReset();
    escopo.mockResolvedValue({ items: [{ id: "s1", titulo: "Enviar contrato" }], truncated: false } as never);
    await despacharLeituras({
      chamadas: [{ name: "ver_atividade", args: { numero: 3 } }],
      oferecidas: OFERECIDAS, policy: ["activity.list"] as never, identity: gerente, fromPhone: "5511999990000",
      referencias: lista.referencias, turno: "m2", agora: AGORA,
    });
    expect(chamadasAoServidor()[0]).toMatchObject({ verb: "activity.get", args: { atividade_id: "s1" } });

    // reagendar_atividade 3 → o fluxo recebe o MESMO alvo.
    const passo = iniciarAtividade(
      { operacao: "reagendar", alvo: { id: alvo.ok ? alvo.item.id : "", rotulo: alvo.ok ? alvo.item.rotulo : "" }, ate: "2026-11-21", hora: "10:00" },
      { texto: "reagenda a 3 pra sábado às 10", messageId: "m3", policy: ["activity.list", "activity.write"] as never, politicaIndisponivel: false, agora: AGORA, orgName: "Imob", thread: "t" } as never
    );
    expect(passo.fluxo).toMatchObject({ operacao: "reagendar", alvo: { id: "s1" } });
  });

  it("bloco truncado sugere pedir o recorte; não há paginação nem continuação na visão agrupada", async () => {
    servidor({
      atrasadas: { items: [atv("a1", "A1"), atv("a2", "A2"), atv("a3", "A3"), atv("a4", "A4"), atv("a5", "A5")], truncated: true, nextCursor: "cur-atrasadas" },
      hoje: { items: [atv("h1", "H1")] },
      "7d": { items: [atv("h1", "H1")] },
    });
    const r = await despachar();
    const res = r.resultados[0]!;
    const atrasadas = res.blocos?.find((b) => b.bloco === "atrasadas");
    expect(atrasadas).toMatchObject({ truncado: true });
    expect(res.hasMore).toBeUndefined();
    expect(r.referencias?.continuacao).toBeUndefined();
    const texto = fenceToolResults([res]);
    expect(texto).toMatch(/Atrasadas[^\n]*h[áa] mais/i);
    expect(texto).toMatch(/s[óo] (as )?atrasadas|s[óo] (as )?de hoje|s[óo] (as )?da semana/i);
    expect(texto).toMatch(/n[ãa]o (h[áa]|existe|ofere[çc]a)[^\n]*ver mais|sem ver mais|n[ãa]o ofere[çc]a ver mais/i);
  });

  it("semana que ficou vazia SÓ por causa do dedupe, mas com corte do servidor, nunca vira 'nenhuma'", async () => {
    const cinco = [atv("h1", "H1"), atv("h2", "H2"), atv("h3", "H3"), atv("h4", "H4"), atv("h5", "H5")];
    servidor({ atrasadas: { items: [] }, hoje: { items: cinco }, "7d": { items: cinco, truncated: true, nextCursor: "c" } });
    const r = await despachar();
    const semana = r.resultados[0]!.blocos!.find((b) => b.bloco === "semana")!;
    expect(semana).toMatchObject({ items: [], truncado: true });
    const texto = fenceToolResults([r.resultados[0]!]);
    expect(texto).not.toMatch(/Semana[^\n]*nenhuma/i);
    expect(texto).toMatch(/Semana[^\n]*h[áa] mais/i);
  });

  it("a hora sai no horário local (atividadeEmHoraLocal), nunca em UTC cru", async () => {
    servidor({ atrasadas: { items: [] }, hoje: { items: [atv("h1", "Ligar", "2026-11-15T12:00:00.000Z")] }, "7d": { items: [] } });
    const r = await despachar();
    const item = r.resultados[0]!.blocos!.find((b) => b.bloco === "hoje")!.items[0] as { vencimento: string };
    expect(item.vencimento).toBe("15/11/2026 09:00");
  });

  it("trilha: outcome ok, com os args pedidos pelo modelo", async () => {
    servidor({ atrasadas: { items: [] }, hoje: { items: [] }, "7d": { items: [] } });
    const r = await despachar();
    expect(r.trilha).toEqual([{ name: "listar_atividades", args: { filtro: "minhas" }, outcome: "ok" }]);
  });
});
