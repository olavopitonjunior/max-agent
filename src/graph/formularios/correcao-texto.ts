import { nomeDoAgente } from "@/lib/deploy-profile";
import type { ContextoDoTurno, DepsDoFluxo, PassoDoFluxo, RespostaDoServidor } from "../fluxos";
import { TEXTO_ESCRITA_INCERTA, TEXTO_SEM_RESPOSTA, querCancelar } from "../fluxos";
import { lerConfirmacao, normalizar } from "../tools";
import { ehFluxoDesligado } from "./selecao";
import { abrirCorpo, selarCorpo, seloDisponivel } from "./selo";

/**
 * Correção de texto por WhatsApp (formulários v2, PR-E). Contrato: CM `docs/max.md` §18.13.14.
 *
 * O corretor pede "troca a multa para 10%"; o CM acha o parágrafo, a IA reescreve só ele, o corretor
 * vê o antes e o depois e só um SIM explícito aplica. Quatro verbos (`proposal|captacao.text.suggest|apply`),
 * capability `document.text.edit` (nasce desligada) e a feature `formularios_v2`.
 *
 * Regras que este módulo carrega (R26–R31 do plano):
 *  - R26: documento em assinatura = explica e manda para a tela. NUNCA envia `aceita_cancelar` nem
 *    `cancelar_envio`, e nunca repete o apply. Sem valor em R$ (o custo do envio não se exibe).
 *  - R27: `nenhum_paragrafo` pede para citar o trecho; sem retentativa.
 *  - R28: `paragrafo_mudou`/`sugestao_expirada` refaz o suggest (chave NOVA) e pede SIM de novo; nunca
 *    aplica sem SIM. 429/502/503: frase fixa, sem retentativa automática.
 *  - R29: o estado do fluxo (checkpoint) guarda SÓ ids. `antes`/`depois`/`trecho` existem apenas na
 *    resposta do turno, que o grafo trata como turno sensível (marcador no checkpoint, fora do resumo,
 *    da memória e do log). O pedido original do corretor, quando precisa sobreviver entre turnos
 *    (escolha do trecho, criar o documento, refazer a sugestão), fica SELADO (AES-GCM, o mesmo selo da
 *    ficha, AAD = thread); sem o selo disponível, o fluxo pede para o corretor dizer de novo.
 *  - R31: "Aplicar" só vale como confirmação explícita (1, "aplicar", SIM). "ok"/"blz" nunca.
 *    "Ajustar" é um pedido novo, com o mesmo `paragrafo_id`.
 */

type Alvo = "proposal" | "captacao";
type Resposta = Extract<PassoDoFluxo, { reply: string }>;

export interface FluxoCorrecaoTexto {
  kind: "correcao_texto";
  alvo: Alvo;
  /** Id da proposta (`proposta_id`) ou da captação (`captacaoId`). */
  id: string;
  /** Código curto para falar com a pessoa ("PROP-2026-0001"); nunca conteúdo do documento. */
  rotulo?: string;
  etapa:
    | "candidatos" // escolher entre até 3 trechos
    | "citar" // `nenhum_paragrafo`: citar a passagem
    | "oferta_documento" // `sem_documento_proprio`: SIM cria o Doc
    | "sugestao" // antes/depois mostrado: Aplicar / Ajustar / Ver
    | "ajustar"; // esperando o pedido novo
  /** O pedido original, selado (R29). Ausente = sem selo disponível: o corretor repete. */
  pedidoSelado?: string;
  paragrafoId?: string;
  /** Ids dos parágrafos oferecidos (na ordem da lista). Nunca o trecho. */
  candidatos?: string[];
  sugestaoId?: string;
  hashParagrafo?: string;
  expiraEm?: number;
  /** Link do documento devolvido pelo servidor (URL, não conteúdo). */
  link?: string;
  /** O Doc ainda precisa nascer (`criar_documento`) — só proposta. */
  criarDocumento?: boolean;
  /** Escrita incerta (apply sem resposta): o SIM seguinte repete a MESMA chave. */
  chave?: { verbo: string; valor: string };
  atualizadoEm: number;
}

/** A sugestão vale 30 minutos no servidor; o mesmo prazo aqui. */
export const VALIDADE_DA_SUGESTAO_MS = 30 * 60 * 1000;
const PEDIDO_MIN = 3;
const PEDIDO_MAX = 500;

