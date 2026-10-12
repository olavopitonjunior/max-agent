import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Fluxo `credito` (M2): roteamento, gate, atestação, coleta campo a campo,
 * comandos, pausa, revisão (SIM sem envio) e status. O ImobPro é um fake que
 * VALIDA o que chega (CPF obrigatório no `lead.upsert`, só o campo do turno,
 * consentimento com o texto oficial) e o checkpoint nunca pode ter o CPF.
 */

process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn(),
  reportUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));
vi.mock("@/lib/acao", () => ({ executarAcao: vi.fn() }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  resolveIdentity: vi.fn(),
}));

const { buildGraph, RESET_DO_TURN, runTurn, respostaDoTurno, encerrarTurno } = await import("../graph");
const { redigir, redigirCredito } = await import("@/lib/pii");
const { resolveIdentity } = await import("@/lib/identity");
type Candidate = import("@/lib/identity").Candidate;
const credito = await import("../credito");
const {
  pedeCredito, interpretarCampo, valoresNoTexto, valoresRotulados, nomeCitado, confirmaEstrito, cifrarCofre, decifrarCofre,
  TEXTO_ATESTACAO, TEXTO_CREDITO_SEM_POLITICA, TEXTO_SCORE, TEXTO_APROVAR,
} = credito;
const { fetchProfile, searchKnowledge } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { executarAcao } = await import("@/lib/acao");
const { MemorySaver } = await import("@langchain/langgraph");

const llm = complete as unknown as ReturnType<typeof vi.fn>;
const acao = executarAcao as unknown as ReturnType<typeof vi.fn>;
const usuario = { orgId: "org1", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };
const corretor: Candidate = { orgId: "org1", orgName: "FINCasa", kind: "broker", splitRecipientId: "sr1", label: "Wes" } as Candidate;
const COM_CREDITO = { byRole: { "*": ["proposal.list", "proposal.create", "credit.read", "credit.request"] }, byRecipient: {}, brokerDefault: [] };
const SEM_CREDITO = { byRole: { "*": ["proposal.list", "proposal.create"] }, byRecipient: {}, brokerDefault: [] };
const uso = { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true };

const CPF = "111.444.777-35";
const CPF_D = "11144477735";
const CPF_MORADOR = "52998224725";
const CPF_SOL = "39053344705";

// ─── O ImobPro simulado ─────────────────────────────────────────────────────

type Credito = { v?: number; tipo?: string; pretendente?: Record<string, unknown>; locacao?: Record<string, unknown>; morador?: Record<string, unknown>; solidarios?: unknown[] };
interface Lead { id: string; nome: string; cpf: string; credito: Credito; consentimento?: { texto: string; messageId: string } }
let leads: Lead[] = [];
let chamadas: { verb: string; args: Record<string, unknown>; key?: string }[] = [];
let preflight: Record<string, unknown> = {};
let faltantesForcados: string[] | null = null;
let statusResposta: { status: number; body: Record<string, unknown> } | null = null;

function cpfOk(raw: string): boolean {
  const c = raw.replace(/\D/g, "");
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (let n = 9; n < 11; n++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i);
    if (Number(c[n]) !== ((s * 10) % 11) % 10) return false;
  }
  return true;
}
const vazio = (v: unknown) => v === undefined || v === null || v === "";
/** Espelho de `camposFaltantes` (contractmaker `applicant-schema.ts`). */
function faltantes(c: Credito): string[] {
  const p = c.pretendente ?? {};
  const l = c.locacao ?? {};
  const f: string[] = [];
  if (vazio(p.documento) || !cpfOk(String(p.documento))) f.push("CPF do pretendente");
  if (vazio(p.nomeCompleto)) f.push("Nome completo do pretendente");
  if (vazio(p.vinculoEmpregaticio)) f.push("Vínculo empregatício do pretendente");
  if (vazio(p.profissao)) f.push("Profissão do pretendente");
  if (vazio(p.rendaMensal)) f.push("Renda mensal do pretendente");
  if (vazio(l.valorAluguel)) f.push("Valor do aluguel");
  if (vazio(l.valorCondominio)) f.push("Valor do condomínio");
  if (vazio(l.valorIptu)) f.push("Valor do IPTU");
  if (vazio(l.vaiMorar)) f.push("Se o pretendente vai morar no imóvel");
  if ([3, 4].includes(l.vaiMorar as number)) {
    const m = c.morador ?? {};
    if (vazio(m.documento) || !cpfOk(String(m.documento))) f.push("CPF do morador principal");
    if (vazio(m.nomeCompleto)) f.push("Nome completo do morador principal");
    if (vazio(m.parentesco)) f.push("Parentesco do morador principal");
  }
  return f;
}
function mesclar(c: Credito, patch: Record<string, unknown>): Credito {
  const out: Record<string, unknown> = { ...c };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...((c as Record<string, unknown>)[k] as object ?? {}), ...v } : v;
  }
  return out as Credito;
}

