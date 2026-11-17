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
const { abrirCorpo, estaSelado } = await import("../selo");
const { MARCADOR_DOCUMENTO_LIDO } = await import("../midia");
const { registrarTurn } = await import("@/lib/turnlog");
const { extractFacts, saveFacts } = await import("@/lib/memory");
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

describe("tolerância a erro de digitação (P1) só com feature E servidor v2", () => {
  async function semFluxo(texto: string) {
    const app = await getApp();
    const thread = `tolerancia-${Math.random()}`;
    await app.getState({ configurable: { thread_id: thread } });
    return withExecution(
      {
        orgId: ORG, subject: { kind: "user", userId: "u1" }, conversationId: thread,
        taskId: "00000000-0000-4000-8000-000000000002", mode: "live", workflowVersion: "max-v1",
        controlVersion: 0, deadline: Date.now() + 30_000, budgetUsd: 0.25, maxConcurrency: 1,
      },
      () => runTurn(msg(texto))
    );
  }

  it("NEGADO: servidor com fluxoV2 false, o 'propossta' (fora da lista fechada da produção) não é pedido de criação (o modelo segue o caminho de hoje)", async () => {
    // A produção (17/11) já aceita "propsta"/"porposta"… sem a feature (`corrigirProposta`); a tolerância por
    // distância de edição é a que só o v2 liga.
    featureV2(true);
    acao.mockResolvedValue({ status: 200, body: { ...OPTIONS, fluxoV2: false } });
    llm.mockResolvedValue({ text: "Como posso ajudar?", toolCalls: [], usage: { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true } } as never);
    await semFluxo("quero criar uma propossta de venda");
    expect(llm).toHaveBeenCalled();
  });

  it("feature + servidor v2: o 'propsta' é reconhecido como criação (sem permissão de criar, responde o template e não chama o modelo)", async () => {
    featureV2(true);
    llm.mockResolvedValue({ text: "Como posso ajudar?", toolCalls: [], usage: { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true } } as never);
    const r = await semFluxo("quero criar uma propsta de venda");
    expect(llm).not.toHaveBeenCalled();
    expect(r.reply).toBeTruthy();
  });
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
    // I5: o corpo no outbox vai SELADO (org|telefone): nenhum valor do documento em claro.
    expect(estaSelado(agendada.body)).toBe(true);
    expect(agendada.body).not.toContain(NOME);
    expect(agendada.body).not.toContain("982.247");
    expect(agendada.body).not.toContain(CPF);
    const aberta = abrirCorpo(agendada.body, `${ORG}|5511987654321`);
    expect(aberta).toContain("***.982.247-**");
    expect(aberta).not.toContain(CPF);
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

  // I5: a ficha mostrada NO turno (o corretor pediu "ficha") traz o valor do documento. Ele chega ao
  // corretor, mas não fica no checkpoint, no log do turno, na fila de entrada nem na memória.
  it("I5: ficha mostrada no turno vai ao corretor, mas o resto (checkpoint, log, memória) só vê o marcador", async () => {
    featureV2(true);
    const thread = `condutor-v2-i5-${Math.random()}`;
    const app = await getApp();
    await app.updateState(
      { configurable: { thread_id: thread } },
      { fluxo: novoFluxoV2({ esteira: "venda", agora: Date.now(), schemaType: "compra_venda_v1" }) as never }
    );
    const exec = (texto: string) =>
      withExecution(
        {
          orgId: ORG, subject: { kind: "user", userId: "u1" }, conversationId: thread,
          taskId: "00000000-0000-4000-8000-000000000003", mode: "live", workflowVersion: "max-v1",
          controlVersion: 0, deadline: Date.now() + 30_000, budgetUsd: 0.25, maxConcurrency: 1,
        },
        () => runTurn(msg(texto))
      );
    await exec(`Comprador ${NOME} CPF ${CPF}`);
    vi.mocked(registrarTurn).mockClear();
    const r = await exec("ficha");
    await r.afterReply();

    // O corretor VÊ o valor.
    expect(r.reply).toContain(NOME);
    // Fila de entrada: só o marcador (`sensivel` apaga o texto e grava `replyGravado`).
    expect(r.sensivel).toBe(true);
    expect(r.replyGravado).toBe(MARCADOR_DOCUMENTO_LIDO);
    // Checkpoint: a resposta do assistente é o marcador, e o campo `reply` não guarda o valor.
    const values = (await app.getState({ configurable: { thread_id: thread } })).values as {
      messages: { role: string; content: string }[];
      reply: string | null;
    };
    const doAssistente = values.messages.filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
    expect(doAssistente).not.toContain(NOME);
    expect(doAssistente).toContain(MARCADOR_DOCUMENTO_LIDO);
    expect(values.reply ?? "").not.toContain(NOME);
    // Log do turno: nada do valor.
    const log = vi.mocked(registrarTurn).mock.calls.at(-1)![0];
    expect(JSON.stringify(log)).not.toContain(NOME);
    expect(JSON.stringify(log)).not.toContain("982.247");
    // Memória: o turno do formulário v2 não alimenta `memory_facts`.
    expect(extractFacts).not.toHaveBeenCalled();
    expect(saveFacts).not.toHaveBeenCalled();
  });

  it("I5 (negado): turno comum, sem fluxo v2, segue como antes (resposta gravada, memória rodando)", async () => {
    featureV2(false);
    llm.mockResolvedValue({ text: "Olá!", toolCalls: [], usage: { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true } } as never);
    const thread = `condutor-v2-i5n-${Math.random()}`;
    const r = await withExecution(
      {
        orgId: ORG, subject: { kind: "user", userId: "u1" }, conversationId: thread,
        taskId: "00000000-0000-4000-8000-000000000004", mode: "live", workflowVersion: "max-v1",
        controlVersion: 0, deadline: Date.now() + 30_000, budgetUsd: 0.25, maxConcurrency: 1,
      },
      () => runTurn(msg("oi, tudo bem?"))
    );
    expect(r.sensivel).toBeFalsy();
    expect(r.replyGravado).toBeUndefined();
  });
});

