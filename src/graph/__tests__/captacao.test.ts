import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// O cofre de pendentes (achado 17) usa a mesma MAX_ENCRYPTION_KEY do cofre de crédito.
process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

/**
 * Fluxo `captacao` (P9): roteamento, gate (NEGADO antes do permitido), coleta,
 * criação cedo, complemento, conferência, resumo, envio (202, sem resposta,
 * brancos, versão) e a projeção. O ImobPro é um fake que VALIDA o que chega
 * (chave de idempotência nas escritas, versão, política) e o checkpoint nunca
 * pode ter CPF, e-mail nem telefone de proprietário.
 */

/**
 * Nit 3 (revisão opus, round 3): simula `fecharCofreCaptacao` falhando DEPOIS
 * de uma gravação bem-sucedida (ex.: chave rotacionada no meio do turno) sem
 * mexer na `MAX_ENCRYPTION_KEY` de verdade (isso quebraria a ABERTURA do
 * cofre também, não só o fechamento). `vi.hoisted` porque `vi.mock` é
 * hoisted para o topo do arquivo.
 */
const falhaFecharCofre = vi.hoisted(() => ({ proximaFalha: false }));
vi.mock("node:crypto", async (orig) => {
  const real = await orig<typeof import("node:crypto")>();
  return {
    ...real,
    createCipheriv: (...args: Parameters<typeof real.createCipheriv>) => {
      if (falhaFecharCofre.proximaFalha) {
        falhaFecharCofre.proximaFalha = false;
        throw new Error("falha simulada ao fechar o cofre (teste)");
      }
      return (real.createCipheriv as (...a: unknown[]) => ReturnType<typeof real.createCipheriv>)(...args);
    },
  };
});

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

const { buildGraph, RESET_DO_TURN, respostaDoTurno, encerrarTurno, threadIdFor } = await import("../graph");
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
let modelos: { id: string; nome: string; resumo?: string; exclusiva?: boolean }[] = [];
/** Confirmação única (26/10): faltantes extras que o Max sabe perguntar. */
let exigeCep = false;
let exigeTipo = false;
let exigeEstadoCivil = false;
/** Faltantes que só a tela resolve (sem tipo conhecido pelo Max) e bloqueios do preflight. */
let faltantesDaTela: { path: string; rotulo: string; etapa: string }[] = [];
let bloqueiosDoPreflight: Record<string, unknown>[] = [];
/** Quem assina pela imobiliária (papel `imobiliaria` no options). */
let assinanteImobiliaria: string | null = null;
/** `campos` do 422 dados_invalidos (o CM real pode mandar vazio). */
let campos422: string[] = [];
/** Força o 422 dados_invalidos no próximo complemento (qualquer dado). */
let complemento422 = false;
let assinaturaConfigurada = true;
/** Os campos `envio` que faltam: o fake exige matrícula para forçar a pergunta de faltante. */
let exigeMatricula = true;
let exigeRg = false;
let emBranco = 0;
let sendModo: "ok" | "202" | "sem_resposta" | { status: number; body: Record<string, unknown> } = "ok";
let createSemResposta = false;
let complementoDesatualizado = 0;
/** O próximo complemento GRAVA, mas a resposta se perde (o Max recebe null). */
let complementoSemResposta = false;
let sendEnvios = 0;
/** Item A: simula a tela mudando BEM na hora do envio — depois que o canal já
 *  foi aplicado (um `captacao.create`), mas no próprio `captacao.send`. */
let sendVersaoDesatualizada = 0;

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
  if (exigeCep && !im.cep) f.push({ path: "imovel.cep", rotulo: "CEP do imóvel", etapa: "imovel" });
  if (exigeTipo && !im.kind) f.push({ path: "imovel.tipo", rotulo: "Tipo do imóvel", etapa: "imovel" });
  for (const p of (d.proprietarios as Record<string, unknown>[] | undefined) ?? []) {
    if (!p.cpf && !p.cnpj) f.push({ path: "proprietarios[].cpf", rotulo: "CPF", etapa: "proprietarios", proprietarioId: String(p.id) });
    if (exigeRg && !p.rg) f.push({ path: "proprietarios[].rg", rotulo: "RG", etapa: "proprietarios", proprietarioId: String(p.id) });
    if (exigeEstadoCivil && p.tipo_pessoa !== "juridica" && !p.estado_civil) f.push({ path: "proprietarios[].estado_civil", rotulo: "Estado civil", etapa: "proprietarios", proprietarioId: String(p.id) });
  }
  if (!(d.proprietarios as unknown[] | undefined)?.length) f.push({ path: "proprietarios[].nome", rotulo: "Nome completo", etapa: "proprietarios" });
  if (c.tipo === "venda" && co.valor === undefined) f.push({ path: "condicoes.valor", rotulo: "Valor de venda", etapa: "condicoes" });
  if (co.comissao_percent === undefined) f.push({ path: "condicoes.comissao_percent", rotulo: "Comissão", etapa: "condicoes" });
  if (co.prazo_dias === undefined) f.push({ path: "condicoes.prazo_dias", rotulo: "Prazo da autorização (dias)", etapa: "condicoes" });
  return [...f, ...faltantesDaTela];
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
        const assinantesExtra = obj(c.dados.assinantes);
        const testemunhas = (assinantesExtra.testemunhas as Record<string, unknown>[] | undefined) ?? [];
        const avulsos = (assinantesExtra.avulsos as Record<string, unknown>[] | undefined) ?? [];
        return {
          status: 200,
          body: {
            ...base, modelos: [],
            assinantes: [
              ...donos.map((d) => ({ nome: d.nome ?? d.razao_social, papel: "proprietario", canal: "email", assina: true })),
              ...testemunhas.map((t) => ({ nome: t.nome, papel: "testemunha", canal: "email", assina: true })),
              ...avulsos.map((v) => ({ nome: v.nome, papel: "avulso", canal: "email", assina: true })),
              ...(assinanteImobiliaria ? [{ nome: assinanteImobiliaria, papel: "imobiliaria", canal: "email", assina: true }] : []),
            ],
          },
        };
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
        // Contrato do CM (26/10): o rascunho MESCLADO que não passa no schema
        // (ex.: mais de 4 testemunhas) volta 422 dados_invalidos e NADA é gravado.
        const assinantesNovos = obj(dados.assinantes);
        const assinantesAtuais = obj(c.dados.assinantes);
        const testemunhasMescladas = mesclarPorId(assinantesAtuais.testemunhas as never, assinantesNovos.testemunhas as never);
        if (testemunhasMescladas.length > 4) return { status: 422, body: { error: "dados_invalidos", campos: campos422 } };
        if (complemento422) { complemento422 = false; return { status: 422, body: { error: "dados_invalidos", campos: campos422 } }; }
        c.dados = {
          ...c.dados,
          ...(dados.imovel ? { imovel: { ...obj(c.dados.imovel), ...obj(dados.imovel) } } : {}),
          ...(dados.condicoes ? { condicoes: { ...obj(c.dados.condicoes), ...obj(dados.condicoes) } } : {}),
          ...(dados.locacao ? { locacao: { ...obj(c.dados.locacao), ...obj(dados.locacao) } } : {}),
          ...(dados.proprietarios ? { proprietarios: mesclarPorId(c.dados.proprietarios as never, dados.proprietarios as never) } : {}),
          ...(dados.assinantes ? {
            assinantes: {
              ...assinantesAtuais,
              testemunhas: testemunhasMescladas,
              avulsos: mesclarPorId(assinantesAtuais.avulsos as never, assinantesNovos.avulsos as never),
            },
          } : {}),
        };
        c.version += 1;
        const ok = grava(hash, { status: 200, body: { captacao: { id: c.id, codigo: c.codigo, nome: c.nome, esteira: c.tipo, estado: estadoDe(c), version: c.version } } });
        return complementoSemResposta ? (complementoSemResposta = false, null) : ok;
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
      const m0 = escolhidos[0]!;
      const resp = { status: 201, body: { captacao: { id: c.id, codigo: c.codigo, nome: c.nome, esteira: c.tipo, estado: "Rascunho", version: 0 }, modelo: { id: m0.id, nome: m0.nome, ...(typeof m0.exclusiva === "boolean" ? { exclusiva: m0.exclusiva } : {}) }, link: `/imoveis/captacoes/${c.id}` } };
      grava(hash, resp);
      return createSemResposta ? (createSemResposta = false, null) : resp;
    }
    case "captacao.preflight": {
      const c = captacoes.find((x) => x.id === a.captacaoId);
      if (!c) return { status: 404, body: { error: "nao_encontrada" } };
      if (c.status !== "rascunho") return { status: 409, body: { error: "nao_e_rascunho", estado: estadoDe(c) } };
      const faltantes = faltantesDe(c);
      return { status: 200, body: { captacaoId: c.id, version: c.version, modelo: { id: c.modeloId, nome: "Modelo" }, pronto: faltantes.length === 0 && !bloqueiosDoPreflight.length, faltantes, bloqueios: bloqueiosDoPreflight, emBranco } };
    }
    case "captacao.send": {
      if (!p.idempotencyKey) return { status: 400, body: { error: "idempotency_key_obrigatoria" } };
      const hash = JSON.stringify(a);
      const rep = replay(hash);
      if (rep !== undefined) return rep;
      const c = captacoes.find((x) => x.id === a.captacaoId);
      if (!c) return { status: 404, body: { error: "nao_encontrada" } };
      if (sendVersaoDesatualizada > 0) { sendVersaoDesatualizada -= 1; c.version += 1; }
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
  exigeCep = false; exigeTipo = false; exigeEstadoCivil = false; faltantesDaTela = []; bloqueiosDoPreflight = []; assinanteImobiliaria = null; campos422 = []; complemento422 = false;
  sendModo = "ok"; createSemResposta = false; complementoDesatualizado = 0; complementoSemResposta = false; sendEnvios = 0; sendVersaoDesatualizada = 0;
  falhaFecharCofre.proximaFalha = false;
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
  // Acesso ao `app`/`thread` crus — só pra teste que precisa corromper o
  // checkpoint diretamente (achado 5, replay de messageId) ou reinvocar com
  // uma messageId escolhida à mão (replay de confirmação).
  return Object.assign(fala, { app, thread });
}
const verbos = (v: string) => chamadas.filter((c) => c.verb === v);
const ultimo = (v: string) => [...chamadas].reverse().find((c) => c.verb === v);
const semDadosPessoais = (x: unknown) => {
  const j = JSON.stringify(x ?? null);
  return !j.includes(CPF_D) && !j.includes(CPF) && !j.includes(EMAIL) && !j.includes(FONE_D) && !j.includes(FONE) && !j.includes("98765");
};

