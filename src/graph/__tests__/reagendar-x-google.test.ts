import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * PR-O3-MA, fix round 1 (I1): "reagenda a 2 sexta às 10" com `activity.write` E `google.calendar.write`
 * na política. Duas ferramentas de escrita podem receber o mesmo pedido: `reagendar_atividade`
 * (vencimento da atividade do Imobpro, verbo `activity.postpone`) e `google_propor` (evento da
 * agenda Google, `calendar.schedule`). A regra: `reagendar_atividade` só resolve `numero` contra a
 * última lista de atividades do CM (`listar_atividades`); se a última lista numerada é do Google,
 * responde texto fixo e não chama verbo nenhum. O caminho do Google não muda.
 */

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn(),
  reportUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));
vi.mock("@/lib/acao", async (orig) => ({ ...(await orig<typeof import("@/lib/acao")>()), executarAcao: vi.fn() }));
vi.mock("@/lib/scope", async (orig) => ({ ...(await orig<typeof import("@/lib/scope")>()), consultarEscopo: vi.fn() }));

const { buildGraph } = await import("../graph");
const { fetchProfile, searchKnowledge } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { executarAcao } = await import("@/lib/acao");
const { consultarEscopo } = await import("@/lib/scope");
const { referenciasDaListaGoogle, googleTools } = await import("../google-workspace");
const { REAGENDAR_ATIVIDADE, ferramentasDoTurno } = await import("../tools");
const { TEXTO_LISTA_DO_GOOGLE } = await import("../atividades");

const llm = complete as unknown as ReturnType<typeof vi.fn>;
const acao = executarAcao as unknown as ReturnType<typeof vi.fn>;
const leitura = consultarEscopo as unknown as ReturnType<typeof vi.fn>;

const AGORA = Date.parse("2026-11-15T15:00:00Z"); // 12:00 em São Paulo; sexta é 2026-11-20
const CAPS = ["deal.list", "activity.list", "activity.write", "google.calendar.read", "google.calendar.write"];
const usuario = { orgId: "org1", orgName: "Imob", kind: "user" as const, userId: "u1", userName: "Marcia" };
const subjectKey = JSON.stringify(["org1", { kind: "user", userId: "u1" }]);
const uso = { model: "openai/gpt-5.4-nano", promptTokens: 10, completionTokens: 5, latencyMs: 5, success: true };
const FRASE = "reagenda a 2 sexta às 10";
const ARGS_REAGENDAR = { numero: 2, ate: "2026-11-20", hora: "10:00" };

const listaGoogle = () => {
  const googleRefs = { subjectKey, createdAt: Date.now(), items: [{ id: "g-a", title: "Visita ao imóvel", version: 1 }, { id: "g-b", title: "Reunião com o João", version: 2 }] };
  return { googleRefs, referencias: referenciasDaListaGoogle(googleRefs, "m0") };
};
const listaDoCm = () => ({
  referencias: { criadoEm: Date.now(), turno: "m0", itens: [{ n: 1, tipo: "atividade", id: "atv_1", rotulo: "Visita ao imóvel" }, { n: 2, tipo: "atividade", id: "atv_2", rotulo: "Enviar contrato" }] },
});