async function imobpro(p: { verb: string; args: Record<string, unknown>; idempotencyKey?: string }) {
  chamadas.push({ verb: p.verb, args: p.args, key: p.idempotencyKey });
  const a = p.args;
  switch (p.verb) {
    case "credit.preflight": {
      const lead = leads.find((l) => l.id === a.leaseClientId);
      return { status: 200, body: { configurado: true, orgLigada: true, custoCents: 1500, consentimento: !!lead?.consentimento,
        faltantes: faltantesForcados ?? (lead ? faltantes(lead.credito) : faltantes({})), avisos: [],
        lead: lead ? { id: lead.id, nome: lead.nome, status: "novo" } : null, ...preflight } };
    }
    case "lead.upsert": {
      if (typeof a.cpf !== "string" || !a.cpf) return { status: 400, body: { error: "Bad Request" } };
      if (!p.idempotencyKey) return { status: 400, body: { error: "Bad Request" } };
      if (!cpfOk(a.cpf)) return { status: 422, body: { error: "documento_invalido" } };
      const cpf = a.cpf.replace(/\D/g, "");
      let lead = leads.find((l) => l.cpf === cpf);
      const novo = !lead;
      if (!lead) {
        if (typeof a.nome !== "string" || !a.nome.trim()) return { status: 422, body: { error: "nome_obrigatorio" } };
        lead = { id: `lc${leads.length + 1}`, nome: a.nome, cpf, credito: {} };
        leads.push(lead);
      }
      const c = a.consentimento as { texto: string; messageId: string } | undefined;
      if (c && !lead.consentimento) lead.consentimento = c;
      if (a.campos) lead.credito = mesclar(lead.credito, a.campos as Record<string, unknown>);
      return { status: novo ? 201 : 200, body: { id: lead.id, status: "novo", faltantes: faltantes(lead.credito) } };
    }
    case "credit.status":
      return statusResposta ?? { status: 404, body: { error: "nao_encontrada" } };
    case "proposal.status":
      return { status: 200, body: { proposta: { id: "prop1", codigo: "PROP-2026-0013", titulo: "Apto", status: "assinada" } } };
    default:
      return { status: 501, body: { error: `nao_simulado:${p.verb}` } };
  }
}

/** O que o extrator (LLM) devolve nesta chamada; `null` = nada. */
let extracao: Record<string, unknown> | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MAX_CREDITO = "true";
  leads = [];
  chamadas = [];
  preflight = {};
  faltantesForcados = null;
  statusResposta = null;
  extracao = null;
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: COM_CREDITO } as never);
  vi.mocked(searchKnowledge).mockResolvedValue([]);
  llm.mockImplementation(async (p: { toolChoice?: string }) => {
    if (p.toolChoice === "preencher_campo") {
      return { text: "", toolCalls: extracao ? [{ name: "preencher_campo", args: extracao }] : [], usage: uso };
    }
    return { text: "O horário é das 9h às 18h.", toolCalls: [], usage: uso };
  });
  acao.mockImplementation(imobpro as never);
});
afterEach(() => { delete process.env.MAX_CREDITO; });

function conversa(identity: Candidate = usuario) {
  const app = buildGraph().compile({ checkpointer: new MemorySaver() });
  const thread = `credito-${Math.random()}`;
  let n = 0;
  return async (text: string) => {
    n += 1;
    const s = await app.invoke(
      { inbound: { messageId: `m${n}`, fromPhone: "5511987654321", groupId: null, kind: "text" as const, text, mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null },
        identity, ...RESET_DO_TURN },
      { configurable: { thread_id: thread } },
    );
    // Turno de crédito: o state guarda a resposta redigida; a real sai de `respostaDoTurno`.
    const real = respostaDoTurno(`m${n}`);
    encerrarTurno(`m${n}`);
    return { ...s, reply: real ?? s.reply, replyNoState: s.reply };
  };
}
const ultimo = (verb: string) => [...chamadas].reverse().find((c) => c.verb === verb);
const semCpf = (x: unknown) => {
  const j = JSON.stringify(x ?? null);
  return !j.includes(CPF_D) && !j.includes(CPF) && !j.includes(CPF_MORADOR) && !j.includes(CPF_SOL) && !j.includes("390.533.447-05");
};

// ─── Roteamento ─────────────────────────────────────────────────────────────

describe("pedeCredito", () => {
  it.each([
    ["faz a ficha de crédito da Letícia Andrade", "abrir"],
    ["quero fazer uma análise de crédito", "abrir"],
    ["analisa o crédito do locatário da proposta PROP-2026-0013", "abrir"],
    ["consulta de crédito pro João Silva", "abrir"],
    ["pode fazer a análise de crédito do João?", "abrir"],
    ["abre uma ficha de crédito", "abrir"],
    ["como está a análise da Letícia?", "status"],
    ["crédito da Letícia", "status"],
    ["a análise de crédito do João já saiu?", "status"],
    ["qual o status do crédito da Letícia?", "status"],
    ["qual o score dele?", "score"],
    ["me passa o score da Letícia", "score"],
  ])("%s → %s", (t, esperado) => expect(pedeCredito(t)).toBe(esperado));

  it.each([
    "manda a ficha de locação do João",
    "ficha do João",
    "como está a análise do contrato?",
    "como funciona a análise de crédito?",
    "quanto custa a análise de crédito?",
    "não faz a análise de crédito ainda",
    "o cliente vai usar carta de crédito do consórcio",
    "quero fazer uma proposta para a Letícia",
    "como está a proposta da Letícia?",
  ])("não é crédito: %s", (t) => expect(pedeCredito(t)).toBeNull());

  it("nome citado", () => {
    expect(nomeCitado("faz a ficha de crédito da Letícia Andrade")).toBe("Letícia Andrade");
    expect(nomeCitado("como está a análise da letícia?")).toBe("Letícia");
    expect(nomeCitado("analisa o crédito do locatário da proposta X")).toBeNull();
  });
});

// ─── Interpretação de campo (código antes do LLM) ───────────────────────────