/**
 * Conversa até o resumo final (confirmação única, 26/10): o rascunho nasce
 * com imóvel + condições, a proprietária e a matrícula são gravadas no turno
 * em que chegam — nenhum "sim" no meio. Devolve o resumo (o único "sim").
 */
async function ateOResumo(fala: ReturnType<typeof conversa>) {
  extracao = IMOVEL_EXTRAIDO;
  await fala("cria uma captação de venda do Apto da Dona Maria");
  await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
  await fala("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade");
  await fala(`Maria Silva, CPF ${CPF}, tel ${FONE}, ${EMAIL}, casada`);
  await fala("FIM");
  const r = await fala("não");
  return exigeMatricula ? fala("matrícula 12345") : r;
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
    expect(s.reply).toBe(cap.textoCaptacaoSemPolitica());
    expect(chamadas).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it("só com captacao.list: consulta funciona, criar não", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: SO_LEITURA } as never);
    const fala = conversa();
    const criar = await fala("cria uma captação de venda do Apto da Dona Maria");
    expect(criar.reply).toBe(cap.textoCaptacaoSemPolitica());
    expect(chamadas).toEqual([]);
    const listar = await fala("quais são as minhas captações?");
    expect(verbos("captacao.list")).toHaveLength(1);
    expect(listar.reply).toContain("Você não tem captações");
  });

  it("corretor comissionado (sem usuário): não liberada", async () => {
    const s = await conversa(corretor)("cria uma captação de venda do Apto da Dona Maria");
    expect(s.reply).toBe(cap.textoCaptacaoSemPolitica());
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
  it("natureza → modelo → imóvel → condições → cria → proprietário → faltante → resumo → um 'sim' envia", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;

    const pedido = await fala("cria uma captação de venda do Apto da Dona Maria");
    expect(verbos("captacao.options")[0]!.args).toEqual({ tipo: "venda" });
    expect(verbos("captacao.options")[0]!.key).toBeUndefined();
    expect(pedido.reply).toContain("Qual o imóvel?");

    const imovel = await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    expect(imovel.reply).toContain("Anotei o imóvel");
    expect(verbos("captacao.create")).toEqual([]);

    // Confirmação única (26/10): imóvel + condições bastam — o rascunho nasce já, sem "Posso criar?".
    const cond = await fala("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade");
    const criacao = verbos("captacao.create")[0]!;
    expect(criacao.key).toBe(cond.messageId);
    expect(criacao.args).toMatchObject({ tipo: "venda", nome: "Apto da Dona Maria", modeloId: "t1" });
    expect(criacao.args.dados).toMatchObject({
      imovel: { rua: "Rua Augusta", numero: "1250", cidade: "São Paulo", uf: "SP" },
      condicoes: { valor: 850000, comissao_percent: 6, prazo_dias: 180, exclusiva: true },
    });
    expect(cond.reply).toContain("Criei o rascunho CAP-2026-0001");
    expect(cond.reply).not.toContain("Posso criar");
    expect(cond.reply).toContain("FIM");

    // A proprietária é GRAVADA no turno em que chega (chave = messageId); nada de PII no estado.
    const dono = await fala(`Maria Silva, CPF ${CPF}, tel ${FONE}, ${EMAIL}, casada`);
    const compl = verbos("captacao.create")[1]!;
    expect(compl.args).toMatchObject({ captacaoId: "cap-1", version: 0 });
    expect(compl.args.dados).toMatchObject({ proprietarios: [{ id: "p1", papel: "proprietario", tipo_pessoa: "fisica", nome: "Maria Silva", cpf: CPF_D, telefone1: `+55${FONE_D}`, email: EMAIL, estado_civil: "casada" }] });
    expect(compl.key).toBe(dono.messageId);
    expect(dono.reply).toContain("Anotei Maria Silva");
    expect(dono.reply).not.toContain("Vou gravar");
    // `inbound` leva o texto cru só nos testes que chamam `buildGraph` direto (o `runTurn` o entra sem texto).
    const vazou = Object.entries(dono).filter(([k, v]) => k !== "inbound" && !semDadosPessoais(v)).map(([k]) => k);
    expect(vazou).toEqual([]);

    const fim = await fala("FIM");
    expect(fim.reply).toContain("testemunha");
    const faltante = await fala("não");
    expect(verbos("captacao.preflight")).toHaveLength(1);
    expect(faltante.reply).toContain("Matrícula do imóvel?");

    const resumo = await fala("matrícula 12345");
    const gravado = ultimo("captacao.create")!;
    expect(gravado.args.dados).toEqual({ imovel: { matricula: "12345" } });
    expect(gravado.key).toBe(resumo.messageId);
    expect(verbos("captacao.preflight")).toHaveLength(2);
    expect(resumo.reply).toContain("Pronta a captação CAP-2026-0001 — Apto da Dona Maria.");
    expect(resumo.reply).toContain("Imóvel: Rua Augusta, 1250, Bela Vista, São Paulo/SP.");
    expect(resumo.reply).toContain("Condições:");
    expect(resumo.reply).toContain("Proprietário: Maria Silva.");
    expect(resumo.reply).toContain("Envio: Maria Silva por e-mail.");
    expect(resumo.reply).toContain("Responda *sim* para enviar");
    expect(semDadosPessoais(resumo.reply)).toBe(true);
    expect(verbos("captacao.options").at(-1)!.args).toEqual({ captacaoId: "cap-1" });
    expect(verbos("captacao.send")).toEqual([]);

    const enviado = await fala("sim");
    // Nenhum canal dito: nada a regravar — o "sim" vai direto ao send (o canal que está no rascunho vale).
    expect(verbos("captacao.create")).toHaveLength(3);
    const envio = verbos("captacao.send")[0]!;
    expect(envio.args).toEqual({ captacaoId: "cap-1", version: captacoes[0]!.version });
    expect(envio.key).toBe(enviado.messageId);
    expect(verbos("captacao.send")).toHaveLength(1);
    expect(sendEnvios).toBe(1);
    expect(enviado.reply).toContain("Enviado");
    expect(enviado.reply).toContain("Em assinatura");
    expect(enviado.fluxo ?? null).toBeNull();
    // O checkpoint guarda só referência: nunca CPF, e-mail ou telefone.
    const vazouNoFim = Object.entries(enviado).filter(([k, v]) => k !== "inbound" && !semDadosPessoais(v)).map(([k]) => k);
    expect(vazouNoFim).toEqual([]);
  });

  it("'sim, por WhatsApp' no resumo: regrava o canal (chave :canal) e envia na mesma resposta", async () => {
    const fala = conversa();
    const resumo = await ateOResumo(fala);
    expect(resumo.reply).toContain('"sim, por WhatsApp"');
    const antes = verbos("captacao.create").length;
    const s = await fala("sim, por WhatsApp");
    expect(verbos("captacao.create")).toHaveLength(antes + 1);
    const canal = ultimo("captacao.create")!;
    expect(canal.args.dados).toEqual({ proprietarios: [{ id: "p1", canal: "whatsapp" }] });
    expect(canal.key).toBe(`${s.messageId}:canal`);
    expect(verbos("captacao.send")).toHaveLength(1);
    expect(verbos("captacao.send")[0]!.key).toBe(s.messageId);
    expect(s.reply).toContain("Enviado");
  });

  it("resposta que não é 'sim' no resumo NÃO envia (vai pro atendimento normal)", async () => {
    const fala = conversa();
    await ateOResumo(fala);
    const outra = await fala("qual o horário de vocês?");
    expect(verbos("captacao.send")).toEqual([]);
    expect(outra.reply).toContain("O horário é das 9h às 18h.");
    await fala("sim");
    expect(verbos("captacao.send")).toHaveLength(1);
  });

  it("'enviar' continua valendo como o 'sim' do resumo", async () => {
    const fala = conversa();
    await ateOResumo(fala);
    const s = await fala("enviar");
    expect(verbos("captacao.send")).toHaveLength(1);
    expect(s.reply).toContain("Enviado");
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

  it("extras: testemunha vira testemunhas[], avulso vira avulsos[] — cada um gravado no turno em que chega", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    await fala(`Maria Silva, CPF ${CPF}, casada`);
    await fala("FIM");
    const t = await fala(`testemunha Carlos Pereira, ${EMAIL.replace("maria", "carlos")}`);
    expect(t.reply).toContain("como testemunha");
    const gT = ultimo("captacao.create")!;
    expect(gT.key).toBe(t.messageId);
    expect((gT.args.dados as { assinantes: { testemunhas: unknown[] } }).assinantes.testemunhas).toHaveLength(1);
    const a = await fala(`Pedro Alves, tel ${FONE}`);
    expect(a.reply).toContain("como assinante");
    const gA = ultimo("captacao.create")!;
    expect(gA.key).toBe(a.messageId);
    expect((gA.args.dados as { assinantes: { avulsos: unknown[] } }).assinantes.avulsos).toHaveLength(1);
    const noServidor = obj(captacoes[0]!.dados.assinantes);
    expect(noServidor.testemunhas).toHaveLength(1);
    expect(noServidor.avulsos).toHaveLength(1);
    const vazou = Object.entries(a).filter(([k, v]) => k !== "inbound" && !semDadosPessoais(v)).map(([k]) => k);
    expect(vazou).toEqual([]);
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

  it("cancelar antes das condições: nada foi criado", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    const antes = chamadas.length;
    const s = await fala("cancelar");
    expect(s.reply).toContain("Nada foi criado");
    expect(chamadas).toHaveLength(antes);
  });
  it("cancelar depois de criado: o rascunho fica salvo e nada mais é chamado", async () => {
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
    const incerto = await fala("valor 850 mil"); // cria já (confirmação única) — e fica sem resposta
    expect(incerto.reply).toContain("não sei se deu certo");
    const outra = await fala("conversa fiada");
    expect(verbos("captacao.create")).toHaveLength(1);
    expect(outra.reply).toBeTruthy();
    const ok = await fala("sim");
    const [primeira, segunda] = verbos("captacao.create");
    expect(segunda!.key).toBe(primeira!.key);
    expect(segunda!.key).toBe(incerto.messageId);
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
    await fala("valor 850 mil"); // cria o rascunho, version 0
    // O proprietário é gravado no turno em que chega — é aí que a versão desatualizada aparece.
    complementoDesatualizado = 1;
    const s = await fala(`Maria Silva, CPF ${CPF}, casada`);
    expect(s.reply).toContain("Alguém mudou a captação na tela; vou conferir de novo.");
    expect(s.reply).toContain("Anotei Maria Silva");
    expect(verbos("captacao.preflight")).toHaveLength(1);
    const [tentativa1, tentativa2] = verbos("captacao.create").slice(1);
    expect(tentativa1!.args.version).toBe(0);
    expect(tentativa2!.args.version).toBe(1);
    expect(tentativa2!.key).not.toBe(tentativa1!.key);
    expect(verbos("captacao.create")).toHaveLength(3);
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
    // Gravado no mesmo turno — o valor vai pro servidor, nunca pro texto nem pro estado.
    const grava = ultimo("captacao.create")!;
    expect(JSON.stringify(grava.args)).toContain("12.345.678-9");
    expect(grava.key).toBe(r.messageId);
    expect(r.reply).toContain("RG anotado");
    expect(JSON.stringify(r.reply)).not.toContain("12.345.678");
    expect(JSON.stringify(r.reply)).not.toContain("12345678");
    expect(JSON.stringify(r.fluxo ?? null)).not.toContain("12.345.678");
    expect(JSON.stringify(r.replyNoState ?? "")).not.toContain("12.345.678");
    expect(r.reply).toContain("Pronta a captação");
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

  it("achado 25: o resumo já avisa os brancos, e UM 'enviar' só já manda confirmarBrancos:true", async () => {
    emBranco = 2;
    const fala = conversa();
    const resumo = await ateOResumo(fala);
    expect(resumo.reply).toContain("2 campo(s) vão em branco");
    const ok = await fala("enviar");
    expect(verbos("captacao.send")).toHaveLength(1);
    expect(verbos("captacao.send")[0]!.args).toMatchObject({ confirmarBrancos: true });
    expect(ok.reply).toContain("Enviado");
  });

  it("servidor acusa confirmar_brancos de surpresa (a tela mudou depois do resumo): diz os brancos e pede o 'sim' de novo", async () => {
    const fala = conversa();
    const resumo = await ateOResumo(fala);
    expect(resumo.reply).not.toContain("em branco");
    emBranco = 2; // só o SEND vê o branco — o preflight não tinha avisado
    const pergunta = await fala("sim");
    expect(pergunta.reply).toContain("2 campo(s) vão em branco no contrato");
    expect(pergunta.reply).toContain("Responda *sim* para enviar assim mesmo");
    expect(verbos("captacao.send")[0]!.args).not.toHaveProperty("confirmarBrancos");
    const ok = await fala("sim");
    const [primeira, segunda] = verbos("captacao.send");
    expect(segunda!.args).toMatchObject({ confirmarBrancos: true });
    expect(segunda!.key).not.toBe(primeira!.key);
    expect(sendEnvios).toBe(1);
    expect(ok.reply).toContain("Enviado");
  });

  it("'enviar assim mesmo' ainda vale como o 'sim' depois do aviso de brancos", async () => {
    const fala = conversa();
    await ateOResumo(fala);
    emBranco = 1;
    await fala("sim");
    const ok = await fala("enviar assim mesmo");
    expect(verbos("captacao.send").at(-1)!.args).toMatchObject({ confirmarBrancos: true });
    expect(ok.reply).toContain("Enviado");
  });

  it("item 1 (revisão opus, round 3): versao_desatualizada ao aplicar o canal NÃO reenvia sozinho — mostra o resumo de novo, só o próximo 'sim' confirma", async () => {
    const fala = conversa();
    await ateOResumo(fala);
    // A tela mudou ENTRE o resumo mostrado e este "sim, por WhatsApp" — o 409
    // vem no complemento que aplica o canal (antes do `captacao.send`).
    complementoDesatualizado = 1;
    const antesDoPreflight = verbos("captacao.preflight").length;
    const s = await fala("sim, por WhatsApp");
    expect(sendEnvios).toBe(0);
    expect(verbos("captacao.send")).toHaveLength(0);
    expect(s.reply).toContain("Alguém mudou a captação na tela; vou conferir de novo.");
    // novo resumo (não o texto genérico de erro), já com o canal pedido — a confirmação antiga não vale.
    expect(s.reply).toContain("Envio: Maria Silva por WhatsApp.");
    expect(verbos("captacao.preflight")).toHaveLength(antesDoPreflight + 1);
    const ok = await fala("sim");
    expect(ultimo("captacao.create")!.args.dados).toEqual({ proprietarios: [{ id: "p1", canal: "whatsapp" }] });
    expect(sendEnvios).toBe(1);
    expect(ok.reply).toContain("Enviado");
  });

  it("versao_desatualizada no próprio send: texto combinado, novo preflight e novo resumo", async () => {
    const fala = conversa();
    await ateOResumo(fala);
    sendVersaoDesatualizada = 1;
    const antes = verbos("captacao.preflight").length;
    const s = await fala("sim");
    expect(s.reply).toContain("Alguém mudou a captação na tela; vou conferir de novo.");
    expect(verbos("captacao.preflight")).toHaveLength(antes + 1);
    expect(s.reply).toContain("Responda *sim* para enviar");
    expect(sendEnvios).toBe(0);
    await fala("sim");
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

  it("resumo lista testemunha e quem assina pela imobiliária; 'por WhatsApp' sozinho troca o canal e refaz o resumo, sem enviar", async () => {
    assinanteImobiliaria = "Ana Gerente";
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade");
    await fala(`Maria Silva, CPF ${CPF}, tel ${FONE}, ${EMAIL}, casada`);
    await fala("FIM");
    await fala(`Carlos Pereira, testemunha, tel ${FONE}`);
    await fala("não"); // fecha extras
    const r = await fala("matrícula 12345");
    expect(r.reply).toContain("Proprietário: Maria Silva.");
    expect(r.reply).toContain("Testemunha: Carlos Pereira.");
    expect(r.reply).toContain("Pela imobiliária assina: Ana Gerente.");
    // quem assina pela imobiliária tem linha própria — não entra na lista do envio
    expect(r.reply).toContain("Envio: Maria Silva e Carlos Pereira por e-mail.");
    const troca = await fala("por WhatsApp");
    expect(verbos("captacao.send")).toEqual([]);
    expect(troca.reply).toContain("Certo, por WhatsApp.");
    expect(troca.reply).toContain("Envio: Maria Silva (WhatsApp) e Carlos Pereira (e-mail).");
    await fala("sim");
    expect(verbos("captacao.send")).toHaveLength(1);
    expect(sendEnvios).toBe(1);
  });
});
describe("envio de rascunho existente e consulta", () => {
  it("'envia a captação da Maria': acha o rascunho, confere e pede o 'enviar'", async () => {
    captacoes.push({ id: "cap-1", codigo: "CAP-2026-0001", nome: "Apto da Dona Maria", tipo: "venda", modeloId: "t1", version: 4, status: "rascunho",
      dados: { imovel: { rua: "Rua Augusta", numero: "1250", matricula: "1" }, proprietarios: [{ id: "p1", nome: "Maria Silva", cpf: CPF_D }], condicoes: { valor: 1, comissao_percent: 6, prazo_dias: 90 } } });
    const fala = conversa();
    const s = await fala("envia a captação da Maria para assinatura");
    expect(verbos("captacao.list")[0]!.args).toMatchObject({ busca: "Maria", situacao: "rascunho" });
    // Item C: sem ids locais (rascunho carregado pelo ENVIO, não pela
    // criação), nenhuma resposta ao 1/2/3 pode ser aplicada (achado 3) —
    // perguntar seria pergunta inútil. Vai direto ao resumo com o canal que já
    // está no servidor.
    expect(s.reply).not.toContain("Por qual canal envio?");
    expect(s.reply).toContain("Envio: Maria Silva por e-mail.");
    await fala("enviar");
    expect(verbos("captacao.send")[0]!.args).toEqual({ captacaoId: "cap-1", version: 4 });
  });

  it("achado 23/28/3: canal dito na própria mensagem dispensa a pergunta, MAS um rascunho já existente não aceita a troca — o Max avisa, não finge", async () => {
    captacoes.push({ id: "cap-1", codigo: "CAP-2026-0001", nome: "Apto da Dona Maria", tipo: "venda", modeloId: "t1", version: 4, status: "rascunho",
      dados: { imovel: { rua: "Rua Augusta", numero: "1250", matricula: "1" }, proprietarios: [{ id: "p1", nome: "Maria Silva", cpf: CPF_D }], condicoes: { valor: 1, comissao_percent: 6, prazo_dias: 90 } } });
    const fala = conversa();
    const s = await fala("envia a captação da Maria, para mandar por aceite no whatsapp");
    expect(s.reply).not.toContain("Por qual canal envio?");
    expect(s.reply).toContain("Envio: Maria Silva");
    // Achado 3 (revisão opus): sem ids locais (rascunho carregado pelo envio,
    // não pela criação), o Max NUNCA manda `{proprietarios:[{id,canal}]}` pro
    // servidor — então nenhuma chamada pode mencionar o canal pedido, e o
    // Max tem que avisar isso, em vez de aparentar ter aplicado.
    expect(s.reply).toContain("Não consigo trocar o canal deste rascunho");
    // o canal de verdade (do servidor, "email" no fake) é o que aparece — nunca "aceite"
    expect(s.reply).toContain("por e-mail");
    expect(s.reply).not.toContain("por aceite");
    for (const c of chamadas) expect(JSON.stringify(c.args)).not.toContain("aceite");
    await fala("enviar");
    // o envio foi em frente (pelo canal real, que o Max não mudou) — nunca travou a conversa.
    expect(verbos("captacao.send")).toHaveLength(1);
  });

  it("listar: sem donos no item, não diz nome de proprietário", async () => {
    captacoes.push({ id: "cap-1", codigo: "CAP-2026-0001", nome: "Apto da Dona Maria", tipo: "venda", modeloId: "t1", version: 0, status: "rascunho", dados: {} });
    const s = await conversa()("quais são as minhas captações?");
    expect(s.reply).toContain("CAP-2026-0001 — Apto da Dona Maria (venda) · Rascunho");
    expect(s.reply).not.toContain("Proprietários");
  });
});

describe("achado 18: conversa solta não vira proprietário", () => {
  it("'Bom dia Roberto' (nome válido, sem CPF/CNPJ nem rótulo) é recusado", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    const s = await fala("Bom dia Roberto");
    expect(s.reply).toContain("CPF");
    expect((s.fluxo as { proprietarios?: unknown[] } | null)?.proprietarios ?? []).toEqual([]);
  });

  it("CPF explícito ainda funciona (não regride)", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    const s = await fala(`Maria Silva, CPF ${CPF}`);
    expect(s.reply).toContain("Anotei Maria Silva");
    expect((s.fluxo as { proprietarios?: unknown[] } | null)?.proprietarios).toHaveLength(1);
  });

  it("sem documento, mas com rótulo explícito ('proprietário: Nome') ainda funciona", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    const s = await fala("proprietário: Maria Silva");
    expect(s.reply).toContain("Anotei Maria Silva");
  });
});

describe("achado 21: usuário só com captacao.send (sem captacao.create)", () => {
  const SO_ENVIO = POLITICA(["captacao.list", "captacao.send"]);

  it("envia um rascunho já PRONTO (sem faltante) sem travar", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: SO_ENVIO } as never);
    exigeMatricula = false;
    captacoes.push({ id: "cap-1", codigo: "CAP-2026-0001", nome: "Apto da Dona Maria", tipo: "venda", modeloId: "t1", version: 0, status: "rascunho",
      dados: { imovel: { rua: "Rua Augusta", numero: "1250" }, proprietarios: [{ id: "p1", nome: "Maria Silva", cpf: CPF_D }], condicoes: { valor: 1, comissao_percent: 6, prazo_dias: 90 } } });
    const fala = conversa();
    await fala("envia a captação da Maria para assinatura");
    await fala("1"); // canal
    const s = await fala("enviar");
    expect(verbos("captacao.send")).toHaveLength(1);
    expect(s.reply).toContain("Enviado");
  });

  it("rascunho com faltante: mensagem CLARA (não a genérica de 'não liberada'), e não trava a conversa", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: SO_ENVIO } as never);
    // exigeMatricula (padrão true) falta de propósito aqui.
    captacoes.push({ id: "cap-1", codigo: "CAP-2026-0001", nome: "Apto da Dona Maria", tipo: "venda", modeloId: "t1", version: 0, status: "rascunho",
      dados: { imovel: { rua: "Rua Augusta", numero: "1250" }, proprietarios: [{ id: "p1", nome: "Maria Silva", cpf: CPF_D }], condicoes: { valor: 1, comissao_percent: 6, prazo_dias: 90 } } });
    const fala = conversa();
    const pedido = await fala("envia a captação da Maria para assinatura");
    expect(pedido.reply).toContain("Matrícula");
    const s = await fala("matrícula 12345");
    expect(s.reply).not.toBe(cap.textoCaptacaoSemPolitica());
    expect(s.reply).toContain("outra permissão");
    expect(s.reply).toContain("/imoveis/captacoes/cap-1");
  });

  it("fail-closed: sem NENHUMA capability de captação, pedido de envio é recusado", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: SEM_CAPTACAO } as never);
    const s = await conversa()("envia a captação da Maria para assinatura");
    expect(s.reply).toBe(cap.textoCaptacaoSemPolitica());
    expect(chamadas).toEqual([]);
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

