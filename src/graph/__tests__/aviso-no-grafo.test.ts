import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Aviso } from "@/lib/aviso/schema";

/**
 * Botão de AVISO (`av:`, M6) no GRAFO: o roteador entra no `conduzir` antes do
 * `atv:`, sem modelo. Mesmo padrão de mocks do `atividades-no-grafo.test.ts`;
 * a linha da outbox vem de um espião em `dadosDoAviso` (sem banco) e a reação
 * é um mock do transporte (nada vai para a Meta).
 */

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn(),
  reportUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));
vi.mock("@/lib/acao", async (orig) => ({ ...(await orig<typeof import("@/lib/acao")>()), executarAcao: vi.fn() }));
vi.mock("@/lib/scope", async (orig) => ({ ...(await orig<typeof import("@/lib/scope")>()), consultarEscopo: vi.fn() }));
vi.mock("@/lib/transport", async (orig) => ({
  ...(await orig<typeof import("@/lib/transport")>()),
  sendReaction: vi.fn().mockResolvedValue(true),
}));

const { buildGraph } = await import("../graph");
const { fetchProfile, searchKnowledge } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { executarAcao } = await import("@/lib/acao");
const { consultarEscopo } = await import("@/lib/scope");
const { sendReaction } = await import("@/lib/transport");
const { dadosDoAviso } = await import("@/lib/aviso-botao");

const llm = complete as unknown as ReturnType<typeof vi.fn>;
const acao = executarAcao as unknown as ReturnType<typeof vi.fn>;
const leitura = consultarEscopo as unknown as ReturnType<typeof vi.fn>;
const reacao = sendReaction as unknown as ReturnType<typeof vi.fn>;

const FONE = "5511987654321";
const usuario = { orgId: "org1", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };
const COM = { byRole: { "*": ["deal.list", "activity.list", "activity.write", "form.create"] }, byRecipient: {}, brokerDefault: ["deal.list"] };

const AVISO: Aviso = {
  v: 1,
  evento: "form_reminder",
  nivel: "B",
  emoji: "⏳",
  titulo: "Formulário aguardando",
  negocio: "Venda Apto 302",
  frase: "O formulário ainda não foi preenchido.",
  itens: [],
  itensExtras: 0,
  link: { rotulo: "Ver formulário", url: "https://trio.imobpro.ia.br/deals/cmx1" },
  acoes: [{ id: "reenviar_link", alvoId: "f1" }, { id: "concluir", alvoId: "atv_1" }, { id: "ver_formulario" }],
  forma: "botoes",
};

function run(text: string, state: Record<string, unknown> = {}, messageId = "m1", buttonPayload: string | null = null) {
  return buildGraph().compile().invoke({
    inbound: { messageId, fromPhone: FONE, groupId: null, kind: "text" as const, text, mediaUrl: null,
      mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null, buttonPayload },
    identity: usuario, reply: null, halt: null, propostaDescartada: false, ...state,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: COM } as never);
  vi.mocked(searchKnowledge).mockResolvedValue([]);
  reacao.mockResolvedValue(true);
  vi.spyOn(dadosDoAviso, "carregar").mockImplementation(async (id) =>
    id === "row1"
      ? {
          id: "row1", org_id: "org1", phone: FONE, audience: "platform_user", status: "sent", deal_id: "deal1",
          sent_at: new Date(Date.now() - 60 * 60_000), aviso: AVISO, recipient_name: "Olavo", title: "t", body: "b",
          link_url: AVISO.link!.url, org_name: "FINCasa", kind: "form_reminder", params: null,
        }
      : null
  );
  vi.spyOn(dadosDoAviso, "reivindicar").mockResolvedValue(true);
  vi.spyOn(dadosDoAviso, "liberar").mockResolvedValue(undefined);
});

describe("botão av: no grafo", () => {
  it("reenviar_link: executa form.remind com a messageId do toque, reage ✅ e não chama o modelo", async () => {
    acao.mockResolvedValue({ status: 200, body: { ok: true } });
    const s = await run("📨 Reenviar link", {}, "wamid.T1", "av:row1:reenviar_link");
    expect(acao).toHaveBeenCalledWith(
      expect.objectContaining({ verb: "form.remind", args: { deal_id: "deal1", form_id: "f1" }, idempotencyKey: "wamid.T1" })
    );
    expect(s.reply).toContain("Reenviei o link");
    expect(reacao).toHaveBeenCalledWith({ to: FONE, messageId: "wamid.T1", emoji: "✅" });
    expect(llm).not.toHaveBeenCalled();
  });

  it("link: devolve a linha 👉 sem escrever nada", async () => {
    const s = await run("🔗 Ver formulário", {}, "m1", "av:row1:ver_formulario");
    expect(s.reply).toBe("👉 Ver formulário: https://trio.imobpro.ia.br/deals/cmx1");
    expect(acao).not.toHaveBeenCalled();
    expect(reacao).not.toHaveBeenCalled();
  });

  it("aviso de outra linha ou inexistente: resposta neutra, sem modelo", async () => {
    const s = await run("x", {}, "m1", "av:nao_existe:reenviar_link");
    expect(s.reply).toBe("Não encontrei esse aviso. Nada foi alterado.");
    expect(acao).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
  });

  it("concluir: segue o fluxo de atividade de hoje (propõe, ainda pede SIM)", async () => {
    leitura.mockResolvedValue({ items: [{ id: "atv_1", titulo: "Ligar para o João" }], truncated: false });
    const s = await run("✅ Concluir", {}, "m-toque", "av:row1:concluir");
    expect(leitura).toHaveBeenCalledWith(expect.objectContaining({ verb: "activity.get", args: { atividade_id: "atv_1" } }));
    expect(s.fluxo).toMatchObject({ kind: "atividade", operacao: "concluir", etapa: "confirmacao" });
    expect(acao).not.toHaveBeenCalled();
    expect(reacao).not.toHaveBeenCalled();
  });

  it("escrita incerta em aberto: concluir pede para terminar antes; a ação direta segue e o fluxo fica", async () => {
    leitura.mockResolvedValue({ items: [{ id: "atv_1", titulo: "Ligar" }], truncated: false });
    const toque = await run("Concluir", {}, "m1", "atv:atv_1:concluir");
    acao.mockResolvedValueOnce(null);
    const incerto = await run("sim", { fluxo: toque.fluxo }, "m-a");
    expect(incerto.fluxo).toMatchObject({ chave: { valor: "m-a" } });
    acao.mockClear();
    leitura.mockClear();

    const bloqueado = await run("✅ Concluir", { fluxo: incerto.fluxo }, "m2", "av:row1:concluir");
    expect(bloqueado.reply).toContain("Responda SIM para eu conferir");
    expect(leitura).not.toHaveBeenCalled();

    acao.mockResolvedValue({ status: 200, body: { ok: true } });
    const direta = await run("📨 Reenviar link", { fluxo: incerto.fluxo }, "m3", "av:row1:reenviar_link");
    expect(direta.reply).toContain("Reenviei o link");
    // O fluxo com a chave da escrita incerta não foi tocado (o retorno não o substitui).
    expect(direta.fluxo).toMatchObject({ chave: { valor: "m-a" } });
  });

  it("o payload av: não vira dúvida nem é tratado pelo aceite", async () => {
    acao.mockResolvedValue({ status: 200, body: { ok: true } });
    const s = await run("📨 Reenviar link", {}, "m1", "av:row1:reenviar_link");
    expect(s.reply).not.toMatch(/d[úu]vida/i);
  });
});