describe("interpretarCampo", () => {
  const nada = vi.fn(async () => null);
  beforeEach(() => nada.mockClear());

  it("valores pt-BR sem o modelo", async () => {
    expect(valoresNoTexto("8 mil")).toEqual([8000]);
    expect(valoresNoTexto("R$ 8.500,00")).toEqual([8500]);
    expect(valoresNoTexto("8,5 mil")).toEqual([8500]);
    expect(valoresNoTexto("oito mil e quinhentos")).toEqual([8500]);
    expect(valoresNoTexto("mil e duzentos reais")).toEqual([1200]);
    expect(valoresNoTexto("ganha uns 3k")).toEqual([3000]);
    expect(await interpretarCampo("renda", "8 mil", nada)).toEqual({ tipo: "ok", valor: 8000 });
    expect(await interpretarCampo("condominio", "não tem condomínio", nada)).toEqual({ tipo: "ok", valor: 0 });
    expect(await interpretarCampo("iptu", "isento", nada)).toEqual({ tipo: "ok", valor: 0 });
    expect(nada).not.toHaveBeenCalled();
  });

  it("vínculo por sinônimo: 'carteira assinada' → 6", async () => {
    expect(await interpretarCampo("vinculo", "carteira assinada", nada)).toEqual({ tipo: "ok", valor: 6 });
    expect(await interpretarCampo("vinculo", "ela é aposentada", nada)).toEqual({ tipo: "ok", valor: 1 });
    expect(await interpretarCampo("vinculo", "5", nada)).toEqual({ tipo: "ok", valor: 5 });
    expect(nada).not.toHaveBeenCalled();
  });

  it("CPF inválido e incompleto: erro em código", async () => {
    expect(await interpretarCampo("cpf", "111.444.777-36", nada)).toMatchObject({ tipo: "erro" });
    expect(await interpretarCampo("cpf", "1234", nada)).toMatchObject({ tipo: "erro" });
    expect(await interpretarCampo("cpf", "12.345.678/0001-95", nada)).toEqual({ tipo: "pj" });
    expect(await interpretarCampo("cpf", CPF, nada)).toEqual({ tipo: "ok", valor: CPF_D });
  });

  it("dois valores: o extrator escolhe, e o trecho TEM que estar na mensagem (nunca valor inventado)", async () => {
    const inventa = vi.fn(async () => ({ trecho: "10 mil" }));
    expect(await interpretarCampo("renda", "ela ganha 8 mil e o marido 3 mil", inventa)).toMatchObject({ tipo: "erro" });
    const certo = vi.fn(async () => ({ trecho: "8 mil" }));
    expect(await interpretarCampo("renda", "ela ganha 8 mil e o marido 3 mil", certo)).toEqual({ tipo: "ok", valor: 8000 });
  });

  it("vínculo ambíguo vai ao extrator, que só escolhe entre as opções", async () => {
    const ext = vi.fn(async () => ({ opcao: 6 }));
    expect(await interpretarCampo("vinculo", "é CLT e também vive de aluguéis", ext)).toEqual({ tipo: "ok", valor: 6 });
    const fora = vi.fn(async () => ({ opcao: 42 }));
    expect(await interpretarCampo("vinculo", "é CLT e também vive de aluguéis", fora)).toMatchObject({ tipo: "erro" });
  });
});

// ─── No grafo ───────────────────────────────────────────────────────────────

describe("flag e gate", () => {
  it("MAX_CREDITO desligada: não abre o fluxo, nenhum verbo de crédito, responde o modelo", async () => {
    delete process.env.MAX_CREDITO;
    const s = await conversa()("faz a ficha de crédito da Letícia Andrade");
    expect(chamadas.filter((c) => c.verb.startsWith("credit") || c.verb === "lead.upsert")).toEqual([]);
    expect(s.fluxo ?? null).toBeNull();
    expect(llm).toHaveBeenCalled();
  });

  it("sem a policy credit.request: frase fixa, nada chamado", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: SEM_CREDITO } as never);
    const s = await conversa()("faz a ficha de crédito da Letícia Andrade");
    expect(s.reply).toBe(TEXTO_CREDITO_SEM_POLITICA);
    expect(chamadas).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it("corretor comissionado (sem usuário): não liberada", async () => {
    const s = await conversa(corretor)("faz a ficha de crédito da Letícia Andrade");
    expect(s.reply).toBe(TEXTO_CREDITO_SEM_POLITICA);
    expect(chamadas).toEqual([]);
  });

  it("org sem a Upestate ligada: frase fixa com a org", async () => {
    preflight = { orgLigada: false };
    const s = await conversa()("faz a ficha de crédito da Letícia Andrade");
    expect(s.reply).toBe("Análise de crédito não está ativa na FINCasa. Fale com o administrador.");
    expect(s.fluxo ?? null).toBeNull();
  });

  it("score não existe: recusa fixa, sem modelo", async () => {
    const s = await conversa()("qual o score da Letícia?");
    expect(s.reply).toBe(TEXTO_SCORE);
    expect(llm).not.toHaveBeenCalled();
  });

  it("PJ: aponta a tela do lead", async () => {
    const s = await conversa()("faz uma análise de crédito PJ da empresa X");
    expect(s.reply).toMatch(/^PJ\/comercial é pela tela do lead: https?:\/\/.+\/locacao\/credito$/);
  });
});

describe("atestação", () => {
  it("NÃO: nada foi feito, nenhum lead", async () => {
    const turno = conversa();
    const s1 = await turno("faz a ficha de crédito da Letícia Andrade");
    expect(s1.reply).toContain("Vou precisar de CPF, renda e vínculo de Letícia Andrade.");
    expect(s1.reply).toContain(TEXTO_ATESTACAO);
    expect(s1.reply).toContain("Responda SIM.");
    const s2 = await turno("não");
    expect(s2.reply).toBe("Certo, sem autorização não consulto. Nada foi feito.");
    expect(s2.fluxo).toBeNull();
    expect(chamadas.map((c) => c.verb)).toEqual(["credit.preflight"]);
  });
});

