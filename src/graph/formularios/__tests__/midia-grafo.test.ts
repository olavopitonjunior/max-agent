import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@/lib/identity";
import { withExecution } from "@/lib/runtime/context";

/**
 * T7 — a mídia no turno: foto/PDF no meio de uma proposta v2 ABERTA vão para
 * `lerMidia`, não para a frase fixa do G5. Fora disso (sem a feature, sem
 * fluxo vivo) o G5 segue byte a byte.
 */

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
vi.mock("@/lib/transport", async (orig) => ({
  ...(await orig<typeof import("@/lib/transport")>()),
  downloadMedia: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/llm", () => ({
  DEFAULT_MODEL: "openai/gpt-5.4-nano",
  complete: vi.fn().mockResolvedValue({
    text: "Anotei a legenda.",
    toolCalls: [],
    usage: { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true },
  }),
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
vi.mock("../midia", async (orig) => ({
  ...(await orig<typeof import("../midia")>()),
  lerMidia: vi.fn(),
}));

const { runTurn, getApp } = await import("../../graph");
const { lerMidia } = await import("../midia");
const { novoFluxoV2 } = await import("../estado");
const { textoSemLeituraDeMidia } = await import("../../prompt");
const { resolveIdentity } = await import("@/lib/identity");
const { downloadMedia } = await import("@/lib/transport");
const { complete } = await import("@/lib/llm");

const ler = vi.mocked(lerMidia);
const baixar = vi.mocked(downloadMedia);
const llm = vi.mocked(complete);

const ORG = "org-midia-v2";
const CANDIDATO = { orgId: ORG, orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "Marcia" };
let seq = 0;

function foto(over: Record<string, unknown> = {}) {
  return {
    messageId: `wamid.FOTO${++seq}`,
    fromPhone: "5511987654321",
    groupId: null,
    kind: "image",
    text: null,
    mediaUrl: "meta:MEDIA1",
    mimeType: "image/jpeg",
    timestampMs: null,
    senderName: "Marcia",
    replyToMessageId: null,
    ...over,
  } as Parameters<typeof runTurn>[0];
}

/** Um turno com a thread numerada, semeada (ou não) com um fluxo proposta_v2. */
async function turno(inbound: Parameters<typeof runTurn>[0], opts: { fluxoVivo: boolean }) {
  const thread = `midia-v2-${Math.random()}`;
  if (opts.fluxoVivo) {
    const app = await getApp();
    await app.updateState(
      { configurable: { thread_id: thread } },
      { fluxo: novoFluxoV2({ esteira: "venda", agora: Date.now(), schemaType: "venda_padrao" }) as never }
    );
  }
  return withExecution(
    {
      orgId: ORG, subject: { kind: "user", userId: "u1" }, conversationId: thread,
      taskId: "00000000-0000-4000-8000-000000000001", mode: "live", workflowVersion: "max-v1",
      controlVersion: 0, deadline: Date.now() + 30_000, budgetUsd: 0.25, maxConcurrency: 1,
    },
    () => runTurn(inbound)
  );
}

function featureV2(ligada: boolean) {
  vi.stubEnv("MAX_FORMULARIOS_V2", ligada ? "true" : "false");
  vi.stubEnv("MAX_ROLLOUT_ORGS", ligada ? JSON.stringify({ [ORG]: ["formularios_v2"] }) : "{}");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  const resolved: Identity = { kind: "resolved", candidate: CANDIDATO, org: { orgId: ORG, orgName: "RE/MAX Trio", apiToken: "t" } };
  vi.mocked(resolveIdentity).mockResolvedValue(resolved);
});

describe("Max: foto de RG durante proposta v2 vai para lerMidia, não para a frase fixa", () => {
  it("HEIC: responde a frase honesta nova, sem a frase do G5", async () => {
    featureV2(true);
    ler.mockResolvedValue({ tipo: "nao_lido", motivo: "heic" });

    const { reply } = await turno(foto({ mimeType: "image/heic" }), { fluxoVivo: true });

    expect(ler).toHaveBeenCalledTimes(1);
    expect(reply).toBe("Não consigo ler foto nesse formato; mande como captura de tela ou digite.");
    expect(reply).not.toBe(textoSemLeituraDeMidia(null));
  });

  it("a leitura recebe a referência da mídia, a org, a messageId e o contexto do fluxo", async () => {
    featureV2(true);
    ler.mockResolvedValue({ tipo: "nao_lido", motivo: "tamanho" });
    const inbound = foto();

    const { reply } = await turno(inbound, { fluxoVivo: true });

    const [, midia, ctx] = ler.mock.calls[0]!;
    expect(midia).toMatchObject({ kind: "image", ref: "meta:MEDIA1", mimeType: "image/jpeg" });
    expect(ctx).toMatchObject({ orgId: ORG, messageId: inbound.messageId, alvo: "proposta", tipo: "venda", schemaType: "venda_padrao" });
    expect(reply).toMatch(/grande demais/i);
  });

  it("PDF sem document.read (a política não concede): frase honesta do PDF, não a do G5", async () => {
    featureV2(true);
    // Sem mock de `lerMidia`: o real roda e, sem a capability, nem baixa o arquivo.
    const real = await vi.importActual<typeof import("../midia")>("../midia");
    ler.mockImplementation(real.lerMidia);

    const { reply } = await turno(foto({ kind: "document", mimeType: "application/pdf" }), { fluxoVivo: true });

    expect(reply).toBe("Ainda não leio PDF aqui; mande foto ou digite.");
    expect(baixar).not.toHaveBeenCalled();
  });

  it("foto sem a capability: a frase do G5 continua, byte a byte", async () => {
    featureV2(true);
    ler.mockResolvedValue({ tipo: "nao_lido", motivo: "sem_leitura" });

    const { reply } = await turno(foto(), { fluxoVivo: true });

    expect(reply).toBe(textoSemLeituraDeMidia(null));
  });
});

describe("legenda + foto: a legenda vai à janela, a foto à leitura", () => {
  it("o turno segue com a legenda como mensagem e a foto foi para lerMidia", async () => {
    featureV2(true);
    ler.mockResolvedValue({ tipo: "nao_lido", motivo: "heic" });

    const { reply } = await turno(foto({ text: "segue o RG do comprador" }), { fluxoVivo: true });

    expect(ler.mock.calls[0]![1]).toMatchObject({ kind: "image", legenda: "segue o RG do comprador" });
    // A legenda é a mensagem: o turno chegou ao modelo e a resposta é a dele.
    expect(reply).toBe("Anotei a legenda.");
    expect(llm).toHaveBeenCalled();
  });
});

describe("sem v2 ativo, o G5 segue byte a byte", () => {
  it("feature desligada: nem lê o fluxo, a frase fixa", async () => {
    featureV2(false);
    const { reply } = await turno(foto(), { fluxoVivo: true });
    expect(ler).not.toHaveBeenCalled();
    expect(reply).toBe(textoSemLeituraDeMidia(null));
  });

  it("feature ligada, mas sem fluxo proposta_v2 vivo: a frase fixa", async () => {
    featureV2(true);
    const { reply } = await turno(foto(), { fluxoVivo: false });
    expect(ler).not.toHaveBeenCalled();
    expect(reply).toBe(textoSemLeituraDeMidia(null));
  });
});

describe("Newton: zapi:<url> só com NEWTON_MEDIA_INBOUND", () => {
  it("sem a flag a URL nem é baixada e a frase não a revela", async () => {
    featureV2(true);
    const real = await vi.importActual<typeof import("../midia")>("../midia");
    ler.mockImplementation(real.lerMidia);
    const url = "zapi:https://media.zapi.example/instances/X/segredo-do-cliente/rg.jpeg";

    const { reply } = await turno(foto({ mediaUrl: url }), { fluxoVivo: true });

    expect(baixar).not.toHaveBeenCalled();
    expect(reply).not.toContain("segredo-do-cliente");
    expect(reply).not.toContain("zapi");
  });
});
