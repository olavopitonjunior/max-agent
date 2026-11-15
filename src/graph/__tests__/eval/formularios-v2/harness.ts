/**
 * Harness dos evals determinísticos dos formulários v2 (spec §12, Tarefa 18).
 *
 * Três peças, nenhuma com rede:
 *  - `ServidorFalso`: o ImobPro. Guarda o RASCUNHO (partes por posição, imóvel, negociação), responde
 *    `proposal.options/create/update/preflight/witnesses.set/send` no formato do contrato (max.md
 *    §18.13) e registra cada chamada com o status devolvido. O estado final do rascunho é o que os
 *    casos afirmam.
 *  - `ModeloFalso`: o modelo (`@/lib/llm` `complete`). Cada chamada de extração recebe o roteiro do
 *    caso, que LÊ os tokens do prompt (`⟨CPF_1⟩`) e devolve args com tokens, para o ciclo
 *    tokenizar -> modelo -> destokenizar rodar de verdade.
 *  - `Sessao`: a conversa pelo grafo real (`runTurn`), uma thread, vários turnos.
 *
 * `verificarTransversais` vale para TODO caso (chamada no `afterEach` de cada arquivo):
 *   T1 nenhum "anotei"/"salvei" sem o 200 do servidor naquele turno;
 *   T2 nenhuma escrita sem um "sim" explícito anterior (a `idempotencyKey` é a messageId do "sim");
 *   T3 nenhum CPF/CNPJ/e-mail/telefone/CEP/valor em claro no que vai ao modelo, e nenhum nome de
 *      parte fora das cercas de dado; nada em claro no outbox nem no checkpoint;
 *   T4 custo reportado (`reportUsage`) em toda chamada ao modelo.
 *
 * Os simulados de módulo ficam em `setup.ts` (setupFiles). Nada aqui lê chave nem segredo.
 */
import { expect, vi } from "vitest";
import "./setup";
import type { Identity } from "@/lib/identity";
import { withExecution } from "@/lib/runtime/context";
import { isWriteVerb } from "@/lib/runtime/catalog";
import { redigir } from "@/lib/pii";
import {
  CPF_SINTETICO,
  PESSOAS,
  cpfFicticio,
  emailFicticio,
  formatarCpf,
  telefoneFicticio,
  telefoneSoDigitos,
} from "../../../../../scripts/fixtures/formularios-v2/mascara";

// O grafo entra ANTES do outbox: o outbox real importa o grafo, e a ordem inversa deixa o grafo com o
// outbox de verdade (sem o simulado) na importação tardia da fila da ficha.
const { runTurn, getApp } = await import("../../../graph");
const { resolveIdentity } = await import("@/lib/identity");
const { executarAcao } = await import("@/lib/acao");
const { complete } = await import("@/lib/llm");
const { fetchProfile, reportUsage, transcribeMedia, lerDocumento } = await import("@/lib/cm");
const { downloadMedia, sendReaction } = await import("@/lib/transport");
const { enqueue, linhaEnviada } = await import("@/lib/outbox");
const { novoFluxoV2 } = await import("../../../formularios/estado");
const { TOOL_PATCH_V2 } = await import("../../../formularios/extracao");
const { abrirCorpo, estaSelado } = await import("../../../formularios/selo");

export const FONE = "5511987654321";
export const ULTIMO_DIGITO_DO_ENVIO = 9;

// ─── Dados fictícios (nada copiado em claro das conversas reais) ─────────────

export { CPF_SINTETICO, PESSOAS, cpfFicticio, emailFicticio, formatarCpf, telefoneFicticio, telefoneSoDigitos };

// ─── ServidorFalso ───────────────────────────────────────────────────────────

