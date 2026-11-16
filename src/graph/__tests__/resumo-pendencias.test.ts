import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * Bug medido em produção (16/11/2026): "quais são minhas pendências de hoje?" voltou
 * "hoje tenho **4 pendências** no total" para 4 NEGÓCIOS com formulário pendente (23 campos),
 * omitiu a atividade atrasada e falou em primeira pessoa. A resposta passou a ser montada pelo
 * código a partir do resultado do `pending.summary`, sem o modelo (como o Newton já faz).
 */

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn(),
  chaveDePolitica: vi.fn().mockResolvedValue("corretor"),
}));
vi.mock("@/lib/scope", async (orig) => ({ ...(await orig<typeof import("@/lib/scope")>()), consultarEscopo: vi.fn() }));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));

const { buildGraph, RESET_DO_TURN } = await import("../graph");
const { fetchProfile } = await import("@/lib/cm");
const { consultarEscopo } = await import("@/lib/scope");
const { complete } = await import("@/lib/llm");
const { renderizarResumoDePendencias, diasDeAtraso } = await import("../resumo-pendencias");
const profile = vi.mocked(fetchProfile);
const scope = vi.mocked(consultarEscopo);
const llm = vi.mocked(complete);

const AGORA = new Date("2026-11-16T15:00:00.000Z"); // 12:00 em São Paulo
const identity = { kind: "user" as const, orgId: "qa-org", orgName: "QA", userId: "u1", userName: "Corretor" };
const usage = { model: "test", promptTokens: 5, completionTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, generationId: null, latencyMs: 1, success: true };
const turn = (text: string) =>
  ({
    ...RESET_DO_TURN,
    identity,
    inbound: { fromPhone: "+5511999063228", text, messageId: crypto.randomUUID(), kind: "text", timestampMs: Date.now(), groupId: null, mediaUrl: null, mimeType: null, senderName: "QA", replyToMessageId: null },
  }) as never;

const form = (dealTitle: string, total: number) => ({ formId: `f-${dealTitle}`, dealId: `d-${dealTitle}`, dealTitle, total, itens: ["CPF", "Endereço"] });
const resumoDaProducao = () => ({
  formularios: {
    total: 4,
    itens: [form("Negocio - cmuyoyxr", 7), form("Negocio - cmuzkv16", 7), form("Proposta — Letícia Gonçalves", 5), form("TESTE vistorias 22-10 (smoke laudo + unificar PDFs)", 4)],
  },
  propostas: { total: 0, itens: [] },
  atividades: {
    total: 1,
    atrasadas: 1,
    hoje: 0,
    itens: [{ activityId: "a1", title: "TESTE pendências — lembrete e relatório", dealId: "d1", dealTitle: "TESTE pendências", whenLabel: "sáb, 25/10", atrasada: true }],
  },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AGORA);
  vi.clearAllMocks();
  llm.mockReset();
  scope.mockReset();
  profile.mockReset();
  profile.mockResolvedValue({ enabled: true, maxPolicy: { byRole: { corretor: ["pending.summary"] } } } as never);
});
afterEach(() => vi.useRealTimers());

describe("resumo de pendências: o que o usuário lê", () => {
  it("reproduz a produção: negócios com formulário não são 'pendências', e a atividade atrasada aparece", async () => {
    llm
      .mockResolvedValueOnce({ text: "", toolCalls: [{ name: "minhas_pendencias", args: {} }], usage })
      // O que o modelo escreveu em produção: errado nos três pontos.
      .mockResolvedValueOnce({
        text: "João, hoje tenho **4 pendências** no total.\n\n• Negocio - cmuyoyxr — 7 pendências\n• Negocio - cmuzkv16 — 7 pendências",
        toolCalls: [],
        usage,
      });
    scope.mockResolvedValue({ items: [resumoDaProducao()], truncated: false });

    const state = await buildGraph().compile().invoke(turn("quais são minhas pendências de hoje?"));
    const reply = String(state.reply);

    expect(llm).toHaveBeenCalledTimes(1); // só a decisão da tool; o texto é do sistema
    expect(reply).toMatch(/4 negócios com formulário/);
    expect(reply).not.toMatch(/4 pend[êe]ncias/i);
    expect(reply).toMatch(/Atrasadas \(1\)/);
    expect(reply).toContain("TESTE pendências — lembrete e relatório");
    expect(reply).toMatch(/atrasada há 22 dias/);
    expect(reply).toContain("Negocio - cmuyoyxr");
    expect(reply).toMatch(/Você tem/);
    expect(reply).not.toMatch(/\btenho\b|\*\*/);
  });

  it("falha na consulta não vira 'nada pendente'", async () => {
    llm.mockResolvedValueOnce({ text: "", toolCalls: [{ name: "minhas_pendencias", args: {} }], usage });
    scope.mockResolvedValue(null);
    const state = await buildGraph().compile().invoke(turn("quais são minhas pendências?"));
    expect(llm).toHaveBeenCalledTimes(1);
    expect(state.reply).toMatch(/Não consegui/);
    expect(state.reply).not.toMatch(/nenhuma pend/i);
  });

  it("sem permissão não vira 'nada pendente'", async () => {
    llm.mockResolvedValueOnce({ text: "", toolCalls: [{ name: "minhas_pendencias", args: {} }], usage });
    scope.mockResolvedValue({ items: [], truncated: false });
    const state = await buildGraph().compile().invoke(turn("quais são minhas pendências?"));
    expect(llm).toHaveBeenCalledTimes(1);
    expect(state.reply).toMatch(/não consigo mostrar pend/i);
    expect(state.reply).not.toMatch(/nenhuma pend/i);
  });
});