describe("coleta completa até a revisão (SIM no M2 não envia)", () => {
  it("campo a campo, cada upsert só com o campo do turno, e o checkpoint sem CPF", async () => {
    const turno = conversa();
    await turno("faz a ficha de crédito da Letícia Andrade");
    let s = await turno("sim");
    expect(s.reply).toBe("Obrigado. CPF de Letícia Andrade?");
    expect(s.fluxo).toMatchObject({ kind: "credito", etapa: "coleta", campoAtual: "cpf", consentimento: { texto: TEXTO_ATESTACAO, messageId: "m2" } });

    s = await turno("123");
    expect(s.reply).toBe("O CPF tem 11 dígitos. CPF de Letícia Andrade?");
    s = await turno("111.444.777-36");
    expect(s.reply).toContain("não confere");
    expect(chamadas.some((c) => c.verb === "lead.upsert")).toBe(false);

    s = await turno(CPF);
    const criacao = ultimo("lead.upsert")!;
    expect(criacao.key).toBe("m5:cpf");
    expect(criacao.args).toEqual({
      cpf: CPF_D, nome: "Letícia Andrade",
      campos: { v: 1, tipo: "residencial", pretendente: { documento: CPF_D, nomeCompleto: "Letícia Andrade" } },
      consentimento: { texto: TEXTO_ATESTACAO, messageId: "m2" },
    });
    expect(s.reply).toBe("Anotei: CPF ***.***.777-35.\nVínculo de trabalho de Letícia Andrade? (CLT, autônomo, aposentado, servidor, empresário, estudante, liberal ou renda de aluguel)");
    expect(s.fluxo).toMatchObject({ leaseClientId: "lc1", campoAtual: "vinculo" });
    expect(semCpf(s.fluxo)).toBe(true);
    expect(semCpf(s.messages)).toBe(true);

    const passos: [string, Record<string, unknown>, RegExp][] = [
      ["carteira assinada", { pretendente: { vinculoEmpregaticio: 6 } }, /^Anotei: CLT\.\nProfissão de Letícia Andrade\?$/],
      ["ela é analista de sistemas", { pretendente: { profissao: "analista de sistemas" } }, /Renda mensal de Letícia Andrade\?$/],
      ["8 mil", { pretendente: { rendaMensal: 8000 } }, /^Anotei: renda R\$ 8\.000,00\.\nValor do aluguel\?$/],
      ["R$ 2.500", { locacao: { valorAluguel: 2500 } }, /Valor do condomínio\?/],
      ["não tem", { locacao: { valorCondominio: 0 } }, /^Anotei: sem condomínio\.\nValor do IPTU\?/],
      ["IPTU 120 reais", { locacao: { valorIptu: 120 } }, /vai morar no imóvel\?\n1\. Sim, sozinho/],
      ["3", { locacao: { vaiMorar: 3 } }, /CPF de quem vai morar no imóvel\?$/],
      [CPF_MORADOR, { morador: { documento: CPF_MORADOR } }, /Nome completo de quem vai morar\?$/],
      ["Maria Andrade Silva", { morador: { nomeCompleto: "Maria Andrade Silva" } }, /Parentesco dessa pessoa/],
      ["mãe", { morador: { parentesco: 2 } }, /Tem mais alguém compondo renda\? Responda SIM ou NÃO\.$/],
    ];
    for (const [fala, patch, resposta] of passos) {
      const antes = chamadas.length;
      s = await turno(fala);
      expect(s.reply, fala).toMatch(resposta);
      const novas = chamadas.slice(antes).filter((c) => c.verb === "lead.upsert");
      expect(novas, fala).toHaveLength(1);
      // Só o campo do turno (mais a marca da ficha) — e sempre com o CPF, que o contrato exige.
      expect(novas[0]!.args, fala).toEqual({ cpf: CPF_D, campos: { v: 1, tipo: "residencial", ...patch }, consentimento: { texto: TEXTO_ATESTACAO, messageId: "m2" } });
      expect(semCpf(s.fluxo), fala).toBe(true);
    }

    // Solidário: a lista inteira vai a cada campo (o servidor substitui o array).
    s = await turno("sim");
    expect(s.reply).toBe("CPF de quem vai compor renda (1ª pessoa)?");
    s = await turno("390.533.447-05");
    expect(ultimo("lead.upsert")!.args.campos).toEqual({ v: 1, tipo: "residencial", solidarios: [{ documento: CPF_SOL }] });
    s = await turno("João Pedro Souza");
    s = await turno("autônomo");
    s = await turno("pedreiro");
    s = await turno("3 mil e quinhentos");
    expect(ultimo("lead.upsert")!.args.campos).toEqual({ v: 1, tipo: "residencial", solidarios: [
      { documento: CPF_SOL, nomeCompleto: "João Pedro Souza", vinculoEmpregaticio: 2, profissao: "pedreiro", rendaMensal: 3500 },
    ] });
    expect(s.reply).toMatch(/Tem mais alguém compondo renda\?/);
    expect(semCpf(s.fluxo)).toBe(true);

    s = await turno("não");
    expect(s.reply).toBe(
      "Vou consultar Letícia Andrade (CPF ***.***.777-35) na Upestate pela FINCasa. Aluguel R$ 2.500,00, renda R$ 8.000,00, CLT, " +
      "1 pessoa(s) compondo renda. Custo R$ 15,00. Responda *SIM* para enviar.",
    );
    expect(s.fluxo).toMatchObject({ etapa: "revisao" });

    s = await turno("sim");
    expect(s.reply).toMatch(/^Envio entra na próxima versão; a ficha está salva: https?:\/\/.+\/locacao\/pessoas\/clientes\/lc1$/);
    expect(s.fluxo).toBeNull();
    expect(chamadas.some((c) => c.verb === "credit.request")).toBe(false);
    // O que o servidor guardou é a ficha completa; o Max não guardou nenhum CPF.
    expect(leads[0]!.credito.pretendente).toEqual({ documento: CPF_D, nomeCompleto: "Letícia Andrade", vinculoEmpregaticio: 6, profissao: "analista de sistemas", rendaMensal: 8000 });
    expect(semCpf(s.messages)).toBe(true);
    expect(llm).not.toHaveBeenCalled();
  });
});