export interface ParteRascunho {
  nome?: string;
  cpf?: string;
  cnpj?: string;
  email?: string;
  telefone?: string;
  estado_civil?: string;
  conjuge?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface Rascunho {
  id: string;
  codigo: string;
  schemaType: string;
  compradores: ParteRascunho[];
  vendedores: ParteRascunho[];
  imovel: Record<string, unknown>;
  negociacao: Record<string, unknown>;
  corretor: Record<string, unknown>;
  observacoes?: string;
}

export interface ChamadaAoServidor {
  verb: string;
  args: Record<string, unknown>;
  idempotencyKey?: string;
  status: number | null;
  escrita: boolean;
  /** Índice do turno (da `Sessao`) em que a chamada ocorreu. */
  turno: number;
}

export interface RespostaProgramada {
  status: number;
  body: Record<string, unknown>;
}

export interface OpcoesDoServidor {
  fluxoV2?: boolean;
  tiposDeAssinatura?: Array<Record<string, unknown>>;
  testemunhas?: Record<string, unknown>;
  modalidades?: Array<Record<string, unknown>>;
  /** A org exige CPF/CNPJ do proponente (obrigatório `proponente.documento`), como a do caso M4' do golden set. */
  exigeDocumento?: boolean;
  /** Força o `tipoEfetivo` do preflight (ex.: "aceite" quando o plano rebaixa o WhatsApp). */
  tipoEfetivo?: string;
}

const OBRIGATORIOS = [
  { chave: "proponente.nome", rotulo: "Nome do comprador", grupo: "Partes", esteira: "venda", tipoCampo: "texto" },
  { chave: "negociacao.valor", rotulo: "Valor da proposta", grupo: "Negociação", esteira: "venda", tipoCampo: "moeda" },
];

const DOCUMENTO_OBRIGATORIO = { chave: "proponente.documento", rotulo: "CPF ou CNPJ", grupo: "Partes", esteira: "venda", tipoCampo: "cpf_cnpj" };

const digitos = (s: unknown): string => (typeof s === "string" ? s.replace(/\D/g, "") : "");

export class ServidorFalso {
  chamadas: ChamadaAoServidor[] = [];
  rascunho: Rascunho | null = null;
  opcoes: OpcoesDoServidor;
  /** Respostas programadas por verbo (consumidas em ordem), para simular 409/422/timeout. `null` = sem resposta. */
  programadas = new Map<string, Array<RespostaProgramada | null>>();
  /** Fila de respostas por chave de idempotência, como o servidor de verdade (mesma chave = mesma resposta). */
  private porChave = new Map<string, RespostaProgramada>();
  /** Posições dos assinantes sem celular (Aceite), vindas do cadastro do rascunho. */
  assinantesSemCelular: Array<{ posicao: number; papel: string; nome: string }> = [];
  turnoAtual = 0;
  /** O `tipo_assinatura` gravado por último no rascunho (o preflight responde conforme ele). */
  tipoGravado: string | null = null;
  private seq = 0;

  constructor(opcoes: OpcoesDoServidor = {}) {
    this.opcoes = opcoes;
  }

  programar(verb: string, ...respostas: Array<RespostaProgramada | null>): void {
    this.programadas.set(verb, [...(this.programadas.get(verb) ?? []), ...respostas]);
  }

  escritas(): ChamadaAoServidor[] {
    return this.chamadas.filter((c) => c.escrita);
  }

  escritasDoVerbo(verb: string): ChamadaAoServidor[] {
    return this.chamadas.filter((c) => c.verb === verb);
  }

  /** O que o `proposal.options` devolve agora (com `faltando` e `signatarios` só havendo alvo). */
  private options(comAlvo: boolean): Record<string, unknown> {
    const aceite: Record<string, unknown> = { tipo: "aceite", disponivel: true, custoCentavos: 99, texto: "Aceite" };
    if (this.assinantesSemCelular.length > 0) aceite.assinantesSemCelular = this.assinantesSemCelular;
    const base: Record<string, unknown> = {
      metodos: [{ valor: "whatsapp", rotulo: "WhatsApp" }, { valor: "email", rotulo: "E-mail" }],
      signatarios: [],
      assinaturaConfigurada: true,
      modalidades: this.opcoes.modalidades ?? [
        { schemaType: "compra_venda_v1", esteira: "venda", rotulo: "Compra e venda", modeloDisponivel: true },
      ],
      obrigatorios: this.opcoes.exigeDocumento ? [...OBRIGATORIOS, DOCUMENTO_OBRIGATORIO] : OBRIGATORIOS,
      tiposDeAssinatura: this.opcoes.tiposDeAssinatura ?? [
        { tipo: "email", disponivel: true, texto: "E-mail" },
        { tipo: "whatsapp", disponivel: true, texto: "WhatsApp" },
        aceite,
      ],
      testemunhas: this.opcoes.testemunhas ?? {
        minimo: 0,
        maximo: 4,
        padrao: [],
        linkConfiguracoes: "https://app.exemplo.invalido/configuracoes/testemunhas",
      },
      fluxoV2: this.opcoes.fluxoV2 ?? true,
    };
    if (!comAlvo || !this.rascunho) return base;
    const r = this.rascunho;
    const signatarios = [
      ...r.compradores.filter((p) => p.nome).map((p, i) => ({ nome: p.nome, papel: "proponente", posicao: i + 1 })),
      ...r.vendedores.filter((p) => p.nome).map((p, i) => ({ nome: p.nome, papel: "vendedor", posicao: i + 1 })),
    ];
    return { ...base, signatarios, faltando: this.faltando() };
  }

  faltando(): Array<Record<string, unknown>> {
    const r = this.rascunho;
    const out: Array<Record<string, unknown>> = [];
    if (!r?.compradores[0]?.nome) {
      out.push({ signatario: { posicao: 1, papel: "proponente" }, campo: "proponente.nome", motivo: "obrigatorio_da_org" });
    }
    if (this.opcoes.exigeDocumento && !r?.compradores[0]?.cpf && !r?.compradores[0]?.cnpj) {
      out.push({ signatario: { posicao: 1, papel: "proponente" }, campo: "proponente.documento", motivo: "obrigatorio_da_org" });
    }
    if (!r?.negociacao.valor) out.push({ signatario: null, campo: "negociacao.valor", motivo: "obrigatorio_da_org" });
    return out;
  }