// ─── Frases fixas ─────────────────────────────────────────────────────────────

const nome = () => nomeDoAgente();
export const TEXTO_TEXTO_SEM_PERMISSAO = () => `Corrigir o texto de um documento pelo ${nome()} não está liberado para você. Faça pela tela do sistema.`;
export const TEXTO_TEXTO_POLITICA_INDISPONIVEL = "Não consegui validar sua permissão agora. Nada foi alterado; tente de novo em instantes.";
const TEXTO_LIMITE = "Já pedi 3 sugestões para este documento nos últimos 10 minutos. Espere um pouco e peça de novo, ou edite direto pela tela. Nada foi alterado.";
const TEXTO_GOOGLE = "Não consegui falar com o Google agora. Nada foi alterado no documento.";
const TEXTO_REDACAO = "Não consegui redigir a correção agora. Nada foi alterado no documento. Tente de novo mais tarde.";
const TEXTO_NAO_CONFIGURADO = "A correção de texto ainda não está configurada nesta imobiliária. Nada foi alterado.";
const TEXTO_SUGESTAO_INVALIDA = "A correção que eu redigi não passou na conferência (ela mexia no que você não pediu). Nada foi alterado; reformule o pedido, dizendo o que trocar e por quê.";
const TEXTO_NAO_ACHADO = "Não encontrei esse documento. Nada foi alterado.";
const TEXTO_TRECHO_SUMIU = "Esse trecho não está mais no documento (ele pode ter mudado). Nada foi alterado; diga de novo o que mudar.";
const TEXTO_PARADO = "Beleza, não apliquei nada no documento.";
const TEXTO_JA_APLICADA = "Essa correção já foi aplicada ao documento. Não repeti nada.";
const TEXTO_ESTADO_MUDOU = "Outro pedido de aplicar essa correção estava em andamento. Não repeti nada; confira o documento.";
const TEXTO_RESPOSTA_ESTRANHA = "Não consegui entender a resposta do sistema. Nada foi alterado; confira o documento.";
const TEXTO_PEDIDO_CURTO = `Diga o que mudar no texto (de ${PEDIDO_MIN} a ${PEDIDO_MAX} caracteres), por exemplo: "troca a multa para 10%".`;
const TEXTO_PEDIDO_LONGO = `O pedido ficou grande demais. Resuma em até ${PEDIDO_MAX} caracteres o que mudar.`;
const TEXTO_PARA_APLICAR = "Para aplicar a correção, responda *1* ou *SIM*. Para ajustar, *2*; para parar, *NÃO*. \"Ok\" sozinho não aplica.";

const ONDE = (alvo: Alvo) => (alvo === "proposal" ? "a proposta" : "a captação");
const DA = (alvo: Alvo) => (alvo === "proposal" ? "da proposta" : "da captação");

// ─── Utilidades puras ─────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Só link https sem espaço: nunca eco de texto livre do servidor para o corretor. */
function linkDe(body: Record<string, unknown>): string | undefined {
  const l = str(body.link);
  return l && /^https:\/\/\S+$/.test(l) ? l : undefined;
}

function resposta(f: FluxoCorrecaoTexto | null, reply: string, evento: string): Resposta {
  return { fluxo: f, reply, evento };
}

/** Antes e depois na resposta do turno (nunca no estado). */
export function renderizarAntesDepois(p: { antes: string; depois: string }): string {
  return `*Antes*\n${p.antes}\n\n*Depois*\n${p.depois}`;
}

function menuDaSugestao(temLink: boolean): string {
  return [
    "Responda com o número:",
    "1. Aplicar",
    "2. Ajustar",
    ...(temLink ? ["3. Ver no documento"] : []),
    "(ou NÃO para parar)",
  ].join("\n");
}

function selar(pedido: string, ctx: ContextoDoTurno): string | undefined {
  if (!ctx.thread || !seloDisponivel()) return undefined;
  try {
    return selarCorpo(pedido, ctx.thread);
  } catch {
    return undefined;
  }
}

