import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Fluxo `captacao` (P9): roteamento, gate (NEGADO antes do permitido), coleta,
 * criação cedo, complemento, conferência, resumo, envio (202, sem resposta,
 * brancos, versão) e a projeção. O ImobPro é um fake que VALIDA o que chega
 * (chave de idempotência nas escritas, versão, política) e o checkpoint nunca
 * pode ter CPF, e-mail nem telefone de proprietário.
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
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  resolveIdentity: vi.fn(),
}));

const { buildGraph, RESET_DO_TURN, respostaDoTurno, encerrarTurno } = await import("../graph");
type Candidate = import("@/lib/identity").Candidate;
const cap = await import("../captacao");
const { fetchProfile, searchKnowledge, reportUsage } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { executarAcao } = await import("@/lib/acao");
const { MemorySaver } = await import("@langchain/langgraph");
const { pedeAcaoForaDoMax, textoDeCapacidades } = await import("../capacidades");
const { TIPOS_CRIAVEIS, lerTipo, capabilityDaCriacao, formToolAtual, FORM_TOOL } = await import("../tools");

const llm = complete as unknown as ReturnType<typeof vi.fn>;
const acao = executarAcao as unknown as ReturnType<typeof vi.fn>;
const usuario = { orgId: "org1", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };
const corretor: Candidate = { orgId: "org1", orgName: "FINCasa", kind: "broker", splitRecipientId: "sr1", label: "Wes" } as Candidate;
const POLITICA = (caps: string[]) => ({ byRole: { "*": caps }, byRecipient: {}, brokerDefault: [] });
const COM_CAPTACAO = POLITICA(["proposal.list", "proposal.create", "captacao.create", "captacao.send", "captacao.list"]);
const SEM_CAPTACAO = POLITICA(["proposal.list", "proposal.create"]);
const SO_LEITURA = POLITICA(["captacao.list"]);
const uso = { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true };

const CPF = "111.444.777-35";
const CPF_D = "11144477735";
const FONE = "(11) 98765-4321";
const FONE_D = "11987654321";
const EMAIL = "maria@ex.com";

// ─── O ImobPro simulado ─────────────────────────────────────────────────────

interface Cap {
  id: string; codigo: string; nome: string; tipo: string; modeloId: string | null; version: number;
  status: "rascunho" | "enviando" | "em_assinatura"; dados: Record<string, unknown>;
}
let captacoes: Cap[] = [];
let chamadas: { verb: string; args: Record<string, unknown>; key?: string }[] = [];
let respostasPorChave = new Map<string, unknown>();
let modelos: { id: string; nome: string; resumo?: string }[] = [];
let assinaturaConfigurada = true;
/** Os campos `envio` que faltam: o fake exige matrícula para forçar a pergunta de faltante. */
let exigeMatricula = true;
let exigeRg = false;
let emBranco = 0;
let sendModo: "ok" | "202" | "sem_resposta" | { status: number; body: Record<string, unknown> } = "ok";
let createSemResposta = false;
let complementoDesatualizado = 0;
let sendEnvios = 0;

const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const estadoDe = (c: Cap) => (c.status === "rascunho" ? "Rascunho" : c.status === "enviando" ? "Enviando…" : "Em assinatura");

function mesclarPorId(atual: Record<string, unknown>[] = [], novo: Record<string, unknown>[] = []) {
  const out = [...atual];
  for (const n of novo) {
    const i = out.findIndex((x) => x.id === n.id);
    if (i >= 0) out[i] = { ...out[i], ...n }; else out.push(n);
  }
  return out;
}

function faltantesDe(c: Cap) {
  const d = c.dados;
  const im = obj(d.imovel);
  const co = obj(d.condicoes);
  const f: { path: string; rotulo: string; etapa: string; proprietarioId?: string }[] = [];
  if (!im.rua || !im.numero) f.push({ path: "imovel.endereco", rotulo: "Endereço do imóvel", etapa: "imovel" });
  if (exigeMatricula && !im.matricula) f.push({ path: "imovel.matricula", rotulo: "Matrícula", etapa: "imovel" });
  for (const p of (d.proprietarios as Record<string, unknown>[] | undefined) ?? []) {
    if (!p.cpf && !p.cnpj) f.push({ path: "proprietarios[].cpf", rotulo: "CPF", etapa: "proprietarios", proprietarioId: String(p.id) });
    if (exigeRg && !p.rg) f.push({ path: "proprietarios[].rg", rotulo: "RG", etapa: "proprietarios", proprietarioId: String(p.id) });
  }
  if (!(d.proprietarios as unknown[] | undefined)?.length) f.push({ path: "proprietarios[].nome", rotulo: "Nome completo", etapa: "proprietarios" });
  if (c.tipo === "venda" && co.valor === undefined) f.push({ path: "condicoes.valor", rotulo: "Valor de venda", etapa: "condicoes" });
  if (co.comissao_percent === undefined) f.push({ path: "condicoes.comissao_percent", rotulo: "Comissão", etapa: "condicoes" });
  if (co.prazo_dias === undefined) f.push({ path: "condicoes.prazo_dias", rotulo: "Prazo da autorização (dias)", etapa: "condicoes" });
  return f;
}