describe("caminhos da coleta", () => {
  async function ateRenda() {
    const turno = conversa();
    await turno("faz a ficha de crédito da Letícia Andrade");
    await turno("sim");
    await turno(CPF);
    await turno("CLT");
    await turno("analista");
    return turno;
  }

  it("sem nome no pedido: o servidor pede o nome; o lead nasce no turno do nome", async () => {
    const turno = conversa();
    let s = await turno("quero fazer uma análise de crédito");
    expect(s.reply).toContain("vínculo do pretendente");
    await turno("sim");
    s = await turno(CPF);
    expect(s.reply).toBe("Anotei: CPF ***.***.777-35.\nNome completo do pretendente?");
    expect(leads).toHaveLength(0);
    expect(semCpf(s.fluxo)).toBe(true);
    s = await turno("Letícia");
    expect(s.reply).toBe("Preciso do nome completo, com sobrenome. Nome completo do pretendente?");
    s = await turno("o nome é Letícia Andrade");
    expect(ultimo("lead.upsert")!.args).toMatchObject({ cpf: CPF_D, nome: "Letícia Andrade",
      campos: { pretendente: { documento: CPF_D, nomeCompleto: "Letícia Andrade" } } });
    expect(s.fluxo).toMatchObject({ leaseClientId: "lc1", leadNome: "Letícia Andrade", campoAtual: "vinculo" });
  });

  it("3 tentativas: 'Pode conferir e mandar de novo?' e mantém o campo", async () => {
    const turno = await ateRenda();
    await turno("xyz");
    await turno("abc");
    const s = await turno("hmm");
    expect(s.reply).toBe("Pode conferir e mandar de novo?\nRenda mensal de Letícia Andrade?");
    expect(s.fluxo).toMatchObject({ campoAtual: "renda" });
  });

  it("pergunta fora do assunto: o modelo responde e a ficha continua", async () => {
    const turno = await ateRenda();
    let s = await turno("qual o horário da imobiliária?");
    expect(s.reply).toBe("O horário é das 9h às 18h.\n\nContinuando a ficha de Letícia Andrade: Renda mensal de Letícia Andrade?");
    expect(s.fluxo).toMatchObject({ kind: "credito", campoAtual: "renda", pausado: false });
    s = await turno("8500");
    expect(ultimo("lead.upsert")!.args.campos).toEqual({ v: 1, tipo: "residencial", pretendente: { rendaMensal: 8500 } });
  });

  it("corrigir, resumo e cancelar", async () => {
    const turno = await ateRenda();
    await turno("8 mil");
    let s = await turno("corrigir renda");
    expect(s.reply).toBe("Renda mensal de Letícia Andrade?");
    s = await turno("9 mil");
    expect(ultimo("lead.upsert")!.args.campos).toEqual({ v: 1, tipo: "residencial", pretendente: { rendaMensal: 9000 } });
    s = await turno("resumo");
    expect(s.reply).toContain("Já tenho: CPF ***.***.777-35, Letícia Andrade, CLT, renda R$ 9.000,00");
    expect(s.reply).toContain("Falta: valor do aluguel");
    expect(s.reply).not.toContain(CPF_D);
    s = await turno("corrigir cpf");
    expect(s.reply).toContain("O CPF identifica a ficha");
    s = await turno("cancelar");
    expect(s.reply).toBe("Parei. A ficha de Letícia Andrade fica salva como rascunho na tela.");
    expect(s.fluxo).toBeNull();
  });

  it("revisão com faltantes volta ao campo que falta", async () => {
    const turno = await ateRenda();
    await turno("8 mil");
    await turno("2500");
    await turno("não tem");
    await turno("não tem");
    await turno("1");
    // O servidor diz que ainda falta o IPTU (ex.: alguém apagou pela tela).
    faltantesForcados = ["Valor do IPTU"];
    const s = await turno("não");
    expect(s.reply).toBe("Ainda falta: valor do iptu.\nValor do IPTU? (se não tiver, diga \"não tem\")");
    expect(s.fluxo).toMatchObject({ etapa: "coleta", campoAtual: "iptu" });
  });
});

describe("status", () => {
  it("como está a análise da Letícia? → credit.status, resposta do sistema", async () => {
    statusResposta = { status: 200, body: {
      lead: { id: "lc9", nome: "Letícia Andrade", status: "aprovado" },
      ultima: { rotulo: "Aprovado", createdAt: "2026-10-09T15:00:00.000Z", completedAt: "2026-10-10T15:00:00.000Z" },
      link: "/locacao/pessoas/clientes/lc9",
    } };
    const s = await conversa()("como está a análise da Letícia?");
    expect(ultimo("credit.status")!.args).toEqual({ nome: "Letícia" });
    expect(s.reply).toMatch(/^Letícia Andrade: Aprovado desde 10\/10\/2026\. https?:\/\/.+\/locacao\/pessoas\/clientes\/lc9$/);
    expect(llm).not.toHaveBeenCalled();
  });

  it("não achou: frase fixa", async () => {
    const s = await conversa()("crédito do João");
    expect(s.reply).toBe("Não achei análise de crédito de João.");
  });
});