function abrir(f: FluxoCorrecaoTexto, ctx: ContextoDoTurno): string | undefined {
  if (!f.pedidoSelado || !ctx.thread) return undefined;
  try {
    return abrirCorpo(f.pedidoSelado, ctx.thread);
  } catch {
    return undefined;
  }
}

const verbo = (alvo: Alvo, op: "suggest" | "apply") => `${alvo}.text.${op}`;
const alvoArgs = (f: Pick<FluxoCorrecaoTexto, "alvo" | "id">) => (f.alvo === "proposal" ? { proposta_id: f.id } : { captacaoId: f.id });

/** O gate de TODO turno do fluxo: RBAC de identidade, política conferida, capability. */
function gate(ctx: ContextoDoTurno): Resposta | null {
  if (ctx.podeEscrever !== true) return resposta(null, TEXTO_TEXTO_SEM_PERMISSAO(), "texto_sem_permissao");
  if (ctx.politicaIndisponivel) return resposta(null, TEXTO_TEXTO_POLITICA_INDISPONIVEL, "texto_politica_indisponivel");
  if (!ctx.policy.includes("document.text.edit")) return resposta(null, TEXTO_TEXTO_SEM_PERMISSAO(), "texto_sem_permissao");
  return null;
}

// ─── Chamadas ao servidor ─────────────────────────────────────────────────────

export interface OpcoesDoSugerir {
  paragrafo_id?: string;
  criar_documento?: boolean;
}

/**
 * `proposal|captacao.text.suggest`. O agente NUNCA passa `aceita_cancelar` (R26). `chave` = a
 * `messageId` do turno (ou `${messageId}:r` na refeita).
 */
export function sugerirTexto(
  deps: DepsDoFluxo, alvo: Alvo, id: string, pedido: string, chave: string, opts: OpcoesDoSugerir = {}
): Promise<RespostaDoServidor | null> {
  return deps.acao(verbo(alvo, "suggest"), {
    ...alvoArgs({ alvo, id }),
    pedido,
    ...(opts.paragrafo_id ? { paragrafo_id: opts.paragrafo_id } : {}),
    ...(alvo === "proposal" && opts.criar_documento ? { criar_documento: true } : {}),
  }, chave);
}

/** `proposal|captacao.text.apply`. O agente NUNCA passa `cancelar_envio` (R26). */
export function aplicarTexto(
  deps: DepsDoFluxo, alvo: Alvo, id: string, p: { sugestaoId: string; hashParagrafo: string }, chave: string
): Promise<RespostaDoServidor | null> {
  return deps.acao(verbo(alvo, "apply"), { ...alvoArgs({ alvo, id }), sugestaoId: p.sugestaoId, hashParagrafo: p.hashParagrafo }, chave);
}

// ─── Textos por erro ──────────────────────────────────────────────────────────

function textoEmAssinatura(alvo: Alvo, link?: string): string {
  return (
    `${ONDE(alvo)[0]!.toUpperCase()}${ONDE(alvo).slice(1)} já foi enviada para assinatura. Para corrigir o texto é preciso cancelar o envio e enviar de novo, ` +
    "e isso consome um envio do plano. Esse cancelamento eu não faço por aqui: faça pela tela" +
    (link ? ` (${link})` : "") +
    ". Nada foi alterado."
  );
}

function textoAprovado(body: Record<string, unknown>): string {
  const q = body.quemPodeDesaprovar;
  const quem = Array.isArray(q) ? q.filter((x): x is string => typeof x === "string").join(", ") : typeof q === "string" ? q : "";
  const link = linkDe(body);
  return (
    "Esse documento está aprovado, e documento aprovado não muda. " +
    (quem ? `Quem pode desaprovar: ${quem}. ` : "Peça a quem pode desaprovar para liberar a edição. ") +
    (link ? `Documento: ${link}. ` : "") +
    "Nada foi alterado."
  );
}

