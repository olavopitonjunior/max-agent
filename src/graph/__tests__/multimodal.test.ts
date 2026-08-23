import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Áudio e imagem no inbound.
 *
 * O que se protege aqui é o CAMINHO, não a qualidade da transcrição (essa é do
 * Gemini): que a mídia vire o turno da pessoa antes do grafo, que a falha
 * SEMPRE vire aviso em vez de silêncio, e que a transcrição nunca aconteça
 * antes de saber a org — porque é o token dela que paga e é a base dela que
 * responde.
 */

vi.mock("@/lib/cm", () => ({
  fetchProfile: vi.fn().mockResolvedValue(null),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  transcribeMedia: vi.fn(),
}));
vi.mock("@/lib/zapi", () => ({
  downloadMedia: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({
  DEFAULT_MODEL: "openai/gpt-5.4-nano",
  complete: vi.fn().mockResolvedValue({
    text: "Entendi que você perguntou do contrato. Ele está pronto.",
    toolCalls: [],
    usage: { model: "m", promptTokens: 1, completionTokens: 1, latencyMs: 1 },
  }),
}));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  resolveIdentity: vi.fn(),
  saveChoice: vi.fn().mockResolvedValue(undefined),
}));

const { runTurn } = await import("../graph");
const { buildSystemPrompt } = await import("../prompt");
const { transcribeMedia } = await import("@/lib/cm");
const { downloadMedia } = await import("@/lib/zapi");
const { resolveIdentity } = await import("@/lib/identity");

const transcrever = transcribeMedia as unknown as ReturnType<typeof vi.fn>;
const baixar = downloadMedia as unknown as ReturnType<typeof vi.fn>;
const identidade = resolveIdentity as unknown as ReturnType<typeof vi.fn>;

/**
 * Os três testes que chegam ao `invoke` do grafo precisam do checkpointer real
 * (Postgres). Pulam sem `DATABASE_URL` para que `npm test` continue verde em
 * quem não tem o banco de teste — mesmo gate dos `*.integration.test.ts`.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const itDb = hasDb ? it : it.skip;

const CANDIDATO = {
  orgId: "org1",
  orgName: "RE/MAX Trio",
  kind: "user" as const,
  userId: "u1",
  userName: "Marcia",
};

function midia(kind: "audio" | "image", over: Record<string, unknown> = {}) {
  return {
    messageId: "m1",
    fromPhone: "5511987654321",
    groupId: null,
    kind,
    text: null,
    mediaUrl: "https://media.z-api.io/abc",
    mimeType: kind === "audio" ? "audio/ogg; codecs=opus" : "image/jpeg",
    timestampMs: null,
    senderName: "Marcia",
    replyToMessageId: null,
    ...over,
  } as Parameters<typeof runTurn>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  identidade.mockResolvedValue({ kind: "identified", candidate: CANDIDATO });
  baixar.mockResolvedValue({ data: Buffer.from("bytes"), contentType: "audio/ogg" });
  transcrever.mockResolvedValue("o contrato do Fulano já saiu?");
});

describe("mídia vira o turno da pessoa", () => {
  itDb("áudio é baixado e transcrito com a org já resolvida", async () => {
    await runTurn(midia("audio"));

    expect(baixar).toHaveBeenCalledWith("https://media.z-api.io/abc");
    expect(transcrever).toHaveBeenCalledWith(
      "org1",
      expect.objectContaining({ kind: "audio", mimeType: "audio/ogg; codecs=opus" })
    );
  }, 30_000);

  itDb("imagem segue o mesmo caminho", async () => {
    transcrever.mockResolvedValue("Uma matrícula de imóvel.");
    await runTurn(midia("image"));

    expect(transcrever).toHaveBeenCalledWith(
      "org1",
      expect.objectContaining({ kind: "image" })
    );
  }, 30_000);

  /**
   * Silêncio é o pior resultado: no WhatsApp a pessoa não distingue "ignorou"
   * de "não chegou", e fica esperando resposta de algo que o agente nunca teve.
   */
  it("download falho vira aviso, não silêncio", async () => {
    baixar.mockResolvedValue(null);

    const { reply } = await runTurn(midia("audio"));

    expect(reply).toContain("Não consegui ouvir");
    expect(transcrever).not.toHaveBeenCalled();
  });

  it("transcrição falha vira aviso, com o verbo certo pra imagem", async () => {
    transcrever.mockResolvedValue(null);

    expect((await runTurn(midia("audio"))).reply).toContain("Não consegui ouvir");
    expect((await runTurn(midia("image"))).reply).toContain("Não consegui ver");
  });

  it("mensagem sem mediaUrl não tenta baixar", async () => {
    const { reply } = await runTurn(midia("audio", { mediaUrl: null }));

    expect(baixar).not.toHaveBeenCalled();
    expect(reply).toContain("Não consegui ouvir");
  });

  /**
   * Áudio com legenda: o texto digitado ganha. Transcrever seria pagar modelo
   * para obter o que a pessoa já escreveu.
   */
  itDb("mídia COM texto usa o texto e não transcreve", async () => {
    await runTurn(midia("audio", { text: "e aí, saiu?" }));

    expect(transcrever).not.toHaveBeenCalled();
  }, 30_000);

  /**
   * A transcrição roda no ImobPro com o token DE UMA org. Enquanto não se sabe
   * qual, mandar o áudio entregaria o conteúdo de alguém a uma imobiliária que
   * pode não ser a dele.
   */
  it("org ainda indefinida: pede por escrito e NÃO transcreve", async () => {
    identidade.mockResolvedValue({
      kind: "pending",
      candidates: [CANDIDATO, { ...CANDIDATO, orgId: "org2", orgName: "RE/MAX Ace" }],
    });

    const { reply } = await runTurn(midia("audio"));

    expect(reply).toContain("por escrito");
    expect(transcrever).not.toHaveBeenCalled();
    expect(baixar).not.toHaveBeenCalled();
  });

  it("número desconhecido não gasta transcrição", async () => {
    identidade.mockResolvedValue({ kind: "unknown" });

    await runTurn(midia("audio"));

    expect(baixar).not.toHaveBeenCalled();
    expect(transcrever).not.toHaveBeenCalled();
  });
});

describe("prompt de turn vindo de mídia", () => {
  const base = { orgName: "RE/MAX Trio", hits: [] };

  it("manda reafirmar o entendido quando veio de áudio", () => {
    const p = buildSystemPrompt({ ...base, fromMedia: "audio" });
    expect(p).toContain("ÁUDIO");
    expect(p).toContain("reafirmando");
  });

  it("e quando veio de imagem", () => {
    const p = buildSystemPrompt({ ...base, fromMedia: "image" });
    expect(p).toContain("IMAGEM");
  });

  it("turn digitado não recebe a instrução", () => {
    const p = buildSystemPrompt({ ...base, fromMedia: null });
    expect(p).not.toContain("reafirmando");
  });

  /**
   * A instrução é por TURN, então fica no bloco volátil — depois do nome da
   * org, que é o fim do prefixo estável que o cache do provedor reaproveita.
   */
  it("entra depois do bloco estável, pra não derrubar o cache", () => {
    const p = buildSystemPrompt({ ...base, fromMedia: "audio" });
    expect(p.indexOf("Você atende a")).toBeLessThan(p.indexOf("ÁUDIO"));
  });
});