async function imobpro(p: { verb: string; args: Record<string, unknown>; idempotencyKey?: string }) {
  chamadas.push({ verb: p.verb, args: p.args, key: p.idempotencyKey });
  const a = p.args;
  const replay = (hash: string) => (p.idempotencyKey ? respostasPorChave.get(`${p.verb}:${p.idempotencyKey}:${hash}`) : undefined);
  const grava = <T,>(hash: string, r: T): T => { if (p.idempotencyKey) respostasPorChave.set(`${p.verb}:${p.idempotencyKey}:${hash}`, r); return r; };
  switch (p.verb) {
    case "captacao.options": {
      const base = { esteiras: ["venda", "locacao"], canais: { email: true, whatsapp: true, aceite: false }, assinaturaConfigurada };
      if (typeof a.captacaoId === "string") {
        const c = captacoes.find((x) => x.id === a.captacaoId);
        if (!c) return { status: 404, body: { error: "nao_encontrada" } };
        const donos = (c.dados.proprietarios as Record<string, unknown>[] | undefined) ?? [];
        return { status: 200, body: { ...base, modelos: [], assinantes: donos.map((d) => ({ nome: d.nome ?? d.razao_social, papel: "proprietario", canal: "email", assina: true })) } };
      }
      return { status: 200, body: { ...base, modelos } };
    }
    case "captacao.create": {
      if (!p.idempotencyKey) return { status: 400, body: { error: "idempotency_key_obrigatoria" } };
      const hash = JSON.stringify(a);
      const rep = replay(hash);
      if (rep !== undefined) return rep;
      if (typeof a.captacaoId === "string") {
        const c = captacoes.find((x) => x.id === a.captacaoId);
        if (!c) return { status: 404, body: { error: "nao_encontrada" } };
        if (typeof a.version !== "number") return { status: 400, body: { error: "version_obrigatoria" } };
        if (complementoDesatualizado > 0) { complementoDesatualizado -= 1; c.version += 1; }
        if (a.version !== c.version) return { status: 409, body: { error: "versao_desatualizada" } };
        const dados = obj(a.dados);
        c.dados = {
          ...c.dados,
          ...(dados.imovel ? { imovel: { ...obj(c.dados.imovel), ...obj(dados.imovel) } } : {}),
          ...(dados.condicoes ? { condicoes: { ...obj(c.dados.condicoes), ...obj(dados.condicoes) } } : {}),
          ...(dados.locacao ? { locacao: { ...obj(c.dados.locacao), ...obj(dados.locacao) } } : {}),
          ...(dados.proprietarios ? { proprietarios: mesclarPorId(c.dados.proprietarios as never, dados.proprietarios as never) } : {}),
          ...(dados.assinantes ? { assinantes: dados.assinantes } : {}),
        };
        c.version += 1;
        return grava(hash, { status: 200, body: { captacao: { id: c.id, codigo: c.codigo, nome: c.nome, esteira: c.tipo, estado: estadoDe(c), version: c.version } } });
      }
      if (typeof a.nome !== "string" || !a.nome.trim()) return { status: 400, body: { error: "nome_obrigatorio" } };
      if (a.tipo !== "venda" && a.tipo !== "locacao") return { status: 400, body: { error: "tipo_invalido" } };
      const escolhidos = a.modeloId ? modelos.filter((m) => m.id === a.modeloId) : modelos;
      if (!escolhidos.length) return { status: 422, body: { error: "sem_modelo" } };
      if (escolhidos.length > 1) return { status: 409, body: { error: "escolher_modelo", modelos: modelos.map((m) => ({ id: m.id, nome: m.nome })) } };
      const c: Cap = {
        id: `cap-${captacoes.length + 1}`, codigo: `CAP-2026-000${captacoes.length + 1}`, nome: a.nome, tipo: String(a.tipo),
        modeloId: escolhidos[0]!.id, version: 0, status: "rascunho", dados: obj(a.dados),
      };
      captacoes.push(c);
      const resp = { status: 201, body: { captacao: { id: c.id, codigo: c.codigo, nome: c.nome, esteira: c.tipo, estado: "Rascunho", version: 0 }, modelo: { id: escolhidos[0]!.id, nome: escolhidos[0]!.nome }, link: `/imoveis/captacoes/${c.id}` } };
      grava(hash, resp);
      return createSemResposta ? (createSemResposta = false, null) : resp;
    }
    case "captacao.preflight": {
      const c = captacoes.find((x) => x.id === a.captacaoId);
      if (!c) return { status: 404, body: { error: "nao_encontrada" } };
      if (c.status !== "rascunho") return { status: 409, body: { error: "nao_e_rascunho", estado: estadoDe(c) } };
      const faltantes = faltantesDe(c);
      return { status: 200, body: { captacaoId: c.id, version: c.version, modelo: { id: c.modeloId, nome: "Modelo" }, pronto: faltantes.length === 0, faltantes, bloqueios: [], emBranco } };
    }
    case "captacao.send": {
      if (!p.idempotencyKey) return { status: 400, body: { error: "idempotency_key_obrigatoria" } };
      const hash = JSON.stringify(a);
      const rep = replay(hash);
      if (rep !== undefined) return rep;
      const c = captacoes.find((x) => x.id === a.captacaoId);
      if (!c) return { status: 404, body: { error: "nao_encontrada" } };
      if (a.version !== c.version) return { status: 409, body: { error: "versao_desatualizada" } };
      if (emBranco > 0 && a.confirmarBrancos !== true) return { status: 409, body: { error: "confirmar_brancos", emBranco } };
      if (typeof sendModo === "object") return sendModo;
      sendEnvios += 1;
      const link = `/imoveis/captacoes/${c.id}`;
      if (sendModo === "202") { c.status = "enviando"; return grava(hash, { status: 202, body: { estado: "Enviando…", link } }); }
      c.status = "em_assinatura";
      const ok = { status: 200, body: { ok: true, estado: "Em assinatura", instrumento: "envelope", pessoas: 1, retomado: false, link } };
      grava(hash, ok);
      return sendModo === "sem_resposta" ? null : ok;
    }
    case "captacao.list": {
      let lista = captacoes;
      if (typeof a.captacaoId === "string") lista = lista.filter((c) => c.id === a.captacaoId);
      if (typeof a.busca === "string") lista = lista.filter((c) => (c.nome + c.codigo).toLowerCase().includes(String(a.busca).toLowerCase()));
      if (a.situacao === "rascunho") lista = lista.filter((c) => c.status === "rascunho");
      const items = lista.map((c, i) => ({ ref: i + 1, id: c.id, codigo: c.codigo, nome: c.nome, esteira: c.tipo, estado: estadoDe(c), tom: "info", link: `/imoveis/captacoes/${c.id}` }));
      return { status: 200, body: { items, total: items.length, ...(a.busca ? { busca: a.busca } : {}) } };
    }
    default:
      return { status: 501, body: { error: `nao_simulado:${p.verb}` } };
  }
}