  private mesclar(alvo: ParteRascunho[], lista: unknown): void {
    if (!Array.isArray(lista)) return;
    lista.forEach((p, i) => {
      if (!p || typeof p !== "object") return;
      const { substituir, ...campos } = p as Record<string, unknown>;
      if (Object.keys(campos).length === 0) return;
      const atual = substituir === true ? {} : (alvo[i] ?? {});
      const conjuge = campos.conjuge ? { ...((atual.conjuge as object) ?? {}), ...(campos.conjuge as object) } : undefined;
      alvo[i] = { ...atual, ...campos, ...(conjuge ? { conjuge } : {}) };
    });
  }

  /** §18.13.5 `signatarios_duplicados`: o mesmo CPF (ou contato) em dois assinantes da proposta. */
  private duplicados(r: Rascunho): boolean {
    const vistos = new Set<string>();
    for (const p of [...r.compradores, ...r.vendedores]) {
      const chaves = [digitos(p.cpf), digitos(p.cnpj)].filter((x) => x.length > 0);
      for (const c of chaves) {
        if (vistos.has(c)) return true;
        vistos.add(c);
      }
    }
    return false;
  }

  /** O ponto de entrada que substitui `executarAcao`. */
  atender = async (p: {
    verb: string;
    args?: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<{ status: number; body: Record<string, unknown> } | null> => {
    const args = p.args ?? {};
    const escrita = isWriteVerb(p.verb);
    const reg: ChamadaAoServidor = { verb: p.verb, args, idempotencyKey: p.idempotencyKey, status: null, escrita, turno: this.turnoAtual };
    this.chamadas.push(reg);
    const resp = this.resolver(p.verb, args, p.idempotencyKey);
    reg.status = resp?.status ?? null;
    return resp;
  };

  private resolver(verb: string, args: Record<string, unknown>, chave?: string): RespostaProgramada | null {
    const fila = this.programadas.get(verb);
    if (fila && fila.length > 0) return fila.shift() ?? null;
    if (chave && isWriteVerb(verb) && this.porChave.has(`${verb}|${chave}`)) return this.porChave.get(`${verb}|${chave}`)!;
    const guardar = (r: RespostaProgramada): RespostaProgramada => {
      if (chave && r.status < 300) this.porChave.set(`${verb}|${chave}`, r);
      return r;
    };
    switch (verb) {
      case "proposal.options":
        return { status: 200, body: this.options(typeof args.proposta_id === "string" || typeof args.codigo === "string") };
      case "proposal.create": {
        const n = ++this.seq;
        const r: Rascunho = {
          id: `prop-${n}`,
          codigo: `PROP-2026-${String(n).padStart(4, "0")}`,
          schemaType: String(args.schemaType ?? "compra_venda_v1"),
          compradores: [],
          vendedores: [],
          imovel: {},
          negociacao: {},
          corretor: {},
        };
        this.aplicar(r, args);
        if (this.duplicados(r)) return { status: 409, body: { error: "signatarios_duplicados" } };
        this.rascunho = r;
        return guardar({ status: 201, body: { proposal: { id: r.id, codigo: r.codigo }, faltando: this.faltando() } });
      }
      case "proposal.update": {
        if (!this.rascunho || args.proposta_id !== this.rascunho.id) return { status: 404, body: { error: "nao_encontrada" } };
        const copia: Rascunho = JSON.parse(JSON.stringify(this.rascunho)) as Rascunho;
        this.aplicar(copia, args);
        if (this.duplicados(copia)) return { status: 409, body: { error: "signatarios_duplicados" } };
        this.rascunho = copia;
        return guardar({ status: 200, body: { proposta: { id: copia.id, codigo: copia.codigo }, faltando: this.faltando() } });
      }
      case "proposal.list":
        return {
          status: 200,
          body: {
            items: this.rascunho
              ? [{ id: this.rascunho.id, codigo: this.rascunho.codigo, titulo: `Proposta ${this.rascunho.codigo}`, estado: "Rascunho" }]
              : [],
          },
        };
      case "proposal.witnesses.set":
        return guardar({ status: 200, body: { ok: true } });
      case "proposal.preflight": {
        const tipo = this.opcoes.tipoEfetivo ?? this.tipoGravado ?? "email";
        const canal = tipo === "aceite" ? "celular" : tipo === "whatsapp" ? "WhatsApp" : "e-mail";
        return {
          status: 200,
          body: {
            instrumento: tipo === "aceite" ? "aceite" : "envelope",
            tipoEfetivo: tipo,
            assinantes: (this.rascunho?.compradores ?? []).filter((p) => p.nome).map((p) => ({ nome: p.nome, papel: "proponente", canal })),
            consomeEnvioDoPlano: tipo !== "aceite",
            ...(tipo === "aceite" ? { custoCentavos: 99, semLembrete: true } : {}),
            avisos: [],
            faltando: this.faltando(),
          },
        };
      }
      case "proposal.send":
        return guardar({ status: 200, body: { avisos: [] } });
      default:
        return { status: 404, body: { error: "verbo_desconhecido_no_servidor_falso" } };
    }
  }

  private aplicar(r: Rascunho, args: Record<string, unknown>): void {
    if (typeof args.tipo_assinatura === "string") this.tipoGravado = args.tipo_assinatura;
    this.mesclar(r.compradores, args.compradores);
    this.mesclar(r.vendedores, args.vendedores);
    if (args.imovel && typeof args.imovel === "object") r.imovel = { ...r.imovel, ...(args.imovel as object) };
    if (args.negociacao && typeof args.negociacao === "object") r.negociacao = { ...r.negociacao, ...(args.negociacao as object) };
    if (args.corretor && typeof args.corretor === "object") r.corretor = { ...r.corretor, ...(args.corretor as object) };
    if (typeof args.observacoes === "string") r.observacoes = args.observacoes;
  }
}

// ─── ModeloFalso ─────────────────────────────────────────────────────────────

export type TokensDoPrompt = Record<"CPF" | "CNPJ" | "EMAIL" | "TEL" | "CEP" | "VALOR", string[]>;

export interface ChamadaAoModelo {
  system: string;
  conteudo: string;
  ferramenta: string | null;
}

export interface ContextoDoRoteiro {
  prompt: string;
  /** Tokens na ordem em que aparecem no prompt (sem repetição). Ex.: `tokens.CPF[0]` = `⟨CPF_1⟩`. */
  tokens: TokensDoPrompt;
  /** Quantas extrações já houve (0 na primeira). */
  indice: number;
}

export type Roteiro = (ctx: ContextoDoRoteiro) => Record<string, unknown> | null;

export function tokensDe(prompt: string): TokensDoPrompt {
  const out: TokensDoPrompt = { CPF: [], CNPJ: [], EMAIL: [], TEL: [], CEP: [], VALOR: [] };
  for (const m of prompt.matchAll(/⟨(CPF|CNPJ|EMAIL|TEL|CEP|VALOR)_\d+⟩/g)) {
    const cat = m[1] as keyof TokensDoPrompt;
    if (!out[cat].includes(m[0])) out[cat].push(m[0]);
  }
  return out;
}

const USO = { model: "eval/modelo-falso", promptTokens: 120, completionTokens: 30, latencyMs: 5, success: true };

export class ModeloFalso {
  chamadas: ChamadaAoModelo[] = [];
  private roteiros: Roteiro[] = [];
  private extracoes = 0;
  /** Resposta livre (fora da extração). */
  respostaLivre = "Como posso ajudar?";
  /** Respostas do modelo de CONVERSA (fora da extração), consumidas em ordem; depois cai em `respostaLivre`. */
  private livres: Array<{ text?: string; toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }> }> = [];

  /** O corretor pede algo em linguagem natural e o MODELO decide chamar uma tool (ex.: `propor_criacao`). */
  conversa(...r: Array<{ text?: string; toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }> }>): this {
    this.livres = [...r];
    return this;
  }