describe("renderizarResumoDePendencias", () => {
  const agora = AGORA.getTime();
  const vazio = { formularios: { total: 0, itens: [] }, propostas: { total: 0, itens: [] }, atividades: { total: 0, atrasadas: 0, hoje: 0, itens: [] } };

  it("separa atrasadas, hoje e próximos dias, com o atraso por extenso", () => {
    const t = renderizarResumoDePendencias(
      {
        ...vazio,
        atividades: {
          total: 4,
          atrasadas: 2,
          hoje: 1,
          itens: [
            { activityId: "1", title: "TESTE ligar", dealId: "d", dealTitle: "TESTE A", whenLabel: "sáb, 25/10", atrasada: true },
            { activityId: "2", title: "TESTE visita", dealId: "d", dealTitle: "TESTE A", whenLabel: "dom, 16/11, 09:00", atrasada: true },
            { activityId: "3", title: "TESTE reunião", dealId: "d", dealTitle: "TESTE B", whenLabel: "hoje, 16/11 15:30", atrasada: false },
            { activityId: "4", title: "TESTE assinatura", dealId: "d", dealTitle: "TESTE C", whenLabel: "qui, 19/11", atrasada: false },
          ],
        },
      },
      { agora },
    );
    expect(t).toMatch(/Atrasadas \(2\)/);
    expect(t).toMatch(/TESTE ligar.*atrasada há 22 dias/);
    expect(t).toMatch(/TESTE visita.*venceu hoje/);
    expect(t).toMatch(/Hoje \(1\)/);
    expect(t).toMatch(/TESTE reunião.*15:30/);
    expect(t).toMatch(/Próximos dias \(1\)/);
    expect(t).toMatch(/TESTE assinatura.*qui, 19\/11/);
  });

  it("conta de atraso: 1 dia no singular e virada de ano", () => {
    expect(diasDeAtraso("dom, 15/11", agora)).toBe(1);
    expect(diasDeAtraso("qua, 31/12", new Date("2027-01-02T15:00:00Z").getTime())).toBe(2);
    expect(diasDeAtraso("hoje, 16/11 09:00", agora)).toBe(0);
    expect(diasDeAtraso("lixo", agora)).toBeNull();
    const t = renderizarResumoDePendencias(
      { ...vazio, atividades: { total: 1, atrasadas: 1, hoje: 0, itens: [{ activityId: "1", title: "TESTE x", dealId: "d", dealTitle: "TESTE", whenLabel: "dom, 15/11", atrasada: true }] } },
      { agora },
    );
    expect(t).toContain("atrasada há 1 dia");
    expect(t).not.toContain("1 dias");
  });

  it("o dia de hoje vem do fuso de São Paulo, não do UTC", () => {
    // 01:00 UTC de 17/11 ainda é 22:00 de 16/11 em São Paulo.
    const tarde = new Date("2026-11-17T01:00:00.000Z").getTime();
    expect(diasDeAtraso("dom, 15/11", tarde)).toBe(1);
  });

  it("nada pendente diz isso, em segunda pessoa", () => {
    const t = renderizarResumoDePendencias(vazio, { agora });
    expect(t).toMatch(/Você não tem/);
  });

  it("filtro: só o bloco pedido, sem 'nenhuma' para o que não foi consultado", () => {
    const t = renderizarResumoDePendencias(resumoDaProducao(), { agora, blocos: ["atividades"] });
    expect(t).toContain("TESTE pendências");
    expect(t).not.toContain("Negocio - cmuyoyxr");
    expect(t).not.toMatch(/formul/i);
  });

  it("total maior que o mostrado diz 'e mais N'; propostas com código e status", () => {
    const t = renderizarResumoDePendencias(
      {
        ...vazio,
        propostas: { total: 7, itens: [{ proposalId: "p", codigo: "PROP-2026-0001", dealTitle: "TESTE casa", status: "enviada" }] },
      },
      { agora },
    );
    expect(t).toMatch(/7 propostas em andamento/);
    expect(t).toContain("PROP-2026-0001");
    expect(t).toMatch(/e mais 6/);
  });

  it("avisos: indisponível não vira 'sem avisos'", () => {
    const t = renderizarResumoDePendencias({ ...vazio, avisos: { disponivel: false, total: 0, itens: [] } }, { agora });
    expect(t).toMatch(/avisos não estão disponíveis/i);
    expect(t).not.toMatch(/nenhum aviso/i);
  });
});
