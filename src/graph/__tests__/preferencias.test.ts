import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Task M3 — a pessoa vê e muda os PRÓPRIOS avisos conversando.
 *
 * O que este arquivo protege, em ordem de gravidade:
 *  1. nada é escrito antes do SIM (a tool só propõe; o PATCH é do fluxo determinístico);
 *  2. sem `prefs.self` a tool não é oferecida nem executa;
 *  3. valor fora das opções do servidor vira resposta com as opções, sem PATCH;
 *  4. `combina` não rouba pedidos de outras tools ("relatório de vendas", "lembra de ligar").
 *
 * A rota do ImobPro (task P8) ainda não existe: o GET e o PATCH são simulados nos mocks de `@/lib/cm`.
 */

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn(),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  lerPreferencias: vi.fn(),
  atualizarPreferencias: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));
vi.mock("@/lib/acao", async (orig) => ({ ...(await orig<typeof import("@/lib/acao")>()), executarAcao: vi.fn() }));
vi.mock("@/lib/scope", async (orig) => ({ ...(await orig<typeof import("@/lib/scope")>()), consultarEscopo: vi.fn() }));

const { buildGraph } = await import("../graph");
const { fetchProfile, searchKnowledge, lerPreferencias, atualizarPreferencias } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { executarAcao } = await import("@/lib/acao");
const { ferramentasDoTurno, pedePreferencias, MINHAS_NOTIFICACOES, MUDAR_MINHAS_NOTIFICACOES } = await import("../tools");
const { despacharLeituras } = await import("../despachante");

const llm = complete as unknown as ReturnType<typeof vi.fn>;
const ler = lerPreferencias as unknown as ReturnType<typeof vi.fn>;
const patchar = atualizarPreferencias as unknown as ReturnType<typeof vi.fn>;
const acao = executarAcao as unknown as ReturnType<typeof vi.fn>;

const usuario = { orgId: "org1", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };
const corretor = { orgId: "org1", orgName: "FINCasa", kind: "broker" as const, splitRecipientId: "sr1", label: "Wesley" };
const COM = { byRole: { "*": ["deal.list", "prefs.self"] }, byRecipient: {}, brokerDefault: ["deal.list"] };
const SEM = { byRole: { "*": ["deal.list"] }, byRecipient: {}, brokerDefault: ["deal.list"] };
const uso = { model: "openai/gpt-5.4-nano", promptTokens: 10, completionTokens: 5, latencyMs: 5, success: true };

