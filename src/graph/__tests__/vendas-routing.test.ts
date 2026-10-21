import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  chaveDePolitica: vi.fn(), fetchProfile: vi.fn(),
  searchKnowledge: vi.fn().mockResolvedValue([]), reportUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/scope")>()), consultarEscopo: vi.fn(),
}));
vi.mock("@/lib/acao", () => ({ executarAcao: vi.fn() }));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "test" }));
vi.mock("@/lib/db", () => ({
  query: vi.fn(() => { throw new Error("DB prohibited"); }),
  checkpointerPool: vi.fn(() => { throw new Error("DB prohibited"); }),
}));

const { buildGraph } = await import("../graph");
const { chaveDePolitica, fetchProfile } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { consultarEscopo } = await import("@/lib/scope");
const { executarAcao } = await import("@/lib/acao");
const uso = { model: "test", promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  costUsd: null, generationId: null, latencyMs: 0, success: true };
const casos = [
  { role: "custom:manager", userId: "manager-A", texto: "Me dá um resumo das vendas do meu time." },
  { role: "admin", userId: "admin-A", texto: "Me dá um resumo das vendas da imobiliária." },
];
function run(texto: string, userId: string) {
  return buildGraph().compile().invoke({
    inbound: { messageId: "m1", fromPhone: "5511999999999", groupId: null, kind: "text", text: texto,
      mediaUrl: null, mimeType: null, timestampMs: null, senderName: "QA", replyToMessageId: null },
    identity: { orgId: "org-A", orgName: "Test", kind: "user", userId, userName: "QA" }, reply: null, halt: null,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network prohibited"); }));
  vi.mocked(consultarEscopo).mockResolvedValue({ items: [{ id: "deal-1", titulo: "Venda autorizada", etapa: "Documentação" }], truncated: false });
  vi.mocked(complete).mockImplementation(async ({ tools }) => ({
    text: tools?.some((t) => t.name === "listar_negocios") ? "" : "Venda autorizada — Documentação.",
    toolCalls: tools?.some((t) => t.name === "listar_negocios") ? [{ name: "listar_negocios", args: {} }] : [], usage: uso,
  }));
});
afterEach(() => vi.unstubAllGlobals());

it.each(casos)("$role consulta vendas como o sujeito original, sem ampliar escopo no cliente", async ({ role, userId, texto }) => {
  vi.mocked(chaveDePolitica).mockResolvedValue(role);
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, maxPolicy: { byRole: { [role]: ["deal.list", "form.create", "proposal.create"] } } } as never);
  const s = await run(texto, userId);
  expect(s.toolsOferecidas).toEqual(["listar_negocios"]);
  expect(s.reply).toContain("Documentação");
  expect(consultarEscopo).toHaveBeenCalledTimes(1);
  expect(consultarEscopo).toHaveBeenCalledWith({
    orgId: "org-A", rawPhone: "5511999999999", subject: { kind: "user", userId }, verb: "deal.list", args: {},
  });
  expect(executarAcao).not.toHaveBeenCalled();
  expect(s.pendingAction).toBeNull();
  expect(s.fluxo).toBeNull();
});

it.each(casos)("$role sem deal.list não consulta nem escreve, mesmo se o modelo pedir", async ({ role, userId, texto }) => {
  vi.mocked(chaveDePolitica).mockResolvedValue(role);
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, maxPolicy: { byRole: { [role]: ["form.create", "proposal.create"] } } } as never);
  vi.mocked(complete).mockResolvedValue({ text: "", toolCalls: [{ name: "listar_negocios", args: {} }], usage: uso });
  const s = await run(texto, userId);
  expect(s.toolsOferecidas).toEqual([]);
  expect(consultarEscopo).not.toHaveBeenCalled();
  expect(executarAcao).not.toHaveBeenCalled();
  expect(s.pendingAction).toBeNull();
  expect(s.fluxo).toBeNull();
});