/** O que o extrator (LLM) devolve nesta chamada; `null` = nada. */
let extracao: Record<string, unknown> | null = null;
const IMOVEL_EXTRAIDO = { rua: "Rua Augusta", numero: "1250", complemento: "ap 42", bairro: "Bela Vista", cidade: "São Paulo", uf: "SP" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MAX_CAPTACAO = "true";
  process.env.MAX_CAPTACAO_ENVIO = "true";
  captacoes = []; chamadas = []; respostasPorChave = new Map();
  modelos = [{ id: "t1", nome: "Modelo de venda", resumo: "Pede 18 campos" }];
  assinaturaConfigurada = true; exigeMatricula = true; exigeRg = false; emBranco = 0;
  sendModo = "ok"; createSemResposta = false; complementoDesatualizado = 0; sendEnvios = 0;
  extracao = null;
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: COM_CAPTACAO } as never);
  vi.mocked(searchKnowledge).mockResolvedValue([]);
  llm.mockImplementation(async (p: { toolChoice?: string }) => {
    if (p.toolChoice === "preencher_captacao") {
      return { text: "", toolCalls: extracao ? [{ name: "preencher_captacao", args: extracao }] : [], usage: uso };
    }
    return { text: "O horário é das 9h às 18h.", toolCalls: [], usage: uso };
  });
  acao.mockImplementation(imobpro as never);
});
afterEach(() => {
  delete process.env.MAX_CAPTACAO;
  delete process.env.MAX_CAPTACAO_ENVIO;
  delete process.env.IMOBPRO_CAPTACAO_SEND_TIMEOUT_MS;
});

function conversa(identity: Candidate = usuario) {
  const app = buildGraph().compile({ checkpointer: new MemorySaver() });
  const thread = `captacao-${Math.random()}`;
  let n = 0;
  const fala = async (text: string) => {
    n += 1;
    const s = await app.invoke(
      { inbound: { messageId: `m${n}`, fromPhone: "5511987654321", groupId: null, kind: "text" as const, text, mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null },
        identity, ...RESET_DO_TURN },
      { configurable: { thread_id: thread } },
    );
    const real = respostaDoTurno(`m${n}`);
    encerrarTurno(`m${n}`);
    return { ...s, reply: real ?? s.reply, replyNoState: s.reply, messageId: `m${n}` };
  };
  return fala;
}
const verbos = (v: string) => chamadas.filter((c) => c.verb === v);
const ultimo = (v: string) => [...chamadas].reverse().find((c) => c.verb === v);
const semDadosPessoais = (x: unknown) => {
  const j = JSON.stringify(x ?? null);
  return !j.includes(CPF_D) && !j.includes(CPF) && !j.includes(EMAIL) && !j.includes(FONE_D) && !j.includes(FONE) && !j.includes("98765");
};

/** Conversa até o resumo do envio (proprietária Maria já gravada). */
async function ateOResumo(fala: ReturnType<typeof conversa>) {
  extracao = IMOVEL_EXTRAIDO;
  await fala("cria uma captação de venda do Apto da Dona Maria");
  await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
  await fala("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade");
  await fala(`Maria Silva, CPF ${CPF}, tel ${FONE}, ${EMAIL}, casada`);
  await fala("FIM");
  await fala("não");
  return fala("matrícula 12345");
}

// ─── NEGADO antes do permitido (capability fail-closed) ─────────────────────

describe("capability nasce desligada", () => {
  it("MAX_CAPTACAO desligada: nada é chamado, o modelo responde (mesmo com a política concedendo)", async () => {
    delete process.env.MAX_CAPTACAO;
    const s = await conversa()("cria uma captação de venda do Apto da Dona Maria");
    expect(chamadas).toEqual([]);
    expect(s.fluxo ?? null).toBeNull();
    expect(llm).toHaveBeenCalled();
  });

  it("MAX_CAPTACAO_ENVIO é sub-flag: sem ela só MAX_CAPTACAO ligada NÃO liga o envio", () => {
    delete process.env.MAX_CAPTACAO_ENVIO;
    expect(cap.captacaoLigada()).toBe(true);
    expect(cap.captacaoEnvioLigado()).toBe(false);
    delete process.env.MAX_CAPTACAO;
    process.env.MAX_CAPTACAO_ENVIO = "true";
    expect(cap.captacaoEnvioLigado()).toBe(false);
  });

  it("sem a policy captacao.create: frase fixa, nada chamado, modelo nem consultado", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: SEM_CAPTACAO } as never);
    const s = await conversa()("cria uma captação de venda do Apto da Dona Maria");
    expect(s.reply).toBe(cap.TEXTO_CAPTACAO_SEM_POLITICA);
    expect(chamadas).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it("só com captacao.list: consulta funciona, criar não", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: SO_LEITURA } as never);
    const fala = conversa();
    const criar = await fala("cria uma captação de venda do Apto da Dona Maria");
    expect(criar.reply).toBe(cap.TEXTO_CAPTACAO_SEM_POLITICA);
    expect(chamadas).toEqual([]);
    const listar = await fala("quais são as minhas captações?");
    expect(verbos("captacao.list")).toHaveLength(1);
    expect(listar.reply).toContain("Você não tem captações");
  });

  it("corretor comissionado (sem usuário): não liberada", async () => {
    const s = await conversa(corretor)("cria uma captação de venda do Apto da Dona Maria");
    expect(s.reply).toBe(cap.TEXTO_CAPTACAO_SEM_POLITICA);
    expect(chamadas).toEqual([]);
  });

  it("política indisponível: nada feito, texto próprio", async () => {
    const { chaveDePolitica } = await import("@/lib/cm");
    vi.mocked(chaveDePolitica).mockRejectedValueOnce(new Error("fora do ar"));
    const s = await conversa()("cria uma captação de venda do Apto da Dona Maria");
    expect(chamadas).toEqual([]);
    expect(s.reply).toMatch(/Nada foi feito|permissão|liberada/);
  });

  it("sem MAX_CAPTACAO_ENVIO: o Max prepara o rascunho até o fim e NÃO oferece nem chama o envio", async () => {
    delete process.env.MAX_CAPTACAO_ENVIO;
    const s = await ateOResumo(conversa());
    expect(s.reply).toContain("Pronta a captação");
    expect(s.reply).toContain("pela tela");
    expect(s.reply).not.toContain("enviar*");
    expect(verbos("captacao.send")).toEqual([]);
  });

  it("sem a policy captacao.send: mesmo com a flag, não oferece envio", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: POLITICA(["captacao.create", "captacao.list"]) } as never);
    const s = await ateOResumo(conversa());
    expect(s.reply).toContain("pela tela");
    expect(verbos("captacao.send")).toEqual([]);
  });
});

// ─── Roteamento ─────────────────────────────────────────────────────────────

