import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * "Quais os tipos de assinatura?", "como funciona a assinatura?" e "como funciona
 * o processo?" são assunto do agente (Max e Newton), não "isso foge do que eu
 * faço". A resposta é TEMPLATE, de uma fonte só (`capacidades.ts`), sem modelo.
 */

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn(),
  reportUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  resolveIdentity: vi.fn(),
}));
vi.mock("@/lib/memory", async (orig) => ({
  ...(await orig<typeof import("@/lib/memory")>()),
  loadFacts: vi.fn().mockResolvedValue({}),
  extractFacts: vi.fn().mockResolvedValue({}),
  saveFacts: vi.fn().mockResolvedValue(0),
}));

const { buildGraph } = await import("../graph");
const { pedeProcessoDeAssinatura, textoDoProcesso, TEXTO_TIPOS_DE_ASSINATURA, TIPOS_DE_ASSINATURA } = await import("../capacidades");
const { TEXTO_FORA_DO_ESCOPO } = await import("../prompt");
const { sanitizar, limitarTamanho } = await import("../compose");
const { fetchProfile, searchKnowledge } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");

const profile = fetchProfile as unknown as ReturnType<typeof vi.fn>;
const search = searchKnowledge as unknown as ReturnType<typeof vi.fn>;
const llm = complete as unknown as ReturnType<typeof vi.fn>;

const identity = { orgId: "org1", orgName: "Newcore", kind: "user" as const, userId: "u1", userName: "Marcia Gerente" };

const TIPOS = ["quais os tipos de assinatura?", "Quais tipos de assinatura existem", "quais as formas de assinatura", "Max, quais são os tipos de assinatura?"];
const PROCESSO = ["como funciona a assinatura?", "Como funciona o processo?", "como funciona o processo de assinatura", "como funciona a assinatura da proposta?"];

describe("detecção", () => {
  it.each(TIPOS)("tipos: %s", (t) => expect(pedeProcessoDeAssinatura(t)).toBe("tipos"));
  it.each(PROCESSO)("processo: %s", (t) => expect(pedeProcessoDeAssinatura(t)).toBe("processo"));
  it.each([
    "envia a proposta da Letícia para assinatura",
    "quem falta assinar a proposta da Ana?",
    "como funciona o formulário do comprador?",
    "como funciona o prompt do sistema?",
    "o contrato já foi assinado?",
    "como mudo o telefone de quem assina?",
  ])("não dispara em: %s", (t) => expect(pedeProcessoDeAssinatura(t)).toBeNull());
});

describe("texto (fonte única)", () => {
  it("lista os 2 tipos do contrato (ClickSign por e-mail e por WhatsApp), sem numerar o Aceite", () => {
    expect(TEXTO_TIPOS_DE_ASSINATURA).toMatch(/1\. E-mail \(ClickSign\)/);
    expect(TEXTO_TIPOS_DE_ASSINATURA).toMatch(/2\. WhatsApp \(ClickSign\).*plano da imobili/);
    expect(TEXTO_TIPOS_DE_ASSINATURA).not.toMatch(/3\./);
  });
  it("o Aceite não é tipo do contrato: vale para propostas e diversos; na captação vai no envio da ClickSign", () => {
    for (const t of [TEXTO_TIPOS_DE_ASSINATURA, textoDoProcesso()]) {
      expect(t).toMatch(/Aceite por WhatsApp vale para propostas e documentos diversos, não para o contrato/);
    }
    expect(TEXTO_TIPOS_DE_ASSINATURA).toMatch(/captação, o aceite vai no mesmo envio da ClickSign/);
    // A frase falsa em todos os casos: a captação e a proposta misturam aceite e ClickSign.
    expect(TEXTO_TIPOS_DE_ASSINATURA).not.toMatch(/sem ClickSign/i);
    expect(textoDoProcesso()).not.toMatch(/sem ClickSign/i);
  });
  it("o processo resume proposta, contrato e assinatura e cita os mesmos tipos (mesma fonte)", () => {
    const t = textoDoProcesso();
    expect(t).toMatch(/proposta/i);
    expect(t).toMatch(/contrato/i);
    expect(t).toMatch(/assinatura/i);
    for (const { rotulo } of TIPOS_DE_ASSINATURA) {
      expect(t).toContain(rotulo);
      expect(TEXTO_TIPOS_DE_ASSINATURA).toContain(rotulo);
    }
    expect(TIPOS_DE_ASSINATURA.map((x) => x.rotulo)).toEqual(["E-mail (ClickSign)", "WhatsApp (ClickSign)"]);
  });
  it.each([TEXTO_TIPOS_DE_ASSINATURA, textoDoProcesso()])("passa pelo sanitizador e pelo teto de tamanho intactos", (t) => {
    expect(t).not.toContain("**");
    expect(t.length).toBeLessThanOrEqual(500);
    expect(t.split("\n").length).toBeLessThanOrEqual(6);
    expect(sanitizar(t).texto).toBe(t);
    expect(limitarTamanho(t).resto).toBeNull();
  });
});

describe.each(["newton", "max"])("no grafo (perfil %s)", (perfil) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AGENT_DEPLOY_PROFILE", perfil);
    profile.mockResolvedValue({ enabled: true, model: "x", maxPolicy: { byRole: { "*": ["proposal.list", "proposal.create"] } } });
    search.mockResolvedValue([]);
    // Se o modelo fosse chamado, ele recusaria — é o defeito observado.
    llm.mockResolvedValue({ text: TEXTO_FORA_DO_ESCOPO, toolCalls: [], usage: { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true } });
  });

  async function run(text: string) {
    const { resolveIdentity } = await import("@/lib/identity");
    (resolveIdentity as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "identified", candidate: identity });
    return buildGraph().compile().invoke({
      inbound: { messageId: "m1", fromPhone: "5511987654321", groupId: null, kind: "text", text, mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Marcia", replyToMessageId: null },
      identity, reply: null, halt: null, draft: null, bloqueios: [],
    });
  }

  it.each(TIPOS)("%s: responde o template, sem modelo e sem 'foge do que eu faço'", async (t) => {
    const r = await run(t);
    expect(r.reply).toBe(TEXTO_TIPOS_DE_ASSINATURA);
    expect(r.reply).not.toContain("foge do que eu faço");
    expect(llm).not.toHaveBeenCalled();
  });

  it.each(PROCESSO)("%s: responde o resumo do processo, sem modelo", async (t) => {
    const r = await run(t);
    expect(r.reply).toBe(textoDoProcesso());
    expect(r.reply).not.toContain("foge do que eu faço");
    expect(llm).not.toHaveBeenCalled();
  });
});
