import { vi } from "vitest";

/**
 * Simulados dos evals dos formulários v2. Rodam ANTES de cada arquivo `*.eval.ts` (setupFiles), então
 * o grafo importado depois já enxerga só estes módulos: nada de rede, de banco, de modelo ou de chave.
 * O cofre dos lidos (`MAX_ENCRYPTION_KEY`) recebe uma chave sintética: não é segredo.
 */
process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

vi.mock("@langchain/langgraph-checkpoint-postgres", async () => {
  const { MemorySaver } = await import("@langchain/langgraph");
  return {
    PostgresSaver: class extends MemorySaver {
      async setup() {}
    },
  };
});
vi.mock("@/lib/db", async (orig) => ({
  ...(await orig<typeof import("@/lib/db")>()),
  checkpointerPool: vi.fn(),
}));
vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  fetchProfile: vi.fn(),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  transcribeMedia: vi.fn().mockResolvedValue(null),
  lerDocumento: vi.fn(),
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
  linhaEnviada: vi.fn().mockResolvedValue(false),
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
vi.mock("@/lib/aceite", () => ({
  interceptar: vi.fn().mockResolvedValue(null),
  repassarDesconhecido: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/turnlog", async (orig) => ({
  ...(await orig<typeof import("@/lib/turnlog")>()),
  registrarTurn: vi.fn().mockResolvedValue(undefined),
}));
