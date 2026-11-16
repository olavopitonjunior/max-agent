import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * PR-O3-MA: `reagendar_atividade` — reagendar uma atividade para uma DATA (e hora opcional), par do
 * contractmaker PR-O3-CM (#3162, `docs/max.md` §19.0, verbo `activity.postpone` com `ate`/`hora`).
 *
 * Negado antes do permitido (regra 3 do contrato). Hoje nos testes é 2026-11-15, 12:00 em São Paulo.
 * Sem capability nova: a escrita usa `activity.write` (OFF por padrão), como as outras quatro.
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

const { buildGraph } = await import("../graph");
const { fetchProfile, searchKnowledge } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { executarAcao } = await import("@/lib/acao");
const { autorizarChamada } = await import("../despachante");
const { ferramentasDoTurno, pedeAtividade, REGISTRO_DE_TOOLS, buscarNoRegistro } = await import("../tools");
const atividades = await import("../atividades");
const { iniciarAtividade, conduzirAtividade, argsDoVerbo, textoDoErro, VERBO_DE_ATIVIDADE, TEXTO_ATIVIDADE_INDISPONIVEL, TEXTO_ATIVIDADE_SEM_VERIFICAR, TEXTO_ATIVIDADE_CONFERIR, textoAtividadeNaoLiberada } = atividades;

import type { Capability } from "../policy";
import type { ContextoDoTurno, DepsDoFluxo } from "../fluxos";
import type { FluxoAtividade } from "../atividades";

const AGORA = Date.parse("2026-11-15T15:00:00Z"); // 12:00 em São Paulo
const COM: Capability[] = ["activity.list", "activity.write"];
const SEM: Capability[] = ["activity.list", "deal.list"];
const usuario = { orgId: "org1", orgName: "Imob", kind: "user" as const, userId: "u1", userName: "Marcia" };
const corretor = { orgId: "org1", orgName: "Imob", kind: "broker" as const, splitRecipientId: "s1", label: "Beto" };
const ALVO = { id: "atv_1", rotulo: "Ligar para o João" };

function ctx(texto: string, over: Partial<ContextoDoTurno> = {}): ContextoDoTurno {
  return { texto, messageId: "m1", policy: COM, agora: AGORA, orgName: "Imob", ...over };
}

function deps(resposta: Awaited<ReturnType<DepsDoFluxo["acao"]>> | Error) {
  const acao = vi.fn(async (_verb: string, _args: Record<string, unknown>, _key?: string) => {
    if (resposta instanceof Error) throw resposta;
    return resposta;
  });
  return { acao, extrairProposta: vi.fn(), extrairCampos: vi.fn() } as unknown as DepsDoFluxo & { acao: typeof acao };
}

function abrir(ate: unknown = "2026-11-21", hora?: unknown, over: Partial<ContextoDoTurno> = {}) {
  return iniciarAtividade({ operacao: "reagendar", alvo: ALVO, ate, hora }, ctx("reagenda a 1", over));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AGORA);
});
afterEach(() => vi.useRealTimers());

// ─── NEGADO primeiro (fail-closed) ────────────────────────────────────────

describe("reagendar: sem activity.write nada acontece", () => {
  it("iniciarAtividade sem a capability: resposta fixa, sem fluxo, nenhum verbo", () => {
    const r = abrir("2026-11-21", "10:00", { policy: SEM });
    expect(r.fluxo).toBeNull();
    expect(r.reply).toBe(textoAtividadeNaoLiberada());
  });

  it("a tool não é oferecida sem a capability, nem a corretor comissionado com a capability", () => {
    const texto = "reagenda a atividade 1 para sexta";
    expect(ferramentasDoTurno({ policy: SEM, texto, identity: usuario, agora: AGORA }).entradas.map((e) => e.nome)).not.toContain("reagendar_atividade");
    expect(ferramentasDoTurno({ policy: COM, texto, identity: corretor, agora: AGORA }).entradas.map((e) => e.nome)).not.toContain("reagendar_atividade");
  });

  it("autorizarChamada recusa por capability_negada, identidade e não oferecida", () => {
    const args = { numero: 1, ate: "2026-11-21" };
    expect(autorizarChamada({ chamada: { name: "reagendar_atividade", args }, oferecidas: ["reagendar_atividade"], policy: SEM, identity: usuario }))
      .toMatchObject({ ok: false, motivo: "capability_negada" });
    expect(autorizarChamada({ chamada: { name: "reagendar_atividade", args }, oferecidas: ["reagendar_atividade"], policy: COM, identity: corretor }))
      .toMatchObject({ ok: false, motivo: "identidade_nao_escreve" });
    expect(autorizarChamada({ chamada: { name: "reagendar_atividade", args }, oferecidas: [], policy: COM, identity: usuario }))
      .toMatchObject({ ok: false, motivo: "nao_oferecida" });
  });

  it("política indisponível: frase de 'não consegui validar', sem fluxo e sem verbo", () => {
    const r = abrir("2026-11-21", "10:00", { politicaIndisponivel: true });
    expect(r.fluxo).toBeNull();
    expect(r.reply).toBe(TEXTO_ATIVIDADE_SEM_VERIFICAR);
  });

  it("a política some entre o resumo e o SIM: nada é chamado", async () => {
    const f = abrir("2026-11-21", "10:00").fluxo as FluxoAtividade;
    const d = deps({ status: 200, body: {} });
    const r = await conduzirAtividade(f, ctx("sim", { policy: SEM }), d);
    expect(d.acao).not.toHaveBeenCalled();
    expect("reply" in r && r.reply).toBe(textoAtividadeNaoLiberada());
  });
});