// ─── Revisão opus (achados 1-6 + nits) ──────────────────────────────────────

describe("achado 1 (revisão opus): o 1º pedido nunca fica em claro", () => {
  it("1ª mensagem já com nome + CPF/telefone: nada disso sobra no estado nem vai ao extrator", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    const s = await fala(
      `cria uma captação de venda do Apto da Dona Maria, CPF ${CPF}, tel ${FONE}, Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP, sem exclusividade`
    );
    // Confirmação única: com imóvel + condição (exclusividade) já cria — e nada do CPF/telefone vai junto.
    expect(s.reply).toContain("Criei o rascunho");
    expect(JSON.stringify(verbos("captacao.create"))).not.toContain(CPF_D);
    expect(JSON.stringify(verbos("captacao.create"))).not.toContain(FONE_D);
    const vazou = Object.entries(s).filter(([k, v]) => k !== "inbound" && !semDadosPessoais(v)).map(([k]) => k);
    expect(vazou).toEqual([]);
    expect(JSON.stringify(llm.mock.calls)).not.toContain(CPF_D);
    expect(JSON.stringify(llm.mock.calls)).not.toContain(FONE_D);
    expect((s.fluxo as { pedidoOriginal?: string } | null)?.pedidoOriginal).toBeUndefined();
  });

  it("sem nome no pedido: o CPF do 1º pedido não sobrevive até a mensagem do nome (nem antes, nem depois)", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    const p1 = await fala(`quero uma captação de venda, CPF ${CPF}, tel ${FONE}`);
    expect(p1.reply).toContain("Que nome dou");
    const vazou1 = Object.entries(p1).filter(([k, v]) => k !== "inbound" && !semDadosPessoais(v)).map(([k]) => k);
    expect(vazou1).toEqual([]);
    const p2 = await fala("Casa da Dona Rosa");
    const vazou2 = Object.entries(p2).filter(([k, v]) => k !== "inbound" && !semDadosPessoais(v)).map(([k]) => k);
    expect(vazou2).toEqual([]);
    expect(JSON.stringify(llm.mock.calls)).not.toContain(CPF_D);
    expect((p2.fluxo as { pedidoOriginal?: string } | null)?.pedidoOriginal).toBeUndefined();
  });
});