/** Erros comuns ao suggest e ao apply que encerram o fluxo com frase fixa. `null` = o código não é deste grupo. */
function erroDeEstado(alvo: Alvo, r: RespostaDoServidor): Resposta | null {
  const erro = str(r.body?.error);
  const link = linkDe(r.body ?? {});
  if (r.status === 409) {
    if (erro === "requer_cancelamento") return resposta(null, textoEmAssinatura(alvo, link), "texto_em_assinatura");
    if (erro === "documento_aprovado") return resposta(null, textoAprovado(r.body), "texto_aprovado");
    if (erro === "documento_assinado") return resposta(null, `Esse documento já foi assinado e não pode mais mudar. Nada foi alterado.`, "texto_assinado");
    if (erro === "documento_encerrado") return resposta(null, "Esse documento foi encerrado sem assinatura (recusado, expirado, cancelado ou arquivado). Nada foi alterado.", "texto_encerrado");
    if (erro === "sem_ancora") {
      return resposta(null, `O modelo desse documento tem dado pessoal escrito direto no texto, então não há onde ancorar a correção por aqui.${link ? ` Edite pela tela: ${link}.` : " Edite pela tela."} Nada foi alterado.`, "texto_sem_ancora");
    }
    if (erro === "sem_documento_proprio") return resposta(null, `Esse documento ainda não tem uma cópia própria para corrigir. Gere pela tela de ${alvo === "proposal" ? "propostas" : "captações"}. Nada foi alterado.`, "texto_sem_documento");
    if (erro === "documento_bloqueado") return resposta(null, "O documento ficou indisponível para edição enquanto eu aplicava (o estado dele mudou). Nada foi confirmado; confira pela tela.", "texto_bloqueado");
  }
  if (r.status === 429 && erro === "limite_de_sugestoes") return resposta(null, TEXTO_LIMITE, "texto_limite");
  if (r.status === 503) return resposta(null, TEXTO_NAO_CONFIGURADO, "texto_nao_configurado");
  return null;
}

// ─── Suggest ──────────────────────────────────────────────────────────────────

interface ContextoDoSugerir {
  f: FluxoCorrecaoTexto;
  pedido: string;
  chave: string;
  ctx: ContextoDoTurno;
  deps: DepsDoFluxo;
  paragrafoId?: string;
  /** Prefixo da resposta (ex.: "O parágrafo mudou… refiz"). */
  prefixo?: string;
}

/** Estado novo do fluxo: só ids; o pedido vai selado (ou nada). */
function estadoBase(f: FluxoCorrecaoTexto, pedido: string, ctx: ContextoDoTurno): FluxoCorrecaoTexto {
  return {
    kind: "correcao_texto", alvo: f.alvo, id: f.id, rotulo: f.rotulo, etapa: f.etapa,
    pedidoSelado: selar(pedido, ctx), criarDocumento: f.criarDocumento, atualizadoEm: ctx.agora,
  };
}