  /** Roteiros consumidos em ordem, um por extração; o último se repete. */
  roteiro(...r: Roteiro[]): this {
    this.roteiros = r;
    return this;
  }

  ligar(): void {
    vi.mocked(complete).mockImplementation((async (req: { system: string; messages: Array<{ content: string }>; toolChoice?: string }) => {
      const conteudo = req.messages.map((m) => m.content).join("\n");
      const ehExtracao = req.toolChoice === TOOL_PATCH_V2.name;
      this.chamadas.push({ system: req.system, conteudo, ferramenta: req.toolChoice ?? null });
      if (!ehExtracao) {
        const l = this.livres.shift();
        return { text: l?.text ?? this.respostaLivre, toolCalls: l?.toolCalls ?? [], usage: USO };
      }
      const indice = this.extracoes++;
      const rot = this.roteiros[Math.min(indice, this.roteiros.length - 1)];
      const args = rot ? rot({ prompt: conteudo, tokens: tokensDe(conteudo), indice }) : null;
      return {
        text: "ok",
        toolCalls: args ? [{ id: `t${indice}`, name: TOOL_PATCH_V2.name, args }] : [],
        usage: USO,
      };
    }) as never);
  }

  get extracoesFeitas(): number {
    return this.extracoes;
  }
}

// ─── Sessao ──────────────────────────────────────────────────────────────────

export interface TurnoRegistrado {
  indice: number;
  messageId: string;
  kind: string;
  entrada: string;
  reply: string | null;
  sensivel: boolean;
  /** Escritas ao servidor feitas neste turno, com o status devolvido. */
  escritas: ChamadaAoServidor[];
  reacoes: string[];
}

export interface OpcoesDaSessao {
  bot?: "max" | "newton";
  servidor?: ServidorFalso;
  modelo?: ModeloFalso;
  /** Capabilities da política do corretor. Padrão: criar e enviar proposta. */
  politica?: string[];
  /** Nomes das partes que a conversa cita (T3 confere que nunca vão fora das cercas). */
  nomes?: string[];
  /** CPFs (só dígitos) que a conversa cita (T3 confere o checkpoint e o outbox). */
  cpfs?: string[];
  /** Liga a transcrição de imagem como fallback do OCR (`MAX_OCR_TRANSCRIBE_FALLBACK`). */
  fallbackOcr?: boolean;
  /** Sem a feature `formularios_v2`. */
  semFeature?: boolean;
}

let contadorDeSessoes = 0;
let contadorDeMensagens = 0;

export class Sessao {
  readonly org: string;
  readonly thread: string;
  readonly servidor: ServidorFalso;
  readonly modelo: ModeloFalso;
  readonly turnos: TurnoRegistrado[] = [];
  readonly nomes: string[];
  readonly cpfs: string[];
  private readonly opts: OpcoesDaSessao;
  private readonly politica: string[];
  /** Ficha agendada abre-se com a chave do selo (org|telefone). */
  private fichasAgendadasAbertas: string[] = [];