describe("memória", () => {
  it("turno da ficha não compacta o histórico", async () => {
    const turno = conversa();
    await turno("faz a ficha de crédito da Letícia Andrade");
    for (let i = 0; i < 9; i++) await turno("sim");
    // Nenhuma chamada de resumo: o único uso do modelo seria o `compact`.
    expect(llm.mock.calls.some((c) => String((c[0] as { system?: string }).system ?? "").startsWith("Resuma"))).toBe(false);
  });
});

// ─── Correções da revisão do M2 ─────────────────────────────────────────────

describe("B1: CPF com espaço ou ponto antes do DV é aceito E redigido", () => {
  it.each(["111 444 777 35", "111.444.777.35", "111.444.777-35", "11144477735"])("%s", async (cpf) => {
    const nada = vi.fn(async () => null);
    expect(await interpretarCampo("cpf", cpf, nada)).toEqual({ tipo: "ok", valor: CPF_D });
    expect(redigir(`o cpf é ${cpf}`)).toBe("o cpf é ⟨CPF⟩");
    expect(redigirCredito(`o cpf é ${cpf}`)).toBe("o cpf é ⟨CPF⟩");
  });
  it("CNPJ com espaço também", () => expect(redigir("cnpj 11 222 333 0001 81")).toBe("cnpj ⟨CNPJ⟩"));
});

describe("B2: o state do turno de crédito não guarda valor nem CPF", () => {
  it.each(["8 mil", "8 mil reais", "R$ 8.000,00", "8.000", "8500", "oito mil e quinhentos", "12k", "novecentos reais",
    "dois mil trezentos e cinquenta", "1 milhão", "um milhão de reais"])("redigirCredito(%s)", (v) => {
    expect(redigirCredito(`renda ${v}`)).toBe("renda ⟨VALOR⟩");
  });

  it("número sem valor não é redigido", () => expect(redigirCredito("um apartamento de dois quartos, opção 3")).toBe("um apartamento de dois quartos, opção 3"));

  it("reply no state é redigido; a resposta real sai por `respostaDoTurno`", async () => {
    const turno = conversa();
    await turno("faz a ficha de crédito da Letícia Andrade");
    await turno("sim");
    await turno(CPF);
    await turno("CLT");
    await turno("analista");
    const s = await turno("8 mil");
    expect(s.reply).toContain("R$ 8.000,00");
    expect(s.replyNoState).not.toContain("8.000");
    expect(s.replyNoState).toContain("⟨VALOR⟩");
    expect(JSON.stringify(s.messages)).not.toMatch(/8 mil|8\.000/);
    expect(s.piiMap).toEqual({});
  });
});

describe("D2: atestação só com SIM explícito", () => {
  it.each(["sim", "Sim!", "s", "confirmo", "autorizo", "sim, ela autorizou", "sim ele autorizou", "autorizou"])("vale: %s", (t) =>
    expect(confirmaEstrito(t)).toBe(true));
  it.each(["ok", "beleza", "👍", "pode", "claro", "sim mas espera"])("não vale: %s", (t) => expect(confirmaEstrito(t)).toBe(false));

  it("'ok' repete a pergunta e não grava consentimento", async () => {
    const turno = conversa();
    await turno("faz a ficha de crédito da Letícia Andrade");
    const s = await turno("ok");
    expect(s.reply).toContain("Preciso dessa confirmação antes de qualquer dado.");
    expect(s.fluxo).toMatchObject({ etapa: "atestacao" });
    expect((s.fluxo as { consentimento?: unknown }).consentimento).toBeUndefined();
  });
});

describe("D4: status, score e 'aprova' no meio da ficha", () => {
  async function naRenda() {
    const turno = conversa();
    await turno("faz a ficha de crédito da Letícia Andrade");
    await turno("sim");
    await turno(CPF);
    await turno("CLT");
    await turno("analista");
    return turno;
  }
  it("status: responde e continua a ficha", async () => {
    const turno = await naRenda();
    const s = await turno("crédito do João");
    expect(s.reply).toBe("Não achei análise de crédito de João.\n\nContinuando a ficha de Letícia Andrade: Renda mensal de Letícia Andrade?");
    expect(ultimo("credit.status")!.args).toEqual({ nome: "João" });
    expect(s.fluxo).toMatchObject({ campoAtual: "renda" });
  });
  it("score: recusa fixa e continua", async () => {
    const turno = await naRenda();
    const s = await turno("qual o score dela?");
    expect(s.reply).toContain(TEXTO_SCORE);
    expect(s.reply).toContain("Continuando a ficha");
    expect(llm).not.toHaveBeenCalled();
  });
  it("aprova aí: o Max não aprova", async () => {
    const turno = await naRenda();
    const s = await turno("aprova aí");
    expect(s.reply).toContain(TEXTO_APROVAR);
    expect(chamadas.some((c) => c.verb === "credit.request")).toBe(false);
  });
  it.each(["aprova a proposta do João", "aprova o contrato", "pode aprovar o desconto", "aprovar o orçamento", "aprova aí", "aprova ela"])(
    "fora da ficha, sem 'crédito', não intercepta: %s", (t) => expect(pedeCredito(t)).toBeNull());
  it("fora da ficha: 'aprova aí o crédito do João' também é a frase fixa", async () => {
    expect(pedeCredito("aprova aí o crédito do João")).toBe("aprovar");
    const s = await conversa()("aprova aí o crédito do João, ele é gente boa");
    expect(s.reply).toBe(TEXTO_APROVAR);
  });
});