async function sugerir(c: ContextoDoSugerir): Promise<Resposta | { liberar: true; fluxo: null; evento: string }> {
  const { f, pedido, ctx, deps } = c;
  const paragrafoId = c.paragrafoId ?? f.paragrafoId;
  const r = await sugerirTexto(deps, f.alvo, f.id, pedido, c.chave, {
    paragrafo_id: paragrafoId, criar_documento: f.criarDocumento,
  });
  if (!r) return resposta(null, `${TEXTO_SEM_RESPOSTA} Nada foi alterado no documento.`, "texto_sem_resposta");
  if (ehFluxoDesligado(r)) return { liberar: true, fluxo: null, evento: "texto_fluxo_desligado" };

  const body = r.body ?? {};
  const erro = str(body.error);

  if (r.status === 200) {
    const estado = str(body.estado);
    if (estado === "sugestao") return mostrarSugestao(c, body);
    if (estado === "candidatos") return mostrarCandidatos(c, body);
    if (estado === "nenhum_paragrafo") {
      // R27: pede a passagem, sem retentativa.
      return resposta(
        { ...estadoBase({ ...f, etapa: "citar" }, pedido, ctx), etapa: "citar", paragrafoId: undefined },
        "Não achei no documento o trecho que você citou. Cole ou descreva a passagem (por exemplo, o começo da frase) e eu tento de novo.",
        "texto_nenhum_paragrafo");
    }
    if (estado === "sem_documento_proprio") {
      if (f.alvo !== "proposal") {
        return resposta(null, `A captação ainda não tem um documento próprio para corrigir. Gere pela tela de captações. Nada foi alterado.`, "texto_sem_documento");
      }
      return resposta(
        { ...estadoBase({ ...f, etapa: "oferta_documento" }, pedido, ctx), etapa: "oferta_documento", paragrafoId },
        "Essa proposta ainda não tem um documento próprio (só o modelo). Posso *criar o documento da proposta* no Google Docs e aplicar a correção nele. " +
          "Isso cria o documento agora.\n\nResponda *SIM* para criar e seguir, ou *NÃO* para parar.",
        "texto_oferta_documento");
    }
    if (estado === "em_assinatura") return resposta(null, textoEmAssinatura(f.alvo, linkDe(body)), "texto_em_assinatura");
    return resposta(null, TEXTO_RESPOSTA_ESTRANHA, "texto_resposta_estranha");
  }

  const comum = erroDeEstado(f.alvo, r);
  if (comum) return comum;
  if (r.status === 403) {
    if (erro === "captacao_desligada") return resposta(null, "A captação não está ligada nesta imobiliária. Nada foi alterado.", "texto_captacao_desligada");
    return resposta(null, TEXTO_TEXTO_SEM_PERMISSAO(), "texto_sem_permissao");
  }
  if (r.status === 404) {
    return resposta(null, erro === "paragrafo_nao_encontrado" ? TEXTO_TRECHO_SUMIU : TEXTO_NAO_ACHADO, erro === "paragrafo_nao_encontrado" ? "texto_paragrafo_nao_encontrado" : "texto_nao_achado");
  }
  if (r.status === 422) return resposta(null, TEXTO_SUGESTAO_INVALIDA, "texto_sugestao_invalida");
  if (r.status === 502) {
    return resposta(null, erro === "redacao_indisponivel" ? TEXTO_REDACAO : TEXTO_GOOGLE, erro === "redacao_indisponivel" ? "texto_redacao_indisponivel" : "texto_documento_indisponivel");
  }
  return resposta(null, `Não consegui preparar a correção agora (${r.status}). Nada foi alterado.`, `texto_suggest_${r.status}`);
}

function mostrarSugestao(c: ContextoDoSugerir, body: Record<string, unknown>): Resposta {
  const sugestaoId = str(body.sugestaoId);
  const hashParagrafo = str(body.hashParagrafo);
  const paragrafoId = str(body.paragrafoId);
  const antes = typeof body.antes === "string" ? body.antes : undefined;
  const depois = typeof body.depois === "string" ? body.depois : undefined;
  if (!sugestaoId || !hashParagrafo || !paragrafoId || antes === undefined || depois === undefined) {
    return resposta(null, TEXTO_RESPOSTA_ESTRANHA, "texto_resposta_estranha");
  }
  const link = linkDe(body);
  const fluxo: FluxoCorrecaoTexto = {
    ...estadoBase({ ...c.f, etapa: "sugestao" }, c.pedido, c.ctx),
    etapa: "sugestao", sugestaoId, hashParagrafo, paragrafoId,
    expiraEm: c.ctx.agora + VALIDADE_DA_SUGESTAO_MS, link,
    // O Doc já existe depois de uma sugestão: não pedir para criar de novo.
    criarDocumento: undefined,
  };
  return resposta(
    fluxo,
    `${c.prefixo ?? ""}Esta é a correção que eu faria ${DA(c.f.alvo)}. Ainda não mudei nada:\n\n${renderizarAntesDepois({ antes, depois })}\n\n${menuDaSugestao(!!link)}`,
    "texto_sugestao");
}

function mostrarCandidatos(c: ContextoDoSugerir, body: Record<string, unknown>): Resposta {
  const brutos = Array.isArray(body.candidatos) ? body.candidatos : [];
  const itens = brutos
    .map((x) => (x && typeof x === "object" ? { id: str((x as Record<string, unknown>).paragrafoId), trecho: str((x as Record<string, unknown>).trecho) } : null))
    .filter((x): x is { id: string; trecho: string | undefined } => !!x && !!x.id)
    .slice(0, 3);
  if (itens.length === 0) {
    return resposta(
      { ...estadoBase({ ...c.f, etapa: "citar" }, c.pedido, c.ctx), etapa: "citar" },
      "Não achei no documento o trecho que você citou. Cole ou descreva a passagem (por exemplo, o começo da frase) e eu tento de novo.",
      "texto_nenhum_paragrafo");
  }
  const lista = itens.map((x, i) => `${i + 1}. ${x.trecho ?? "(trecho sem texto)"}`).join("\n");
  return resposta(
    { ...estadoBase({ ...c.f, etapa: "candidatos" }, c.pedido, c.ctx), etapa: "candidatos", candidatos: itens.map((x) => x.id) },
    `Achei mais de um trecho que pode ser esse. Qual deles?\n\n${lista}\n\nResponda com o número do trecho (ou NÃO para parar).`,
    "texto_candidatos");
}