describe("pedeCaptacao", () => {
  it.each([
    ["cria uma captação de venda do Apto da Dona Maria", "abrir"],
    ["quero fazer uma captação", "abrir"],
    ["abre uma nova captação de locação", "abrir"],
    ["faz o contrato de captação da Rua Augusta", "abrir"],
    ["preciso de uma captação para o João", "abrir"],
    ["quais são as minhas captações?", "listar"],
    ["como está a captação da Maria?", "listar"],
    ["status da captação CAP-2026-0007", "listar"],
    ["a captação da Maria já foi assinada?", "listar"],
    ["envia a captação da Maria para assinatura", "enviar"],
    ["manda a captação do Apto da Dona Maria", "enviar"],
  ])("%s → %s", (t, esperado) => expect(cap.pedeCaptacao(t)).toBe(esperado));

  it.each([
    "como funciona a captação?",
    "não cria a captação ainda",
    "quero captação de clientes novos",
    "captação de leads no instagram",
    "faz uma proposta para a Letícia",
    "o que é captação de imóvel?",
    "manda o link do formulário",
  ])("não é captação: %s", (t) => expect(cap.pedeCaptacao(t)).toBeNull());

  it("nome dito no pedido, verbatim", () => {
    expect(cap.nomeDaCaptacao("cria uma captação de venda do Apto da Dona Maria")).toBe("Apto da Dona Maria");
    expect(cap.nomeDaCaptacao("faz a captação da Rua Augusta 1250, por favor")).toBe("Rua Augusta 1250");
    expect(cap.nomeDaCaptacao("cria uma captação de venda")).toBeNull();
    expect(cap.nomeDaCaptacao("quero fazer uma captação")).toBeNull();
  });

  it("natureza dita", () => {
    expect(cap.tipoDito("captação de venda")).toBe("venda");
    expect(cap.tipoDito("captação de locação")).toBe("locacao");
    expect(cap.tipoDito("captação para alugar")).toBe("locacao");
    expect(cap.tipoDito("quero uma captação")).toBeNull();
  });
});

describe("exceção 'contrato de captação' no ACAO_NO_CONTRATO", () => {
  it("com a flag ligada, 'faz o contrato de captação da Rua X' NÃO cai em pedeAcaoForaDoMax", () => {
    expect(pedeAcaoForaDoMax("faz o contrato de captação da Rua X")).toBeNull();
    expect(pedeAcaoForaDoMax("cria o contrato de captação do João")).toBeNull();
    expect(pedeAcaoForaDoMax("envia o contrato de captação da Maria")).toBeNull();
  });

  it("com a flag desligada, continua 'contrato eu não gero' (fail-closed)", () => {
    delete process.env.MAX_CAPTACAO;
    expect(pedeAcaoForaDoMax("faz o contrato de captação da Rua X")).toBe("contrato");
  });

  it("o resto do contrato segue barrado, com a flag ligada", () => {
    expect(pedeAcaoForaDoMax("faz o contrato do João")).toBe("contrato");
    expect(pedeAcaoForaDoMax("edita o contrato de captação da Maria")).toBe("contrato");
    expect(pedeAcaoForaDoMax("gera o contrato de locação")).toBe("contrato");
    expect(pedeAcaoForaDoMax("gera uma cobrança")).toBe("cobranca");
  });
});

describe("tools e capacidades", () => {
  it("TIPOS_CRIAVEIS ganha 'captacao' e a capability dela é captacao.create", () => {
    expect([...TIPOS_CRIAVEIS]).toContain("captacao");
    expect(capabilityDaCriacao("captacao")).toBe("captacao.create");
    expect(capabilityDaCriacao("proposta")).toBe("proposal.create");
    expect(capabilityDaCriacao("venda")).toBe("form.create");
  });

  it("flag desligada: 'captacao' é tipo inválido e o modelo nem vê o valor", () => {
    delete process.env.MAX_CAPTACAO;
    expect(lerTipo("captacao")).toBeNull();
    expect(capabilityDaCriacao("captacao")).toBeNull();
    expect(formToolAtual()).toBe(FORM_TOOL);
    const enumDoTipo = (FORM_TOOL.parameters as { properties: { tipo: { enum: string[] } } }).properties.tipo.enum;
    expect(enumDoTipo).toEqual(["venda", "locacao", "proposta"]);
  });

  it("flag ligada: o enum da tool ganha 'captacao'", () => {
    expect(lerTipo("captacao")).toBe("captacao");
    const enumDoTipo = (formToolAtual().parameters as { properties: { tipo: { enum: string[] } } }).properties.tipo.enum;
    expect(enumDoTipo).toContain("captacao");
  });

  it("'o que você faz' só cita captação com flag E política", () => {
    const todas = ["captacao.create", "captacao.send", "captacao.list"] as const;
    expect(textoDeCapacidades(todas, true, false, false)).not.toMatch(/aptação/);
    expect(textoDeCapacidades([], true, false, true)).not.toMatch(/aptação/);
    expect(textoDeCapacidades(todas, true, false, true)).toContain("enviar para assinatura");
    delete process.env.MAX_CAPTACAO_ENVIO;
    expect(textoDeCapacidades(todas, true, false, true)).not.toContain("enviar para assinatura");
    expect(textoDeCapacidades(["captacao.list"], true, false, true)).toContain("Captação: consultar e ver o status");
  });
});

// ─── Leitura de dados em código ─────────────────────────────────────────────