function run(text: string, state: Record<string, unknown> = {}, messageId = "m1") {
  return buildGraph().compile().invoke({
    inbound: { messageId, fromPhone: "5511987654321", groupId: null, kind: "text" as const, text, mediaUrl: null,
      mimeType: null, timestampMs: null, senderName: "Marcia", replyToMessageId: null, buttonPayload: null },
    identity: usuario, reply: null, halt: null, propostaDescartada: false, ...state,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AGORA);
  vi.mocked(fetchProfile).mockResolvedValue({
    enabled: true, model: "x", instructions: null, googleMaxEnabled: true,
    maxPolicy: { byRole: { "*": CAPS }, byRecipient: {}, brokerDefault: ["deal.list"] },
  } as never);
  vi.mocked(searchKnowledge).mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("(a) a última lista numerada é do Google: reagendar_atividade não resolve", () => {
  it("o modelo escolhe reagendar_atividade: texto fixo, nenhum verbo, sem fluxo, lista do Google intacta", async () => {
    const { googleRefs, referencias } = listaGoogle();
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "reagendar_atividade", args: ARGS_REAGENDAR }], usage: uso });
    const s = await run(FRASE, { googleRefs, referencias });
    expect(acao).not.toHaveBeenCalled();
    expect(leitura).not.toHaveBeenCalled();
    expect(s.fluxo ?? null).toBeNull();
    expect(s.googlePending ?? null).toBeNull();
    expect(s.reply).toBe(TEXTO_LISTA_DO_GOOGLE);
    expect(s.reply).toMatch(/Google/);
    expect(s.reply).toMatch(/Nada foi alterado/);
    // O texto não vaza id nem título da lista do Google.
    expect(s.reply).not.toMatch(/g-b|g-a|Reuni/);
    // A lista do Google continua valendo para a próxima mensagem.
    expect(s.googleRefs).toEqual(googleRefs);
    expect(s.referencias?.itens.map((i: { id: string }) => i.id)).toEqual(["g-a", "g-b"]);
  });

  it("o modelo escolhe google_propor: o caminho do Google segue como estava (consulta a versão e propõe)", async () => {
    const { googleRefs, referencias } = listaGoogle();
    llm.mockResolvedValue({
      text: "",
      toolCalls: [{ name: "google_propor", args: { kind: "calendar.schedule", numero: 2, startAt: "2026-11-20T10:00:00-03:00", endAt: "2026-11-20T11:00:00-03:00" } }],
      usage: uso,
    });
    // A versão (2) já vem da lista do Google em estado: a proposta sai direto, sem reconsultar.
    const preview = {
      activityId: "g-b", expectedVersion: 2, startAt: "2026-11-20T10:00:00-03:00", endAt: "2026-11-20T11:00:00-03:00",
      timeZone: "America/Sao_Paulo", participants: [], createMeet: false,
    };
    acao.mockResolvedValueOnce({
      status: 200,
      body: { proposalId: "p1", digest: "a".repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString(), kind: "calendar.schedule", summary: { title: "Reunião com o João", dueAt: null }, preview },
    });
    const s = await run(FRASE, { googleRefs, referencias });
    const verbos = acao.mock.calls.map((c) => (c[0] as { verb: string }).verb);
    expect(verbos).toEqual(["google.propose"]);
    expect(acao.mock.calls[0][0]).toMatchObject({ args: { kind: "calendar.schedule", input: expect.objectContaining({ activityId: "g-b" }) } });
    expect(verbos).not.toContain("activity.postpone");
    expect(s.googlePending?.proposalId).toBe("p1");
    expect(s.fluxo ?? null).toBeNull();
  });

  it("a mesma chamada em lista do Google sem activity.write na política também não grava (negado antes)", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({
      enabled: true, model: "x", instructions: null, googleMaxEnabled: true,
      maxPolicy: { byRole: { "*": ["deal.list", "activity.list", "google.calendar.read", "google.calendar.write"] }, byRecipient: {}, brokerDefault: ["deal.list"] },
    } as never);
    const { googleRefs, referencias } = listaGoogle();
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "reagendar_atividade", args: ARGS_REAGENDAR }], usage: uso });
    const s = await run(FRASE, { googleRefs, referencias });
    expect(acao).not.toHaveBeenCalled();
    expect(s.fluxo ?? null).toBeNull();
  });
});

