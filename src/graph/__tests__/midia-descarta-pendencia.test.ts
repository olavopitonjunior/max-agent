import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * D3 (review de segurança do PR 2): a saída antecipada por mídia é um TURN, e
 * a pendência de escrita sobrevive no máximo um turn.
 *
 * Sem isto: "Crio o formulário?" → foto (resposta fixa, fora do grafo) → "sim"
 * horas depois, dentro do TTL → o formulário nascia com uma confirmação que a
 * pessoa já não dava. Precisa do checkpointer real: pula sem `DATABASE_URL`.
 */

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  fetchProfile: vi.fn().mockResolvedValue({
    enabled: true, model: "x", maxPolicy: { byRole: { "*": ["form.create"] } },
  }),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  transcribeMedia: vi.fn().mockResolvedValue(null),
  criarFormularioVenda: vi.fn(),
}));
vi.mock("@/lib/zapi", async (orig) => ({
  ...(await orig<typeof import("@/lib/zapi")>()),
  downloadMedia: vi.fn().mockResolvedValue({ data: Buffer.from("x"), contentType: "audio/ogg" }),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  resolveIdentity: vi.fn(),
}));
vi.mock("@/lib/turnlog", () => ({ registrarTurn: vi.fn().mockResolvedValue(undefined) }));

const { runTurn, buildGraph, getCheckpointer, threadIdFor } = await import("../graph");
const { resolveIdentity } = await import("@/lib/identity");
const { criarFormularioVenda } = await import("@/lib/cm");
const identidade = vi.mocked(resolveIdentity);
const criar = vi.mocked(criarFormularioVenda);

const itDb = process.env.DATABASE_URL ? it : it.skip;

const CANDIDATO = { orgId: "org-d3", orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "M" };

function msg(kind: "image" | "document" | "audio" | "unknown" | "text", phone: string, text: string | null = null) {
  return {
    messageId: `m_${Math.random()}`, fromPhone: phone, groupId: null, kind, text,
    mediaUrl: kind === "text" ? null : "https://media.example/x",
    mimeType: null, timestampMs: null, senderName: "M", replyToMessageId: null,
  } as Parameters<typeof runTurn>[0];
}

async function semear(phone: string) {
  const app = buildGraph().compile({ checkpointer: await getCheckpointer() });
  const config = { configurable: { thread_id: threadIdFor(CANDIDATO.orgId, phone) } };
  await app.updateState(config, {
    pendingAction: {
      kind: "criar_documento", args: { tipo: "venda" }, askedAt: Date.now(), askedForMessageId: "m0",
    },
    restoDaResposta: { texto: "o resto", criadoEm: Date.now() },
  });
  return async () => (await app.getState(config)).values as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  identidade.mockResolvedValue({ kind: "identified", candidate: CANDIDATO } as never);
});

describe("D3 — saída antecipada descarta a pendência", () => {
  itDb.each(["image", "document", "unknown", "audio"] as const)(
    "%s sem texto limpa pendingAction e restoDaResposta",
    async (kind) => {
      const phone = `55119${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
      const estado = await semear(phone);
      expect((await estado()).pendingAction).not.toBeNull();

      // Áudio cai na saída antecipada porque a transcrição (mock) falha.
      await runTurn(msg(kind, phone));

      const depois = await estado();
      expect(depois.pendingAction).toBeNull();
      expect(depois.restoDaResposta).toBeNull();
    },
    30_000
  );

  itDb("o 'sim' depois da foto não cria nada", async () => {
    const phone = `55118${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    await semear(phone);
    await runTurn(msg("image", phone));
    const { complete } = await import("@/lib/llm");
    vi.mocked(complete).mockResolvedValue({
      text: "Sim o quê?", toolCalls: [],
      usage: { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true },
    } as never);

    await runTurn(msg("text", phone, "sim"));

    expect(criar).not.toHaveBeenCalled();
  }, 30_000);
});