describe("E1/E2: extrator sem valor inventado; dois valores por rótulo", () => {
  it.each(["não sei ainda, vou perguntar", "vou ver com ela", "depois te falo", "sei lá"])("incerteza não chega ao modelo: %s", async (t) => {
    const ext = vi.fn(async () => ({ opcao: 1, trecho: "x" }));
    for (const campo of ["vinculo", "renda", "nome", "profissao", "vaiMorar"] as const) {
      expect((await interpretarCampo(campo, t, ext)).tipo).not.toBe("ok");
    }
    expect(ext).not.toHaveBeenCalled();
  });
  it("vínculo sem sinônimo na frase: o modelo não é chamado (nada a escolher)", async () => {
    const ext = vi.fn(async () => ({ opcao: 1 }));
    expect(await interpretarCampo("vinculo", "trabalha numa loja do shopping", ext)).toEqual({ tipo: "vazio" });
    expect(ext).not.toHaveBeenCalled();
  });
  it("valores por rótulo", () => {
    expect(valoresRotulados("aluguel 3 mil, condomínio 800")).toEqual({ aluguel: 3000, condominio: 800 });
    expect(valoresRotulados("condomínio 650 e iptu 120")).toEqual({ condominio: 650, iptu: 120 });
    expect(valoresRotulados("aluguel 2.500, condomínio não tem")).toEqual({ aluguel: 2500, condominio: 0 });
  });
  it("valor dentro de pergunta não é aceito", async () => {
    const nada = vi.fn(async () => null);
    expect(await interpretarCampo("renda", "8 mil ou somo o bico?", nada)).toMatchObject({ tipo: "erro" });
  });
  it("no grafo: 'aluguel 3 mil, condomínio 800' grava os dois e pula o condomínio", async () => {
    const turno = conversa();
    await turno("faz a ficha de crédito da Letícia Andrade");
    await turno("sim");
    await turno(CPF);
    await turno("CLT");
    await turno("analista");
    await turno("8 mil");
    const s = await turno("aluguel 3 mil, condomínio 800");
    expect(ultimo("lead.upsert")!.args.campos).toEqual({ v: 1, tipo: "residencial", locacao: { valorAluguel: 3000, valorCondominio: 800 } });
    expect(s.reply).toBe("Anotei: aluguel R$ 3.000,00, condomínio R$ 800,00.\nValor do IPTU? (se não tiver, diga \"não tem\")");
  });
});

describe("revisão: só o SIM estrito avança", () => {
  it.each(["ok", "👍"])("'%s' na revisão não chega ao envio e mantém a etapa", async (fala) => {
    const turno = conversa();
    await turno("faz a ficha de crédito da Letícia Andrade");
    await turno("sim");
    await turno(CPF);
    await turno("CLT");
    await turno("analista");
    await turno("8 mil");
    await turno("2500");
    await turno("não tem");
    await turno("não tem");
    await turno("1");
    let s = await turno("não");
    expect(s.fluxo).toMatchObject({ etapa: "revisao" });
    s = await turno(fala);
    expect(s.reply).not.toContain("próxima versão");
    expect(s.toolLog.some((t: { outcome: string }) => t.outcome === "credito_envio_m3")).toBe(false);
    expect(s.fluxo).toMatchObject({ kind: "credito", etapa: "revisao" });
  });
});

describe("cofre: subchave própria e AAD = thread", () => {
  it("o cofre de uma thread não abre em outra", () => {
    const c = cifrarCofre('{"cpf":"11144477735"}', "org1:a");
    expect(c).not.toContain(CPF_D);
    expect(decifrarCofre(c, "org1:a")).toBe('{"cpf":"11144477735"}');
    expect(() => decifrarCofre(c, "org1:b")).toThrow();
  });
});

/** Caminho de erro do `runTurn` (`comRastro`): com a flag ligada, o texto vai redigido. */
function itDbErro() {
  const hasDb = Boolean(process.env.DATABASE_URL);
  (hasDb ? it : it.skip)("turno que falha grava a fala redigida (CPF e renda)", async () => {
    const ORG = "org-credito-erro";
    vi.mocked(resolveIdentity).mockResolvedValue({ kind: "identified", candidate: { ...usuario, orgId: ORG } } as never);
    acao.mockRejectedValue(new Error("ImobPro fora"));
    const { query } = await import("@/lib/db");
    const id = `erro-${Math.random()}`;
    try {
      await expect(runTurn({ messageId: id, fromPhone: "5511900000778", groupId: null, kind: "text",
        text: "faz a ficha de crédito da Letícia Andrade, cpf 111 444 777 35, renda 8 mil", mediaUrl: null, mimeType: null,
        timestampMs: null, senderName: "Olavo", replyToMessageId: null } as Parameters<typeof runTurn>[0])).rejects.toThrow();
      const [linha] = await query<{ inbound_text: string; error: string }>(
        `SELECT inbound_text, error FROM conversation_turn WHERE message_id = $1`, [id]);
      expect(linha!.error).toContain("ImobPro fora");
      expect(linha!.inbound_text).toContain("Andrade");
      expect(linha!.inbound_text).not.toMatch(/111 444 777 35|8 mil/);
    } finally {
      await query(`DELETE FROM conversation_turn WHERE org_id = $1`, [ORG]);
      await query(`DELETE FROM checkpoint_writes WHERE thread_id LIKE $1`, [`${ORG}:%`]);
      await query(`DELETE FROM checkpoint_blobs WHERE thread_id LIKE $1`, [`${ORG}:%`]);
      await query(`DELETE FROM checkpoints WHERE thread_id LIKE $1`, [`${ORG}:%`]);
    }
  }, 30_000);
}

