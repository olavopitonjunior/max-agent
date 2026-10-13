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
/** M3: resposta do `credit.request`; "sem_resposta" = timeout/5xx (o cliente devolve null). */
let requestResposta: { status: number; body: Record<string, unknown> } | "sem_resposta" | null = null;
/** M3: `credit.status{leaseClientId}` forçado; null = o que o fake guardou em `analises`. */
let statusPorLead: { status: number; body: Record<string, unknown> } | null = null;
let analises: Record<string, unknown>[] = [];
const APROVADO = { status: 200, body: { requestId: "r1", decision: "aprovado", rotulo: "Aprovado", justificativa: "Bom histórico de pagamentos.",
  podePedirHumanizada: false, leadLink: "/locacao/pessoas/clientes/lc1" } };

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
    case "credit.status": {
      if (typeof a.leaseClientId !== "string") return statusResposta ?? { status: 404, body: { error: "nao_encontrada" } };
      if (statusPorLead) return statusPorLead;
      const lead = leads.find((l) => l.id === a.leaseClientId);
      if (!lead) return { status: 404, body: { error: "nao_encontrada" } };
      const ultima = [...analises].reverse().find((x) => x.leaseClientId === lead.id) ?? null;
      return { status: 200, body: { lead: { id: lead.id, nome: lead.nome }, ultima, link: `/locacao/pessoas/clientes/${lead.id}` } };
    }
    case "credit.request": {
      if (!p.idempotencyKey || typeof a.leaseClientId !== "string") return { status: 400, body: { error: "Bad Request" } };
      if (requestResposta === "sem_resposta") return null;
      const r = requestResposta ?? APROVADO;
      // O servidor guarda a análise (200/202): o `credit.status` passa a vê-la.
      if (r.status === 200 || r.status === 202) {
        analises.push({ leaseClientId: a.leaseClientId, createdAt: new Date().toISOString(), status: r.status === 202 ? "processing" : "completed",
          decision: r.body.decision ?? "pendente", rotulo: r.body.rotulo ?? "Em análise", justificativa: r.body.justificativa ?? null, reenvioArriscado: false });
      }
      return r;
    }
    case "proposal.preflight":
      return { status: 200, body: { modelo: true, assinatura: true } };
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
  requestResposta = null;
  statusPorLead = null;
  analises = [];
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
afterEach(() => { delete process.env.MAX_CREDITO; delete process.env.MAX_CREDITO_ENVIO; });

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
    ["faz a análise de crédito do Pedro Teste Recusado", "abrir"],
    ["quero uma ficha de crédito da Ana Aprovada", "abrir"],
    ["o crédito do João Silva recusado?", "status"],
    ["pode ver se o crédito do João foi recusado", "status"],
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
    expect(nomeCitado("quero fazer uma análise de crédito de um inquilino")).toBeNull();
    expect(nomeCitado("faz a ficha da minha cliente")).toBeNull();
    expect(nomeCitado("análise de crédito de uma candidata nova")).toBeNull();
    expect(nomeCitado("análise de crédito da minha cliente Letícia")).toBeNull();
    expect(nomeCitado("faz a análise de crédito da Ana Maria")).toBe("Ana Maria");
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

  it("resposta que nomeia outro campo ('renda é 9 mil' na pergunta do aluguel) grava a renda e volta ao aluguel", async () => {
    const turno = await ateRenda();
    await turno("8 mil");
    const s = await turno("renda é 9 mil");
    expect(ultimo("lead.upsert")!.args.campos).toEqual({ v: 1, tipo: "residencial", pretendente: { rendaMensal: 9000 } });
    expect(s.reply).toMatch(/Valor do aluguel/);
    const a = await turno("2500");
    expect(ultimo("lead.upsert")!.args.campos).toMatchObject({ locacao: { valorAluguel: 2500 } });
    expect(a.reply).not.toMatch(/Valor do aluguel/);
  });

  it("o mesmo campo nomeado ('aluguel de 2500' na pergunta do aluguel) segue normal", async () => {
    const turno = await ateRenda();
    await turno("8 mil");
    await turno("aluguel de 2500");
    expect(ultimo("lead.upsert")!.args.campos).toMatchObject({ locacao: { valorAluguel: 2500 } });
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

// ─── M3: envio, resultado e desdobramentos ──────────────────────────────────

/** Ficha completa até o resumo (m11). O SIM seguinte é a m12. */
async function ateRevisao() {
  const turno = conversa();
  for (const fala of ["faz a ficha de crédito da Letícia Andrade", "sim", CPF, "CLT", "analista", "8 mil", "2500", "não tem", "não tem", "1"]) {
    await turno(fala);
  }
  const s = await turno("não");
  expect(s.fluxo).toMatchObject({ etapa: "revisao", leaseClientId: "lc1" });
  return turno;
}
const pedidos = () => chamadas.filter((c) => c.verb === "credit.request");
const LINK_LC1 = /https?:\/\/\S+\/locacao\/pessoas\/clientes\/lc1$/m;
const ROTULO_DE: Record<string, string> = { aprovado: "Aprovado", revisao: "Pré-aprovado", reprovado: "Reprovado", pendencia: "Pendência", erro: "Erro" };

describe("M3: sub-flag MAX_CREDITO_ENVIO", () => {
  it("desligada: o SIM da revisão é o do M2 — nada enviado", async () => {
    const turno = await ateRevisao();
    const s = await turno("SIM");
    expect(s.reply).toMatch(/^Envio entra na próxima versão/);
    expect(pedidos()).toEqual([]);
  });

  it("controle: ligada, o MESMO roteiro envia (o oráculo acima sabe falhar)", async () => {
    process.env.MAX_CREDITO_ENVIO = "true";
    const turno = await ateRevisao();
    await turno("SIM");
    expect(pedidos()).toHaveLength(1);
  });

  it("MAX_CREDITO_ENVIO sem MAX_CREDITO não liga nada", () => {
    process.env.MAX_CREDITO_ENVIO = "true";
    delete process.env.MAX_CREDITO;
    expect(credito.envioLigado()).toBe(false);
  });
});

describe("M3: envio", () => {
  beforeEach(() => { process.env.MAX_CREDITO_ENVIO = "true"; });

  it("feliz (200 aprovado): preflight, request com a chave do SIM, resultado e a proposta aberta com nome e aluguel", async () => {
    const turno = await ateRevisao();
    const antes = chamadas.length;
    let s = await turno("SIM");
    expect(chamadas.slice(antes).map((c) => c.verb)).toEqual(["credit.preflight", "credit.status", "credit.request"]);
    const req = pedidos()[0]!;
    expect(req.key).toBe("m12");
    expect(req.args).toEqual({ leaseClientId: "lc1", consentimento: { texto: TEXTO_ATESTACAO, messageId: "m2" } });
    expect(s.reply).toBe("Aprovado na Upestate. Quer que eu abra a proposta de locação de Letícia Andrade?");
    expect(s.fluxo).toMatchObject({ kind: "credito", etapa: "resultado", decisao: "aprovado" });
    expect(semCpf(s.fluxo)).toBe(true);

    s = await turno("sim");
    expect(pedidos()).toHaveLength(1);
    expect(s.reply).toMatch(/^Abrindo a proposta de locação de Letícia Andrade\.\n\n/);
    expect(s.fluxo).toMatchObject({ kind: "proposta", natureza: "locacao", etapa: "coleta", leaseClientId: "lc1",
      dados: { proponente: { nome: "Letícia Andrade" }, valor: 2500, finalidade: "residencial" } });
    // O CPF não vai para a proposta (o checkpoint seguiria com ele).
    expect(semCpf(s.fluxo)).toBe(true);
    // Ligada ao lead: a coleta não pede Inquilino/CPF nem aluguel de novo (o `proposal.create` preenche).
    expect(s.reply).not.toContain("CPF");
    expect(s.reply).not.toContain("Valor do aluguel");
    expect(llm).not.toHaveBeenCalled();
  });

  it("proposta ligada ao lead: o create leva o leaseClientId e o resumo some com nome/CPF/telefone crus", async () => {
    const turno = await ateRevisao();
    await turno("SIM");
    await turno("sim");
    llm.mockImplementation(async (p: { toolChoice?: string }) => {
      if (p.toolChoice === "preencher_proposta") {
        return { text: "", toolCalls: [{ name: "preencher_proposta",
          args: { imovel: { endereco: "Rua Senador Godoi, 606" }, proponente: { telefone: "11999990000" } } }], usage: uso };
      }
      return { text: "", toolCalls: [], usage: uso };
    });
    let s = await turno("Rua Senador Godoi, 606, tel 11 99999-0000");
    expect(s.fluxo).toMatchObject({ kind: "proposta", etapa: "revisao", leaseClientId: "lc1" });
    expect(s.reply).toContain("Inquilino: Letícia Andrade (dados do lead analisado)");
    expect(s.reply).not.toContain("11999990000");

    acao.mockImplementation((async (p: { verb: string; args: Record<string, unknown>; idempotencyKey?: string }) => {
      const base = await imobpro(p);
      return p.verb === "proposal.create" ? { status: 201, body: { proposal: { id: "p1", codigo: "P-1" } } } : base;
    }) as never);
    s = await turno("sim");
    expect(ultimo("proposal.create")!.args).toMatchObject({ leaseClientId: "lc1" });
    expect(s.fluxo).toMatchObject({ kind: "proposta", etapa: "ajustes", propostaId: "p1" });
  });

  it("create recusa a POSSE do lead (404): oferece abrir sem vínculo", async () => {
    const turno = await ateRevisao();
    await turno("SIM");
    await turno("sim");
    llm.mockImplementation(async (p: { toolChoice?: string }) => {
      if (p.toolChoice === "preencher_proposta") {
        return { text: "", toolCalls: [{ name: "preencher_proposta",
          args: { imovel: { endereco: "Rua Senador Godoi, 606" }, proponente: { telefone: "11999990000" } } }], usage: uso };
      }
      return { text: "", toolCalls: [], usage: uso };
    });
    await turno("Rua Senador Godoi, 606, tel 11 99999-0000");

    acao.mockImplementation((async (p: { verb: string; args: Record<string, unknown>; idempotencyKey?: string }) => {
      const base = await imobpro(p);
      return p.verb === "proposal.create" ? { status: 404, body: { error: "lead_nao_encontrado" } } : base;
    }) as never);
    const s = await turno("sim");
    expect(s.reply).toBe("Não consegui ligar a proposta ao lead agora. Quer abrir a proposta sem o vínculo? (SIM)");
    expect(s.fluxo).toMatchObject({ kind: "proposta", ofertaSemVinculo: true, leaseClientId: "lc1" });
  });

  it("aprovado e NÃO: encerra com o link do lead", async () => {
    const turno = await ateRevisao();
    await turno("SIM");
    const s = await turno("não");
    expect(s.reply).toMatch(/^Certo\. A análise fica na tela do lead: /);
    expect(s.reply).toMatch(LINK_LC1);
    expect(s.fluxo).toBeNull();
  });

  it("202: 'Enviei… te aviso aqui' e o fluxo acaba (o aviso vem pelo credit_result)", async () => {
    requestResposta = { status: 202, body: { requestId: "r1", pending: true, leadLink: "/locacao/pessoas/clientes/lc1" } };
    const turno = await ateRevisao();
    const s = await turno("SIM");
    expect(s.reply).toBe(credito.TEXTO_ENVIO_PENDENTE);
    expect(s.fluxo).toBeNull();
  });

  it.each([
    [402, { error: "Teto mensal da análise de crédito atingido" }, "O limite mensal de análises da imobiliária foi atingido. Fale com o administrador."],
    [409, { error: "em_andamento", inProgress: true }, "Este CPF já tem uma análise em andamento na Upestate."],
    [503, { error: "Upestate não está configurada nesta instância.", notConfigured: true }, "Análise de crédito indisponível agora."],
  ])("%i: texto fixo e o fluxo acaba", async (status, body, texto) => {
    requestResposta = { status, body };
    const turno = await ateRevisao();
    const s = await turno("SIM");
    expect(s.reply).toBe(texto);
    expect(s.fluxo).toBeNull();
  });

  it("422 cpf_divergente: texto fixo com o link", async () => {
    requestResposta = { status: 422, body: { error: "cpf_divergente" } };
    const turno = await ateRevisao();
    const s = await turno("SIM");
    expect(s.reply).toMatch(/^O CPF da ficha não bate com o do cadastro\. Confira na tela: /);
    expect(s.reply).toMatch(LINK_LC1);
  });

  it("422 faltantes: volta ao campo que falta", async () => {
    requestResposta = { status: 422, body: { error: "Dados incompletos para a análise de crédito", missing: ["Profissão do pretendente"] } };
    const turno = await ateRevisao();
    const s = await turno("SIM");
    expect(s.reply).toBe("Ainda falta: profissão do pretendente.\nProfissão de Letícia Andrade?");
    expect(s.fluxo).toMatchObject({ etapa: "coleta", campoAtual: "profissao" });
    expect((s.fluxo as { chave?: unknown }).chave).toBeUndefined();
  });

  it("preflight com faltantes antes do envio: volta à coleta e NÃO envia", async () => {
    const turno = await ateRevisao();
    faltantesForcados = ["Renda mensal do pretendente"];
    const s = await turno("SIM");
    expect(s.reply).toBe("Ainda falta: renda mensal do pretendente.\nRenda mensal de Letícia Andrade?");
    expect(pedidos()).toEqual([]);
  });

  it("412: refaz a atestação; o SIM volta ao resumo e o novo envio leva o novo consentimento", async () => {
    requestResposta = { status: 412, body: { requiresConsent: true } };
    const turno = await ateRevisao();
    let s = await turno("SIM");
    expect(s.reply).toMatch(/^A autorização não ficou registrada\. Vou precisar de CPF, renda e vínculo de Letícia Andrade\./);
    expect(s.fluxo).toMatchObject({ etapa: "atestacao" });
    expect((s.fluxo as { consentimento?: unknown }).consentimento).toBeUndefined();
    s = await turno("sim");
    expect(s.reply).toMatch(/^Obrigado\. Vou consultar Letícia Andrade .* Responda \*SIM\* para enviar\.$/);
    requestResposta = null;
    s = await turno("SIM");
    expect(pedidos()).toHaveLength(2);
    expect(pedidos()[1]!).toMatchObject({ key: "m14", args: { consentimento: { texto: TEXTO_ATESTACAO, messageId: "m13" } } });
    expect(s.fluxo).toMatchObject({ etapa: "resultado" });
  });

  it("D1: análise recente (< 24 h) e concluída: NÃO envia; diz qual e oferece consulta nova", async () => {
    const turno = await ateRevisao();
    const ha2h = new Date(Date.now() - 2 * 3600_000);
    analises.push({ leaseClientId: "lc1", createdAt: ha2h.toISOString(), status: "completed", decision: "reprovado", rotulo: "Reprovado" });
    const s = await turno("SIM");
    const dm = ha2h.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
    expect(s.reply).toMatch(new RegExp(`^Já existe uma análise de Letícia Andrade de ${dm.replace("/", "\\/")}: Reprovado\\. Veja na tela: `));
    expect(s.reply).toMatch(LINK_LC1);
    expect(s.reply).toMatch(/Quer fazer uma consulta nova mesmo assim\? Responda \*SIM\*\.$/);
    expect(pedidos()).toEqual([]);
    expect(s.fluxo).toMatchObject({ etapa: "revisao", novaConsulta: true });
  });

  it("D1: lead já existente (achado pelo CPF): a mensagem usa o nome da ficha, não 'do pretendente'", async () => {
    leads.push({ id: "lc1", nome: "Mariana Lima", cpf: CPF_D, credito: { pretendente: { documento: CPF_D, nomeCompleto: "Mariana Lima" } } as Credito });
    const turno = conversa();
    let s = await turno("quero fazer uma análise de crédito");
    for (const fala of ["sim", CPF, "CLT", "analista", "8 mil", "2500", "não tem", "não tem", "1", "não"]) s = await turno(fala);
    expect(s.fluxo).toMatchObject({ etapa: "revisao", leaseClientId: "lc1" });
    analises.push({ leaseClientId: "lc1", createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(), status: "completed", decision: "reprovado", rotulo: "Reprovado" });
    s = await turno("SIM");
    expect(s.reply).toMatch(/^Já existe uma análise de Mariana Lima de \d{2}\/\d{2}: Reprovado\./);
    expect(pedidos()).toEqual([]);
  });

  it("D1: depois da oferta, o SIM consulta de novo (uma vez, com a chave do SIM)", async () => {
    const turno = await ateRevisao();
    analises.push({ leaseClientId: "lc1", createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(), status: "completed", decision: "aprovado", rotulo: "Aprovado" });
    await turno("SIM");
    expect(pedidos()).toEqual([]);
    const s = await turno("SIM");
    expect(pedidos()).toHaveLength(1);
    expect(s.reply).toMatch(/^Aprovado na Upestate\./);
  });

  it("D1: depois da oferta, NÃO encerra sem enviar", async () => {
    const turno = await ateRevisao();
    analises.push({ leaseClientId: "lc1", createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(), status: "completed", decision: "aprovado", rotulo: "Aprovado" });
    await turno("SIM");
    const s = await turno("não");
    expect(pedidos()).toEqual([]);
    expect(s.fluxo).toBeNull();
  });

  it("D1: corrigir a ficha depois da oferta desfaz a consulta nova (o SIM seguinte avisa de novo)", async () => {
    const turno = await ateRevisao();
    analises.push({ leaseClientId: "lc1", createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(), status: "completed", decision: "aprovado", rotulo: "Aprovado" });
    await turno("SIM");
    const c = await turno("corrigir aluguel");
    expect(c.fluxo).not.toHaveProperty("novaConsulta", true);
    await turno("2600");
    const s = await turno("SIM");
    expect(pedidos()).toEqual([]);
    expect(s.reply).toMatch(/^Já existe uma análise/);
  });

  it.each([
    ["em voo (processing), de 3 dias", { status: "processing", rotulo: "Em análise" }],
    ["reenvio arriscado, de 3 dias", { status: "failed", rotulo: "Falhou", reenvioArriscado: true }],
  ])("D1: %s: NÃO envia", async (_nome, extra) => {
    const turno = await ateRevisao();
    analises.push({ leaseClientId: "lc1", createdAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(), ...extra });
    const s = await turno("SIM");
    expect(s.reply).toMatch(/^Já existe uma análise de Letícia Andrade de \d{2}\/\d{2}: /);
    expect(pedidos()).toEqual([]);
  });

  it("D1: análise antiga (> 24 h, concluída): envia (controle)", async () => {
    const turno = await ateRevisao();
    analises.push({ leaseClientId: "lc1", createdAt: new Date(Date.now() - 25 * 3600_000).toISOString(), status: "completed", decision: "reprovado", rotulo: "Reprovado" });
    await turno("SIM");
    expect(pedidos()).toHaveLength(1);
  });

  it("D1: status sem resposta: nada é enviado e a revisão fica", async () => {
    const turno = await ateRevisao();
    statusPorLead = { status: 500, body: {} };
    const s = await turno("SIM");
    expect(s.reply).toMatch(/Nada foi enviado\.$/);
    expect(pedidos()).toEqual([]);
    expect(s.fluxo).toMatchObject({ etapa: "revisao" });
  });

  it("D1: cancelar em 'enviando' + nova ficha do mesmo CPF: não envia de novo (a anterior é recente)", async () => {
    requestResposta = { status: 202, body: { requestId: "r1", pending: true } };
    // 1º envio sai (202): o servidor guarda a análise em voo.
    const turno = await ateRevisao();
    await turno("SIM");
    expect(pedidos()).toHaveLength(1);
    // Nova ficha, mesmo CPF: o SIM é barrado pela análise recente.
    for (const fala of ["faz a ficha de crédito da Letícia Andrade", "sim", CPF, "não"]) await turno(fala);
    const s = await turno("SIM");
    expect(s.reply).toMatch(/^Já existe uma análise de Letícia Andrade de \d{2}\/\d{2}: Em análise\./);
    expect(pedidos()).toHaveLength(1);
  });

  it("D1: envio incerto, CANCELAR e nova ficha: se a anterior chegou ao servidor, não envia de novo", async () => {
    requestResposta = "sem_resposta";
    const turno = await ateRevisao();
    await turno("SIM");
    expect((await turno("cancelar")).reply).toMatch(/^Parei\. Se o envio chegou à Upestate/);
    // O servidor reconciliou: a análise existe.
    analises.push({ leaseClientId: "lc1", createdAt: new Date().toISOString(), status: "processing", rotulo: "Em análise" });
    requestResposta = null;
    for (const fala of ["faz a ficha de crédito da Letícia Andrade", "sim", CPF, "não"]) await turno(fala);
    const s = await turno("SIM");
    expect(s.reply).toMatch(/^Já existe uma análise/);
    expect(pedidos()).toHaveLength(1);
  });

  it("'ok' e 👍 na revisão não enviam (só o SIM estrito)", async () => {
    const turno = await ateRevisao();
    await turno("ok");
    await turno("👍");
    expect(pedidos()).toEqual([]);
  });
});

describe("M3: envio incerto (timeout/5xx) e idempotência", () => {
  beforeEach(() => { process.env.MAX_CREDITO_ENVIO = "true"; });

  it("sem resposta: texto fixo, a chave fica; 2º SIM e 'manda de novo' NÃO disparam outro envio", async () => {
    requestResposta = "sem_resposta";
    const turno = await ateRevisao();
    let s = await turno("SIM");
    expect(s.reply).toMatch(/^Não consegui confirmar o envio agora\. Não reenvie: veja o status na tela do lead \(https?:\/\/\S+\/lc1\) ou me pergunte daqui a pouco\.$/);
    expect(s.fluxo).toMatchObject({ etapa: "enviando", chave: { verbo: "credit.request", valor: "m12" } });
    expect(typeof (s.fluxo as { chave: { em?: number } }).chave.em).toBe("number");

    requestResposta = null; // o servidor voltaria a responder: mesmo assim, nada de reenvio
    s = await turno("SIM");
    expect(pedidos()).toHaveLength(1);
    expect(ultimo("credit.status")!.args).toEqual({ leaseClientId: "lc1" });
    expect(s.reply).toMatch(/^Ainda não encontrei sua análise\. Veja na tela do lead: \S+\/lc1, ou me pergunte daqui a pouco\.$/);
    expect(s.fluxo).toMatchObject({ etapa: "enviando", chave: { valor: "m12" } });

    s = await turno("manda de novo");
    expect(pedidos()).toHaveLength(1);
    expect(s.reply).toMatch(/^Ainda não encontrei/);
    s = await turno("reenvia a análise de crédito da Letícia");
    expect(pedidos()).toHaveLength(1);
    expect(s.reply).toMatch(/^Ainda não encontrei/);

    // A análise deste envio aparece (criada depois do SIM): responde e encerra.
    analises.push({ leaseClientId: "lc1", createdAt: new Date().toISOString(), status: "processing", rotulo: "Em análise" });
    s = await turno("e aí, chegou?");
    expect(pedidos()).toHaveLength(1);
    expect(s.reply).toMatch(/^Não reenviei\. A análise de Letícia Andrade está como "Em análise": /);
    expect(s.fluxo).toBeNull();
  });

  it("D2: análise ANTIGA do lead ('Aprovado' de antes do SIM) não conta como a deste envio", async () => {
    requestResposta = "sem_resposta";
    const turno = await ateRevisao();
    await turno("SIM");
    analises.push({ leaseClientId: "lc1", createdAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(), status: "completed", decision: "aprovado", rotulo: "Aprovado" });
    const s = await turno("SIM");
    expect(s.reply).toMatch(/^Ainda não encontrei sua análise/);
    expect(s.reply).not.toContain("Aprovado");
    expect(s.fluxo).toMatchObject({ etapa: "enviando" });
    expect(pedidos()).toHaveLength(1);
  });

  it("controle (mutante): o mesmo SIM sem a chave guardada DISPARA — o oráculo acima sabe falhar", async () => {
    requestResposta = "sem_resposta";
    const turno = await ateRevisao();
    const s = await turno("SIM");
    const comChave = s.fluxo as import("../credito").FluxoCredito;
    const deps = {
      acao: (verb: string, args: Record<string, unknown>, key?: string) => imobpro({ verb, args, idempotencyKey: key }),
      extrairProposta: async () => null, extrairCampos: async () => null,
    };
    const ctx = { texto: "SIM", messageId: "m13", policy: ["credit.read", "credit.request"] as never, agora: Date.now(), orgName: "FINCasa", thread: "t" };
    await credito.conduzirCredito(comChave, ctx, deps as never);
    expect(pedidos()).toHaveLength(1);
    // Mutante: sem a chave (e de volta à revisão), o SIM envia outra vez.
    const { chave: _chave, ...semChave } = comChave;
    await credito.conduzirCredito({ ...semChave, etapa: "revisao" }, ctx, deps as never);
    expect(pedidos()).toHaveLength(2);
    expect(pedidos()[1]!.key).toBe("m13");
  });

  it("outro assunto com envio incerto: o modelo responde e a chave fica", async () => {
    requestResposta = "sem_resposta";
    const turno = await ateRevisao();
    await turno("SIM");
    const s = await turno("qual o horário da imobiliária?");
    expect(s.reply).toBe("O horário é das 9h às 18h.");
    expect(s.fluxo).toMatchObject({ etapa: "enviando", chave: { valor: "m12" } });
    expect(pedidos()).toHaveLength(1);
  });
});

describe("M3: resultado sem score, restrição nem renda", () => {
  beforeEach(() => { process.env.MAX_CREDITO_ENVIO = "true"; });

  it("reprovado: só o rótulo e o link", async () => {
    requestResposta = { status: 200, body: { decision: "reprovado", rotulo: "Reprovado",
      justificativa: "Restrição no CPF 111.444.777-35, score 320 e renda de R$ 8.000 insuficiente", leadLink: "/locacao/pessoas/clientes/lc1" } };
    const turno = await ateRevisao();
    const s = await turno("SIM");
    expect(s.reply).toMatch(/^Letícia Andrade foi recusado\(a\) na análise automática da Upestate \(Reprovado\)\.\nO motivo está na tela do lead: /);
    expect(s.reply).toMatch(LINK_LC1);
    expect(s.reply).not.toMatch(/score|restri|renda|8\.000|777/i);
    expect(s.fluxo).toBeNull();
  });

  it("revisão (pré-aprovado): explica e dá o próximo passo — sem a justificativa", async () => {
    requestResposta = { status: 200, body: { decision: "revisao", rotulo: "Pré-aprovado", justificativa: "Requer análise da mesa.", podePedirHumanizada: true, leadLink: "/locacao/pessoas/clientes/lc1" } };
    const turno = await ateRevisao();
    const s = await turno("SIM");
    expect(s.reply).toMatch(/^Letícia Andrade ficou em revisão na análise automática da Upestate \(Pré-aprovado\) — ainda não é aprovação\.\nPróximo passo: pedir a análise humanizada, com comprovantes de renda, na tela do lead\. O motivo também está lá: /);
    expect(s.reply).toMatch(LINK_LC1);
    expect(s.reply).not.toContain("mesa");
  });

  it("revisão com rótulo 'Revisão' não repete o rótulo", async () => {
    requestResposta = { status: 200, body: { decision: "revisao", rotulo: "Revisão", podePedirHumanizada: false, leadLink: "/locacao/pessoas/clientes/lc1" } };
    const turno = await ateRevisao();
    const s = await turno("SIM");
    expect(s.reply).toMatch(/^Letícia Andrade ficou em revisão na análise automática da Upestate — ainda não é aprovação\.\nO motivo está na tela do lead: /);
  });

  /** B1: a justificativa (texto livre do provedor) nunca chega à resposta nem ao state, em nenhuma decisão. */
  const FRASES = [
    "Nome sujo", "Endividamento elevado", "Histórico de atrasos", "Pendências cadastrais", "Possui apontamentos",
    "Cheque sem fundo (CCF)", "Ação judicial de despejo", "Possui processos judiciais", "Falência decretada",
    "Recuperação judicial", "Rendimentos insuficientes", "Capacidade de pagamento insuficiente",
    "Consta no cadastro de devedores", "Antecedentes criminais",
  ];
  it.each(["aprovado", "revisao", "reprovado", "pendencia", "erro"])("B1 (%s): nenhuma das 14 frases no request nem no status", async (decision) => {
    const turno = await ateRevisao();
    for (const [i, frase] of FRASES.entries()) {
      requestResposta = { status: 200, body: { decision, rotulo: ROTULO_DE[decision], justificativa: frase, leadLink: "/locacao/pessoas/clientes/lc1" } };
      analises = [];
      // Volta à revisão a cada frase (ficha completa: o servidor não pede nada).
      if (i > 0) await turno("faz a ficha de crédito da Letícia Andrade"), await turno("sim"), await turno(CPF), await turno("não");
      const s = await turno("SIM");
      // O envio aconteceu de verdade nesta volta (senão o teste passaria em vão).
      expect(pedidos(), `${decision}: ${frase}`).toHaveLength(i + 1);
      const st = await turno("como está a análise da Letícia?");
      for (const x of [s, st]) {
        const tudo = JSON.stringify({ reply: x.reply, replyNoState: x.replyNoState, fluxo: x.fluxo, messages: x.messages });
        expect(tudo, `${decision}: ${frase}`).not.toContain(frase);
      }
      // A frase não some só porque o status falhou: o status disse o rótulo.
      statusResposta = { status: 200, body: { lead: { id: "lc1", nome: "Letícia Andrade" }, ultima: { rotulo: ROTULO_DE[decision], justificativa: frase }, link: "/locacao/pessoas/clientes/lc1" } };
      const st2 = await turno("como está a análise da Letícia?");
      expect(st2.reply).toContain(ROTULO_DE[decision]);
      expect(st2.reply).not.toContain(frase);
      statusResposta = null;
      await turno("cancelar");
    }
  });

  it("aprovado sem proposal.create na política: não oferece a proposta", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null,
      maxPolicy: { byRole: { "*": ["proposal.list", "credit.read", "credit.request"] }, byRecipient: {}, brokerDefault: [] } } as never);
    const turno = await ateRevisao();
    const s = await turno("SIM");
    expect(s.reply).toMatch(/^Aprovado na Upestate\. Veja na tela do lead: /);
    expect(s.reply).not.toMatch(/proposta/);
    expect(s.fluxo).toBeNull();
  });

  it.each([
    ["pendencia", /^A Upestate pediu complemento da ficha \(Pendência\)\. Veja na tela do lead: /],
    ["erro", /^A análise não pôde ser concluída \(Erro\)\. Veja na tela do lead: /],
  ])("%s: texto fixo + link", async (decision, re) => {
    requestResposta = { status: 200, body: { decision, rotulo: null, leadLink: "/locacao/pessoas/clientes/lc1" } };
    const turno = await ateRevisao();
    const s = await turno("SIM");
    expect(s.reply).toMatch(re);
    expect(s.reply).toMatch(LINK_LC1);
  });

  it("'aprova mesmo assim' no meio do fluxo: o Max não aprova", async () => {
    const turno = await ateRevisao();
    const s = await turno("aprova mesmo assim");
    expect(s.reply).toContain(TEXTO_APROVAR);
    expect(pedidos()).toEqual([]);
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

/**
 * M3: os turnos de ENVIO e RESULTADO (envio incerto, 2º SIM, aprovado, proposta
 * aberta) pelo `runTurn` de verdade — todos sensíveis, e nenhum CPF/renda nos
 * 5 lugares. Controle positivo: o sobrenome está lá.
 */
function itDbEnvio() {
  const hasDb = Boolean(process.env.DATABASE_URL);
  (hasDb ? it : it.skip)("envio e resultado: CPF e renda fora do banco; turnos sensíveis", async () => {
    const ORG = "org-credito-envio-pii";
    const FONE = "5511900000779";
    process.env.MAX_CREDITO_ENVIO = "true";
    vi.mocked(resolveIdentity).mockResolvedValue({ kind: "identified", candidate: { ...usuario, orgId: ORG } } as never);
    const { query } = await import("@/lib/db");
    const limpar = async () => {
      await query(`DELETE FROM checkpoint_writes WHERE thread_id LIKE $1`, [`${ORG}:%`]);
      await query(`DELETE FROM checkpoint_blobs WHERE thread_id LIKE $1`, [`${ORG}:%`]);
      await query(`DELETE FROM checkpoints WHERE thread_id LIKE $1`, [`${ORG}:%`]);
      await query(`DELETE FROM conversation_turn WHERE org_id = $1`, [ORG]);
      await query(`DELETE FROM memory_facts WHERE org_id = $1`, [ORG]);
    };
    await limpar();
    try {
      const sensiveis: (boolean | undefined)[] = [];
      let n = 0;
      const falar = async (text: string) => {
        const r = await runTurn({ messageId: `env-${++n}-${Math.random()}`, fromPhone: FONE, groupId: null, kind: "text", text,
          mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null } as Parameters<typeof runTurn>[0]);
        await r.afterReply();
        sensiveis.push(r.sensivel);
        return r.reply ?? "";
      };
      for (const fala of ["faz a ficha de crédito da Letícia Andrade", "sim", `cpf ${CPF}`, "CLT", "analista", "renda 8 mil", "2500", "não tem", "não tem", "1", "não"]) {
        await falar(fala);
      }
      sensiveis.length = 0;
      // Envio incerto e o 2º SIM (consulta, sem reenvio).
      requestResposta = "sem_resposta";
      expect(await falar("SIM")).toMatch(/^Não consegui confirmar o envio agora\. Não reenvie/);
      requestResposta = { status: 200, body: { ...APROVADO.body, justificativa: "Renda de R$ 8.000,00 compatível; CPF 111.444.777-35 sem restrição" } };
      expect(await falar("SIM")).toMatch(/^Ainda não encontrei/);
      expect(pedidos()).toHaveLength(1);
      // Cancela o incerto e refaz até o resultado aprovado (nova ficha do mesmo CPF).
      await falar("cancelar");
      for (const fala of ["faz a ficha de crédito da Letícia Andrade", "sim", `cpf ${CPF}`]) await falar(fala);
      faltantesForcados = [];
      await falar("não");
      faltantesForcados = null;
      const aprovado = await falar("SIM");
      expect(aprovado).toBe("Aprovado na Upestate. Quer que eu abra a proposta de locação de Letícia Andrade?");
      expect(await falar("sim")).toMatch(/^Abrindo a proposta de locação de Letícia Andrade/);
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
      for (const p of [CPF_D, CPF, "8 mil", "8.000,00", "8.000", "restrição"]) {
        expect(await conta(`%${p}%`), p).toBe(0);
      }
    } finally {
      await limpar();
    }
  }, 30_000);
}

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
  itDbEnvio();

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