describe("achado 2 (revisão opus): 'verificar' é read-only — nunca exige captacao.create", () => {
  const SO_ENVIO_2 = POLITICA(["captacao.list", "captacao.send"]);

  it("send-only rebaixado de 'canal' pra 'verificar' (halt por leitura de anexo) ainda consegue concluir o envio", async () => {
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: SO_ENVIO_2 } as never);
    exigeMatricula = false;
    captacoes.push({ id: "cap-1", codigo: "CAP-2026-0001", nome: "Apto da Dona Maria", tipo: "venda", modeloId: "t1", version: 0, status: "rascunho",
      dados: { imovel: { rua: "Rua Augusta", numero: "1250" }, proprietarios: [{ id: "p1", nome: "Maria Silva", cpf: CPF_D }], condicoes: { valor: 1, comissao_percent: 6, prazo_dias: 90 } } });
    const fala = conversa();
    await fala("envia a captação da Maria para assinatura");
    // Item C: sem ids locais (rascunho carregado pelo envio), o resumo não
    // pergunta mais o canal (não dá pra aplicar nenhuma resposta) — a etapa
    // "canal" só existe quando a captação foi criada pelo Max (com
    // `captacao.create`). Pra exercitar o rebaixamento dela (o que ESTE
    // achado testa: a etapa "verificar", read-only, não pode herdar a
    // exigência de create da etapa de onde veio), força a etapa manualmente.
    const app = (fala as unknown as { app: { getState: Function; updateState: Function } }).app;
    const thread = (fala as unknown as { thread: string }).thread;
    const estado = await app.getState({ configurable: { thread_id: thread } });
    const atual = (estado as { values: { fluxo: Record<string, unknown> } }).values.fluxo;
    await app.updateState({ configurable: { thread_id: thread } }, { fluxo: { ...atual, etapa: "canal" } });
    const halt = await fala("lê a foto que eu te mandei"); // pedeLeituraDeAnexo -> halt -> rebaixarFluxo
    expect((halt.fluxo as { etapa?: string } | null)?.etapa).toBe("verificar");
    // Etapa "verificar": a mensagem não é interpretada como resposta ao canal
    // (isso só acontece de volta na etapa "canal") — ela só reconfere e
    // repergunta. O que importa pro achado 2: ANTES do fix, send-only (sem
    // `captacao.create`) era recusado aqui com a frase fixa de "não liberada".
    const depois = await fala("1");
    expect(depois.reply).not.toBe(cap.textoCaptacaoSemPolitica());
    // Sem ids locais, "verificar" -> resumir() nem repergunta o canal (item C
    // — já volta direto pro resumo de envio).
    expect(depois.reply).toContain("Envio: Maria Silva");
    await fala("enviar");
    expect(verbos("captacao.send")).toHaveLength(1);
  });
});