describe("leitura de dados", () => {
  it("CPF, telefone e e-mail em código; o nome vem do texto sem o modelo", async () => {
    const nada = vi.fn(async () => null);
    const p = await cap.lerPessoa(`Maria Silva, CPF ${CPF}, tel ${FONE}, ${EMAIL}, casada, 50%`, nada);
    expect(p).toMatchObject({ nome: "Maria Silva", cpf: CPF_D, telefone: FONE_D, email: EMAIL, estadoCivil: "casada", percentual: 50 });
    expect(nada).not.toHaveBeenCalled();
  });

  it("telefone de 11 dígitos puro não vira CPF", async () => {
    const p = await cap.lerPessoa(`João Souza ${FONE_D} ${CPF_D}`, vi.fn(async () => null));
    expect(p).toMatchObject({ nome: "João Souza", cpf: CPF_D, telefone: FONE_D });
  });

  it("CPF inválido e CNPJ: erro em código; CNPJ vira pessoa jurídica", async () => {
    const nada = vi.fn(async () => null);
    expect(await cap.lerPessoa("Maria Silva 111.444.777-36", nada)).toMatchObject({ erro: expect.stringContaining("CPF não confere") });
    const pj = await cap.lerPessoa("Imobiliária Exemplo Ltda, CNPJ 11.222.333/0001-81", nada);
    expect(pj).toMatchObject({ pj: true, cnpj: "11222333000181", nome: "Imobiliária Exemplo Ltda" });
  });

  it("nome que o modelo devolve precisa estar no texto (nunca inventado)", async () => {
    const inventa = vi.fn(async () => ({ nome: "Fulano de Tal" }));
    expect(await cap.lerPessoa("m. silva 111.444.777-35", inventa)).toMatchObject({ erro: expect.any(String) });
    const certo = vi.fn(async () => ({ nome: "Maria Aparecida" }));
    expect(await cap.lerPessoa("a Maria Aparecida tem cpf 111.444.777-35", certo)).toMatchObject({ nome: "Maria Aparecida" });
  });

  it("resposta a um faltante tira o rótulo do campo: 'matrícula 12345' é 12345", () => {
    expect(cap.semRotulo("matrícula 12345", "Matrícula")).toBe("12345");
    expect(cap.semRotulo("Matricula: 12.345", "Matrícula")).toBe("12.345");
    expect(cap.semRotulo("a matrícula é 12345", "Matrícula")).toBe("a matrícula é 12345");
    expect(cap.semRotulo("cartório 2º Ofício", "Cartório de registro")).toBe("2º Ofício");
    expect(cap.semRotulo("12345", "Matrícula")).toBe("12345");
    expect(cap.semRotulo("matrícula", "Matrícula")).toBe("matrícula");
  });

  it("condições de venda e de locação", () => {
    expect(cap.lerCondicoes("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade", "venda")).toEqual({
      condicoes: { valor: 850000, comissao_percent: 6, prazo_dias: 180, exclusiva: true }, locacao: {},
    });
    expect(cap.lerCondicoes("850 mil, 6%, 6 meses, sem exclusividade", "venda").condicoes).toEqual({
      valor: 850000, comissao_percent: 6, prazo_dias: 180, exclusiva: false,
    });
    expect(cap.lerCondicoes("aluguel 3500, condomínio 800, iptu 250, taxa de administração 10%, comissão 100%", "locacao")).toEqual({
      condicoes: { comissao_percent: 100 }, locacao: { aluguel: 3500, condominio: 800, iptu: 250, taxa_administracao: 10 },
    });
    expect(cap.lerCondicoes("não sei ainda", "venda")).toEqual({ condicoes: {}, locacao: {} });
  });

  it("imóvel: endereço do modelo só vale se estiver no texto; matrícula, área e tipo em código", async () => {
    const r = await cap.lerImovel("Apartamento na Rua Augusta, 1250, matrícula 12345, 85 m2, 2 vagas, SP", async () => ({ ...IMOVEL_EXTRAIDO, rua: "Rua Inventada" }));
    expect(r.erro).toBeTruthy();
    expect(r.dados).toMatchObject({ matricula: "12345", area: "85 m²", vagas: "2", kind: "apartamento" });
    const ok = await cap.lerImovel("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP", async () => IMOVEL_EXTRAIDO);
    expect(ok.dados).toMatchObject({ rua: "Rua Augusta", numero: "1250", bairro: "Bela Vista", cidade: "São Paulo", uf: "SP" });
  });
});

// ─── O fluxo inteiro ────────────────────────────────────────────────────────