describe("revisão e Flow (C2) com formularios_v2 OFF: o v1 de antes, sem Flow nem condutor", () => {
  const RESPOSTA_DE_FLOW = `compradores_0__nome: ${NOME}\ncompradores_0__cpf: ${CPF}`;

  async function turnoV1(texto: string, extra: Partial<Parameters<typeof runTurn>[0]> = {}, fluxo?: unknown) {
    const thread = `condutor-v2-off-${Math.random()}`;
    const app = await getApp();
    if (fluxo) await app.updateState({ configurable: { thread_id: thread } }, { fluxo: fluxo as never });
    const mensagem = { ...msg(texto), ...extra } as Parameters<typeof runTurn>[0];
    const r = await withExecution(
      {
        orgId: ORG, subject: { kind: "user", userId: "u1" }, conversationId: thread,
        taskId: "00000000-0000-4000-8000-000000000005", mode: "live", workflowVersion: "max-v1",
        controlVersion: 0, deadline: Date.now() + 30_000, budgetUsd: 0.25, maxConcurrency: 1,
      },
      () => runTurn(mensagem)
    );
    return { r, mensagem };
  }

  const emRevisao = () => ({
    ...novoFluxoV2({ esteira: "venda", agora: Date.now(), schemaType: "compra_venda_v1" }),
    proposalId: "prop-1",
    etapa: "revisar",
    revisao: { passo: "partes", via: "texto", nonce: "NONCE", itens: ["compradores[0].nome"] },
  });

  function flowLigado() {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "max");
    vi.stubEnv("MAX_INTERACTIVE", "");
    vi.stubEnv("MAX_FLOW_ID_REVISAR_PARTES", "FLOW_PARTES");
    vi.stubEnv("MAX_FLOW_ID_REVISAR_IMOVEL_VALOR", "FLOW_IMOVEL");
  }

  const escritasNoServidor = () => acao.mock.calls.filter(([p]) => p.verb === "proposal.create" || p.verb === "proposal.update");

  it("NEGADO: 'revisar' com a flag OFF e o Flow configurado não abre revisão nem registra Flow", async () => {
    featureV2(false);
    flowLigado();
    llm.mockResolvedValue({ text: "Não tenho como revisar isso.", toolCalls: [], usage: { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true } } as never);
    const { r, mensagem } = await turnoV1("revisar");
    const { espiarFlowDoTurno } = await import("@/lib/meta-flow");
    expect(espiarFlowDoTurno(mensagem.messageId)).toBeUndefined();
    expect(acao.mock.calls.some(([p]) => p.verb === "proposal.options")).toBe(false);
    expect(escritasNoServidor()).toHaveLength(0);
    expect(fila).not.toHaveBeenCalled();
    expect(r.reply ?? "").not.toMatch(/Revisão da proposta|Toque em \*Revisar\*/);
  });

  it("NEGADO: resposta de Flow com token, flag OFF, não vira cartão nem escrita (o v1 de antes)", async () => {
    featureV2(false);
    flowLigado();
    const { r, mensagem } = await turnoV1(RESPOSTA_DE_FLOW, { buttonPayload: "flow:fv2:partes:NONCE" } as never, emRevisao());
    const { espiarFlowDoTurno } = await import("@/lib/meta-flow");
    expect(espiarFlowDoTurno(mensagem.messageId)).toBeUndefined();
    expect(escritasNoServidor()).toHaveLength(0);
    expect(acao.mock.calls.some(([p]) => p.verb === "proposal.options")).toBe(false);
    expect(fila).not.toHaveBeenCalled();
    expect(r.reply ?? "").not.toContain("📋");
    expect(r.reply ?? "").not.toMatch(/revisão anterior|não veio do formulário/);
  });
});