describe("reagendar: data inválida ou passada pergunta a data, sem fluxo", () => {
  it.each([
    ["vazio", ""],
    ["ausente", null],
    ["número", 20261121],
    ["formato brasileiro", "21/11"],
    ["dia inexistente", "2026-02-31"],
    ["linguagem natural", "amanhã"],
    ["data e hora juntas", "2026-11-21T10:00:00-03:00"],
  ])("ate %s", (_nome, ate) => {
    const r = abrir(ate);
    expect(r.fluxo).toBeNull();
    expect(r.reply).toContain("Para qual dia");
    expect(r.reply).toContain("Nada foi alterado");
    expect(r.evento).toBe("atividade_dado_invalido");
  });

  it("ate no passado (ontem em São Paulo): pergunta a data e não abre fluxo", () => {
    const r = abrir("2026-11-14");
    expect(r.fluxo).toBeNull();
    expect(r.reply).toContain("já passou");
    expect(r.evento).toBe("atividade_dado_invalido");
  });

  it("hoje é aceito (o servidor também aceita)", () => {
    expect(abrir("2026-11-15").fluxo).toMatchObject({ kind: "atividade", operacao: "reagendar", etapa: "confirmacao" });
  });

  it("virada de dia: às 23:30 de São Paulo, 'hoje' ainda é 15/11 (e 14/11 já passou)", () => {
    const tarde = Date.parse("2026-11-16T02:30:00Z"); // 23:30 do dia 15 em SP
    expect(abrir("2026-11-15", undefined, { agora: tarde }).fluxo).not.toBeNull();
    expect(abrir("2026-11-14", undefined, { agora: tarde }).fluxo).toBeNull();
  });

  it.each(["25:00", "9h", "10:60", "10", "10:00:00", "às 10"])("hora inválida %s: pergunta a hora, sem fluxo", (hora) => {
    const r = abrir("2026-11-21", hora);
    expect(r.fluxo).toBeNull();
    expect(r.reply).toContain("hora");
    expect(r.reply).toContain("Nada foi alterado");
  });
});

describe("reagendar: sem SIM explícito não chama o verbo", () => {
  it.each(["ok", "blz", "beleza", "👍", "talvez mais tarde", "sim, mas muda a hora", ""])("'%s' não escreve", async (resposta) => {
    const f = abrir("2026-11-21", "10:00").fluxo as FluxoAtividade;
    const d = deps({ status: 200, body: { ok: true } });
    await conduzirAtividade(f, ctx(resposta, { messageId: "m2" }), d);
    expect(d.acao).not.toHaveBeenCalled();
  });

  it("'ok' reapresenta o resumo e pede o SIM (não solta o turno nem escreve)", async () => {
    const f = abrir("2026-11-21", "10:00").fluxo as FluxoAtividade;
    const d = deps({ status: 200, body: {} });
    const r = await conduzirAtividade(f, ctx("ok"), d);
    expect("reply" in r && r.reply).toContain("Confirma?");
    expect("reply" in r && r.reply).toContain("SIM");
    expect("fluxo" in r && r.fluxo).toMatchObject({ etapa: "confirmacao" });
  });

  it("NÃO cancela e para: nada é chamado", async () => {
    const f = abrir("2026-11-21", "10:00").fluxo as FluxoAtividade;
    const d = deps({ status: 200, body: {} });
    const r = await conduzirAtividade(f, ctx("não"), d);
    expect(d.acao).not.toHaveBeenCalled();
    expect("fluxo" in r && r.fluxo).toBeNull();
  });
});