describe("fluxo feliz: da conversa ao envio", () => {
  it("natureza → modelo → imóvel → condições → cria cedo → proprietário → faltante → resumo → enviar", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;

    const pedido = await fala("cria uma captação de venda do Apto da Dona Maria");
    expect(verbos("captacao.options")[0]!.args).toEqual({ tipo: "venda" });
    expect(verbos("captacao.options")[0]!.key).toBeUndefined();
    expect(pedido.reply).toContain("Qual o imóvel?");

    const imovel = await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    expect(imovel.reply).toContain("Anotei o imóvel");
    expect(verbos("captacao.create")).toEqual([]);

    const cond = await fala("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade");
    const criacao = verbos("captacao.create")[0]!;
    expect(criacao.key).toBe("m3");
    expect(criacao.args).toMatchObject({ tipo: "venda", nome: "Apto da Dona Maria", modeloId: "t1" });
    expect(criacao.args.dados).toMatchObject({
      imovel: { rua: "Rua Augusta", numero: "1250", cidade: "São Paulo", uf: "SP" },
      condicoes: { valor: 850000, comissao_percent: 6, prazo_dias: 180, exclusiva: true },
    });
    expect(cond.reply).toContain("Criei o rascunho CAP-2026-0001");
    expect(cond.reply).toContain("FIM");

    const dono = await fala(`Maria Silva, CPF ${CPF}, tel ${FONE}, ${EMAIL}, casada`);
    const compl = verbos("captacao.create")[1]!;
    expect(compl.args).toMatchObject({ captacaoId: "cap-1", version: 0 });
    expect(compl.args.dados).toMatchObject({ proprietarios: [{ id: "p1", papel: "proprietario", tipo_pessoa: "fisica", nome: "Maria Silva", cpf: CPF_D, telefone1: FONE_D, email: EMAIL, estado_civil: "casada" }] });
    expect(compl.key).toBe("m4");
    // `inbound` leva o texto cru só nos testes que chamam `buildGraph` direto (o `runTurn` o entra sem texto).
    const vazou = Object.entries(dono).filter(([k, v]) => k !== "inbound" && !semDadosPessoais(v)).map(([k]) => k);
    expect(vazou).toEqual([]);

    const fim = await fala("FIM");
    expect(fim.reply).toContain("testemunha");
    const extras = await fala("não");
    // Preflight: só pergunta o que falta.
    expect(verbos("captacao.preflight")).toHaveLength(1);
    expect(extras.reply).toContain("Matrícula");
    expect(extras.reply).toContain("Matrícula do imóvel?");

    const resumo = await fala("matrícula 12345");
    expect(ultimo("captacao.create")!.args.dados).toEqual({ imovel: { matricula: "12345" } });
    expect(verbos("captacao.preflight")).toHaveLength(2);
    expect(resumo.reply).toContain("Pronta a captação CAP-2026-0001");
    expect(resumo.reply).toContain("Envio para Maria Silva por e-mail?");
    expect(resumo.reply).toContain("*enviar*");
    expect(verbos("captacao.options").at(-1)!.args).toEqual({ captacaoId: "cap-1" });
    expect(verbos("captacao.send")).toEqual([]);

    const enviado = await fala("enviar");
    const envio = verbos("captacao.send")[0]!;
    expect(envio.args).toEqual({ captacaoId: "cap-1", version: captacoes[0]!.version });
    expect(envio.key).toBe(enviado.messageId);
    expect(enviado.reply).toContain("Enviado");
    expect(enviado.reply).toContain("Em assinatura");
    expect(enviado.fluxo ?? null).toBeNull();
    // O checkpoint guarda só referência: nunca CPF, e-mail ou telefone.
    const vazouNoFim = Object.entries(enviado).filter(([k, v]) => k !== "inbound" && !semDadosPessoais(v)).map(([k]) => k);
    expect(vazouNoFim).toEqual([]);
  });

  it("'sim' solto no resumo NÃO envia; só 'enviar'", async () => {
    const fala = conversa();
    await ateOResumo(fala);
    const sim = await fala("sim");
    expect(verbos("captacao.send")).toEqual([]);
    expect(sim.reply).toBeTruthy();
    await fala("enviar");
    expect(verbos("captacao.send")).toHaveLength(1);
  });

  it("vários modelos: pergunta qual e usa o escolhido", async () => {
    modelos = [{ id: "t1", nome: "Modelo A" }, { id: "t2", nome: "Modelo B", resumo: "2 testemunhas" }];
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    const p = await fala("cria uma captação de venda do Apto da Dona Maria");
    expect(p.reply).toContain("1. Modelo A");
    expect(p.reply).toContain("2. Modelo B — 2 testemunhas");
    await fala("2");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    expect(verbos("captacao.create")[0]!.args.modeloId).toBe("t2");
  });

  it("sem nome no pedido: pergunta o nome e guarda o que a pessoa disse, verbatim", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    const p = await fala("quero fazer uma captação de venda");
    expect(p.reply).toContain("Que nome dou");
    await fala("Casa da Dona Rosa — Moema");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("pular");
    expect(verbos("captacao.create")[0]!.args.nome).toBe("Casa da Dona Rosa — Moema");
  });

  it("sem natureza dita: pergunta venda ou locação, e só então consulta os modelos", async () => {
    const fala = conversa();
    const p = await fala("quero fazer uma captação do Apto da Rua Augusta");
    expect(p.reply).toContain("venda* ou de *locação");
    expect(chamadas).toEqual([]);
    await fala("locação");
    expect(verbos("captacao.options")[0]!.args).toEqual({ tipo: "locacao" });
  });

  it("sem modelo ativo: avisa e para, nada criado", async () => {
    modelos = [];
    const s = await conversa()("cria uma captação de venda do Apto da Dona Maria");
    expect(s.reply).toContain("não tem um modelo de captação de venda ativo");
    expect(verbos("captacao.create")).toEqual([]);
    expect(s.fluxo ?? null).toBeNull();
  });

  it("ClickSign não configurada: avisa já no início, sem travar o rascunho", async () => {
    assinaturaConfigurada = false;
    const s = await conversa()("cria uma captação de venda do Apto da Dona Maria");
    expect(s.reply).toContain("ClickSign");
    expect(s.reply).toContain("Qual o imóvel?");
  });

  it("extras: testemunha vira testemunhas[], avulso vira avulsos[]", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    await fala(`Maria Silva, CPF ${CPF}`);
    await fala("FIM");
    const t = await fala(`testemunha Carlos Pereira, ${EMAIL.replace("maria", "carlos")}`);
    expect(t.reply).toContain("como testemunha");
    expect((ultimo("captacao.create")!.args.dados as { assinantes: { testemunhas: unknown[] } }).assinantes.testemunhas).toHaveLength(1);
    await fala(`Pedro Alves, tel ${FONE}`);
    expect((ultimo("captacao.create")!.args.dados as { assinantes: { avulsos: unknown[] } }).assinantes.avulsos).toHaveLength(1);
  });

  it("FIM sem nenhum proprietário não avança", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    const s = await fala("FIM");
    expect(s.reply).toContain("pelo menos um proprietário");
    expect(verbos("captacao.preflight")).toEqual([]);
  });

  it("cancelar: o rascunho fica salvo e nada mais é chamado", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    const antes = chamadas.length;
    const s = await fala("cancelar");
    expect(s.reply).toContain("fica salvo na tela");
    expect(chamadas).toHaveLength(antes);
  });
});

// ─── Idempotência e versão ──────────────────────────────────────────────────

describe("criação sem resposta", () => {
  it("o 'sim' REPETE a mesma chave e os mesmos dados — não duplica", async () => {
    createSemResposta = true;
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    const incerto = await fala("valor 850 mil");
    expect(incerto.reply).toContain("não sei se deu certo");
    const outra = await fala("conversa fiada");
    expect(verbos("captacao.create")).toHaveLength(1);
    expect(outra.reply).toBeTruthy();
    const ok = await fala("sim");
    const [primeira, segunda] = verbos("captacao.create");
    expect(segunda!.key).toBe(primeira!.key);
    expect(segunda!.args).toEqual(primeira!.args);
    expect(captacoes).toHaveLength(1);
    expect(ok.reply).toContain("Criei o rascunho");
  });
});

describe("versão desatualizada no complemento", () => {
  it("diz que alguém mexeu na tela, confere de novo (preflight) e refaz UMA vez com a versão nova", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    complementoDesatualizado = 1;
    const s = await fala(`Maria Silva, CPF ${CPF}`);
    expect(s.reply).toContain("Alguém mudou a captação na tela; vou conferir de novo.");
    expect(verbos("captacao.preflight")).toHaveLength(1);
    const [tentativa1, tentativa2] = verbos("captacao.create").slice(1);
    expect(tentativa1!.args.version).toBe(0);
    expect(tentativa2!.args.version).toBe(1);
    expect(tentativa2!.key).not.toBe(tentativa1!.key);
    expect(captacoes[0]!.dados.proprietarios).toHaveLength(1);
  });
});

