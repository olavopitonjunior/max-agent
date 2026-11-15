import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A mídia do Newton chega como `zapi:<url>`, e a URL é link não adivinhável
 * para documento de cliente. O checkpoint do grafo guarda o `inbound`: com
 * legenda a mensagem entra no grafo (`image`/`document` + texto), e a URL ia
 * junto para o banco. O download acontece ANTES do `invoke`, então o grafo não
 * precisa dela: a referência é zerada na borda, o resto do `inbound` fica.
 */

const memoria = vi.hoisted(() => ({ saver: null as unknown }));

vi.mock("@langchain/langgraph-checkpoint-postgres", async () => {
  const { MemorySaver } = await import("@langchain/langgraph");
  class PostgresSaver extends MemorySaver {
    constructor() {
      super();
      memoria.saver = this;
    }
    async setup() {}
  }
  return { PostgresSaver };
});
vi.mock("@/lib/db", async (orig) => ({
  ...(await orig<typeof import("@/lib/db")>()),
  checkpointerPool: vi.fn(() => ({})),
}));
vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  fetchProfile: vi.fn().mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: { byRole: { "*": ["proposal.list"] }, byRecipient: {}, brokerDefault: [] } }),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/llm", () => ({
  complete: vi.fn().mockResolvedValue({
    text: "Recebi a legenda.",
    toolCalls: [],
    usage: { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true },
  }),
  DEFAULT_MODEL: "openai/gpt-5.4-nano",
}));

const { invokeIsolatedGraph, inboundParaCheckpoint, getApp } = await import("../graph");

const URL_ZAPI = "zapi:https://media.zapi.example/instances/X/segredo-do-cliente/foto.jpeg";
const identity = { kind: "user" as const, userId: "u1", userName: "Olavo", orgId: "org1", orgName: "Newcore" };

function inbound(extra: Record<string, unknown> = {}) {
  return {
    messageId: "3EB0A1B2C3D4E5F6",
    fromPhone: "5511900000001",
    groupId: null,
    kind: "image" as const,
    text: "segue o RG do comprador",
    mediaUrl: URL_ZAPI,
    mimeType: "image/jpeg",
    timestampMs: 1_700_000_000_000,
    senderName: "Olavo",
    replyToMessageId: null,
    ...extra,
  };
}

describe("inboundParaCheckpoint", () => {
  it("zera a referência zapi: e tira o texto; o resto do inbound fica intacto", () => {
    const base = inbound();
    const r = inboundParaCheckpoint(base);
    expect(r).toEqual({ ...base, text: null, mediaUrl: null });
    expect(base.mediaUrl).toBe(URL_ZAPI); // não muta o original
  });

  it("referência que não é zapi: (meta:<id>) segue como está", () => {
    expect(inboundParaCheckpoint(inbound({ mediaUrl: "meta:123" }))).toMatchObject({ mediaUrl: "meta:123", text: null });
  });

  it("sem mídia: só o texto sai", () => {
    expect(inboundParaCheckpoint(inbound({ kind: "text", mediaUrl: null, mimeType: null }))).toMatchObject({
      kind: "text",
      mediaUrl: null,
      text: null,
    });
  });
});

describe("checkpoint do grafo com mídia do Newton e legenda", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("nenhuma URL zapi: (nem o caminho dela) aparece no estado gravado", async () => {
    const thread = `newton-midia-${Math.random()}`;
    await invokeIsolatedGraph(inbound(), identity, thread);
    const app = await getApp();
    const estado = await app.getState({ configurable: { thread_id: thread } });
    const gravado = JSON.stringify(estado.values);
    expect(gravado).toContain("5511900000001"); // o estado existe e guarda o resto do inbound
    expect(gravado).not.toContain("zapi:");
    expect(gravado).not.toContain("segredo-do-cliente");
    expect(gravado).not.toContain("media.zapi.example");
    expect(estado.values.inbound).toMatchObject({ kind: "image", mimeType: "image/jpeg", text: null, mediaUrl: null });

    // Nada nos checkpoints brutos do saver (inclui as escritas pendentes).
    const saver = memoria.saver as { storage: unknown; writes: unknown };
    const bruto = JSON.stringify([...Object.values(saver.storage as object)].map((v) => Object.values(v as object))) +
      JSON.stringify(saver.writes instanceof Object ? Object.entries(saver.writes as object) : []);
    expect(bruto).not.toContain("segredo-do-cliente");
  });
});

describe("os dois pontos de invoke usam a mesma borda", () => {
  it("graph.ts não monta `{ ...inbound, text: null }` à mão", () => {
    const src = readFileSync(join(__dirname, "..", "graph.ts"), "utf8");
    expect(src).not.toMatch(/\{\s*\.\.\.inbound,\s*text:\s*null\s*\}/);
    expect(src.match(/inbound:\s*inboundParaCheckpoint\(inbound\)/g)).toHaveLength(2);
  });
});