  constructor(opts: OpcoesDaSessao = {}) {
    this.opts = opts;
    const n = ++contadorDeSessoes;
    this.org = `org-eval-fv2-${n}`;
    this.thread = `eval-fv2-thread-${n}-${Math.random().toString(36).slice(2, 8)}`;
    this.servidor = opts.servidor ?? new ServidorFalso();
    this.modelo = opts.modelo ?? new ModeloFalso();
    this.nomes = opts.nomes ?? [];
    this.cpfs = opts.cpfs ?? [];
    this.politica = opts.politica ?? ["proposal.create", "proposal.send"];
  }

  /** Prepara os simulados e o ambiente da sessão. Chamar antes do primeiro turno. */
  async preparar(): Promise<void> {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("AGENT_DEPLOY_PROFILE", this.opts.bot === "newton" ? "newton" : "");
    if (!this.opts.semFeature) {
      vi.stubEnv("MAX_FORMULARIOS_V2", "true");
      vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ [this.org]: ["formularios_v2"] }));
    }
    if (this.opts.fallbackOcr) vi.stubEnv("MAX_OCR_TRANSCRIBE_FALLBACK", "true");
    if (this.opts.bot === "newton") vi.stubEnv("NEWTON_MEDIA_INBOUND", "true");

    const resolvida: Identity = {
      kind: "resolved",
      candidate: { orgId: this.org, orgName: "RE/MAX Trio", kind: "user", userId: "u1", userName: "Marcia" },
      org: { orgId: this.org, orgName: "RE/MAX Trio", apiToken: "t" },
    };
    vi.mocked(resolveIdentity).mockResolvedValue(resolvida);
    vi.mocked(fetchProfile).mockResolvedValue({
      enabled: true,
      model: "x",
      instructions: null,
      maxPolicy: { byRole: { "*": this.politica }, byRecipient: {}, brokerDefault: [] },
    } as never);
    vi.mocked(executarAcao).mockImplementation(this.servidor.atender as never);
    vi.mocked(lerDocumento).mockReset();
    vi.mocked(downloadMedia).mockResolvedValue(null);
    vi.mocked(transcribeMedia).mockResolvedValue(null);
    vi.mocked(linhaEnviada).mockResolvedValue(false);
    this.modelo.ligar();
  }

  private entrada(kind: string, texto: string | null, extra: Record<string, unknown> = {}) {
    const messageId = `wamid.EVAL${++contadorDeMensagens}`;
    return {
      messageId,
      fromPhone: FONE,
      groupId: null,
      kind,
      text: texto,
      mediaUrl: null,
      mimeType: null,
      timestampMs: null,
      senderName: "Marcia",
      replyToMessageId: null,
      ...extra,
    } as Parameters<typeof runTurn>[0];
  }

  /** Semeia um fluxo v2 aberto (equivale a "quero criar uma proposta" já respondido). */
  async semear(esteira: "venda" | "locacao" = "venda", schemaType = "compra_venda_v1"): Promise<void> {
    const app = await getApp();
    await app.updateState(
      { configurable: { thread_id: this.thread } },
      { fluxo: novoFluxoV2({ esteira, agora: Date.now(), schemaType }) as never }
    );
  }

  private async executar(inbound: Parameters<typeof runTurn>[0], rotulo: string): Promise<TurnoRegistrado> {
    const indice = this.turnos.length;
    this.servidor.turnoAtual = indice;
    const antesDeEscritas = this.servidor.chamadas.length;
    const antesDeReacoes = vi.mocked(sendReaction).mock.calls.length;
    const antesDeFila = vi.mocked(enqueue).mock.calls.length;
    const r = await withExecution(
      {
        orgId: this.org,
        subject: { kind: "user", userId: "u1" },
        conversationId: this.thread,
        taskId: `00000000-0000-4000-8000-${String(indice + 1).padStart(12, "0")}`,
        mode: "live",
        workflowVersion: "max-v1",
        controlVersion: 0,
        deadline: Date.now() + 30_000,
        budgetUsd: 0.25,
        maxConcurrency: 1,
      },
      () => runTurn(inbound)
    );
    await r.afterReply();
    for (const [p] of vi.mocked(enqueue).mock.calls.slice(antesDeFila)) {
      if (typeof p.dedupeKey === "string" && p.dedupeKey.startsWith("ficha:")) {
        this.fichasAgendadasAbertas.push(abrirCorpo(p.body, `${this.org}|${FONE}`) ?? "");
      }
    }
    const t: TurnoRegistrado = {
      indice,
      messageId: inbound.messageId,
      kind: inbound.kind,
      entrada: rotulo,
      reply: r.reply ?? null,
      sensivel: r.sensivel === true,
      escritas: this.servidor.chamadas.slice(antesDeEscritas).filter((c) => c.escrita),
      reacoes: vi.mocked(sendReaction).mock.calls.slice(antesDeReacoes).map((c) => String((c[0] as { emoji?: string }).emoji ?? "")),
    };
    this.turnos.push(t);
    return t;
  }

  /** Uma mensagem de texto do corretor. */
  fala(texto: string, extra: Record<string, unknown> = {}): Promise<TurnoRegistrado> {
    return this.executar(this.entrada("text", texto, extra), texto);
  }

  /** Foto ou PDF (`bytes` = o que o transporte baixa). `legenda` opcional. */
  async midia(a: { kind?: "image" | "document"; mimeType: string; bytes: Buffer; legenda?: string; ref?: string }): Promise<TurnoRegistrado> {
    const ref = a.ref ?? (this.opts.bot === "newton" ? "zapi:https://media.exemplo.invalido/instancia/arquivo.jpeg" : "meta:MEDIA-EVAL");
    vi.mocked(downloadMedia).mockResolvedValue({ data: a.bytes, contentType: a.mimeType } as never);
    return this.executar(
      this.entrada(a.kind ?? "image", a.legenda ?? null, { mediaUrl: ref, mimeType: a.mimeType }),
      `[${a.kind ?? "image"}${a.legenda ? `: ${a.legenda}` : ""}]`
    );
  }

  /** Áudio cuja transcrição (feita no servidor) é `transcricao`; `null` = não foi possível ouvir. */
  async audio(transcricao: string | null): Promise<TurnoRegistrado> {
    vi.mocked(downloadMedia).mockResolvedValue({ data: Buffer.from("ogg-sintetico"), contentType: "audio/ogg" } as never);
    vi.mocked(transcribeMedia).mockResolvedValue(transcricao);
    return this.executar(
      this.entrada("audio", null, { mediaUrl: this.opts.bot === "newton" ? "zapi:https://media.exemplo.invalido/audio.ogg" : "meta:AUDIO-EVAL", mimeType: "audio/ogg" }),
      transcricao ? `[audio: ${transcricao}]` : "[audio ininteligível]"
    );
  }

  /** A ficha agendada no outbox chegou ao corretor (o cron a enviou): o próximo "sim" vale. */
  fichaAgendadaFoiEnviada(): void {
    vi.mocked(linhaEnviada).mockResolvedValue(true);
  }

  /** O estado do fluxo no checkpoint. */
  async fluxo(): Promise<Record<string, unknown> | undefined> {
    const app = await getApp();
    const v = (await app.getState({ configurable: { thread_id: this.thread } })).values as { fluxo?: Record<string, unknown> };
    return v.fluxo ?? undefined;
  }

  async checkpointCompleto(): Promise<string> {
    const app = await getApp();
    return JSON.stringify((await app.getState({ configurable: { thread_id: this.thread } })).values);
  }

  /** O checkpoint sem o histórico de conversa (`messages`): o estado do fluxo e o resto. */
  async checkpointSemHistorico(): Promise<string> {
    const app = await getApp();
    const { messages: _historico, ...resto } = (await app.getState({ configurable: { thread_id: this.thread } })).values as Record<string, unknown>;
    return JSON.stringify(resto);
  }

  /** O histórico de conversa do checkpoint (`messages`), como texto. */
  async historicoDoCheckpoint(): Promise<string> {
    const app = await getApp();
    const v = (await app.getState({ configurable: { thread_id: this.thread } })).values as { messages?: unknown };
    return JSON.stringify(v.messages ?? []);
  }

  /** Fichas agendadas (texto aberto) que foram para o outbox. */
  get fichasAgendadas(): string[] {
    return this.fichasAgendadasAbertas;
  }

  /** O último texto que o corretor recebeu. */
  get ultimaResposta(): string {
    for (let i = this.turnos.length - 1; i >= 0; i--) {
      const r = this.turnos[i]!.reply;
      if (r) return r;
    }
    return "";
  }
}

