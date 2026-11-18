import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Prod 10/11/2026 (Max Fincasa, Olavo): depois de `proposta_criada` o fluxo
 * ficava preso em "ajustes". "manda a PROP-2026-0003 pro comprador assinar"
 * virou `proposta_liberada` e o modelo improvisou a pergunta do canal. O envio
 * tem caminho determinístico (métodos, depois o cartão do SIM) e NUNCA sai sem
 * o SIM. Mesmo padrão de mocks do `fluxo-no-grafo.test.ts`.
 */

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn(),
  reportUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));
vi.mock("@/lib/acao", () => ({ executarAcao: vi.fn() }));

const { buildGraph } = await import("../graph");
const { fetchProfile, searchKnowledge } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { executarAcao } = await import("@/lib/acao");

const llm = complete as unknown as ReturnType<typeof vi.fn>;
const acao = executarAcao as unknown as ReturnType<typeof vi.fn>;

const usuario = { orgId: "org1", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };
const POLITICA = {
  byRole: { "*": ["deal.list", "deal.pending", "proposal.list", "proposal.create", "proposal.send"] },
  byRecipient: {},
  brokerDefault: ["deal.list", "deal.pending"],
};
const uso = { model: "openai/gpt-5.4-nano", promptTokens: 10, completionTokens: 5, latencyMs: 5, success: true };

function run(text: string, state: Record<string, unknown> = {}, messageId = "m1") {
  return buildGraph()
    .compile()
    .invoke({
      inbound: {
        messageId,
        fromPhone: "5511987654321",
        groupId: null,
        kind: "text" as const,
        text,
        mediaUrl: null,
        mimeType: null,
        timestampMs: null,
        senderName: "Olavo",
        replyToMessageId: null,
      },
      identity: usuario,
      reply: null,
      halt: null,
      propostaDescartada: false,
      ...state,
    });
}

const rascunho = (codigo: string, id: string) => ({
  kind: "proposta",
  etapa: "ajustes",
  natureza: "venda",
  dados: { proponente: { nome: "Carlos Eduardo TESTE Andrade" }, valor: 1_000_000 },
  propostaId: id,
  codigo,
  atualizadoEm: Date.now(),
});

const OPCOES = {
  status: 200,
  body: {
    assinaturaConfigurada: true,
    metodos: [{ valor: "whatsapp", rotulo: "WhatsApp" }],
    signatarios: [{ nome: "Carlos Eduardo TESTE Andrade", papel: "comprador" }],
  },
};

const verbos = () => acao.mock.calls.map(([p]) => (p as { verb: string }).verb);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: POLITICA } as never);
  vi.mocked(searchKnowledge).mockResolvedValue([]);
});

describe("depois do rascunho (prod 10/11)", () => {
  it("'manda a PROP-X pro comprador assinar' abre o caminho do envio: métodos, cartão do SIM, sem modelo e sem enviar", async () => {
    acao.mockImplementation(async ({ verb }: { verb: string }) => {
      if (verb === "proposal.options") return OPCOES;
      throw new Error(`Ação inesperada: ${verb}`);
    });
    const s = await run("manda a PROP-2026-0003 pro comprador assinar", { fluxo: rascunho("PROP-2026-0003", "p3") });
    expect(verbos()).toEqual(["proposal.options"]);
    expect(verbos()).not.toContain("proposal.send");
    expect(llm).not.toHaveBeenCalled();
    expect(s.fluxo).toMatchObject({ kind: "proposta", etapa: "envio", propostaId: "p3" });
    expect(s.reply).toMatch(/\bSIM\b/);
    expect(s.reply).toContain("Carlos Eduardo TESTE Andrade");
  });

  it("só o SIM envia (o pedido de envio, sozinho, nunca executa)", async () => {
    acao.mockImplementation(async ({ verb }: { verb: string }) => {
      if (verb === "proposal.options") return OPCOES;
      if (verb === "proposal.send") return { status: 200, body: { envelope: { id: "e1" } } };
      throw new Error(`Ação inesperada: ${verb}`);
    });
    const s = await run("manda a PROP-2026-0003 pro comprador assinar", { fluxo: rascunho("PROP-2026-0003", "p3") });
    expect(verbos()).not.toContain("proposal.send");
    await run("sim", { fluxo: s.fluxo }, "sim-envio");
    expect(verbos()).toContain("proposal.send");
  });

  it("citando OUTRA proposta que a do fluxo aberto, retoma pela busca e abre o cartão da citada", async () => {
    acao.mockImplementation(async ({ verb, args }: { verb: string; args: Record<string, unknown> }) => {
      if (verb === "proposal.list") {
        return { status: 200, body: { items: [{ id: "p3", codigo: "PROP-2026-0003", titulo: "Carlos", estado: "rascunho" }], total: 1, busca: args.busca } };
      }
      if (verb === "proposal.options") return OPCOES;
      throw new Error(`Ação inesperada: ${verb}`);
    });
    const s = await run("manda a PROP-2026-0003 pro comprador assinar", { fluxo: rascunho("PROP-2026-0002", "p2") });
    expect(verbos()).toContain("proposal.list");
    expect(verbos()).not.toContain("proposal.send");
    expect(s.fluxo).toMatchObject({ kind: "proposta", propostaId: "p3", etapa: "envio" });
    expect(llm).not.toHaveBeenCalled();
  });

  it("no passo de envio da PROP-2, 'manda a PROP-3' troca para a PROP-3 (e nunca envia sem o SIM)", async () => {
    acao.mockImplementation(async ({ verb, args }: { verb: string; args: Record<string, unknown> }) => {
      if (verb === "proposal.list") {
        return { status: 200, body: { items: [{ id: "p3", codigo: "PROP-2026-0003", titulo: "Carlos", estado: "rascunho" }], total: 1, busca: args.busca } };
      }
      if (verb === "proposal.options") return OPCOES;
      throw new Error(`Ação inesperada: ${verb}`);
    });
    const s = await run("manda a PROP-2026-0003 pro comprador assinar", { fluxo: { ...rascunho("PROP-2026-0002", "p2"), etapa: "envio" } });
    expect(verbos()).toContain("proposal.list");
    expect(verbos()).not.toContain("proposal.send");
    expect(s.fluxo).toMatchObject({ kind: "proposta", propostaId: "p3", etapa: "envio" });
    expect(llm).not.toHaveBeenCalled();
  });

  it("troca de assunto (pendências de um negócio) não é capturada pelo rascunho: o fluxo encerra e o extrator não roda", async () => {
    llm.mockResolvedValue({ text: "Não achei esse negócio. Qual o nome ou código?", toolCalls: [], usage: uso });
    acao.mockImplementation(async () => ({ status: 200, body: { items: [], total: 0 } }));
    const s = await run("quais as pendências do negócio TESTE1?", { fluxo: rascunho("PROP-2026-0003", "p3") });
    expect(s.fluxo ?? null).toBeNull();
    expect(verbos()).not.toContain("proposal.send");
    const extracao = llm.mock.calls.some(([a]) => JSON.stringify(a).includes("extrair_proposta"));
    expect(extracao).toBe(false);
    expect((s.toolLog as { outcome?: string }[]).some((t) => t.outcome === "proposta_encerrada_por_assunto")).toBe(true);
  });
});
