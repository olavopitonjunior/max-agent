import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Prod 18/11/2026 (Max Fincasa): perguntas comuns sobre a carteira caíam no menu "Qual etapa deseja consultar?":
 * "em que etapa está o negócio TESTE1?", "quantos negócios eu tenho em andamento?" (o "em …" virava pista de
 * etapa), "quais são os nomes dos meus negócios abertos?" / "quais estão parados?" (o modelo inventava
 * estado "aberto"/"parado"). E "Todas as etapas" digitado no menu não era entendido (o modelo prometia
 * "Vou listar…" sem listar). A regra de não adivinhar etapa continua: "minhas vendas" segue no menu.
 */

vi.mock("@/lib/cm", async orig => ({...await orig<typeof import("@/lib/cm")>(), fetchProfile: vi.fn(), searchKnowledge: vi.fn().mockResolvedValue([]), reportUsage: vi.fn(), chaveDePolitica: vi.fn().mockResolvedValue("corretor")}));
vi.mock("@/lib/scope", async orig => ({...await orig<typeof import("@/lib/scope")>(), consultarEscopo: vi.fn()}));
vi.mock("@/lib/llm", () => ({complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano"}));
vi.mock("../consulta", async orig => ({...await orig<typeof import("../consulta")>(), pedeConsulta: vi.fn().mockReturnValue(false)}));
const {buildGraph, RESET_DO_TURN} = await import("../graph");
const {queryChoice} = await import("../query-options");
const {fetchProfile} = await import("@/lib/cm");
const {consultarEscopo} = await import("@/lib/scope");
const {complete} = await import("@/lib/llm");
const profile = vi.mocked(fetchProfile), scope = vi.mocked(consultarEscopo), llm = vi.mocked(complete);
const identity = {kind: "user" as const, orgId: "qa-org", orgName: "QA", userId: "broker", userName: "Corretor"};
const usage = {model: "test", promptTokens: 5, completionTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, generationId: null, latencyMs: 1, success: true};
function turn(text: string) {
  return {...RESET_DO_TURN, identity, inbound: {fromPhone: "+5511999063228", text, messageId: crypto.randomUUID(), kind: "text", timestampMs: Date.now(), groupId: null, mediaUrl: null, mimeType: null, senderName: "QA", replyToMessageId: null}} as never;
}
const ETAPAS = {items: [], truncated: false, clarification: {field: "estado" as const, options: ["Formulário", "Em contrato", "Assinado"]}};
const LISTA = {items: [{id: "D1", titulo: "TESTE1", etapa: "Formulário"}], truncated: false};

beforeEach(() => {
  vi.clearAllMocks(); llm.mockReset(); scope.mockReset(); profile.mockReset();
  profile.mockResolvedValue({enabled: true, maxPolicy: {byRole: {corretor: ["deal.list"]}}} as never);
  llm.mockResolvedValue({text: "Resposta do modelo", toolCalls: [], usage});
});

describe("'em …' sem etapa real não vira menu", () => {
  it.each([
    ["em que etapa está o negócio TESTE1?", {busca: "TESTE1"}],
    ["quantos negócios eu tenho em andamento?", {}],
  ])("%s → consulta direto", async (text, args) => {
    llm.mockResolvedValueOnce({text: "", toolCalls: [{name: "listar_negocios", args}], usage});
    scope.mockResolvedValueOnce(ETAPAS).mockResolvedValueOnce(LISTA);
    const s = await buildGraph().compile().invoke(turn(text));
    expect(scope.mock.calls.map(c => c[0].args)).toEqual([{opcoes_etapas: true}, args]);
    expect(s.reply ?? "").not.toContain("Qual etapa");
    expect(s.queryOptions).toBeNull();
  });
});

describe("estado genérico inventado pelo modelo vira lista sem filtro", () => {
  it.each(["aberto", "abertos", "em andamento", "parados", "ativos", "todos"])("estado %s", async estado => {
    llm.mockResolvedValueOnce({text: "", toolCalls: [{name: "listar_negocios", args: {estado, limite: 10}}], usage});
    scope.mockResolvedValueOnce(ETAPAS).mockResolvedValueOnce(LISTA);
    const s = await buildGraph().compile().invoke(turn("quais são os nomes dos meus negócios abertos?"));
    expect(scope.mock.calls.map(c => c[0].args)).toEqual([{estado, limite: 10}, {limite: 10}]);
    expect(s.reply ?? "").not.toContain("Qual etapa");
    expect(s.queryOptions).toBeNull();
  });

  it("estado que é um recorte de verdade (venda) continua no menu", async () => {
    llm.mockResolvedValueOnce({text: "", toolCalls: [{name: "listar_negocios", args: {estado: "venda"}}], usage});
    scope.mockResolvedValue(ETAPAS);
    const s = await buildGraph().compile().invoke(turn("Minhas vendas"));
    expect(scope).toHaveBeenCalledTimes(1);
    expect(s.reply).toContain("Qual etapa");
  });
});

describe("'todas as etapas' digitado no menu", () => {
  const pend = {subjectKey: "s", createdAt: 0, options: ["Formulário", "Em contrato"], offset: 0};
  it.each(["Todas as etapas", "todas", "todos", "Todas."])("%s = 0", text => {
    expect(queryChoice(text, pend)).toEqual({kind: "select"});
  });
});