// ─── Verificações transversais ───────────────────────────────────────────────

/** "sim" explícito: sozinho ou com um pedido curto de execução. "ok", "blz", 👍 nunca valem. */
const SIM_EXPLICITO = /^\s*sim\b[\s,.!]*(?:pode\s+(?:gravar|mandar|enviar|salvar))?[\s.!]*$/i;

/** "anotei"/"salvei" afirmativos (a negação "não anotei" é a recusa honesta, não a afirmação). */
const AFIRMA_GRAVACAO = /(?<![Nn][ãa]o )(?<!então não )\b(anotei|salvei)\b/i;

const CERCAS_DE_DADO = /<(mensagem|documento_lido)\b[^>]*>[\s\S]*?<\/\1>/g;

const escritaOk = (c: ChamadaAoServidor): boolean => c.status !== null && c.status >= 200 && c.status < 300;

export interface OpcoesDeVerificacao {
  /** Textos a mais que valem como "sim" explícito neste caso. */
  simsExtras?: RegExp[];
  /** Chamadas a `complete` que NÃO são do corretor (nenhuma hoje). */
  semModelo?: boolean;
}

export async function verificarTransversais(s: Sessao, o: OpcoesDeVerificacao = {}): Promise<void> {
  // T1: "anotei"/"salvei" só no turno em que o servidor devolveu 2xx para uma escrita.
  for (const t of s.turnos) {
    const textos = [t.reply ?? ""];
    if (AFIRMA_GRAVACAO.test(textos.join("\n"))) {
      expect(
        t.escritas.some(escritaOk),
        `T1: o turno ${t.indice} ("${t.entrada}") afirmou "anotei/salvei" sem 2xx do servidor. Resposta: ${t.reply}`
      ).toBe(true);
    }
  }
  for (const ficha of s.fichasAgendadas) {
    expect(AFIRMA_GRAVACAO.test(ficha), "T1: a ficha agendada não pode dizer que anotou/salvou").toBe(false);
  }

  // T2: nenhuma escrita sem um "sim" explícito antes (a idempotencyKey é a messageId do "sim").
  const simsPorMessageId = new Map<string, number>();
  for (const t of s.turnos) {
    const ehSim = t.kind === "text" && (SIM_EXPLICITO.test(t.entrada) || (o.simsExtras ?? []).some((re) => re.test(t.entrada)));
    if (ehSim) simsPorMessageId.set(t.messageId, t.indice);
  }
  for (const c of s.servidor.escritas()) {
    expect(c.idempotencyKey, `T2: a escrita ${c.verb} (turno ${c.turno}) foi sem idempotencyKey`).toBeTruthy();
    const turnoDoSim = simsPorMessageId.get(String(c.idempotencyKey));
    expect(turnoDoSim, `T2: a escrita ${c.verb} (turno ${c.turno}) não tem "sim" explícito por trás da chave ${c.idempotencyKey}`).toBeDefined();
    expect(turnoDoSim! <= c.turno, `T2: o "sim" (turno ${turnoDoSim}) veio DEPOIS da escrita (turno ${c.turno})`).toBe(true);
  }

  // T3: nada em claro no que vai ao modelo.
  for (const [i, ch] of s.modelo.chamadas.entries()) {
    expect(redigir(ch.system), `T3: PII em claro no system da chamada ${i}`).toBe(ch.system);
    expect(redigir(ch.conteudo), `T3: PII em claro no conteúdo da chamada ${i}`).toBe(ch.conteudo);
    for (const nome of s.nomes) {
      expect(ch.system.includes(nome), `T3: o nome "${nome}" apareceu no system da chamada ${i}`).toBe(false);
      // Só a EXTRAÇÃO tem a regra das cercas (o nome vai dentro de `<mensagem>`/`<documento_lido>`).
      // A chamada de conversa carrega o histórico do corretor, com nomes em claro por desenho
      // (não existe categoria NOME no `tokenizar`); CPF/telefone/valor seguem tokenizados.
      if (ch.ferramenta === TOOL_PATCH_V2.name) {
        const foraDasCercas = ch.conteudo.replace(CERCAS_DE_DADO, "");
        expect(foraDasCercas.includes(nome), `T3: o nome "${nome}" apareceu fora das cercas de dado na chamada ${i}`).toBe(false);
      }
    }
    for (const cpf of s.cpfs) {
      expect(ch.conteudo.replace(/\D/g, "").includes(cpf), `T3: o CPF da conversa chegou ao modelo (chamada ${i})`).toBe(false);
    }
  }
  // ...nem no outbox (selado), nem no checkpoint.
  for (const [p] of vi.mocked(enqueue).mock.calls) {
    if (typeof p.body === "string" && typeof p.dedupeKey === "string" && p.dedupeKey.startsWith("ficha:")) {
      expect(estaSelado(p.body), "T3: o corpo da ficha no outbox tem de ir selado").toBe(true);
      for (const cpf of s.cpfs) expect(p.body.replace(/\D/g, "").includes(cpf), "T3: CPF em claro no outbox").toBe(false);
    }
  }
  // O checkpoint INTEIRO (estado do fluxo e histórico `messages`): CPF, telefone e e-mail dos casos nunca em
  // claro (só caminho + referência; o valor mora no cofre cifrado).
  const cp = await s.checkpointCompleto();
  for (const cpf of s.cpfs) {
    expect(cp.replace(/\D/g, "").includes(cpf), "T3: CPF em claro no checkpoint").toBe(false);
    expect(cp.includes(formatarCpf(cpf)), "T3: CPF formatado no checkpoint").toBe(false);
  }
  expect(/90000[-\s]?00\d\d/.test(cp), "T3: telefone fictício em claro no checkpoint").toBe(false);
  expect(/@[a-z0-9.-]*\.invalid/i.test(cp), "T3: e-mail fictício em claro no checkpoint").toBe(false);
  // Nome: fora do histórico (o estado do fluxo só tem caminho). No histórico o nome pode aparecer na resposta
  // do assistente (lista de assinantes, "quem falta"): o projeto não trata nome como PII ali (não há categoria
  // NOME no `tokenizar`); a fala do corretor vira marcador.
  const { messages: _historico, ...semHistorico } = JSON.parse(cp) as Record<string, unknown>;
  const cpSemHistorico = JSON.stringify(semHistorico);
  for (const nome of s.nomes) {
    expect(cpSemHistorico.includes(nome), `T3: o nome "${nome}" apareceu no checkpoint (fora do histórico)`).toBe(false);
  }

  // T4: custo reportado por chamada ao modelo (e só com o modelo real: lerDocumento/transcribe são cobrados no servidor).
  const usos = vi.mocked(reportUsage).mock.calls;
  expect(usos.length, "T4: toda chamada ao modelo tem de reportar uso").toBeGreaterThanOrEqual(s.modelo.chamadas.length);
  for (const [org, uso] of usos) {
    expect(org).toBe(s.org);
    expect(uso).toMatchObject({ model: expect.any(String), promptTokens: expect.any(Number), completionTokens: expect.any(Number) });
  }
}

