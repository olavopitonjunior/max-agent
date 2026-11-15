import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@/lib/identity";
import { withExecution } from "@/lib/runtime/context";

/**
 * PR-C1 no GRAFO: o turno do corretor passa pelo condutor v2 de verdade.
 * Negado primeiro (sem a feature o condutor nem roda), depois o turno silencioso:
 * sem resposta de texto, com 👍, a ficha agendada no outbox e nada de PII no checkpoint.
 */

process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

vi.mock("@langchain/langgraph-checkpoint-postgres", async () => {
  const { MemorySaver } = await import("@langchain/langgraph");
  return { PostgresSaver: class extends MemorySaver { async setup() {} } };
});
vi.mock("@/lib/db", async (orig) => ({
  ...(await orig<typeof import("@/lib/db")>()),
  checkpointerPool: vi.fn(),
}));
vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  fetchProfile: vi.fn().mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: { byRole: { "*": ["proposal.list"] }, byRecipient: {}, brokerDefault: [] } }),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  transcribeMedia: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/acao", async (orig) => ({
  ...(await orig<typeof import("@/lib/acao")>()),
  executarAcao: vi.fn(),
}));
vi.mock("@/lib/transport", async (orig) => ({
  ...(await orig<typeof import("@/lib/transport")>()),
  downloadMedia: vi.fn().mockResolvedValue(null),
  sendReaction: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/outbox", async (orig) => ({
  ...(await orig<typeof import("@/lib/outbox")>()),
  enqueue: vi.fn().mockResolvedValue({ status: "queued", id: "o1", deliverAfter: new Date() }),
  cancelarPendentesPorPrefixo: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/llm", () => ({
  DEFAULT_MODEL: "openai/gpt-5.4-nano",
  complete: vi.fn(),
}));
vi.mock("@/lib/memory", async (orig) => ({
  ...(await orig<typeof import("@/lib/memory")>()),
  loadFacts: vi.fn().mockResolvedValue([]),
  saveFacts: vi.fn().mockResolvedValue(0),
  extractFacts: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  resolveIdentity: vi.fn(),
  saveChoice: vi.fn().mockResolvedValue(undefined),
  markGreeted: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/aceite", () => ({ interceptar: vi.fn().mockResolvedValue(null), repassarDesconhecido: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/turnlog", async (orig) => ({
  ...(await orig<typeof import("@/lib/turnlog")>()),
  registrarTurn: vi.fn().mockResolvedValue(undefined),
}));

const { runTurn, getApp } = await import("../../graph");
const { novoFluxoV2 } = await import("../estado");
const { TOOL_PATCH_V2 } = await import("../extracao");
const { resolveIdentity } = await import("@/lib/identity");
const { executarAcao } = await import("@/lib/acao");
const { sendReaction } = await import("@/lib/transport");
const { enqueue } = await import("@/lib/outbox");
const { complete } = await import("@/lib/llm");

const acao = vi.mocked(executarAcao);
const reagir = vi.mocked(sendReaction);
const fila = vi.mocked(enqueue);
const llm = vi.mocked(complete);

const ORG = "org-condutor-v2";
const CANDIDATO = { orgId: ORG, orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "Marcia" };
const CPF = "529.982.247-25";
const NOME = "Maria Souza Lima";
let seq = 0;

function msg(text: string) {
  return {
    messageId: `wamid.TXT${++seq}`,
    fromPhone: "5511987654321",
    groupId: null,
    kind: "text",
    text,
    mediaUrl: null,
    mimeType: null,
    timestampMs: null,
    senderName: "Marcia",
    replyToMessageId: null,
  } as Parameters<typeof runTurn>[0];
}

const OPTIONS = {
  metodos: [{ valor: "whatsapp", rotulo: "WhatsApp" }],
  signatarios: [],
  assinaturaConfigurada: true,
  modalidades: [{ schemaType: "compra_venda_v1", esteira: "venda", rotulo: "Compra e venda", modeloDisponivel: true }],
  obrigatorios: [
    { chave: "proponente.nome", rotulo: "Nome do comprador", grupo: "Partes", esteira: "venda", tipoCampo: "texto" },
    { chave: "negociacao.valor", rotulo: "Valor da proposta", grupo: "Negociação", esteira: "venda", tipoCampo: "moeda" },
  ],
  tiposDeAssinatura: [],
  fluxoV2: true,
};

async function turno(texto: string) {
  const thread = `condutor-v2-${Math.random()}`;
  const app = await getApp();
  await app.updateState(
    { configurable: { thread_id: thread } },
    { fluxo: novoFluxoV2({ esteira: "venda", agora: Date.now(), schemaType: "compra_venda_v1" }) as never }
  );
  const r = await withExecution(
    {
      orgId: ORG, subject: { kind: "user", userId: "u1" }, conversationId: thread,
      taskId: "00000000-0000-4000-8000-000000000001", mode: "live", workflowVersion: "max-v1",
      controlVersion: 0, deadline: Date.now() + 30_000, budgetUsd: 0.25, maxConcurrency: 1,
    },
    () => runTurn(msg(texto))
  );
  const values = (await app.getState({ configurable: { thread_id: thread } })).values;
  return { ...r, values };
}

function featureV2(ligada: boolean) {
  vi.stubEnv("MAX_FORMULARIOS_V2", ligada ? "true" : "false");
  vi.stubEnv("MAX_ROLLOUT_ORGS", ligada ? JSON.stringify({ [ORG]: ["formularios_v2"] }) : "{}");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  acao.mockResolvedValue({ status: 200, body: OPTIONS });
  const resolved: Identity = { kind: "resolved", candidate: CANDIDATO, org: { orgId: ORG, orgName: "RE/MAX Trio", apiToken: "t" } };
  vi.mocked(resolveIdentity).mockResolvedValue(resolved);
  llm.mockResolvedValue({
    text: "ok",
    toolCalls: [{ id: "t1", name: TOOL_PATCH_V2.name, args: { compradores: [{ nome: NOME, cpf: "52998224725" }] } }],
    usage: { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true },
  } as never);
});

describe("rebaixarFluxo no v2", () => {
  it("a ficha mostrada sem chave volta para compor e apaga o agendamento", async () => {
    const { rebaixarFluxo } = await import("../../fluxos");
    const base = novoFluxoV2({ esteira: "venda", agora: 1, schemaType: "compra_venda_v1" });
    const f = rebaixarFluxo({ ...base, etapa: "ficha", fichaAgendadaEm: 5 } as never) as typeof base;
    expect(f.etapa).toBe("compor");
    expect(f.fichaAgendadaEm).toBeUndefined();
  });
});

describe("condutor v2 no grafo", () => {
  it("NEGADO: feature desligada, o condutor nem roda (sem extração, sem fila, sem reação)", async () => {
    featureV2(false);
    await turno(`Comprador ${NOME} CPF ${CPF}`);
    expect(fila).not.toHaveBeenCalled();
    expect(reagir).not.toHaveBeenCalled();
    expect(acao.mock.calls.some(([p]) => p.verb === "proposal.options")).toBe(false);
  });

  it("dado dentro dos 20 s: sem texto de resposta, 👍, ficha agendada no outbox, nada de PII no checkpoint", async () => {
    featureV2(true);

    const { reply, values } = await turno(`Comprador ${NOME} CPF ${CPF}`);

    // Silêncio: nenhuma resposta de texto (o transporte não manda nada quando `reply` é nulo).
    expect(reply).toBeNull();
    expect(reagir).toHaveBeenCalledTimes(1);
    expect(reagir.mock.calls[0]![0]).toMatchObject({ emoji: "👍" });
    // Nada foi escrito no servidor: coletar não grava.
    expect(acao.mock.calls.filter(([p]) => p.verb === "proposal.create" || p.verb === "proposal.update")).toHaveLength(0);
    // A ficha sai depois da pausa, com o CPF mascarado.
    expect(fila).toHaveBeenCalledTimes(1);
    const agendada = fila.mock.calls[0]![0];
    expect(agendada.dedupeKey).toMatch(/^ficha:/);
    expect(agendada.deliverAfter).toBeInstanceOf(Date);
    expect(agendada.body).toContain("***.982.247-**");
    expect(agendada.body).not.toContain(CPF);
    // O modelo só foi chamado para extrair (nada de resposta livre).
    expect(llm).toHaveBeenCalledTimes(1);
    // Checkpoint: o fluxo guarda caminhos e referência, nunca o valor lido.
    const fluxo = values.fluxo as { kind: string; lidosPendentes: unknown[]; fichaAgendadaEm?: number };
    expect(fluxo.kind).toBe("proposta_v2");
    expect(fluxo.lidosPendentes.length).toBeGreaterThan(0);
    expect(fluxo.fichaAgendadaEm).toBeTypeOf("number");
    const cp = JSON.stringify(fluxo);
    expect(cp).not.toContain("52998224725");
    expect(cp).not.toContain(CPF);
    expect(cp).not.toContain(NOME);
  });
});