describe("achado 4 (revisão opus): a escrita do canal exige captacao.create de verdade", () => {
  it("permissão de criação perdida no meio do fluxo nega a gravação do canal, sem tentar escrever", async () => {
    const fala = conversa();
    const resumo = await ateOResumo(fala);
    expect(resumo.reply).toContain("Pronta a captação");
    // a política é relida a cada turno — perde `captacao.create` justo antes
    // do "sim, por WhatsApp" que tentaria aplicar o canal.
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: POLITICA(["captacao.list", "captacao.send"]) } as never);
    const antes = verbos("captacao.create").length;
    const s = await fala("sim, por WhatsApp");
    expect(verbos("captacao.create")).toHaveLength(antes);
    expect(verbos("captacao.send")).toEqual([]);
    expect(s.reply).toContain("permissão");
  });
});
describe("achado 5 (revisão opus): cofre falha fechado, nunca lança nem perde em silêncio", () => {
  it("cifrar/decifrar: roundtrip ok; thread errada, tag adulterada, payload malformado e chave ausente todos LANÇAM (nunca devolvem lixo)", () => {
    const thread = "thread-de-teste-1";
    const payload = cap.cifrarCofreCaptacao("segredo-123", thread);
    expect(cap.decifrarCofreCaptacao(payload, thread)).toBe("segredo-123");
    expect(() => cap.decifrarCofreCaptacao(payload, "outra-thread")).toThrow();
    const [iv, tag, dado] = payload.split(".");
    const tagAdulterada = Buffer.from(tag!, "base64");
    tagAdulterada[0] = tagAdulterada[0]! ^ 0xff;
    expect(() => cap.decifrarCofreCaptacao([iv, tagAdulterada.toString("base64"), dado].join("."), thread)).toThrow();
    expect(() => cap.decifrarCofreCaptacao("so-uma-parte", thread)).toThrow();
    const antiga = process.env.MAX_ENCRYPTION_KEY;
    try {
      delete process.env.MAX_ENCRYPTION_KEY;
      expect(() => cap.cifrarCofreCaptacao("x", thread)).toThrow();
      expect(() => cap.decifrarCofreCaptacao(payload, thread)).toThrow();
    } finally {
      process.env.MAX_ENCRYPTION_KEY = antiga;
    }
  });

  it("checkpoint antigo (confirmar_pessoas) com cofre de OUTRA thread: avisa e NÃO grava nada", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    const app = (fala as unknown as { app: { getState: Function; updateState: Function } }).app;
    const thread = (fala as unknown as { thread: string }).thread;
    const estado = await app.getState({ configurable: { thread_id: thread } });
    const atual = (estado as { values: { fluxo: Record<string, unknown> } }).values.fluxo;
    const cofreDeOutraThread = cap.cifrarCofreCaptacao(JSON.stringify({ proprietarios: [{ id: "p1", nome: "Maria" }] }), "thread-que-nao-e-esta");
    await app.updateState({ configurable: { thread_id: thread } }, { fluxo: { ...atual, etapa: "confirmar_pessoas", cofre: cofreDeOutraThread } });
    const antesDeEscritas = verbos("captacao.create").length;
    const s = await fala("sim");
    expect(s.reply).toContain("Não consegui");
    expect(verbos("captacao.create")).toHaveLength(antesDeEscritas);
  });

  it("checkpoint antigo (confirmar_pessoas) com o cofre desta thread: grava o que ficou lá (chave :legado) e segue sem pedir outro 'sim'", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade");
    const app = (fala as unknown as { app: { getState: Function; updateState: Function } }).app;
    const thread = (fala as unknown as { thread: string }).thread;
    const estado = await app.getState({ configurable: { thread_id: thread } });
    const atual = (estado as { values: { fluxo: Record<string, unknown> } }).values.fluxo;
    const pendentes = { proprietarios: [{ id: "p1", papel: "proprietario", tipo_pessoa: "fisica", nome: "Maria Silva", cpf: CPF_D, estado_civil: "casada" }], testemunhas: [], avulsos: [] };
    const cofre = cap.cifrarCofreCaptacao(JSON.stringify(pendentes), threadIdFor("org1", "5511987654321"));
    await app.updateState({ configurable: { thread_id: thread } }, {
      fluxo: { ...atual, etapa: "confirmar_pessoas", cofre, proprietarios: [{ id: "p1", nome: "Maria Silva" }] },
    });
    const s = await fala("sim");
    const grava = verbos("captacao.create")[1]!;
    expect(grava.key).toBe(`${s.messageId}:legado`);
    expect(grava.args.dados).toMatchObject({ proprietarios: [{ id: "p1", cpf: CPF_D }] });
    expect(captacoes[0]!.dados.proprietarios).toHaveLength(1);
    // seguiu sozinho para a conferência (a matrícula é o faltante), sem pedir outro "sim"
    expect(s.reply).toContain("Matrícula do imóvel?");
    expect((s.fluxo as { cofre?: string } | null)?.cofre).toBeUndefined();
    expect(semDadosPessoais(s.fluxo)).toBe(true);
  });

  it("o fluxo novo não usa o cofre: sem MAX_ENCRYPTION_KEY o proprietário é gravado e nada de PII fica no estado", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    const antiga = process.env.MAX_ENCRYPTION_KEY;
    const antesDeEscritas = verbos("captacao.create").length;
    let s: Awaited<ReturnType<typeof fala>>;
    try {
      delete process.env.MAX_ENCRYPTION_KEY;
      s = await fala(`Maria Silva, CPF ${CPF}, casada`);
    } finally {
      process.env.MAX_ENCRYPTION_KEY = antiga;
    }
    expect(s.reply).toContain("Anotei Maria Silva");
    expect(verbos("captacao.create")).toHaveLength(antesDeEscritas + 1);
    expect((s.fluxo as { cofre?: string } | null)?.cofre).toBeUndefined();
    expect(semDadosPessoais(s.fluxo)).toBe(true);
  });
});
describe("achado 6 (revisão opus): resposta com CPF que termina em '?' não escapa pro atendimento normal", () => {
  it("'Maria, CPF ..., casada?' é lida como proprietário — não pausa, e nada vaza", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    const dono = await fala(`Maria Silva, CPF ${CPF}, casada?`);
    expect(dono.reply).toContain("Anotei Maria Silva");
    expect(dono.reply).not.toBe("O horário é das 9h às 18h.");
    expect((dono.fluxo as { pausado?: boolean } | null)?.pausado).toBeFalsy();
    const vazou = Object.entries(dono).filter(([k, v]) => k !== "inbound" && !semDadosPessoais(v)).map(([k]) => k);
    expect(vazou).toEqual([]);
  });

  it("pergunta de verdade (sem CPF/contato) ainda pausa pro atendimento normal", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    const s = await fala("qual o horário de vocês?");
    // `pausar` marca `pausado:true`, mas o `compose` já tira a marca no mesmo
    // turno (ela só serve pra ele colar o "Continuando..." na resposta do
    // modelo) — por isso o estado final tem `pausado:false`, não `true`.
    expect(s.reply).toContain("O horário é das 9h às 18h.");
    expect(s.reply).toContain("Continuando a captação");
    expect((s.fluxo as { pausado?: boolean } | null)?.pausado).toBe(false);
  });

  it("o mesmo vale pra extras (testemunha/avulso) com e-mail/telefone", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    await fala(`Maria Silva, CPF ${CPF}`);
    await fala("FIM");
    const extra = await fala(`testemunha Carlos Pereira, ${EMAIL.replace("maria", "carlos")}, ele confirma?`);
    expect(extra.reply).toContain("como testemunha");
    expect((extra.fluxo as { pausado?: boolean } | null)?.pausado).toBeFalsy();
  });
});

describe("achado 22: 1ª mensagem completa (natureza+nome+endereço+condições+canal) não repergunta nada disso", () => {
  it("cria direto do pedido inicial, sem pedir confirmação", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    const s = await fala(
      "cria uma captação de venda do Apto da Dona Maria, Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP, " +
      "valor 850 mil, comissão 6%, prazo 180 dias, sem exclusividade, aceite por whatsapp"
    );
    expect(s.reply).not.toContain("Qual o imóvel?");
    expect(s.reply).not.toContain("Condições da captação");
    expect(s.reply).not.toContain("Posso criar");
    const criado = verbos("captacao.create")[0]!;
    expect(criado.key).toBe(s.messageId);
    expect(criado.args).toMatchObject({ tipo: "venda", nome: "Apto da Dona Maria" });
    expect(criado.args.dados).toMatchObject({
      imovel: { rua: "Rua Augusta", numero: "1250" },
      condicoes: { valor: 850000, comissao_percent: 6, prazo_dias: 180, exclusiva: false },
    });
    expect(s.reply).toContain("Criei o rascunho");
  });
});
describe("achado 26: o extrator corta o fim do logradouro como complemento", () => {
  it("'Rua TESTE Max Aceite, 88' sem número/palavra de complemento: junta de volta na rua", async () => {
    const extrairFake: import("../captacao").ExtratorDeSecao = async () => ({
      rua: "Rua TESTE", numero: "88", complemento: "Max Aceite", bairro: "Centro", cidade: "São Paulo", uf: "SP",
    });
    const r = await cap.lerImovel("Rua TESTE Max Aceite, 88, Centro, São Paulo/SP", extrairFake);
    expect(r.dados.rua).toBe("Rua TESTE Max Aceite");
    expect(r.dados.complemento).toBeUndefined();
  });

  it("complemento de verdade ('ap 42', tem número): NÃO junta na rua", async () => {
    const extrairFake: import("../captacao").ExtratorDeSecao = async () => ({
      rua: "Rua Augusta", numero: "1250", complemento: "ap 42", bairro: "Bela Vista", cidade: "São Paulo", uf: "SP",
    });
    const r = await cap.lerImovel("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP", extrairFake);
    expect(r.dados.rua).toBe("Rua Augusta");
    expect(r.dados.complemento).toBe("ap 42");
  });
});