// ─── Roteiros prontos ────────────────────────────────────────────────────────

/** Roteiro que devolve sempre os mesmos args (sem tokens). */
export const sempre = (args: Record<string, unknown>): Roteiro => () => args;

/**
 * Os fixtures descrevem o que o modelo devolve SEM conhecer os tokens: `{{CPF:2}}` é o segundo CPF que
 * aparece na conversa (a numeração do `tokenizar` é pela ordem de aparição na janela). O harness troca pelo
 * token que o prompt realmente trouxe (`⟨CPF_2⟩`), e o agente destokeniza como em produção.
 */
export type PatchDoFixture = Record<string, unknown>;

const PLACEHOLDER = /^\{\{(CPF|CNPJ|EMAIL|TEL|CEP|VALOR):(\d+)\}\}$/;

export function trocarPlaceholders(valor: unknown, tokens: TokensDoPrompt): unknown {
  if (typeof valor === "string") {
    const m = PLACEHOLDER.exec(valor);
    if (!m) return valor;
    const token = tokens[m[1] as keyof TokensDoPrompt][Number(m[2]) - 1];
    if (!token) throw new Error(`fixture pede ${valor}, mas o prompt só trouxe ${JSON.stringify(tokens)}`);
    return token;
  }
  if (Array.isArray(valor)) return valor.map((v) => trocarPlaceholders(v, tokens));
  if (valor && typeof valor === "object") {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, trocarPlaceholders(v, tokens)]));
  }
  return valor;
}

/** Um roteiro por patch do fixture, com os placeholders trocados pelos tokens do prompt. */
export const roteirosDe = (patches: PatchDoFixture[]): Roteiro[] =>
  patches.map((p): Roteiro => ({ tokens }) => trocarPlaceholders(p, tokens) as Record<string, unknown>);

// ─── Bytes de mídia sintéticos ───────────────────────────────────────────────

export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)]);
export const PDF = Buffer.from(`%PDF-1.4\n${"x".repeat(2000)}`);
export const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(2000, 2)]);