describe("reagendar: recusas do servidor viram frase fixa", () => {
  async function recusa(status: number, body: Record<string, unknown>) {
    const f = abrir("2026-11-21", "10:00").fluxo as FluxoAtividade;
    const d = deps({ status, body });
    const r = await conduzirAtividade(f, ctx("sim", { messageId: "m-sim" }), d);
    expect(d.acao).toHaveBeenCalledTimes(1);
    expect("fluxo" in r && r.fluxo).toBeNull();
    return "reply" in r ? r.reply : "";
  }

  it("404 (inexistente, de outra org ou de outro responsável): a resposta neutra", async () => {
    const reply = await recusa(404, { error: "not_found" });
    expect(reply).toContain(TEXTO_ATIVIDADE_INDISPONIVEL);
    expect(reply).toContain("Nada foi alterado");
    expect(reply).not.toMatch(/reagendada/i);
  });

  it("400 DATE_IN_PAST: frase fixa pedindo outra data", async () => {
    const reply = await recusa(400, { error: "DATE_IN_PAST" });
    expect(reply).toContain("Essa data já passou");
    expect(reply).toContain("Nada foi alterado");
  });

  it("400 invalid_args: o sistema não aceitou o pedido (nunca afirma que reagendou)", async () => {
    const reply = await recusa(400, { error: "invalid_args" });
    expect(reply).toContain("não aceitou");
    expect(reply).not.toMatch(/reagendada/i);
  });

  it("403 politica_nao_concede: 'não está liberado'", async () => {
    expect(await recusa(403, { error: "Forbidden", reason: "politica_nao_concede" })).toBe(textoAtividadeNaoLiberada());
  });

  it("409 do writer (já concluída / cancelada / mudou): diz que nada foi alterado", async () => {
    expect(await recusa(409, { error: "ALREADY_DONE" })).toContain("já estava concluída");
    expect(await recusa(409, { error: "CANCELED" })).toContain("cancelada");
    expect(await recusa(409, { error: "OUTRO" })).toContain("Nada foi alterado");
  });

  it("textoDoErro: 400 e 404 de reagendar nunca dizem 'criado'", () => {
    for (const [status, body] of [[400, { error: "DATE_IN_PAST" }], [400, { error: "invalid_args" }], [404, {}]] as const) {
      expect(textoDoErro("reagendar", status, body as Record<string, unknown>)).not.toMatch(/criad/i);
    }
  });
});

// ─── Permitidos ───────────────────────────────────────────────────────────