describe("achados da rodada P9 (revisão)", () => {
  it("send sem resposta -> halt (leitura de anexo) -> 'enviar' reusa a MESMA chave e args", async () => {
    sendModo = "sem_resposta";
    const fala = conversa();
    await ateOResumo(fala);
    await fala("enviar");
    const halt = await fala("lê a foto que eu te mandei");
    expect(halt.fluxo?.kind).toBe("captacao");
    expect((halt.fluxo as { chave?: { verbo: string } } | null)?.chave?.verbo).toBe("captacao.send");
    sendModo = "sem_resposta";
    await fala("enviar");
    const envios = verbos("captacao.send");
    expect(envios).toHaveLength(2);
    expect(envios[1]!.key).toBe(envios[0]!.key);
    expect(envios[1]!.args).toEqual(envios[0]!.args);
    expect(sendEnvios).toBe(1);
  });

  it("em_andamento no send vira ja_enviando: etapa enviando, sem texto neutro", async () => {
    sendModo = { status: 409, body: { error: "em_andamento" } };
    const fala = conversa();
    await ateOResumo(fala);
    const s = await fala("enviar");
    expect((s.fluxo as { etapa?: string } | null)?.etapa).toBe("enviando");
    expect(s.reply).toContain("/imoveis/captacoes/cap-1");
    const depois = await fala("enviar");
    expect(verbos("captacao.send")).toHaveLength(1);
    expect(depois.reply).toContain("Não reenviei");
    expect(verbos("captacao.list").length).toBeGreaterThan(0);
  });

  it("TTL longo só com captacaoId ou chave; antes do rascunho vale o curto", async () => {
    const { fluxoExpirou, FLUXO_TTL_MS, FLUXO_TTL_POS_RASCUNHO_MS } = await import("../fluxos");
    const base = { kind: "captacao", etapa: "tipo", atualizadoEm: 0 } as never;
    const t = FLUXO_TTL_MS + 1;
    expect(fluxoExpirou(base, t)).toBe(true);
    expect(fluxoExpirou({ ...(base as object), captacaoId: "cap-1" } as never, t)).toBe(false);
    expect(fluxoExpirou({ ...(base as object), chave: { verbo: "captacao.send", valor: "m1", version: 0 } } as never, t)).toBe(false);
    expect(fluxoExpirou({ ...(base as object), captacaoId: "cap-1" } as never, FLUXO_TTL_POS_RASCUNHO_MS + 1)).toBe(true);
  });

  it("eco de campo sensível (RG) não repete o valor, nem no texto nem no estado", async () => {
    exigeMatricula = false; exigeRg = true;
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade");
    await fala(`Maria Silva, CPF ${CPF}, tel ${FONE}, ${EMAIL}, casada`);
    await fala("FIM");
    const perg = await fala("não");
    expect(perg.reply).toContain("RG");
    const r = await fala("RG 12.345.678-9");
    expect(JSON.stringify(r.reply)).not.toContain("12.345.678");
    expect(JSON.stringify(r.reply)).not.toContain("12345678");
    expect(r.reply).toContain("anotado");
    expect(JSON.stringify(r.fluxo ?? null)).not.toContain("12.345.678");
    expect(JSON.stringify(r.replyNoState ?? "")).not.toContain("12.345.678");
    // o dado foi pro servidor
    expect(JSON.stringify(ultimo("captacao.create")!.args)).toContain("12.345.678-9");
  });
});

describe("envio", () => {
  it("202: confere com captacao.list{captacaoId} e NUNCA dispara outro send", async () => {
    sendModo = "202";
    const fala = conversa();
    await ateOResumo(fala);
    const s = await fala("enviar");
    expect(verbos("captacao.send")).toHaveLength(1);
    expect(ultimo("captacao.list")!.args).toEqual({ captacaoId: "cap-1" });
    expect(s.reply).toContain("em andamento");
    const depois = await fala("sim");
    const de_novo = await fala("enviar");
    expect(verbos("captacao.send")).toHaveLength(1);
    expect(sendEnvios).toBe(1);
    expect(depois.reply).toContain("Ainda em andamento");
    expect(de_novo.reply).toContain("Ainda em andamento");
    captacoes[0]!.status = "em_assinatura";
    const fim = await fala("como está?");
    expect(fim.reply).toContain("Não reenviei");
    expect(fim.reply).toContain("Em assinatura");
    expect(verbos("captacao.send")).toHaveLength(1);
  });

  it("sem resposta: o 'enviar' seguinte repete a MESMA chave e os mesmos args — o servidor não envia em dobro", async () => {
    sendModo = "sem_resposta";
    const fala = conversa();
    await ateOResumo(fala);
    const incerto = await fala("enviar");
    expect(incerto.reply).toContain("Não consegui confirmar o envio");
    expect(incerto.reply).toContain("não duplica");
    sendModo = "sem_resposta";
    await fala("enviar");
    const [a, b] = verbos("captacao.send");
    expect(b!.key).toBe(a!.key);
    expect(b!.args).toEqual(a!.args);
    expect(sendEnvios).toBe(1);
  });

  it("confirmar_brancos: pergunta explícita; 'enviar assim mesmo' manda confirmarBrancos:true com chave nova", async () => {
    emBranco = 2;
    const fala = conversa();
    const resumo = await ateOResumo(fala);
    expect(resumo.reply).toContain("2 campo(s) vão em branco");
    const pergunta = await fala("enviar");
    expect(pergunta.reply).toContain("2 campo(s) vão em branco no contrato. Envio assim mesmo?");
    expect(verbos("captacao.send")[0]!.args).not.toHaveProperty("confirmarBrancos");
    const sim = await fala("sim");
    expect(verbos("captacao.send")).toHaveLength(1);
    expect(sim.reply).toBeTruthy();
    const ok = await fala("enviar assim mesmo");
    const [primeira, segunda] = verbos("captacao.send");
    expect(segunda!.args).toMatchObject({ confirmarBrancos: true });
    expect(segunda!.key).not.toBe(primeira!.key);
    expect(ok.reply).toContain("Enviado");
  });

  it("versao_desatualizada no envio: texto combinado, novo preflight e novo resumo (a confirmação antiga não vale)", async () => {
    const fala = conversa();
    await ateOResumo(fala);
    captacoes[0]!.version += 1;
    const antes = verbos("captacao.preflight").length;
    const s = await fala("enviar");
    expect(s.reply).toContain("Alguém mudou a captação na tela; vou conferir de novo.");
    expect(verbos("captacao.preflight")).toHaveLength(antes + 1);
    expect(s.reply).toContain("*enviar*");
    expect(sendEnvios).toBe(0);
    await fala("enviar");
    expect(sendEnvios).toBe(1);
  });

  it.each([
    [{ status: 429, body: { error: "cota_diaria", limite: 10 } }, "limite de envios de captação pelo Max por hoje (10)"],
    [{ status: 429, body: { error: "muitas_tentativas" } }, "Muitos envios em pouco tempo"],
    [{ status: 402, body: { error: "limite_do_plano" } }, "limite do plano"],
    [{ status: 409, body: { error: "clicksign_nao_conectada" } }, "ClickSign"],
    [{ status: 422, body: { error: "contato_invalido", message: "Celular inválido (Maria Silva)" } }, "contato"],
    [{ status: 422, body: { error: "previa" } }, "preparar o documento"],
    [{ status: 502, body: { error: "falha_envio" } }, "Falha no envio"],
    [{ status: 409, body: { error: "codigo_que_nao_existe", message: "Texto do servidor com Maria Silva" } }, "não aceitou o envio"],
  ])("erro %j → texto por código, sem o que o servidor escreveu", async (modo, trecho) => {
    sendModo = modo;
    const fala = conversa();
    await ateOResumo(fala);
    const s = await fala("enviar");
    expect(s.reply).toContain(trecho);
    expect(s.reply).not.toContain("Maria Silva");
    expect(s.reply).not.toContain("codigo_que_nao_existe");
    expect(s.fluxo ?? null).toBeNull();
  });
});