/**
 * Auditoria de PII (spec M2 + revisão): ficha pelo `runTurn` de verdade
 * (checkpointer Postgres, `conversation_turn`, `memory_facts`) com o CPF em 3
 * formatos, renda "8 mil"/"8.000,00", uma pausa (o `answer` roda) e a flag
 * desligada no meio. Nada disso aparece nos 5 lugares. Controle positivo: o
 * sobrenome da pretendente ESTÁ lá — a busca acharia o resto se estivesse.
 * D3: o `extractFacts` não roda em turno de crédito (o mock devolveria o CPF).
 */
describe("auditoria de PII no banco", () => {
  itDbErro();

  const hasDb = Boolean(process.env.DATABASE_URL);
  const itDb = hasDb ? it : it.skip;
  const ORG = "org-credito-pii";
  const FONE = "5511900000777";

  itDb("CPF e renda fora de checkpoints, conversation_turn e memory_facts; extractFacts não chamado", async () => {
    vi.mocked(resolveIdentity).mockResolvedValue({ kind: "identified", candidate: { ...usuario, orgId: ORG } } as never);
    const sistemas: string[] = [];
    llm.mockImplementation(async (p: { system?: string; toolChoice?: string }) => {
      sistemas.push(String(p.system ?? ""));
      if (String(p.system).includes("FATOS DURÁVEIS")) return { text: `{"cpf_da_cliente":"${CPF_D}","renda":"8 mil"}`, toolCalls: [], usage: uso };
      return { text: "O horário é das 9h às 18h.", toolCalls: [], usage: uso };
    });
    const { query, db } = await import("@/lib/db");
    const limpar = async () => {
      await query(`DELETE FROM checkpoint_writes WHERE thread_id LIKE $1`, [`${ORG}:%`]);
      await query(`DELETE FROM checkpoint_blobs WHERE thread_id LIKE $1`, [`${ORG}:%`]);
      await query(`DELETE FROM checkpoints WHERE thread_id LIKE $1`, [`${ORG}:%`]);
      await query(`DELETE FROM conversation_turn WHERE org_id = $1`, [ORG]);
      await query(`DELETE FROM memory_facts WHERE org_id = $1`, [ORG]);
    };
    await limpar();
    try {
      let n = 0;
      const falar = async (text: string) => {
        const r = await runTurn({ messageId: `pii-${++n}-${Math.random()}`, fromPhone: FONE, groupId: null, kind: "text", text,
          mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null } as Parameters<typeof runTurn>[0]);
        await r.afterReply();
        sensiveis.push(r.sensivel);
        return r.reply ?? "";
      };
      const sensiveis: (boolean | undefined)[] = [];
      await falar("faz a ficha de crédito da Letícia Andrade");
      await falar("sim");
      expect(await falar(`o cpf é ${CPF}`)).toContain("***.***.777-35");
      await falar("CLT");
      // Pausa no campo profissão: o `answer` roda com o CPF (espaço) na mensagem.
      expect(await falar("o cpf dela é 111 444 777 35, qual o horário?")).toContain("Continuando a ficha");
      await falar("analista");
      expect(await falar("8 mil")).toContain("R$ 8.000,00");
      // Status no meio da ficha com o CPF com ponto antes do DV.
      await falar("crédito do 111.444.777.35");
      // Flag desligada no meio: o turno vai ao modelo com valor e CPF na mensagem.
      delete process.env.MAX_CREDITO;
      await falar("o aluguel é R$ 8.000,00 e o cpf 111.444.777-35, tá bom?");
      expect(ultimo("lead.upsert")!.args.cpf).toBe(CPF_D);
      // Todos os turnos acima passaram pela ficha (o último pela flag desligada no meio).
      expect(sensiveis.length).toBe(9);
      for (const s of sensiveis) expect(s).toBe(true);

      const conta = async (padrao: string) => {
        const [linha] = await query<{ n: string }>(
          `SELECT (
             (SELECT count(*) FROM checkpoints WHERE thread_id LIKE $2 AND (checkpoint::text LIKE $1 OR metadata::text LIKE $1)) +
             (SELECT count(*) FROM checkpoint_blobs WHERE thread_id LIKE $2 AND encode(blob, 'escape') LIKE $1) +
             (SELECT count(*) FROM checkpoint_writes WHERE thread_id LIKE $2 AND encode(blob, 'escape') LIKE $1) +
             (SELECT count(*) FROM conversation_turn t WHERE org_id = $3 AND row_to_json(t)::text LIKE $1) +
             (SELECT count(*) FROM memory_facts m WHERE org_id = $3 AND row_to_json(m)::text LIKE $1)
           )::text AS n`,
          [padrao, `${ORG}:%`, ORG]
        );
        return Number(linha!.n);
      };
      expect(await conta("%Andrade%")).toBeGreaterThan(0);
      for (const p of [CPF_D, CPF, "111 444 777 35", "111.444.777.35", "8 mil", "8.000,00", "8.000"]) {
        expect(await conta(`%${p}%`), p).toBe(0);
      }
      expect(sistemas.some((s) => s.includes("FATOS DURÁVEIS"))).toBe(false);
      // Turno comum, sem ficha (depois da contagem: este alimenta a memória): não sensível.
      sensiveis.length = 0;
      await falar("bom dia, tudo bem?");
      expect(sensiveis[0]).toBeFalsy();
    } finally {
      await limpar();
      await db().end();
    }
  }, 30_000);
});