describe("reagendar: proposta, confirmação e chamada com idempotency key", () => {
  it("o verbo é activity.postpone e a operação está no mapa de verbos", () => {
    expect(VERBO_DE_ATIVIDADE.reagendar).toBe("activity.postpone");
  });

  it("resumo com hora: 'Vou reagendar a atividade X para 21/11 às 10:00. Confirma?'", () => {
    const r = abrir("2026-11-21", "10:00");
    expect(r.evento).toBe("atividade_resumo");
    expect(r.reply).toContain('Vou reagendar a atividade "Ligar para o João" para 21/11 às 10:00. Confirma?');
    expect(r.reply).toContain("Responda SIM");
    expect(r.fluxo).toMatchObject({ kind: "atividade", operacao: "reagendar", etapa: "confirmacao", alvo: { id: "atv_1" } });
  });

  it("resumo sem hora: só o dia; e em outro ano mostra o ano", () => {
    expect(abrir("2026-11-21").reply).toContain('para 21/11. Confirma?');
    expect(abrir("2027-01-05").reply).toContain("para 05/01/2027. Confirma?");
  });

  it("o resumo não vaza o id da atividade", () => {
    expect(abrir("2026-11-21", "10:00").reply).not.toContain("atv_1");
  });

  it("SIM chama activity.postpone com a messageId do SIM como chave e args {atividade_id, ate, hora}", async () => {
    const f = abrir("2026-11-21", "10:00").fluxo as FluxoAtividade;
    const d = deps({ status: 200, body: { ok: true, atividadeId: "atv_1", venceEm: "2026-11-21T13:00:00.000Z", temHorario: true } });
    const fim = await conduzirAtividade(f, ctx("sim", { messageId: "m-sim" }), d);
    expect(d.acao).toHaveBeenCalledTimes(1);
    expect(d.acao).toHaveBeenCalledWith("activity.postpone", { atividade_id: "atv_1", ate: "2026-11-21", hora: "10:00" }, "m-sim");
    expect("fluxo" in fim && fim.fluxo).toBeNull();
    expect("reply" in fim && fim.reply).toContain("reagendada");
    expect("reply" in fim && fim.reply).toContain("21/11 às 10:00");
  });

  it("sem hora, os args não levam a chave `hora` e nunca levam `dias`", async () => {
    const f = abrir("2026-11-21").fluxo as FluxoAtividade;
    expect(argsDoVerbo(f)).toStrictEqual({ atividade_id: "atv_1", ate: "2026-11-21" });
    const d = deps({ status: 200, body: { ok: true } });
    await conduzirAtividade(f, ctx("sim", { messageId: "m-sim" }), d);
    expect(d.acao.mock.calls[0]![1]).not.toHaveProperty("dias");
    expect(d.acao.mock.calls[0]![1]).not.toHaveProperty("hora");
  });

  it("'SIM' em maiúsculas e 'isso mesmo' valem", async () => {
    for (const resposta of ["SIM", "sim", "Sim!", "isso mesmo"]) {
      const f = abrir("2026-11-21", "10:00").fluxo as FluxoAtividade;
      const d = deps({ status: 200, body: { ok: true } });
      await conduzirAtividade(f, ctx(resposta), d);
      expect(d.acao, resposta).toHaveBeenCalledTimes(1);
    }
  });

  it("replay incerto: sem resposta, a chave fica; outro assunto guia para o SIM; o SIM reusa a MESMA chave", async () => {
    const f = abrir("2026-11-21", "10:00").fluxo as FluxoAtividade;
    const d = deps(null as never);
    const incerto = await conduzirAtividade(f, ctx("sim", { messageId: "m-a" }), d);
    expect("fluxo" in incerto && incerto.fluxo).toMatchObject({ chave: { verbo: "activity.postpone", valor: "m-a" } });
    expect("reply" in incerto && incerto.reply).toContain("Responda SIM");

    const guia = await conduzirAtividade((incerto as { fluxo: FluxoAtividade }).fluxo, ctx("não", { messageId: "m-b" }), d);
    expect("reply" in guia && guia.reply).toBe(TEXTO_ATIVIDADE_CONFERIR);

    const d2 = deps({ status: 200, body: { ok: true } });
    const fim = await conduzirAtividade((guia as { fluxo: FluxoAtividade }).fluxo, ctx("sim", { messageId: "m-c" }), d2);
    expect(d2.acao).toHaveBeenCalledWith("activity.postpone", { atividade_id: "atv_1", ate: "2026-11-21", hora: "10:00" }, "m-a");
    expect("fluxo" in fim && fim.fluxo).toBeNull();
  });

  it("'em_andamento' (409) também é incerto e preserva a chave", async () => {
    const f = abrir("2026-11-21", "10:00").fluxo as FluxoAtividade;
    const r = await conduzirAtividade(f, ctx("sim", { messageId: "m-a" }), deps({ status: 409, body: { error: "em_andamento" } }));
    expect("fluxo" in r && r.fluxo).toMatchObject({ chave: { valor: "m-a" } });
  });
});

describe("reagendar: a tool no registro", () => {
  it("params {numero, ate, hora?}, capability activity.write, com confirmação; o modelo nunca recebe campo de id", () => {
    const e = buscarNoRegistro("reagendar_atividade");
    expect(e).toMatchObject({ tipo: "escrita", capabilities: ["activity.write"], confirmacao: true, refs: { consome: "atividade" } });
    const p = e!.def.parameters as { properties: Record<string, { type: string }>; required: string[]; additionalProperties: boolean };
    expect(Object.keys(p.properties).sort()).toEqual(["ate", "hora", "numero"]);
    expect(p.required.sort()).toEqual(["ate", "numero"]);
    expect(p.additionalProperties).toBe(false);
    expect(REGISTRO_DE_TOOLS.map((t) => t.nome)).toContain("reagendar_atividade");
  });

  it("com a capability e usuário interno, é oferecida; a descrição de `ate` leva a data de hoje", () => {
    const { entradas } = ferramentasDoTurno({ policy: COM, texto: "reagenda a atividade 1 para sexta", identity: usuario, agora: AGORA });
    const e = entradas.find((x) => x.nome === "reagendar_atividade");
    expect(e).toBeDefined();
    const ate = (e!.def.parameters as { properties: Record<string, { description?: string }> }).properties.ate!;
    expect(ate.description).toContain("2026-11-15");
  });

  it.each(["reagenda a atividade 2 para sexta", "adia a 2 para segunda", "remarca a tarefa 1 pro dia 21", "reagenda a 3 para 21/11 às 10"])(
    "o pré-filtro reconhece: %s",
    (texto) => expect(pedeAtividade(texto)).toBe(true),
  );

  it.each(["reagenda a proposta do João", "adia a assinatura do contrato"])("não rouba a frase de outro objeto: %s", (texto) => {
    expect(pedeAtividade(texto)).toBe(false);
  });
});