// ─── Entrada ──────────────────────────────────────────────────────────────────

export interface EntradaDaCorrecao {
  alvo: Alvo;
  id: string;
  rotulo?: string;
  /** O que o corretor pediu (a mensagem que abriu o fluxo). */
  pedido: string;
}

/** Valida o tamanho do pedido (3 a 500, a regra do servidor) antes de gastar uma chamada. */
function pedidoValido(pedido: string): string | null {
  const t = pedido.trim();
  if (t.length < PEDIDO_MIN) return TEXTO_PEDIDO_CURTO;
  if (t.length > PEDIDO_MAX) return TEXTO_PEDIDO_LONGO;
  return null;
}

export async function iniciarCorrecaoTexto(ctx: ContextoDoTurno, deps: DepsDoFluxo, e: EntradaDaCorrecao): Promise<PassoDoFluxo> {
  const bloqueio = gate(ctx);
  if (bloqueio) return bloqueio;
  const invalido = pedidoValido(e.pedido);
  if (invalido) return resposta(null, invalido, "texto_pedido_invalido");
  const f: FluxoCorrecaoTexto = { kind: "correcao_texto", alvo: e.alvo, id: e.id, rotulo: e.rotulo, etapa: "sugestao", atualizadoEm: ctx.agora };
  return sugerir({ f, pedido: e.pedido.trim(), chave: ctx.messageId, ctx, deps });
}

// ─── Turno dentro do fluxo ────────────────────────────────────────────────────

const LER_UM = /^(1|aplicar?|aplica ai|aplica a correcao)$/;
const LER_DOIS = /^(2|ajustar?|ajusta)$/;
const LER_TRES = /^(3|ver|ver no documento|ver documento)$/;

/** Número de 1 a 3 da escolha de trecho ("2", "o 2", "a segunda"). */
function lerNumero(texto: string, max: number): number | null {
  const t = normalizar(texto).replace(/^(opcao|numero|o|a|n)\s+/, "");
  const m = /^(\d)$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= max ? n : null;
  }
  const ord: Record<string, number> = { primeiro: 1, primeira: 1, segundo: 2, segunda: 2, terceiro: 3, terceira: 3 };
  const o = ord[t];
  return o && o <= max ? o : null;
}