describe("envio de rascunho existente e consulta", () => {
  it("'envia a captação da Maria': acha o rascunho, confere e pede o 'enviar'", async () => {
    captacoes.push({ id: "cap-1", codigo: "CAP-2026-0001", nome: "Apto da Dona Maria", tipo: "venda", modeloId: "t1", version: 4, status: "rascunho",
      dados: { imovel: { rua: "Rua Augusta", numero: "1250", matricula: "1" }, proprietarios: [{ id: "p1", nome: "Maria Silva", cpf: CPF_D }], condicoes: { valor: 1, comissao_percent: 6, prazo_dias: 90 } } });
    const fala = conversa();
    const s = await fala("envia a captação da Maria para assinatura");
    expect(verbos("captacao.list")[0]!.args).toMatchObject({ busca: "Maria", situacao: "rascunho" });
    expect(s.reply).toContain("Envio para Maria Silva por e-mail?");
    await fala("enviar");
    expect(verbos("captacao.send")[0]!.args).toEqual({ captacaoId: "cap-1", version: 4 });
  });

  it("listar: sem donos no item, não diz nome de proprietário", async () => {
    captacoes.push({ id: "cap-1", codigo: "CAP-2026-0001", nome: "Apto da Dona Maria", tipo: "venda", modeloId: "t1", version: 0, status: "rascunho", dados: {} });
    const s = await conversa()("quais são as minhas captações?");
    expect(s.reply).toContain("CAP-2026-0001 — Apto da Dona Maria (venda) · Rascunho");
    expect(s.reply).not.toContain("Proprietários");
  });
});

describe("pelo modelo: propor_criacao{tipo:'captacao'}", () => {
  // Texto que o roteador determinístico NÃO pega, mas que o prefiltro da tool oferece ("cria…").
  const TEXTO = "cria algo pro apto da Dona Maria";

  it("com a flag: abre o mesmo fluxo (pergunta a natureza antes de qualquer verbo), nunca uma pendência de um passo", async () => {
    llm.mockImplementation(async (p: { toolChoice?: string }) =>
      p.toolChoice === "preencher_captacao"
        ? { text: "", toolCalls: [], usage: uso }
        : { text: "", toolCalls: [{ name: "propor_criacao", args: { tipo: "captacao" } }], usage: uso });
    const s = await conversa()(TEXTO);
    expect(chamadas).toEqual([]);
    expect(s.reply).toContain("venda* ou de *locação");
    expect((s.fluxo as { kind?: string } | null)?.kind).toBe("captacao");
    expect(s.pendingAction ?? null).toBeNull();
  });

  it("sem a policy captacao.create: o despachante nega, nada chamado", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: SEM_CAPTACAO } as never);
    llm.mockImplementation(async () => ({ text: "", toolCalls: [{ name: "propor_criacao", args: { tipo: "captacao" } }], usage: uso }));
    const s = await conversa()(TEXTO);
    expect(chamadas).toEqual([]);
    expect((s.fluxo as { kind?: string } | null)?.kind).not.toBe("captacao");
  });

  it("flag desligada: 'captacao' é tipo inválido, nada chamado", async () => {
    delete process.env.MAX_CAPTACAO;
    llm.mockImplementation(async () => ({ text: "", toolCalls: [{ name: "propor_criacao", args: { tipo: "captacao" } }], usage: uso }));
    const s = await conversa()(TEXTO);
    expect(chamadas).toEqual([]);
    expect((s.fluxo as { kind?: string } | null)?.kind).not.toBe("captacao");
  });
});

// ─── Custo, R7 e vazamento ──────────────────────────────────────────────────

describe("AIUsage: toda extração por LLM reporta custo", () => {
  it("a extração do endereço passa por reportUsage e entra no usage do turno", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    expect(reportUsage).not.toHaveBeenCalled();
    const s = await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    const chamadasDeExtracao = llm.mock.calls.filter((c) => (c[0] as { toolChoice?: string }).toolChoice === "preencher_captacao");
    expect(chamadasDeExtracao).toHaveLength(1);
    expect(reportUsage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportUsage).mock.calls[0]![0]).toBe("org1");
    expect(s.usage?.length ?? 0).toBeGreaterThan(0);
  });

  it("o texto com CPF/e-mail/telefone nunca chega cru ao modelo", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await ateOResumo(fala);
    const enviadoAoModelo = JSON.stringify(llm.mock.calls);
    for (const dado of [CPF_D, CPF, EMAIL, FONE_D]) expect(enviadoAoModelo).not.toContain(dado);
  });
});

describe("R7: o Max não fala com o proprietário", () => {
  it("só os 5 verbos de captação são usados no fluxo, e nenhum tem destinatário externo", async () => {
    await ateOResumo(conversa());
    const usados = new Set(chamadas.map((c) => c.verb));
    expect([...usados].every((v) => ["captacao.options", "captacao.create", "captacao.preflight", "captacao.send", "captacao.list"].includes(v))).toBe(true);
    for (const c of chamadas) expect(JSON.stringify(c.args)).not.toMatch(/"(notificar|avisar|destinatario|mensagem)"/);
  });

  it("não existe `kind` de aviso de captação para parte/proprietário em src/", () => {
    const raiz = join(__dirname, "..", "..");
    const achados: string[] = [];
    const varre = (dir: string) => {
      for (const nome of readdirSync(dir)) {
        const p = join(dir, nome);
        if (statSync(p).isDirectory()) { if (nome !== "__tests__") varre(p); continue; }
        if (!/\.(ts|tsx)$/.test(nome)) continue;
        if (/captacao_[a-z_]*_parte/i.test(readFileSync(p, "utf8"))) achados.push(p);
      }
    };
    varre(raiz);
    expect(achados).toEqual([]);
  });
});