describe("(b) a última lista numerada é de atividades do CM: abre o cartão de reagendar", () => {
  it("o mesmo texto, com lista do CM: resumo + Confirma, sem verbo, id só do mapa", async () => {
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "reagendar_atividade", args: ARGS_REAGENDAR }], usage: uso });
    const s = await run(FRASE, listaDoCm());
    expect(acao).not.toHaveBeenCalled();
    expect(s.fluxo).toMatchObject({ kind: "atividade", operacao: "reagendar", alvo: { id: "atv_2" } });
    expect(s.reply).toContain('Vou reagendar a atividade "Enviar contrato" para 20/11 às 10:00. Confirma?');
    expect(s.reply).not.toContain("atv_2");
  });

  it("uma lista do CM que chega depois da lista do Google troca a origem: googleRefs vira nulo e o reagendar resolve", async () => {
    vi.stubEnv("MAX_EXTENDED_QUERIES", "true");
    vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ org1: ["queries"] }));
    const { googleRefs, referencias } = listaGoogle();
    llm.mockResolvedValueOnce({ text: "", toolCalls: [{ name: "listar_atividades", args: { filtro: "minhas", estado: "hoje" } }], usage: uso });
    leitura.mockResolvedValueOnce({ items: [{ id: "atv_1", titulo: "Visita ao imóvel" }, { id: "atv_2", titulo: "Enviar contrato" }], truncated: false });
    llm.mockResolvedValueOnce({ text: "1. Visita ao imóvel\n2. Enviar contrato", toolCalls: [], usage: uso });
    const lista = await run("minhas atividades de hoje", { googleRefs, referencias }, "m1");
    expect(lista.googleRefs ?? null).toBeNull();
    expect(lista.referencias?.itens.map((i: { id: string }) => i.id)).toEqual(["atv_1", "atv_2"]);

    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "reagendar_atividade", args: ARGS_REAGENDAR }], usage: uso });
    const s = await run(FRASE, { googleRefs: lista.googleRefs, referencias: lista.referencias }, "m2");
    expect(s.fluxo).toMatchObject({ kind: "atividade", operacao: "reagendar", alvo: { id: "atv_2" } });
    expect(acao).not.toHaveBeenCalled();
  });
});

describe("(c) antes de qualquer lista: pergunta qual, sem verbo", () => {
  it("sem lista nenhuma, o reagendar pede a lista/número e não abre fluxo", async () => {
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "reagendar_atividade", args: ARGS_REAGENDAR }], usage: uso });
    const s = await run(FRASE, {});
    expect(acao).not.toHaveBeenCalled();
    expect(s.fluxo ?? null).toBeNull();
    expect(s.reply).toMatch(/lista de atividades/);
    expect(s.reply).toMatch(/número/);
    expect(s.reply).not.toBe(TEXTO_LISTA_DO_GOOGLE);
  });
});

describe("as descrições não se sobrepõem", () => {
  const ctx = { enabled: true, identity: usuario, policy: CAPS, now: AGORA, messageId: "m1", subjectKey };
  const propor = () => googleTools(ctx).find((t) => t.name === "google_propor")!.description;

  it("reagendar_atividade é da atividade do Imobpro/CRM e manda o evento do Google para google_propor", () => {
    const d = REAGENDAR_ATIVIDADE.def.description;
    expect(d).toMatch(/atividade do Imobpro/i);
    expect(d).toMatch(/listar_atividades/);
    expect(d).toMatch(/Google/);
    expect(d).toMatch(/google_propor/);
  });

  it("google_propor é do evento da agenda Google e manda a atividade do Imobpro para reagendar_atividade", () => {
    const d = propor();
    expect(d).toMatch(/evento da agenda Google/i);
    expect(d).toMatch(/reagendar_atividade/);
  });

  it("as duas são oferecidas no mesmo turno com as duas capabilities (a escolha é do modelo, a recusa é do código)", () => {
    const { entradas } = ferramentasDoTurno({ policy: CAPS as never, texto: FRASE, identity: usuario, agora: AGORA });
    expect(entradas.map((e) => e.nome)).toContain("reagendar_atividade");
  });
});