export async function conduzirCorrecaoTexto(f: FluxoCorrecaoTexto, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const bloqueio = gate(ctx);
  if (bloqueio) return bloqueio;
  const agora = ctx.agora;
  const texto = ctx.texto;
  const confirmacao = lerConfirmacao(texto);
  const t = normalizar(texto);

  // Escrita incerta (apply sem resposta): só o SIM repete, com a MESMA chave.
  if (f.chave) {
    if (confirmacao === "nao" || querCancelar(texto)) {
      return resposta(null, "Parei por aqui. A correção anterior pode ter sido aplicada — confira o documento no sistema.", "texto_cancelado_incerto");
    }
    if (confirmacao === "sim" || LER_UM.test(t)) return aplicar(f, ctx, deps, f.chave.valor);
    return resposta(f, "Antes de seguir, preciso conferir o último pedido: responda *SIM* (não duplica) ou *NÃO* para parar.", "texto_escrita_em_aberto");
  }

  if (confirmacao === "nao" || querCancelar(texto)) return resposta(null, TEXTO_PARADO, "texto_cancelado");

  switch (f.etapa) {
    case "sugestao": {
      if (f.expiraEm !== undefined && agora > f.expiraEm && (confirmacao === "sim" || LER_UM.test(t))) {
        // A sugestão venceu: nunca aplica; refaz e pede SIM de novo (R28).
        return refazer(f, ctx, deps, "Essa sugestão venceu (passou de 30 minutos). ");
      }
      if (confirmacao === "sim" || LER_UM.test(t)) return aplicar(f, ctx, deps, ctx.messageId);
      if (LER_DOIS.test(t)) {
        return resposta({ ...f, etapa: "ajustar", atualizadoEm: agora, sugestaoId: undefined, hashParagrafo: undefined, expiraEm: undefined },
          "Certo. Diga o que você quer diferente nesse trecho, do jeito que preferir (por exemplo: \"coloca 12% em vez de 10%\").", "texto_ajustar");
      }
      if (LER_TRES.test(t)) {
        return resposta({ ...f, atualizadoEm: agora },
          f.link ? `Veja o documento aqui: ${f.link}\n\n${menuDaSugestao(true)}` : "Abra pela tela do sistema para ver o documento. Ainda não mudei nada.",
          "texto_ver_documento");
      }
      // "ok", "blz", "pode": não autorizam escrita (R31).
      if (confirmacao === "vago") return resposta({ ...f, atualizadoEm: agora }, TEXTO_PARA_APLICAR, "texto_confirmar");
      return { liberar: true, fluxo: null, evento: "texto_fora_do_fluxo" };
    }
    case "oferta_documento": {
      if (confirmacao === "sim") {
        const pedido = abrir(f, ctx);
        if (!pedido) {
          return resposta({ ...f, etapa: "ajustar", criarDocumento: true, atualizadoEm: agora },
            "Certo, vou criar o documento. Me diga de novo o que mudar no texto.", "texto_pedir_de_novo");
        }
        return sugerir({ f: { ...f, criarDocumento: true }, pedido, chave: ctx.messageId, ctx, deps, paragrafoId: f.paragrafoId });
      }
      if (confirmacao === "vago") return resposta({ ...f, atualizadoEm: agora }, "Para criar o documento da proposta e seguir, responda *SIM*. Para parar, *NÃO*.", "texto_confirmar");
      return { liberar: true, fluxo: null, evento: "texto_fora_do_fluxo" };
    }
    case "candidatos": {
      const n = lerNumero(texto, f.candidatos?.length ?? 0);
      if (n === null) {
        // Texto que não é número: pode ser a pessoa citando o trecho. Só números escolhem; o resto sai do fluxo.
        return { liberar: true, fluxo: null, evento: "texto_fora_do_fluxo" };
      }
      const paragrafoId = f.candidatos![n - 1]!;
      const pedido = abrir(f, ctx);
      if (!pedido) {
        return resposta({ ...f, etapa: "ajustar", paragrafoId, candidatos: undefined, atualizadoEm: agora },
          "Certo, esse trecho. Me diga de novo o que mudar nele.", "texto_pedir_de_novo");
      }
      return sugerir({ f: { ...f, candidatos: undefined }, pedido, chave: ctx.messageId, ctx, deps, paragrafoId });
    }
    case "citar": {
      const citacao = texto.trim();
      const original = abrir(f, ctx);
      const combinado = original ? `${original} (trecho: ${citacao})` : citacao;
      const pedido = combinado.length > PEDIDO_MAX ? citacao : combinado;
      const invalido = pedidoValido(pedido);
      if (invalido) return resposta({ ...f, atualizadoEm: agora }, invalido, "texto_pedido_invalido");
      return sugerir({ f, pedido, chave: ctx.messageId, ctx, deps });
    }
    case "ajustar": {
      const invalido = pedidoValido(texto);
      if (invalido) return resposta({ ...f, atualizadoEm: agora }, invalido, "texto_pedido_invalido");
      // R31: pedido novo, MESMO paragrafo_id.
      return sugerir({ f, pedido: texto.trim(), chave: ctx.messageId, ctx, deps, paragrafoId: f.paragrafoId });
    }
  }
}