// ─── No grafo ─────────────────────────────────────────────────────────────

describe("reagendar_atividade no grafo", () => {
  const llm = complete as unknown as ReturnType<typeof vi.fn>;
  const acao = executarAcao as unknown as ReturnType<typeof vi.fn>;
  const policy = (caps: string[]) => ({ byRole: { "*": caps }, byRecipient: {}, brokerDefault: ["deal.list"] });
  const uso = { model: "openai/gpt-5.4-nano", promptTokens: 10, completionTokens: 5, latencyMs: 5, success: true };
  const referencias = () => ({ criadoEm: Date.now(), itens: [{ n: 1, tipo: "atividade", id: "atv_7", rotulo: "Enviar contrato" }] });

  function run(text: string, state: Record<string, unknown> = {}, messageId = "m1") {
    return buildGraph().compile().invoke({
      inbound: { messageId, fromPhone: "5511987654321", groupId: null, kind: "text" as const, text, mediaUrl: null,
        mimeType: null, timestampMs: null, senderName: "Marcia", replyToMessageId: null, buttonPayload: null },
      identity: usuario, reply: null, halt: null, propostaDescartada: false, ...state,
    });
  }

  beforeEach(() => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: policy(["deal.list", "activity.list", "activity.write"]) } as never);
    vi.mocked(searchKnowledge).mockResolvedValue([]);
  });

  it("NEGADO: sem activity.write o pedido não abre fluxo nem escreve", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: policy(["deal.list", "activity.list"]) } as never);
    llm.mockResolvedValue({ text: "Não consigo reagendar por aqui.", toolCalls: [{ name: "reagendar_atividade", args: { numero: 1, ate: "2026-11-21" } }], usage: uso });
    const s = await run("reagenda a atividade 1 para sexta", { referencias: referencias() });
    expect(s.fluxo ?? null).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });

  it("o modelo propõe pelo número; o id vem do mapa; o SIM escreve com a messageId do SIM", async () => {
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "reagendar_atividade", args: { numero: 1, ate: "2026-11-21", hora: "10:00" } }], usage: uso });
    const s = await run("reagenda a atividade 1 para sábado às 10", { referencias: referencias() });
    expect(s.fluxo).toMatchObject({ kind: "atividade", operacao: "reagendar", alvo: { id: "atv_7" } });
    expect(s.reply).toContain('Vou reagendar a atividade "Enviar contrato" para 21/11 às 10:00. Confirma?');
    expect(s.reply).not.toContain("atv_7");
    expect(acao).not.toHaveBeenCalled();

    acao.mockResolvedValue({ status: 200, body: { ok: true, atividadeId: "atv_7", venceEm: "2026-11-21T13:00:00.000Z", temHorario: true } });
    const fim = await run("sim", { fluxo: s.fluxo }, "m-sim");
    expect(acao).toHaveBeenCalledWith(expect.objectContaining({
      verb: "activity.postpone", args: { atividade_id: "atv_7", ate: "2026-11-21", hora: "10:00" }, idempotencyKey: "m-sim",
    }));
    expect(fim.reply).toContain("reagendada");
  });

  it("número fora da lista: pede a lista de novo, sem fluxo", async () => {
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "reagendar_atividade", args: { numero: 9, ate: "2026-11-21" } }], usage: uso });
    const s = await run("reagenda a atividade 9 para sábado", { referencias: referencias() });
    expect(s.fluxo ?? null).toBeNull();
    expect(s.reply).toContain("Não achei essa atividade");
  });

  it("data passada do modelo: pergunta a data, sem fluxo e sem verbo", async () => {
    llm.mockResolvedValue({ text: "", toolCalls: [{ name: "reagendar_atividade", args: { numero: 1, ate: "2026-11-10" } }], usage: uso });
    const s = await run("reagenda a atividade 1 para dia 10", { referencias: referencias() });
    expect(s.fluxo ?? null).toBeNull();
    expect(s.reply).toContain("já passou");
    expect(acao).not.toHaveBeenCalled();
  });
});