describe("nit: replay EXATO da mesma messageId não duplica", () => {
  it("webhook reentrega a MESMA messageId da mensagem que cria: mesma chave, cria uma vez só", async () => {
    createSemResposta = true; // 1ª tentativa fica sem resposta — a etapa NÃO avança.
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    const app = (fala as unknown as { app: { invoke: Function } }).app;
    const thread = (fala as unknown as { thread: string }).thread;
    const invocar = (messageId: string, text: string) => app.invoke(
      { inbound: { messageId, fromPhone: "5511987654321", groupId: null, kind: "text" as const, text, mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null },
        identity: usuario, ...RESET_DO_TURN },
      { configurable: { thread_id: thread } },
    );
    // createSemResposta simula o servidor TENDO gravado mas a resposta se
    // perdendo antes de chegar no Max — por isso `captacoes` já tem 1 aqui.
    await invocar("replay-1", "valor 850 mil");
    expect(captacoes).toHaveLength(1);
    await invocar("replay-1", "valor 850 mil"); // replay EXATO da mesma messageId
    expect(captacoes).toHaveLength(1);
    await invocar("m-sim", "sim"); // o "sim" de conferir repete a chave guardada
    expect(captacoes).toHaveLength(1);
    const creates = verbos("captacao.create");
    expect(creates.length).toBeGreaterThanOrEqual(2);
    for (const c of creates) expect(c.key).toBe("replay-1");
    expect(creates.at(-1)!.args).toEqual(creates[0]!.args);
  });

  it("webhook reentrega o MESMO 'sim' do resumo depois do envio: não envia de novo", async () => {
    const fala = conversa();
    await ateOResumo(fala);
    const app = (fala as unknown as { app: { invoke: Function } }).app;
    const thread = (fala as unknown as { thread: string }).thread;
    const invocar = (messageId: string) => app.invoke(
      { inbound: { messageId, fromPhone: "5511987654321", groupId: null, kind: "text" as const, text: "sim", mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null },
        identity: usuario, ...RESET_DO_TURN },
      { configurable: { thread_id: thread } },
    );
    await invocar("sim-1");
    await invocar("sim-1");
    expect(sendEnvios).toBe(1);
    expect(verbos("captacao.send")).toHaveLength(1);
  });
});
describe("nit: rebaixarFluxo (captação) nunca deixa a próxima mensagem escrever sem resumo novo", () => {
  it("confirmar_criacao, confirmar_pessoas, confirmar_faltantes, canal, revisão e brancos são todos rebaixados pra etapas que não gravam por si", async () => {
    const { rebaixarFluxo } = await import("../fluxos");
    const base = { kind: "captacao" as const, tentativas: 0, atualizadoEm: 0 };
    const etapa = (f: unknown) => (f as { etapa?: string } | null)?.etapa;
    expect(etapa(rebaixarFluxo({ ...base, etapa: "confirmar_criacao" } as never))).toBe("condicoes");
    expect(etapa(rebaixarFluxo({ ...base, etapa: "confirmar_pessoas" } as never))).toBe("extras");
    // Item B: o "sim" de confirmar_faltantes grava — mesmo risco N1.
    expect(etapa(rebaixarFluxo({ ...base, etapa: "confirmar_faltantes" } as never))).toBe("faltantes");
    expect(etapa(rebaixarFluxo({ ...base, etapa: "canal" } as never))).toBe("verificar");
    expect(etapa(rebaixarFluxo({ ...base, etapa: "revisao" } as never))).toBe("verificar");
    expect(etapa(rebaixarFluxo({ ...base, etapa: "brancos" } as never))).toBe("verificar");
    // com `chave` (send sem resposta em curso), a etapa NÃO muda — a chave sobrevive.
    expect(etapa(rebaixarFluxo({ ...base, etapa: "revisao", chave: { verbo: "captacao.send", valor: "m1", version: 0 } } as never))).toBe("revisao");
  });
});

/** Até a primeira pergunta de faltante: rascunho criado, Maria gravada, extras fechados. */
async function ateOFaltante(fala: ReturnType<typeof conversa>) {
  extracao = IMOVEL_EXTRAIDO;
  await fala("cria uma captação de venda do Apto da Dona Maria");
  await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
  await fala("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade");
  await fala(`Maria Silva, CPF ${CPF}, casada`);
  await fala("FIM");
  return fala("não");
}
const PEDE_CONFIRMACAO = /Posso (criar|gravar)|Vou gravar|Responda \*sim\*/;

describe("confirmação única (26/10): faltantes gravados no turno em que chegam", () => {
  it("'matrícula 12345' grava já, com a messageId da própria resposta, e segue pro resumo", async () => {
    const fala = conversa();
    const faltante = await ateOFaltante(fala);
    expect(faltante.reply).toContain("Matrícula do imóvel?");
    const r = await fala("matrícula 12345");
    const grava = ultimo("captacao.create")!;
    expect(grava.args.dados).toEqual({ imovel: { matricula: "12345" } });
    expect(grava.key).toBe(r.messageId);
    expect(r.reply).toContain("Anotei: Matrícula: 12345.");
    expect(r.reply).not.toContain("Vou gravar");
    expect(r.reply).not.toContain("Posso gravar");
    expect(r.reply).toContain("Pronta a captação");
  });

  it("dois faltantes (matrícula e RG): cada resposta é gravada no seu turno, sem confirmação no fim", async () => {
    exigeRg = true;
    const fala = conversa();
    const primeiro = await ateOFaltante(fala);
    expect(primeiro.reply).toContain("Matrícula");
    const segundo = await fala("matrícula 12345");
    expect(ultimo("captacao.create")!.args.dados).toEqual({ imovel: { matricula: "12345" } });
    expect(segundo.reply).toContain("RG");
    expect(segundo.reply).not.toMatch(PEDE_CONFIRMACAO);
    const r = await fala("RG 12.345.678-9");
    expect(JSON.stringify(ultimo("captacao.create")!.args.dados)).toContain("12.345.678-9");
    expect(ultimo("captacao.create")!.key).toBe(r.messageId);
    expect(r.reply).toContain("Pronta a captação");
    expect(r.reply).not.toContain("12.345.678-9");
  });

  it("CANCELAR na pergunta do faltante não grava nada; o que já foi gravado fica no rascunho", async () => {
    const fala = conversa();
    await ateOFaltante(fala);
    const antes = verbos("captacao.create").length;
    const s = await fala("cancelar");
    expect(verbos("captacao.create")).toHaveLength(antes);
    expect(s.reply).toContain("fica salvo na tela");
    expect(s.fluxo ?? null).toBeNull();
  });

  it("PULAR deixa para a tela: nada gravado, fluxo encerrado, sem pedir confirmação", async () => {
    const fala = conversa();
    await ateOFaltante(fala);
    const antes = verbos("captacao.create").length;
    const s = await fala("pular");
    expect(verbos("captacao.create")).toHaveLength(antes);
    expect(s.reply).toContain("complete pela tela");
    expect(s.reply).not.toMatch(PEDE_CONFIRMACAO);
    expect(s.fluxo ?? null).toBeNull();
  });

  it("CEP sozinho: grava como 00000-000 e pergunta o próximo; a pergunta nunca diz 'do imóvel do imóvel'", async () => {
    exigeMatricula = false; exigeCep = true; exigeTipo = true;
    const fala = conversa();
    const perg = await ateOFaltante(fala);
    expect(perg.reply).toContain("CEP do imóvel");
    expect(perg.reply).not.toContain("do imóvel do imóvel");
    const r = await fala("01310100");
    expect(ultimo("captacao.create")!.args.dados).toEqual({ imovel: { cep: "01310-100" } });
    expect(r.reply).toContain("Tipo do imóvel");
    expect(r.reply).not.toContain("do imóvel do imóvel");
    const fim = await fala("casa");
    expect(ultimo("captacao.create")!.args.dados).toEqual({ imovel: { kind: "casa" } });
    expect(fim.reply).toContain("Imóvel: Rua Augusta, 1250, Bela Vista, São Paulo/SP (casa, CEP 01310-100).");
  });

  it("'01310-100, Casa' preenche CEP e tipo numa resposta só (uma escrita)", async () => {
    exigeMatricula = false; exigeCep = true; exigeTipo = true;
    const fala = conversa();
    await ateOFaltante(fala);
    const antes = verbos("captacao.create").length;
    const r = await fala("01310-100, Casa");
    expect(verbos("captacao.create")).toHaveLength(antes + 1);
    expect(ultimo("captacao.create")!.args.dados).toEqual({ imovel: { cep: "01310-100", kind: "casa" } });
    expect(ultimo("captacao.create")!.key).toBe(r.messageId);
    expect(r.reply).toContain("Pronta a captação");
    expect(r.reply).toContain("(casa, CEP 01310-100)");
  });

  it("CEP inválido é perguntado de novo, sem gravar", async () => {
    exigeMatricula = false; exigeCep = true;
    const fala = conversa();
    await ateOFaltante(fala);
    const antes = verbos("captacao.create").length;
    const r = await fala("0131");
    expect(verbos("captacao.create")).toHaveLength(antes);
    expect(r.reply).toContain("8 dígitos");
  });

  it("CPF que não confere é perguntado de novo, sem gravar; o certo grava", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    const antes = verbos("captacao.create").length;
    const errado = await fala("Maria Silva, CPF 111.444.777-00, casada");
    expect(errado.reply).toContain("não confere");
    expect(verbos("captacao.create")).toHaveLength(antes);
    const certo = await fala(`Maria Silva, CPF ${CPF}, casada`);
    expect(verbos("captacao.create")).toHaveLength(antes + 1);
    expect(certo.reply).toContain("Anotei Maria Silva");
  });
});