async function aplicar(f: FluxoCorrecaoTexto, ctx: ContextoDoTurno, deps: DepsDoFluxo, chave: string): Promise<PassoDoFluxo> {
  if (!f.sugestaoId || !f.hashParagrafo) return resposta(null, TEXTO_RESPOSTA_ESTRANHA, "texto_resposta_estranha");
  const r = await aplicarTexto(deps, f.alvo, f.id, { sugestaoId: f.sugestaoId, hashParagrafo: f.hashParagrafo }, chave);
  if (!r) {
    // Escrita incerta: guarda a chave; o SIM seguinte repete (não duplica).
    return resposta({ ...f, chave: { verbo: verbo(f.alvo, "apply"), valor: chave }, etapa: "sugestao", atualizadoEm: ctx.agora }, TEXTO_ESCRITA_INCERTA, "texto_incerta");
  }
  if (ehFluxoDesligado(r)) return { liberar: true, fluxo: null, evento: "texto_fluxo_desligado" };
  const body = r.body ?? {};
  const erro = str(body.error);

  if (r.status === 200 && body.aplicado === true) {
    const avisos = Array.isArray(body.avisos) ? body.avisos.filter((a): a is string => typeof a === "string" && a.length > 0) : [];
    return resposta(null,
      `Pronto, apliquei a correção ${DA(f.alvo)}.` + (avisos.length ? `\n\nAtenção:\n${avisos.map((a) => `- ${a}`).join("\n")}` : ""),
      avisos.length ? "texto_aplicado_com_avisos" : "texto_aplicado");
  }
  if (r.status === 200) return resposta(null, TEXTO_RESPOSTA_ESTRANHA, "texto_resposta_estranha");

  if (r.status === 409 && (erro === "paragrafo_mudou" || erro === "sugestao_expirada")) {
    return refazer(f, ctx, deps, erro === "paragrafo_mudou"
      ? "O parágrafo mudou depois da sugestão (alguém editou o documento). Não apliquei nada. "
      : "Essa sugestão venceu. Não apliquei nada. ");
  }
  if (r.status === 409 && erro === "sugestao_ja_aplicada") return resposta(null, TEXTO_JA_APLICADA, "texto_ja_aplicada");
  if (r.status === 409 && erro === "estado_mudou") return resposta(null, TEXTO_ESTADO_MUDOU, "texto_estado_mudou");
  if (r.status === 404 && erro === "sugestao_nao_encontrada") return resposta(null, "Não encontrei essa sugestão (ela pode ter vencido). Nada foi alterado; peça a correção de novo.", "texto_sugestao_nao_encontrada");

  const comum = erroDeEstado(f.alvo, r);
  if (comum) return comum;
  if (r.status === 502) {
    // O servidor soltou a sugestão: o SIM seguinte tenta de novo, com chave nova (sem retentativa automática).
    return resposta({ ...f, atualizadoEm: ctx.agora }, `${TEXTO_GOOGLE} A correção continua valendo por pouco tempo: responda *SIM* para tentar de novo.`, "texto_documento_indisponivel");
  }
  if (r.status === 403) return resposta(null, TEXTO_TEXTO_SEM_PERMISSAO(), "texto_sem_permissao");
  if (r.status === 404) return resposta(null, TEXTO_NAO_ACHADO, "texto_nao_achado");
  return resposta(null, `Não consegui aplicar a correção (${r.status}). Confira o documento: nada foi confirmado.`, `texto_apply_${r.status}`);
}

/**
 * `paragrafo_mudou`/`sugestao_expirada`: refaz o suggest com chave NOVA (`${messageId}:r`) e mostra
 * o antes/depois NOVO, pedindo SIM de novo (R28). Sem o pedido (sem selo), pede ao corretor repetir.
 */
async function refazer(f: FluxoCorrecaoTexto, ctx: ContextoDoTurno, deps: DepsDoFluxo, prefixo: string): Promise<PassoDoFluxo> {
  const pedido = abrir(f, ctx);
  if (!pedido) {
    return resposta({ ...f, etapa: "ajustar", sugestaoId: undefined, hashParagrafo: undefined, expiraEm: undefined, chave: undefined, atualizadoEm: ctx.agora },
      `${prefixo}Me diga de novo o que mudar nesse trecho e eu refaço.`, "texto_pedir_de_novo");
  }
  return sugerir({ f: { ...f, chave: undefined }, pedido, chave: `${ctx.messageId}:r`, ctx, deps, paragrafoId: f.paragrafoId,
    prefixo: `${prefixo}Refiz com o texto atual. ` });
}

/** O fluxo rebaixado: só a escrita incerta sobrevive a uma interrupção (o resto pede de novo). */
export function rebaixarCorrecaoTexto(f: FluxoCorrecaoTexto): FluxoCorrecaoTexto | null {
  return f.chave ? f : null;
}
