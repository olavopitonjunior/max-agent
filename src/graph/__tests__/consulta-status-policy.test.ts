import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// External boundaries only: a status question must never reach a provider or DB.
vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "test" }));
vi.mock("@/lib/acao", () => ({ executarAcao: vi.fn() }));
vi.mock("@/lib/db", () => ({
  query: vi.fn(() => { throw new Error("DB prohibited"); }),
  checkpointerPool: vi.fn(() => { throw new Error("DB prohibited"); }),
}));

const { buildGraph } = await import("../graph");
const { fetchProfile, chaveDePolitica } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { executarAcao } = await import("@/lib/acao");

const perguntas = [
  "Qual é o status da proposta PROP-2026-0027? O comprador já assinou?",
  "Sem criar, editar ou enviar nada: apenas consulte a proposta PROP-2026-0027 e diga quem já assinou e o que ainda está pendente.",
];
const usuario = { orgId: "org-test", orgName: "Test", kind: "user" as const, userId: "u1", userName: "QA" };
const parcial = ["deal.list", "deal.pending", "credit.read", "credit.request", "proposal.create", "form.create", "proposal.send"];
const uso = { model: "test", promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  costUsd: null, generationId: null, latencyMs: 0, success: true };
const proposta = {
  id: "p27", codigo: "PROP-2026-0027", status: "assinada_proponente",
  signatarios: [{ nome: "Comprador QA", status: "assinou" }, { nome: "Vendedor QA", status: "pendente" }],
};

function perfil(policy: string[]) {
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, maxPolicy: { byRole: { admin: policy } } } as never);
}
function run(text: string, state: Record<string, unknown> = {}) {
  return buildGraph().compile().invoke({
    inbound: { messageId: "m1", fromPhone: "5511999999999", groupId: null, kind: "text", text,
      mediaUrl: null, mimeType: null, timestampMs: null, senderName: "QA", replyToMessageId: null },
    identity: usuario, reply: null, halt: null, ...state,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chaveDePolitica).mockResolvedValue("admin");
  perfil(parcial);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network prohibited"); }));
  // Reproduces the wrong staging classification if the deterministic route is missed.
  vi.mocked(complete).mockResolvedValue({ text: "", toolCalls: [{ name: "propor_criacao", args: { tipo: "proposta" } }], usage: uso });
  vi.mocked(executarAcao).mockImplementation(async () => { throw new Error("Unexpected action"); });
});
afterEach(() => vi.unstubAllGlobals());

describe.each(perguntas)("consulta de status: %s", (text) => {
  it.each(["parcial", "vazia", "indisponivel"])("política %s recusa a leitura antes do LLM e de qualquer ação", async (modo) => {
    if (modo === "vazia") perfil([]);
    if (modo === "indisponivel") vi.mocked(chaveDePolitica).mockResolvedValue(null);
    const s = await run(text);
    expect(s.reply).toMatch(modo === "indisponivel" ? /Não consegui validar sua permissão.*consultar/ : /não tem permissão para consultar/i);
    expect(s.toolLog).toContainEqual({ name: "fluxo", args: { kind: "consulta" }, outcome: modo === "indisponivel" ? "consulta_politica_indisponivel" : "consulta_sem_politica" });
    expect(complete).not.toHaveBeenCalled();
    expect(executarAcao).not.toHaveBeenCalled();
    expect(s.fluxo).toBeNull();
  });

  it("autorizada usa somente proposal.status com o sujeito e tenant do turno", async () => {
    perfil([...parcial, "proposal.list"]);
    vi.mocked(executarAcao).mockResolvedValue({ status: 200, body: { proposta } });
    const s = await run(text);
    expect(s.reply).toContain("Comprador QA (assinou)");
    expect(s.reply).toContain("Vendedor QA (pendente)");
    expect(executarAcao).toHaveBeenCalledTimes(1);
    expect(executarAcao).toHaveBeenCalledWith({ orgId: "org-test", rawPhone: "5511999999999", subject: { kind: "user", userId: "u1" }, verb: "proposal.status", args: { codigo: "PROP-2026-0027" }, idempotencyKey: undefined });
    expect(complete).not.toHaveBeenCalled();
  });
});

it.each([403, 404])("resposta %s do servidor não vira escrita nem classificação por LLM", async (status) => {
  perfil([...parcial, "proposal.list"]);
  vi.mocked(executarAcao).mockResolvedValue({ status, body: {} });
  const s = await run(perguntas[0]);
  expect(s.reply).toMatch(status === 404 ? /Não achei proposta sua/ : /Não consegui consultar/);
  expect(s.reply).not.toContain("Comprador QA");
  expect(vi.mocked(executarAcao).mock.calls.map(([p]) => p.verb)).toEqual(["proposal.status"]);
  expect(complete).not.toHaveBeenCalled();
});

it.each([false, true])("consulta com checkpoint de conversão anterior (autorizada=%s) preserva o alvo e rebaixa confirmação", async (autorizada) => {
  perfil(autorizada ? [...parcial, "proposal.list"] : parcial);
  vi.mocked(executarAcao).mockResolvedValue({ status: 200, body: { proposta } });
  const fluxo = { kind: "continuidade", etapa: "confirmacao", converter: true,
    alvo: { id: "p-old", codigo: "PROP-2026-0010", status: "completa" }, atualizadoEm: Date.now() };
  const s = await run(perguntas[0], { fluxo });
  expect(s.reply).toMatch(autorizada ? /Comprador QA \(assinou\)/ : /não tem permissão para consultar/i);
  expect(s.fluxo).toEqual({ ...fluxo, etapa: "resumo" });
  expect(s.reply).not.toMatch(/converter|continuar essa proposta/);
  expect(vi.mocked(executarAcao).mock.calls.map(([p]) => p.verb)).toEqual(autorizada ? ["proposal.status"] : []);
  expect(complete).not.toHaveBeenCalled();
});

it("pedido legítimo de criação ainda abre a escolha de proposta", async () => {
  const s = await run("Quero criar uma proposta nova");
  expect(s.fluxo).toMatchObject({ kind: "escolha" });
  expect(s.reply).toContain("proposta rápida");
  expect(complete).toHaveBeenCalledTimes(1);
  expect(executarAcao).not.toHaveBeenCalled();
});
