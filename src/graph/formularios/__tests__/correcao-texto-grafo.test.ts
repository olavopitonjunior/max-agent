import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@/lib/identity";
import { withExecution } from "@/lib/runtime/context";

/**
 * PR-E (T15) no GRAFO: o turno de correção de texto é sensível. O texto do documento (antes/depois)
 * chega ao corretor e some do resto: checkpoint, fila de entrada, log do turno e memória (R29).
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
  fetchProfile: vi.fn().mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: { byRole: { "*": ["proposal.list", "document.text.edit"] }, byRecipient: {}, brokerDefault: [] } }),
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
const { resolveIdentity } = await import("@/lib/identity");
const { executarAcao } = await import("@/lib/acao");
const { MARCADOR_DOCUMENTO_LIDO } = await import("../midia");
const { registrarTurn } = await import("@/lib/turnlog");
const { extractFacts, saveFacts } = await import("@/lib/memory");
const { complete } = await import("@/lib/llm");

const acao = vi.mocked(executarAcao);
const llm = vi.mocked(complete);

const ORG = "org-correcao-texto";
const CANDIDATO = { orgId: ORG, orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "Marcia" };
const ANTES = "ANTES-MARCADOR multa de 20 por cento";
const DEPOIS = "DEPOIS-MARCADOR multa de 10 por cento";
let seq = 0;

function msg(text: string) {
  return {
    messageId: `wamid.CT${++seq}`, fromPhone: "5511987654321", groupId: null, kind: "text", text,
    mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Marcia", replyToMessageId: null,
  } as Parameters<typeof runTurn>[0];
}

function featureV2(ligada: boolean) {
  vi.stubEnv("MAX_FORMULARIOS_V2", ligada ? "true" : "false");
  vi.stubEnv("MAX_ROLLOUT_ORGS", ligada ? JSON.stringify({ [ORG]: ["formularios_v2"] }) : "{}");
}

const fluxoSugestao = () => ({
  kind: "correcao_texto", alvo: "proposal", id: "prop-1", rotulo: "PROP-1", etapa: "sugestao",
  paragrafoId: "p4", sugestaoId: "sug-1", hashParagrafo: "h".repeat(16), atualizadoEm: Date.now(),
  expiraEm: Date.now() + 10 * 60_000,
});

async function turnoComFluxo(texto: string, fluxo: Record<string, unknown> = fluxoSugestao()) {
  const thread = `correcao-texto-${Math.random()}`;
  const app = await getApp();
  await app.updateState({ configurable: { thread_id: thread } }, { fluxo: fluxo as never });
  const r = await withExecution(
    {
      orgId: ORG, subject: { kind: "user", userId: "u1" }, conversationId: thread,
      taskId: "00000000-0000-4000-8000-0000000000c1", mode: "live", workflowVersion: "max-v1",
      controlVersion: 0, deadline: Date.now() + 30_000, budgetUsd: 0.25, maxConcurrency: 1,
    },
    () => runTurn(msg(texto))
  );
  await r.afterReply();
  const values = (await app.getState({ configurable: { thread_id: thread } })).values as Record<string, unknown> & {
    messages: { role: string; content: string }[];
  };
  return { r, values };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  const resolved: Identity = { kind: "resolved", candidate: CANDIDATO, org: { orgId: ORG, orgName: "RE/MAX Trio", apiToken: "t" } };
  vi.mocked(resolveIdentity).mockResolvedValue(resolved);
  llm.mockResolvedValue({ text: "ok", toolCalls: [], usage: { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true } } as never);
});

describe("correção de texto no grafo", () => {
  it("NEGADO: com a feature desligada o fluxo de correção não conduz nada e não chama o servidor", async () => {
    featureV2(false);
    await turnoComFluxo("sim");
    expect(acao.mock.calls.some(([p]) => String(p.verb).includes(".text."))).toBe(false);
  });

  it("o SIM aplica; o antes/depois do NOVO texto vai ao corretor e só o marcador fica no resto (R29)", async () => {
    featureV2(true);
    // O aviso do servidor carrega texto do documento: chega ao corretor, não ao resto.
    acao.mockResolvedValueOnce({ status: 200, body: { aplicado: true, avisos: [`O parágrafo 7 também mudou: ${ANTES} -> ${DEPOIS}`] } } as never);
    const { r, values } = await turnoComFluxo("sim");

    expect(acao).toHaveBeenCalledTimes(1);
    expect(acao.mock.calls[0]![0]).toMatchObject({ verb: "proposal.text.apply", args: { proposta_id: "prop-1", sugestaoId: "sug-1" } });
    // O corretor vê a resposta (com o aviso do servidor).
    expect(r.reply).toMatch(/apliquei a correção/);
    expect(r.reply).toContain("ANTES-MARCADOR");
    // Fila de entrada e checkpoint: só o marcador.
    expect(r.sensivel).toBe(true);
    expect(r.replyGravado).toBe(MARCADOR_DOCUMENTO_LIDO);
    const doAssistente = values.messages.filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
    expect(doAssistente).not.toContain("ANTES-MARCADOR");
    expect(String(values.reply ?? "")).not.toContain("ANTES-MARCADOR");
    // Log do turno e memória: nada do texto do documento.
    const log = vi.mocked(registrarTurn).mock.calls.at(-1)![0];
    expect(JSON.stringify(log)).not.toContain("ANTES-MARCADOR");
    expect(extractFacts).not.toHaveBeenCalled();
    expect(saveFacts).not.toHaveBeenCalled();
    // O modelo não foi chamado: a correção é determinística.
    expect(llm).not.toHaveBeenCalled();
  });

  it("o estado do fluxo no checkpoint depois da sugestão guarda só ids", async () => {
    featureV2(true);
    acao.mockResolvedValueOnce({ status: 502, body: { error: "documento_indisponivel" } } as never);
    const { values } = await turnoComFluxo("sim");
    // apply 502: o fluxo segue esperando o SIM, só ids no estado.
    const cp = JSON.stringify(values.fluxo);
    expect(cp).toContain("sug-1");
    expect(cp).not.toContain("MARCADOR");
  });

  it("R33: o trecho colado pelo corretor (etapa citar) não fica no checkpoint nem no log do turno", async () => {
    featureV2(true);
    const COLADO = "TRECHO-COLADO-MARCADOR a multa rescisória será de vinte por cento";
    acao.mockResolvedValueOnce({
      status: 200,
      body: { estado: "sugestao", sugestaoId: "sug-7", paragrafoId: "p9", hashParagrafo: "h".repeat(16), antes: ANTES, depois: DEPOIS },
    } as never);
    const citar = { ...fluxoSugestao(), etapa: "citar", paragrafoId: undefined, sugestaoId: undefined, hashParagrafo: undefined, expiraEm: undefined };
    const { r, values } = await turnoComFluxo(COLADO, citar);

    // O servidor recebeu a citação (é para isso que ela existe) e o corretor viu a resposta.
    expect(acao).toHaveBeenCalledTimes(1);
    expect(acao.mock.calls[0]![0]).toMatchObject({ verb: "proposal.text.suggest" });
    expect(r.reply).toContain("ANTES-MARCADOR");
    expect(r.sensivel).toBe(true);
    // Checkpoint: NENHUMA mensagem (de qualquer papel) carrega o trecho colado nem o antes/depois.
    expect(values.messages.some((m) => m.role === "user")).toBe(true); // o turno do corretor está lá, só que cego
    const todas = JSON.stringify(values.messages);
    expect(todas).not.toContain("TRECHO-COLADO-MARCADOR");
    expect(todas).not.toContain("ANTES-MARCADOR");
    expect(JSON.stringify(values)).not.toContain("TRECHO-COLADO-MARCADOR");
    // Log do turno: o texto de entrada e a transcrição viram o marcador.
    const log = vi.mocked(registrarTurn).mock.calls.at(-1)![0];
    expect(JSON.stringify(log)).not.toContain("TRECHO-COLADO-MARCADOR");
    expect(JSON.stringify(log)).not.toContain("ANTES-MARCADOR");
    expect(extractFacts).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
  });

  it("R34: feature desligada com a correção aberta e 'sim': frase fixa, sem servidor e sem modelo livre", async () => {
    featureV2(false);
    const { r } = await turnoComFluxo("sim");
    expect(acao.mock.calls.some(([p]) => String(p.verb).includes(".text."))).toBe(false);
    expect(llm).not.toHaveBeenCalled();
    expect(r.reply).toMatch(/foi desligada/);
    expect(r.reply).toMatch(/Nada foi aplicado/);
  });

  it("R34: feature desligada com escrita incerta aberta: manda conferir no documento, sem modelo livre", async () => {
    featureV2(false);
    const incerto = { ...fluxoSugestao(), chave: { verbo: "proposal.text.apply", valor: "wamid.ANTIGA" } };
    const { r, values } = await turnoComFluxo("sim", incerto);
    expect(acao.mock.calls.some(([p]) => String(p.verb).includes(".text."))).toBe(false);
    expect(llm).not.toHaveBeenCalled();
    expect(r.reply).toMatch(/confira no documento/);
    expect(JSON.stringify(values.fluxo ?? null)).not.toContain("wamid.ANTIGA");
  });

  it.each(["sim", "1", "aplicar", "confirmo"])("N2: sugestão vencida SEM escrita incerta + '%s' tardio: frase fixa, sem apply e sem modelo livre", async (tardio) => {
    featureV2(true);
    const velho = Date.now() - 3 * 60 * 60_000;
    const { r, values } = await turnoComFluxo(tardio, { ...fluxoSugestao(), atualizadoEm: velho, expiraEm: velho + 30 * 60_000 });
    expect(acao.mock.calls.some(([p]) => String(p.verb).includes(".text."))).toBe(false);
    expect(llm).not.toHaveBeenCalled();
    expect(r.reply).toMatch(/venceu/);
    expect(r.reply).toMatch(/peça a correção de novo/);
    expect(r.reply).toMatch(/Nada foi aplicado/);
    expect(values.fluxo ?? null).toBeNull();
  });

  it("N2: com a feature desligada o 'sim' tardio também recebe a frase fixa (nunca o modelo livre)", async () => {
    featureV2(false);
    const velho = Date.now() - 3 * 60 * 60_000;
    const { r } = await turnoComFluxo("sim", { ...fluxoSugestao(), atualizadoEm: velho });
    expect(acao.mock.calls.some(([p]) => String(p.verb).includes(".text."))).toBe(false);
    expect(llm).not.toHaveBeenCalled();
    expect(r.reply).toMatch(/venceu/);
  });

  it("N2: outra conversa depois do vencimento segue o caminho normal (a frase só vale para o SIM de aplicar)", async () => {
    featureV2(true);
    const velho = Date.now() - 3 * 60 * 60_000;
    const { r } = await turnoComFluxo("oi, tudo bem?", { ...fluxoSugestao(), atualizadoEm: velho });
    expect(r.reply).not.toMatch(/venceu/);
    expect(acao.mock.calls.some(([p]) => String(p.verb).includes(".text."))).toBe(false);
  });

  it("M2: escrita incerta vencida no relógio do fluxo: manda conferir, não repete o apply", async () => {
    featureV2(true);
    const velho = Date.now() - 3 * 60 * 60_000;
    const incerto = { ...fluxoSugestao(), atualizadoEm: velho, chave: { verbo: "proposal.text.apply", valor: "wamid.ANTIGA" } };
    const { r } = await turnoComFluxo("sim", incerto);
    expect(acao.mock.calls.some(([p]) => String(p.verb).includes(".text."))).toBe(false);
    expect(llm).not.toHaveBeenCalled();
    expect(r.reply).toMatch(/confira no documento/);
  });
});