describe("confirmação única (26/10): o resumo final e o único 'sim'", () => {
  it("nenhum 'sim' intermediário: nada antes do resumo pede confirmação, e o send é chamado uma vez", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    const respostas = [
      await fala("cria uma captação de venda do Apto da Dona Maria"),
      await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP"),
      await fala("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade"),
      await fala(`Maria Silva, CPF ${CPF}, tel ${FONE}, ${EMAIL}, casada`),
      await fala("FIM"),
      await fala(`testemunha Carlos Pereira, ${EMAIL.replace("maria", "carlos")}`),
      await fala("não"),
    ];
    for (const r of respostas) expect(r.reply).not.toMatch(PEDE_CONFIRMACAO);
    const resumo = await fala("matrícula 12345");
    expect(resumo.reply).toContain("Responda *sim* para enviar");
    expect(verbos("captacao.send")).toEqual([]);
    await fala("sim");
    expect(verbos("captacao.send")).toHaveLength(1);
    expect(sendEnvios).toBe(1);
  });

  it("resumo mostra imóvel (tipo, CEP), condições, nomes sem documento, testemunhas, quem assina pela imobiliária, canal e brancos — o 'sim' manda confirmarBrancos", async () => {
    exigeMatricula = false; exigeCep = true; exigeTipo = true; emBranco = 3; assinanteImobiliaria = "Ana Gerente";
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade");
    await fala(`Maria Silva, CPF ${CPF}, tel ${FONE}, ${EMAIL}, casada`);
    await fala("FIM");
    await fala(`testemunha Carlos Pereira, ${EMAIL.replace("maria", "carlos")}`);
    await fala("não");
    const resumo = await fala("01310-100, casa");
    expect(resumo.reply).toContain("Imóvel: Rua Augusta, 1250, Bela Vista, São Paulo/SP (casa, CEP 01310-100).");
    expect(resumo.reply).toContain("Condições:");
    expect(resumo.reply).toContain("Proprietário: Maria Silva.");
    expect(resumo.reply).toContain("Testemunha: Carlos Pereira.");
    expect(resumo.reply).toContain("Pela imobiliária assina: Ana Gerente.");
    expect(resumo.reply).toContain("Envio: Maria Silva e Carlos Pereira por e-mail.");
    expect(resumo.reply).toContain("3 campo(s) vão em branco");
    expect(semDadosPessoais(resumo.reply)).toBe(true);
    expect(resumo.reply).not.toContain("carlos@ex.com");
    const s = await fala("sim");
    expect(verbos("captacao.send")).toHaveLength(1);
    expect(verbos("captacao.send")[0]!.args).toMatchObject({ confirmarBrancos: true });
    expect(s.reply).toContain("Enviado");
  });

  it("'sim' repetido depois de um envio sem resposta não envia de novo (mesma chave)", async () => {
    sendModo = "sem_resposta";
    const fala = conversa();
    await ateOResumo(fala);
    const incerto = await fala("sim");
    expect(incerto.reply).toContain("Responda *sim* de novo");
    sendModo = "ok";
    await fala("sim");
    const [a, b] = verbos("captacao.send");
    expect(b!.key).toBe(a!.key);
    expect(b!.args).toEqual(a!.args);
    expect(sendEnvios).toBe(1);
  });

  it("CANCELAR no resumo não envia e o rascunho fica salvo", async () => {
    const fala = conversa();
    await ateOResumo(fala);
    const s = await fala("cancelar");
    expect(verbos("captacao.send")).toEqual([]);
    expect(s.reply).toContain("fica salvo na tela");
    expect(s.fluxo ?? null).toBeNull();
  });

  it("'não' no resumo também para, sem enviar", async () => {
    const fala = conversa();
    await ateOResumo(fala);
    const s = await fala("não");
    expect(verbos("captacao.send")).toEqual([]);
    expect(s.fluxo ?? null).toBeNull();
  });
});

describe("confirmação única (26/10): pendências só da tela", () => {
  it("ditas UMA vez, com o link e sem pedir 'sim'; 'pronto' sem resolver ganha resposta curta e encerra", async () => {
    exigeMatricula = false;
    faltantesDaTela = [{ path: "campos.cor_fachada", rotulo: "Cor da fachada", etapa: "campos" }];
    const fala = conversa();
    const r = await ateOFaltante(fala);
    expect(r.reply).toContain("Cor da fachada");
    expect(r.reply).toContain("/imoveis/captacoes/cap-1");
    expect(r.reply).toContain("*pronto*");
    expect(r.reply).not.toMatch(/Responda \*sim\*/);
    const preflights = verbos("captacao.preflight").length;
    const solta = await fala("qual o horário de vocês?");
    expect(solta.reply).toContain("O horário é das 9h às 18h.");
    expect(verbos("captacao.preflight")).toHaveLength(preflights);
    const pronto = await fala("pronto");
    expect(verbos("captacao.preflight")).toHaveLength(preflights + 1);
    expect(pronto.reply).toContain("Continua pendente");
    expect(pronto.reply).not.toContain("Cor da fachada");
    expect(pronto.fluxo ?? null).toBeNull();
  });

  it("'ajustei' depois de resolver na tela: confere e vai pro resumo", async () => {
    exigeMatricula = false;
    faltantesDaTela = [{ path: "campos.cor_fachada", rotulo: "Cor da fachada", etapa: "campos" }];
    const fala = conversa();
    await ateOFaltante(fala);
    faltantesDaTela = [];
    const r = await fala("ajustei");
    expect(r.reply).toContain("Pronta a captação");
  });
});

describe("confirmação única (26/10): exclusividade do modelo × a dita", () => {
  it("modelo SEM exclusividade e a pessoa disse COM: avisa uma vez e pergunta; 'sem' grava como no modelo", async () => {
    modelos = [{ id: "t1", nome: "Modelo de venda", exclusiva: false }];
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    const c = await fala("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade");
    expect(c.reply).toContain("Criei o rascunho");
    expect(c.reply).toContain("o modelo escolhido é sem exclusividade, mas você disse com");
    expect(c.reply).toContain("*COM* ou *SEM*");
    const s = await fala("sem");
    const grava = ultimo("captacao.create")!;
    expect(grava.args.dados).toEqual({ condicoes: { exclusiva: false } });
    expect(grava.key).toBe(s.messageId);
    expect(s.reply).toContain("como no modelo");
    expect((s.fluxo as { etapa?: string } | null)?.etapa).toBe("proprietarios");
    const dono = await fala(`Maria Silva, CPF ${CPF}, casada`);
    expect(dono.reply).not.toContain("exclusividade");
  });

  it("mantendo o que disse ('com'): não grava nada e avisa que o modelo se troca na tela", async () => {
    modelos = [{ id: "t1", nome: "Modelo de venda", exclusiva: false }];
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade");
    const antes = verbos("captacao.create").length;
    const s = await fala("com exclusividade");
    expect(verbos("captacao.create")).toHaveLength(antes);
    expect(s.reply).toContain("troque o modelo na tela");
    expect(s.reply).toContain("/imoveis/captacoes/cap-1");
    expect((s.fluxo as { etapa?: string } | null)?.etapa).toBe("proprietarios");
  });

  it("modelo sem a informação (o CM ainda não manda `exclusiva`): nenhum aviso", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    const c = await fala("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade");
    expect(c.reply).not.toContain("Atenção");
    expect((c.fluxo as { etapa?: string } | null)?.etapa).toBe("proprietarios");
  });
});

describe("confirmação única (26/10): estado civil do proprietário PF", () => {
  async function ateOProprietario(fala: ReturnType<typeof conversa>) {
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade");
  }

  it("PF sem estado civil: pergunta uma vez; a resposta grava estado_civil", async () => {
    const fala = conversa();
    await ateOProprietario(fala);
    const d = await fala(`Maria Silva, CPF ${CPF}`);
    expect(d.reply).toContain("Anotei Maria Silva");
    expect(d.reply).toContain("Qual o estado civil de Maria Silva?");
    const e = await fala("casada");
    const grava = ultimo("captacao.create")!;
    expect(grava.args.dados).toEqual({ proprietarios: [{ id: "p1", papel: "proprietario", tipo_pessoa: "fisica", estado_civil: "casada" }] });
    expect(grava.key).toBe(e.messageId);
    expect(e.reply).toContain("Anotei: Maria Silva, casada.");
    expect(e.reply).toContain("próximo proprietário");
  });

  it("PULAR é aceito: não grava, e a conferência não pergunta de novo (vira pendência da tela)", async () => {
    exigeMatricula = false; exigeEstadoCivil = true;
    const fala = conversa();
    await ateOProprietario(fala);
    await fala(`Maria Silva, CPF ${CPF}`);
    const antes = verbos("captacao.create").length;
    const p = await fala("pular");
    expect(verbos("captacao.create")).toHaveLength(antes);
    expect(p.reply).toContain("fica para a tela");
    await fala("FIM");
    const v = await fala("não");
    expect(v.reply).not.toContain("Qual o estado civil");
    expect(v.reply).toContain("Estado civil");
    expect(v.reply).toContain("/imoveis/captacoes/cap-1");
  });

  it("já mandou o próximo proprietário: o estado civil do anterior fica para a tela e o novo é gravado", async () => {
    const fala = conversa();
    await ateOProprietario(fala);
    await fala(`Maria Silva, CPF ${CPF}`);
    const j = await fala("João Souza, CPF 529.982.247-25, casado");
    expect(j.reply).toContain("Anotei João Souza");
    expect(ultimo("captacao.create")!.args.dados).toMatchObject({ proprietarios: [{ id: "p2", nome: "João Souza" }] });
  });
});