const HORARIOS = Array.from({ length: 30 }, (_, i) => {
  const min = 7 * 60 + i * 30;
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${min % 60 === 0 ? "00" : "30"}`;
});

/** O que o GET devolve (contrato da task P8). */
const VIEW = {
  prefs: { types: { activity_due: { email: true, whatsapp: false } }, schedule: { morningReportAt: "08:00" } },
  defaults: { morningReportAt: "08:00", dueSoonLeadMin: 120 },
  options: { morningReport: HORARIOS, dueSoon: [30, 60, 120, 240, 1440] },
  tipos: [
    { type: "activity_due", label: "Relatório da manhã (formulários e atividades)" },
    { type: "activity_due_soon", label: "Lembrete antes do vencimento" },
    { type: "activity_completed", label: "Conclusão de atividade" },
  ],
};

function run(text: string, state: Record<string, unknown> = {}, messageId = "m1", identity: typeof usuario | typeof corretor = usuario) {
  return buildGraph().compile().invoke({
    inbound: { messageId, fromPhone: "5511987654321", groupId: null, kind: "text" as const, text, mediaUrl: null,
      mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null, buttonPayload: null },
    identity, reply: null, halt: null, propostaDescartada: false, ...state,
  });
}

function chamada(args: Record<string, unknown>) {
  return { text: "", toolCalls: [{ name: "mudar_minhas_notificacoes", args }], usage: uso };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: COM } as never);
  vi.mocked(searchKnowledge).mockResolvedValue([]);
  ler.mockResolvedValue(VIEW);
});

describe("mudar_minhas_notificacoes no grafo", () => {
  it("'não quero mais o relatório': só propõe; o PATCH sai depois do SIM, com os dois canais desligados", async () => {
    llm.mockResolvedValue(chamada({ avisos: [{ tipo: "relatorio_manha", ativo: false }] }));
    const prop = await run("não quero mais o relatório da manhã");
    expect(prop.fluxo).toMatchObject({ kind: "preferencias", etapa: "confirmacao" });
    expect(prop.reply).toContain("Relatório da manhã");
    expect(prop.reply).toContain("Confirma?");
    expect(patchar).not.toHaveBeenCalled();
    expect(acao).not.toHaveBeenCalled();

    patchar.mockResolvedValue({ ok: true, prefs: {}, whatsappOptIn: "unchanged" });
    llm.mockClear();
    const fim = await run("sim", { fluxo: prop.fluxo }, "m2");
    expect(patchar).toHaveBeenCalledTimes(1);
    expect(patchar).toHaveBeenCalledWith({
      orgId: "org1",
      rawPhone: "5511987654321",
      patch: { types: { activity_due: { email: false, whatsapp: false } } },
    });
    expect(fim.reply).toContain("Pronto");
    expect(fim.fluxo ?? null).toBeNull();
    expect(llm).not.toHaveBeenCalled();
  });

  it("'me lembra 1 hora antes': antecedência 60, sem tocar em canal nem horário", async () => {
    llm.mockResolvedValue(chamada({ antecedencia_lembrete_min: 60 }));
    const prop = await run("me lembra 1 hora antes do vencimento");
    expect(prop.fluxo).toMatchObject({ kind: "preferencias", patch: { schedule: { dueSoonLeadMin: 60 } } });
    expect((prop.fluxo as unknown as { patch: Record<string, unknown> }).patch).not.toHaveProperty("types");
    expect(patchar).not.toHaveBeenCalled();

    patchar.mockResolvedValue({ ok: true, prefs: {}, whatsappOptIn: "unchanged" });
    await run("sim", { fluxo: prop.fluxo }, "m2");
    expect(patchar).toHaveBeenCalledWith(expect.objectContaining({ patch: { schedule: { dueSoonLeadMin: 60 } } }));
  });

  it("horário válido: 'às 9h' vira 09:00 no PATCH", async () => {
    llm.mockResolvedValue(chamada({ horario_relatorio: "9h" }));
    const prop = await run("manda o relatório da manhã às 9h");
    expect(prop.fluxo).toMatchObject({ patch: { schedule: { morningReportAt: "09:00" } } });
    expect(patchar).not.toHaveBeenCalled();
  });

  it("'manda às 6h': 6h está fora das opções; responde com as opções e não chama o PATCH", async () => {
    llm.mockResolvedValue(chamada({ horario_relatorio: "06:00" }));
    const r = await run("manda o relatório da manhã às 6h");
    expect(r.fluxo ?? null).toBeNull();
    expect(r.reply).toContain("06:00");
    expect(r.reply).toContain("07:00");
    expect(r.reply).toContain("21:30");
    expect(r.reply).toContain("Nada foi alterado");
    expect(patchar).not.toHaveBeenCalled();
  });

  it("antecedência fora das opções: lista as opções e não escreve", async () => {
    llm.mockResolvedValue(chamada({ antecedencia_lembrete_min: 45 }));
    const r = await run("me avisa 45 minutos antes do vencimento");
    expect(r.fluxo ?? null).toBeNull();
    expect(r.reply).toContain("Nada foi alterado");
    expect(patchar).not.toHaveBeenCalled();
  });

  it("canal não dito: pergunta o canal, em vez de ligar o WhatsApp por conta própria", async () => {
    llm.mockResolvedValue(chamada({ avisos: [{ tipo: "lembrete_vencimento", ativo: true }] }));
    const r = await run("quero receber o lembrete antes do vencimento");
    expect(r.fluxo ?? null).toBeNull();
    expect(r.reply).toMatch(/e-mail|WhatsApp/);
    expect(patchar).not.toHaveBeenCalled();
  });

  it("ligar o WhatsApp avisa do aceite no resumo", async () => {
    llm.mockResolvedValue(chamada({ avisos: [{ tipo: "relatorio_manha", whatsapp: true }] }));
    const r = await run("quero receber o relatório da manhã no whatsapp");
    expect(r.fluxo).toMatchObject({ patch: { types: { activity_due: { whatsapp: true } } } });
    expect(r.reply).toContain("WhatsApp");
    expect(r.reply).toContain("autoriza");
  });

  it("NÃO cancela: nada é escrito e o fluxo acaba", async () => {
    llm.mockResolvedValue(chamada({ avisos: [{ tipo: "relatorio_manha", ativo: false }] }));
    const prop = await run("não quero mais o relatório da manhã");
    const r = await run("não", { fluxo: prop.fluxo }, "m2");
    expect(r.reply).toContain("Nada foi alterado");
    expect(r.fluxo ?? null).toBeNull();
    expect(patchar).not.toHaveBeenCalled();
  });

  it("interrupção rebaixa o fluxo: um SIM solto só reapresenta o resumo", async () => {
    llm.mockResolvedValue(chamada({ avisos: [{ tipo: "relatorio_manha", ativo: false }] }));
    const prop = await run("não quero mais o relatório da manhã");
    const rebaixado = { ...(prop.fluxo as object), etapa: "resumo" };
    const r = await run("sim", { fluxo: rebaixado }, "m2");
    expect(patchar).not.toHaveBeenCalled();
    expect(r.reply).toContain("Confirma?");
    expect(r.fluxo).toMatchObject({ kind: "preferencias", etapa: "confirmacao" });
  });

  it("resultado incerto: segura o fluxo e o próximo SIM repete o mesmo PATCH", async () => {
    llm.mockResolvedValue(chamada({ antecedencia_lembrete_min: 60 }));
    const prop = await run("me lembra 1 hora antes do vencimento");
    patchar.mockResolvedValueOnce(null);
    const incerto = await run("sim", { fluxo: prop.fluxo }, "m2");
    expect(incerto.reply).toContain("Ainda não confirmei");
    expect(incerto.fluxo).toMatchObject({ kind: "preferencias", etapa: "confirmacao" });

    patchar.mockResolvedValueOnce({ ok: true, prefs: {}, whatsappOptIn: "unchanged" });
    const fim = await run("sim", { fluxo: incerto.fluxo }, "m3");
    expect(patchar).toHaveBeenCalledTimes(2);
    expect(patchar.mock.calls[1][0]).toEqual(patchar.mock.calls[0][0]);
    expect(fim.fluxo ?? null).toBeNull();
  });

  it("422 do servidor: devolve o que é permitido e não finge sucesso", async () => {
    llm.mockResolvedValue(chamada({ antecedencia_lembrete_min: 60 }));
    const prop = await run("me lembra 1 hora antes do vencimento");
    patchar.mockResolvedValueOnce({ ok: false, code: "valor_invalido", allowed: [30, 120], subject: "u1" });
    const r = await run("sim", { fluxo: prop.fluxo }, "m2");
    expect(r.reply).toContain("não aceitou");
    expect(r.reply).toContain("Nada foi alterado");
    expect(r.fluxo ?? null).toBeNull();
  });

  it("opt-in do WhatsApp registrado vem no texto final", async () => {
    llm.mockResolvedValue(chamada({ avisos: [{ tipo: "relatorio_manha", whatsapp: true }] }));
    const prop = await run("quero receber o relatório da manhã no whatsapp");
    patchar.mockResolvedValueOnce({ ok: true, prefs: {}, whatsappOptIn: "set" });
    const r = await run("sim", { fluxo: prop.fluxo }, "m2");
    expect(r.reply).toContain("aceite");
  });

  it("GET fora do ar: nada é proposto nem escrito", async () => {
    ler.mockResolvedValue(null);
    llm.mockResolvedValue(chamada({ avisos: [{ tipo: "relatorio_manha", ativo: false }] }));
    const r = await run("não quero mais o relatório da manhã");
    expect(r.fluxo ?? null).toBeNull();
    expect(r.reply).toContain("Nada foi alterado");
    expect(patchar).not.toHaveBeenCalled();
  });

  it("NEGADO: sem prefs.self a tool não é oferecida e nada é lido nem escrito", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: SEM } as never);
    llm.mockResolvedValue(chamada({ avisos: [{ tipo: "relatorio_manha", ativo: false }] }));
    const r = await run("não quero mais o relatório da manhã");
    expect(r.fluxo ?? null).toBeNull();
    expect(ler).not.toHaveBeenCalled();
    expect(patchar).not.toHaveBeenCalled();
    const ofertadas = (llm.mock.calls[0]?.[0]?.tools ?? []).map((t: { name: string }) => t.name);
    expect(ofertadas).not.toContain("mudar_minhas_notificacoes");
    expect(ofertadas).not.toContain("minhas_notificacoes");
  });

  it("corretor (não usuário) nunca mexe em aviso, mesmo com a política concedendo", async () => {
    llm.mockResolvedValue(chamada({ avisos: [{ tipo: "relatorio_manha", ativo: false }] }));
    const r = await run("não quero mais o relatório da manhã", {}, "m1", corretor);
    expect(r.fluxo ?? null).toBeNull();
    expect(patchar).not.toHaveBeenCalled();
    expect(ler).not.toHaveBeenCalled();
  });
});

describe("oferta das tools de aviso", () => {
  const identity = usuario;
  const nomes = (texto: string, policy: string[], id: unknown = identity) =>
    ferramentasDoTurno({ policy: policy as never, texto, identity: id as never }).entradas.map((t) => t.nome);

  it("com prefs.self e o texto certo, as duas tools são oferecidas", () => {
    const n = nomes("não quero mais o relatório da manhã", ["prefs.self"]);
    expect(n).toContain("mudar_minhas_notificacoes");
    expect(n).toContain("minhas_notificacoes");
  });

  it("sem prefs.self, nenhuma das duas aparece", () => {
    for (const texto of ["não quero mais o relatório da manhã", "me lembra 1 hora antes do vencimento", "manda o relatório da manhã às 6h"]) {
      const n = nomes(texto, ["deal.list"]);
      expect(n).not.toContain("mudar_minhas_notificacoes");
      expect(n).not.toContain("minhas_notificacoes");
    }
  });

  it("a escrita nunca é oferecida a corretor", () => {
    const n = nomes("não quero mais o relatório da manhã", ["prefs.self"], corretor);
    expect(n).not.toContain("mudar_minhas_notificacoes");
  });

  it("as duas usam a capability prefs.self e a escrita exige confirmação", () => {
    expect(MINHAS_NOTIFICACOES.capability).toBe("prefs.self");
    expect(MUDAR_MINHAS_NOTIFICACOES.capabilities).toEqual(["prefs.self"]);
    expect(MUDAR_MINHAS_NOTIFICACOES.confirmacao).toBe(true);
    expect(MINHAS_NOTIFICACOES.confirmacao).toBe(false);
  });
});

describe("combina: pede aviso, não rouba o de outras tools", () => {
  it.each([
    "não quero mais o relatório",
    "não quero mais o relatório da manhã",
    "me lembra 1 hora antes",
    "me lembra 1 hora antes do vencimento",
    "manda o relatório da manhã às 6h",
    "desliga o resumo da manhã",
    "quero receber o relatório diário por whatsapp",
    "muda o lembrete de vencimento para 2 horas antes",
    "desativa as notificações por e-mail",
    "muda o relatório pra 9h",
    "para de me mandar o resumo da manhã",
    "não quero mais o relatório",
    "me notifica quando receber proposta",
    "como estão meus avisos de atividade?",
  ])("combina: %s", (texto) => {
    expect(pedePreferencias(texto)).toBe(true);
  });

  it.each([
    "relatório de vendas do mês",
    "me manda o relatório de vendas",
    "resumo da carteira",
    "resumo das vendas do time",
    "me dá um resumo dos negócios",
    "relatório de propostas",
    "me manda o relatório das pendências",
    "manda o relatório de atividades atrasadas",
    "me manda o relatório do João",
    "me envia o relatório do imóvel da Rua A",
    "me envia o relatório dos imóveis",
    "me lembra de ligar pro João",
    "me lembra de ligar pro João amanhã às 10h",
    "me lembra que preciso enviar o contrato",
    "quais são minhas notificações?",
    "tenho alguma notificação nova?",
    "como estão minhas notificações?",
    "bom dia, tudo bem?",
    "como estão meus negócios?",
  ])("não combina: %s", (texto) => {
    expect(pedePreferencias(texto)).toBe(false);
  });

  it("os pedidos de outras tools não ganham a tool de aviso", () => {
    const identity = usuario;
    const policy = ["prefs.self", "deal.list", "activity.list", "activity.write"] as never;
    const n = (texto: string) => ferramentasDoTurno({ policy, texto, identity }).entradas.map((t) => t.nome);
    expect(n("resumo da carteira")).not.toContain("mudar_minhas_notificacoes");
    expect(n("relatório de vendas do mês")).not.toContain("mudar_minhas_notificacoes");
    expect(n("me lembra de ligar pro João")).not.toContain("mudar_minhas_notificacoes");
    expect(n("quais são minhas notificações?")).not.toContain("mudar_minhas_notificacoes");
  });
});

describe("recusa do servidor com code desconhecido", () => {
  it("textoDaRecusa nunca devolve texto indefinido", async () => {
    const { textoDaRecusa } = await import("../preferencias");
    for (const code of ["valor_invalido", "tipo_desconhecido", "sem_telefone", "email_nao_configuravel", "recusa_desconhecida", "inventado_pelo_servidor"]) {
      const t = textoDaRecusa({ ok: false, code } as never);
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThan(10);
      expect(t).toContain("Nada foi alterado");
    }
  });

  it("no grafo: code desconhecido vira recusa genérica e encerra o fluxo", async () => {
    llm.mockResolvedValue(chamada({ antecedencia_lembrete_min: 60 }));
    const prop = await run("me lembra 1 hora antes do vencimento");
    patchar.mockResolvedValueOnce({ ok: false, code: "recusa_desconhecida" });
    const r = await run("sim", { fluxo: prop.fluxo }, "m2");
    expect(r.reply).toContain("não aceitou essa mudança");
    expect(r.reply).not.toContain("undefined");
    expect(r.fluxo ?? null).toBeNull();
  });
});

describe("escopo do prompt só com prefs.self", () => {
  it("avisos entram no escopo quando a pessoa tem a capability; sem ela, o texto é o de antes", async () => {
    const { buildSystemPrompt } = await import("../prompt");
    const base = { orgName: "FINCasa", hits: [], podeEscrever: true };
    const com = buildSystemPrompt({ ...base, avisos: true });
    const sem = buildSystemPrompt({ ...base });
    expect(com).toContain("avisos da própria pessoa");
    expect(sem).not.toContain("avisos da própria pessoa");
    expect(com).toContain("imobiliária. Para qualquer\n  outro assunto");
  });
});

describe("minhas_notificacoes (leitura)", () => {
  const ctx = {
    oferecidas: ["minhas_notificacoes"],
    policy: ["prefs.self"] as never,
    fromPhone: "5511987654321",
    referencias: null,
    turno: "m1",
    agora: 1_000,
  };

  it("lê as preferências da própria pessoa e devolve ao modelo sem ids internos", async () => {
    const r = await despacharLeituras({ ...ctx, identity: usuario, chamadas: [{ name: "minhas_notificacoes", args: {} }] });
    expect(ler).toHaveBeenCalledWith({ orgId: "org1", rawPhone: "5511987654321" });
    expect(r.resultados[0].tool).toBe("minhas_notificacoes");
    expect(r.resultados[0].items).toHaveLength(1);
    expect(JSON.stringify(r.resultados[0].items)).toContain("Relatório da manhã");
    expect(r.trilha[0].outcome).not.toBe("falha_na_consulta");
  });

  it("sem prefs.self, a leitura é recusada antes de chegar ao servidor", async () => {
    const r = await despacharLeituras({ ...ctx, policy: ["deal.list"] as never, identity: usuario, chamadas: [{ name: "minhas_notificacoes", args: {} }] });
    expect(ler).not.toHaveBeenCalled();
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("capability_negada");
  });

  it("corretor não lê aviso de ninguém", async () => {
    const r = await despacharLeituras({ ...ctx, identity: corretor, chamadas: [{ name: "minhas_notificacoes", args: {} }] });
    expect(ler).not.toHaveBeenCalled();
    expect(r.resultados[0].items === null || JSON.stringify(r.resultados[0].items).includes("sem_permissao")).toBe(true);
  });

  it("GET fora do ar vira falha na consulta, não resposta inventada", async () => {
    ler.mockResolvedValue(null);
    const r = await despacharLeituras({ ...ctx, identity: usuario, chamadas: [{ name: "minhas_notificacoes", args: {} }] });
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("falha_na_consulta");
  });
});