describe("contrato do CM (26/10): complemento 422 dados_invalidos", () => {
  const NOMES = ["Ana Souza", "Bruno Lima", "Carla Dias", "Davi Rocha"];
  async function comQuatroTestemunhas(fala: ReturnType<typeof conversa>) {
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade");
    await fala(`Maria Silva, CPF ${CPF}, casada`);
    await fala("FIM");
    for (const [i, n] of NOMES.entries()) await fala(`testemunha ${n}, t${i}@ex.com`);
    expect(obj(captacoes[0]!.dados.assinantes).testemunhas).toHaveLength(4);
  }

  it("5ª testemunha: o CM recusa, o Max diz que são no máximo 4, não retenta e a etapa continua aberta", async () => {
    const fala = conversa();
    await comQuatroTestemunhas(fala);
    const antes = verbos("captacao.create").length;
    const s = await fala("testemunha Eva Nunes, eva@ex.com");
    expect(verbos("captacao.create")).toHaveLength(antes + 1); // sem retentativa
    expect(s.reply).toContain("no máximo 4 testemunhas");
    expect(s.reply).toContain("/imoveis/captacoes/cap-1");
    expect(s.reply).not.toContain("eva@ex.com");
    expect((s.fluxo as { etapa?: string } | null)?.etapa).toBe("extras");
    expect(obj(captacoes[0]!.dados.assinantes).testemunhas).toHaveLength(4);
    const segue = await fala("não");
    expect(segue.reply).toContain("Matrícula do imóvel?");
  });

  it("422 com `campos` de testemunha: a mesma mensagem do limite de 4", async () => {
    campos422 = ["assinantes.testemunhas"];
    const fala = conversa();
    await comQuatroTestemunhas(fala);
    const s = await fala("testemunha Eva Nunes, eva@ex.com");
    expect(s.reply).toContain("Não gravei: a captação aceita no máximo 4 testemunhas");
  });

  it("422 em outro dado: diz que não coube, aponta a tela, não retenta e repergunta o mesmo campo", async () => {
    const fala = conversa();
    await ateOFaltante(fala);
    complemento422 = true; campos422 = ["imovel.matricula"];
    const antes = verbos("captacao.create").length;
    const s = await fala("matrícula 12345");
    expect(verbos("captacao.create")).toHaveLength(antes + 1);
    expect(s.reply).toContain("Não gravei: algo não coube no rascunho (imovel.matricula)");
    expect(s.reply).toContain("/imoveis/captacoes/cap-1");
    expect(s.reply).toContain("Matrícula do imóvel?");
    expect((s.fluxo as { etapa?: string } | null)?.etapa).toBe("faltantes");
  });
});

describe("item D (revisão opus, round 2): 'liberado' só quando o texto não tem PII nenhum", () => {
  it("proprietarios: 'Maria, 11 98765-4321, maria@x.com?' não marca liberado — telefone/e-mail não vazam no toolLog nem no checkpoint", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    const s = await fala("Maria, 11 98765-4321, maria@x.com?");
    const tool = (s.toolLog as { name: string; args: Record<string, unknown> }[]).find((x) => x.name === "fluxo");
    expect(tool?.args.liberado).not.toBe(true);
    expect(JSON.stringify(s.toolLog)).not.toContain("98765");
    expect(JSON.stringify(s.toolLog)).not.toContain("maria@x.com");
    expect(JSON.stringify(s.fluxo)).not.toContain("98765");
    expect(JSON.stringify(s.fluxo)).not.toContain("maria@x.com");
  });

  it("faltantes: 'o telefone é 11987654321?' não marca liberado — telefone não vaza no toolLog nem no checkpoint", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    await fala(`Maria Silva, CPF ${CPF}`);
    await fala("FIM");
    const faltante = await fala("não"); // fecha os extras -> confere -> pergunta o faltante
    expect(faltante.reply).toContain("Matrícula");
    const s = await fala("o telefone é 11987654321?");
    const tool = (s.toolLog as { name: string; args: Record<string, unknown> }[]).find((x) => x.name === "fluxo");
    expect(tool?.args.liberado).not.toBe(true);
    expect(JSON.stringify(s.toolLog)).not.toContain("11987654321");
    expect(JSON.stringify(s.fluxo)).not.toContain("11987654321");
  });

  it("controle: pergunta de verdade SEM PII nenhum ainda marca liberado (não regride o achado 19)", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    const s = await fala("qual o horário de vocês?");
    const tool = (s.toolLog as { name: string; args: Record<string, unknown> }[]).find((x) => x.name === "fluxo");
    expect(tool?.args.liberado).toBe(true);
  });
});

describe("revisão opus (26/10, rodada de correções)", () => {
  it("'sim, mas troca o CPF 111…' no resumo NÃO envia, não ecoa o número e aponta a tela; o 'sim' seguinte envia", async () => {
    const fala = conversa();
    await ateOResumo(fala);
    const s = await fala("sim, mas troca o CPF 111.444.777-35");
    expect(verbos("captacao.send")).toEqual([]);
    expect(s.reply).toContain("Não enviei");
    expect(s.reply).toContain("/imoveis/captacoes/cap-1");
    expect(s.reply).not.toContain("111");
    expect(JSON.stringify(s.fluxo ?? null)).not.toContain("111.444");
    expect((s.fluxo as { etapa?: string } | null)?.etapa).toBe("revisao");
    const ok = await fala("sim");
    expect(verbos("captacao.send")).toHaveLength(1);
    expect(ok.reply).toContain("Enviado");
  });

  it("e-mail ou telefone no resumo também não envia (nem vai cru pro atendimento normal)", async () => {
    const fala = conversa();
    await ateOResumo(fala);
    const s = await fala(`o e-mail certo é ${EMAIL.replace("maria", "m2")}`);
    expect(verbos("captacao.send")).toEqual([]);
    expect(s.reply).toContain("pela tela");
    expect(s.reply).not.toContain("m2@");
  });

  it("409 versao_desatualizada no meio dos faltantes: grava com a versão nova e o resumo NÃO mostra imóvel/condições locais como se fossem o rascunho", async () => {
    const fala = conversa();
    await ateOFaltante(fala);
    complementoDesatualizado = 1;
    const r = await fala("matrícula 12345");
    expect(r.reply).toContain("Alguém mudou a captação na tela; vou conferir de novo.");
    const [t1, t2] = verbos("captacao.create").slice(-2);
    expect(t2!.args.version).toBe((t1!.args.version as number) + 1);
    expect(r.reply).toContain("Pronta a captação");
    expect(r.reply).not.toContain("Imóvel: Rua Augusta");
    expect(r.reply).not.toContain("Condições: valor");
    expect(r.reply).toContain("alterada na tela");
    await fala("sim");
    expect(verbos("captacao.send")[0]!.args.version).toBe(captacoes[0]!.version);
    expect(sendEnvios).toBe(1);
  });

  it("409 no meio dos proprietários: o resumo também avisa que a tela mudou", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil, comissão 6%, prazo 180 dias, com exclusividade");
    complementoDesatualizado = 1;
    await fala(`Maria Silva, CPF ${CPF}, casada`);
    await fala("FIM");
    await fala("não");
    const r = await fala("matrícula 12345");
    expect(r.reply).not.toContain("Imóvel: Rua Augusta");
    expect(r.reply).toContain("alterada na tela");
  });

  it("tela mexida sem 409 (versão do preflight ≠ a que o Max gravou): resumo não mostra os valores locais", async () => {
    const fala = conversa();
    await ateOFaltante(fala);
    await fala("matrícula 12345");
    // alguém edita na tela depois da última escrita do Max, e o resumo é refeito
    captacoes[0]!.version += 1;
    const r = await fala("por WhatsApp");
    expect(r.reply).not.toContain("Imóvel: Rua Augusta");
    expect(r.reply).toContain("alterada na tela");
  });

  it("sem mudança na tela o resumo mostra imóvel e condições", async () => {
    const fala = conversa();
    const r = await ateOResumo(fala);
    expect(r.reply).toContain("Imóvel: Rua Augusta");
    expect(r.reply).not.toContain("alterada na tela");
  });

  it("testemunha reenviada depois de uma escrita sem resposta não duplica (id determinístico, estado não avança)", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    await fala(`Maria Silva, CPF ${CPF}, casada`);
    await fala("FIM");
    complementoSemResposta = true;
    const incerto = await fala("testemunha Carlos Pereira, carlos@ex.com");
    expect(incerto.reply).toContain("Mande de novo");
    expect(obj(captacoes[0]!.dados.assinantes).testemunhas).toHaveLength(1); // o servidor gravou
    const de_novo = await fala("testemunha Carlos Pereira, carlos@ex.com");
    expect(de_novo.reply).toContain("Anotei Carlos Pereira como testemunha");
    const [a, b] = verbos("captacao.create").slice(-2);
    const idDe = (c: typeof a) => (obj(obj(c!.args.dados).assinantes).testemunhas as { id: string }[])[0]!.id;
    expect(idDe(b)).toBe(idDe(a));
    expect(obj(captacoes[0]!.dados.assinantes).testemunhas).toHaveLength(1);
    // a próxima pessoa ganha outro id
    await fala("testemunha Ana Souza, ana@ex.com");
    expect(obj(captacoes[0]!.dados.assinantes).testemunhas).toHaveLength(2);
  });

  it("'não é testemunha' vira assinante, não testemunha", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    await fala("valor 850 mil");
    await fala(`Maria Silva, CPF ${CPF}, casada`);
    await fala("FIM");
    const s = await fala("Pedro Alves, pedro@ex.com, não é testemunha");
    expect(s.reply).toContain("como assinante");
    const dados = obj(ultimo("captacao.create")!.args.dados);
    expect(obj(dados.assinantes).avulsos).toHaveLength(1);
    expect(obj(dados.assinantes).testemunhas).toBeUndefined();
  });

  it("checkpoint antigo em confirmar_criacao: pergunta de outro assunto NÃO cria; o 'sim' cria", async () => {
    const fala = conversa();
    extracao = IMOVEL_EXTRAIDO;
    await fala("cria uma captação de venda do Apto da Dona Maria");
    await fala("Rua Augusta, 1250, ap 42, Bela Vista, São Paulo/SP");
    const app = (fala as unknown as { app: { getState: Function; updateState: Function } }).app;
    const thread = (fala as unknown as { thread: string }).thread;
    const estado = await app.getState({ configurable: { thread_id: thread } });
    const atual = (estado as { values: { fluxo: Record<string, unknown> } }).values.fluxo;
    await app.updateState({ configurable: { thread_id: thread } }, {
      fluxo: { ...atual, etapa: "confirmar_criacao", criacao: { chave: "legado-1", dados: { imovel: { rua: "Rua Augusta", numero: "1250" }, condicoes: { valor: 850000 } } } },
    });
    const outra = await fala("qual o horário de vocês?");
    expect(verbos("captacao.create")).toEqual([]);
    expect(outra.reply).toContain("O horário é das 9h às 18h.");
    const ok = await fala("sim");
    expect(verbos("captacao.create")).toHaveLength(1);
    expect(ok.reply).toContain("Criei o rascunho");
  });
});
