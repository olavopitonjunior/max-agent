import { nomeDoAgente } from "@/lib/deploy-profile";
import type { ContextoDoTurno, DepsDoFluxo, Fluxo, PassoDoFluxo } from "./fluxos";
import { termoDaEdicao, pedeGestao } from "./gestao";
import { buscarPropostas, codigoCitado, pedeBusca, pedeLista, rotuloDaProposta, termoDaResposta, termoDeBusca, type CanalDeAssinatura, type PropostaListada } from "./localizar";
import { lerConfirmacao, normalizar } from "./tools";
import { negaAcao } from "./capacidades";

/**
 * Lembrar quem falta assinar e cancelar a assinatura de uma proposta pelo
 * WhatsApp (Passo 4, 25/10/2026; servidor: docs/max.md §18.7 do contractmaker).
 *
 * Mesmo desenho da gestão (`gestao.ts`): localizar → MOSTRAR OS SIGNATÁRIOS
 * (nome, situação, canal) → SIM → o verbo do servidor, com a `messageId` do SIM
 * como chave, guardada até o resultado ser conhecido. Quem decide se pode é o
 * servidor (política do Max + RBAC `PROPOSAL_RESEND`/`PROPOSAL_CANCEL` + "proposta
 * do usuário" + estado); o Max só traduz o código de recusa em frase fixa e
 * NUNCA afirma que algo aconteceu sem o 200.
 */

/** "trocar" é só leitura: orienta o caminho de trocar signatário DEPOIS do envio (Passo 4c, 26/10). */
type Operacao = "lembrar" | "cancelar" | "trocar";
type OperacaoDeEscrita = Exclude<Operacao, "trocar">;
interface AssinaturaDoAlvo { nome: string; status: string; canal?: CanalDeAssinatura }
interface Alvo { id: string; codigo: string; titulo?: string; estado?: string; status?: string; nomes?: string[]; assinaturas?: AssinaturaDoAlvo[] }

export interface FluxoAssinatura {
  kind: "assinatura";
  operacao: Operacao;
  /** `resumo` = o resumo foi interrompido: o próximo SIM só o reapresenta (nunca escreve). */
  etapa: "selecao" | "motivo" | "resumo" | "confirmacao" | "concluida";
  alvo?: Alvo;
  candidatos?: Alvo[];
  /** O que a pessoa digitou para achar a proposta. */
  termo?: string;
  /** Cancelar: o motivo (3–500), vai no histórico da proposta. */
  motivo?: string;
  chave?: { verbo: string; valor: string };
  atualizadoEm: number;
}
type Resposta = Extract<PassoDoFluxo, { reply: string }>;

const VERBO: Record<OperacaoDeEscrita, string> = { lembrar: "proposal.remind", cancelar: "proposal.cancel" };
/** Estados em que o servidor aceita lembrar (REMINDABLE_STATUSES do ImobPro). */
const LEMBRAVEIS = new Set(["enviada", "entregue", "visualizada", "assinada_proponente", "aguardando_vendedor"]);
/** Estados em que o servidor aceita cancelar (CANCELLABLE_STATUSES, apps/web/src/lib/proposals/status-sets.ts). */
const CANCELAVEIS = new Set(["rascunho", "aguardando_aprovacao", "enviada", "entregue", "visualizada", "assinada_proponente", "aguardando_vendedor", "falha_envio"]);
/** Cancelar estes não mexe na ClickSign: ainda não há assinatura em andamento. */
const SEM_ASSINATURA_VIVA = new Set(["rascunho", "aguardando_aprovacao", "falha_envio"]);
const UTEIS: Record<OperacaoDeEscrita, Set<string>> = { lembrar: LEMBRAVEIS, cancelar: CANCELAVEIS };

const MOTIVO_MIN = 3;
const MOTIVO_MAX = 500;
const PEDE_SIM = "Responda SIM para confirmar ou NÃO para parar.";
const INCERTO = "Ainda não confirmei o resultado. Responda SIM para verificar o mesmo pedido, sem repeti-lo.";

// ─── Detecção ───────────────────────────────────────────────────────────────

const PREF = String.raw`^(?:(?:pode|poderia|consegue|quero|preciso|por favor|favor|pf|pfv)[\s,]+)*(?:que\s+(?:voce\s+|vc\s+)?)?`;
const ARTIGO = String.raw`(?:(?:a|essa|esta|aquela|minha|uma)\s+)?`;
/** "a proposta", "a assinatura da proposta", "PROP-…": o alvo é uma proposta, nunca um contrato. */
const ALVO = ARTIGO + String.raw`(?:assinatura\s+(?:d[ae]\s+)?(?:(?:a|essa|esta|aquela|minha)\s+)?)?(?:proposta\b|prop-\d)`;
const CANCELAR = new RegExp(PREF + String.raw`cancel(?:a|ar|e)\s+` + ALVO);
/** "lembra quem falta assinar a proposta…", "cobra a assinatura da proposta…" — com palavra de assinatura, e nunca "lembra de/que…". */
const LEMBRAR_VERBO = new RegExp(PREF + String.raw`(?:lembr|cobr)(?:a|ar|e)\s+(?!(?:de|que|pra|para|me|a gente)\b)([^.?!]{0,60}?\b(?:proposta\b|prop-\d))`);
const PALAVRA_DE_ASSINATURA = /\b(?:quem|assin\w*|signat\w*|pendente\w*|lembrete|falta\w*)\b/;
/** "manda/reenvia um lembrete da proposta…". */
const LEMBRAR_LEMBRETE = new RegExp(PREF + String.raw`(?:mand|envi|reenvi|dispar)(?:a|ar|e|o)\s+(?:um\s+|o\s+|outro\s+|novo\s+)*lembrete\b[^.?!]{0,60}?\b(?:proposta\b|prop-\d)`);
/** Negar a AÇÃO ("não cancela", "nunca lembra"), e não qualquer "não" da frase ("lembra quem não assinou"). */
const NEGA_O_VERBO = /\b(?:nao|nunca|jamais)\s+(?:precisa\s+|quero\s+que\s+(?:voce\s+|vc\s+)?|vai\s+|pode\s+|deve\s+)?(?:cancel|lembr|cobr|mand|envi|reenvi)/;
/** Estados em que a assinatura já foi enviada: o contato de quem assina não muda mais no mesmo envio. */
const POS_ENVIO = new Set(["enviada", "entregue", "visualizada", "assinada_proponente", "aguardando_vendedor"]);
/** Antes do envio o contato se corrige pelo caminho normal (edição da proposta, `proposal.update`). */
const PRE_ENVIO = new Set(["rascunho", "aguardando_aprovacao", "falha_envio"]);

// Trocar o contato de quem assina (Passo 4c): só a ORIENTAÇÃO; a edição antes do envio é da gestão.
const VERBO_TROCA = String.raw`(?:troc|alter|mud|corrig|corrij|atualiz|edit|substitu)\w*`;
const CONTATO = String.raw`(?:e-?mail|telefone|celular|whatsapp|zap|numero|canal|contato|assinante|signatario)s?`;
const PEDE_OU_PERGUNTA = String.raw`^(?:(?:pode|poderia|consegue|quero|preciso|por favor|favor|pf|pfv)[\s,]+)*` +
  String.raw`(?:(?:da|dah)\s+(?:pra|para)(?:\s+(?:voce|vc))?\s+|tem\s+como\s+|como\s+(?:eu\s+)?(?:(?:faco|posso)\s+(?:pra|para)\s+)?|posso\s+)?`;
const TROCAR_VERBO = new RegExp(PEDE_OU_PERGUNTA + String.raw`(?:que\s+(?:voce\s+|vc\s+)?)?${VERBO_TROCA}\b[^.?!]{0,80}?\b${CONTATO}\b[^.?!]{0,100}?\b(?:proposta\b|prop-\d)`);
const TROCAR_NA_PROPOSTA = new RegExp(String.raw`^(?:n|d)?a\s+(?:proposta\b|prop-\d)[^.?!]{0,60}?[,:;]?\s*${VERBO_TROCA}\b[^.?!]{0,80}?\b${CONTATO}\b`);
/** Frase com "?" só é pedido de orientação com a forma de pergunta ("dá pra…?", "tem como…?", "como troco…?"). */
const FORMA_DE_PERGUNTA = /^(?:(?:pode|poderia|consegue|posso)\b|(?:da|dah)\s+(?:pra|para)\b|tem\s+como\b|como\s+(?:eu\s+)?(?:troc|alter|mud|corrig|corrij|atualiz|edit|substitu|faco|posso))/;
/** Negar a troca ("não troca o e-mail") — só vale para este ramo, para não derrubar "o cliente não mudou de ideia" no cancelar. */
const NEGA_A_TROCA = /\b(?:nao|nunca|jamais)\s+(?:precisa\s+|quero\s+que\s+(?:voce\s+|vc\s+)?|vai\s+|pode\s+|deve\s+)?(?:troc|alter|mud|corrig|corrij|atualiz|edit|substitu)/;

const MARCA_DE_MOTIVO = /(?:\bporque|\bpor que|\bpois\b|\bmotivo|\bdevido\b|\bj[aá] que\b|:)/i;
const EXTRAI_MOTIVO = /(?:\bporque|\bpor que|\bpois\b|\bmotivo(?:\s+(?:e|é|foi))?|\bdevido\s+(?:a|ao|à|aos|às)\b|\bj[aá] que\b)\s*:?\s*(.+)$/is;

/** A frase sem a justificativa: nome/código a achar saem daqui, nunca do "porque…". */
function cabecaDe(texto: string): string {
  // "Max: cancela…" — o vocativo com dois-pontos não é a marca do motivo.
  const sem = texto.replace(/^\s*max\b[\s,:-]*/i, "");
  const i = sem.search(MARCA_DE_MOTIVO);
  return (i > 0 ? sem.slice(0, i) : sem).trim();
}

/** O pedido é trocar o contato de quem assina uma proposta citada (inclui a pergunta "dá pra…?")? */
export function pedeTrocaDeSignatario(texto: string): boolean {
  const t = normalizar(cabecaDe(texto)).replace(/^max\b[\s,:-]*/, "").trim();
  if (!t || NEGA_O_VERBO.test(t) || NEGA_A_TROCA.test(t)) return false;
  if (/\?\s*$/.test(texto.trim()) && !FORMA_DE_PERGUNTA.test(t)) return false;
  return TROCAR_VERBO.test(t) || TROCAR_NA_PROPOSTA.test(t);
}

/** O pedido é lembrar, cancelar ou (orientar a) trocar signatário numa proposta citada? Pergunta e negação não contam. */
export function pedeAssinatura(texto: string): Operacao | null {
  const t = normalizar(cabecaDe(texto)).replace(/^max\b[\s,:-]*/, "").trim();
  if (!t || NEGA_O_VERBO.test(t)) return null;
  // "Pode cancelar…?" é pedido; qualquer outra frase com "?" é pergunta (cancelar/lembrar).
  const pergunta = /\?\s*$/.test(texto.trim()) && !/^(pode|poderia|consegue)\b/.test(t);
  if (!pergunta) {
    if (CANCELAR.test(t)) return "cancelar";
    const l = LEMBRAR_VERBO.exec(t);
    if (l && PALAVRA_DE_ASSINATURA.test(l[1]!)) return "lembrar";
    if (LEMBRAR_LEMBRETE.test(t)) return "lembrar";
  }
  // Cancelar e lembrar têm prioridade. Trocar tem a sua própria regra de pergunta ("dá pra mudar…?" é pedido de orientação).
  return pedeTrocaDeSignatario(texto) ? "trocar" : null;
}

/** O motivo dito na frase do pedido ("…porque o cliente desistiu"), se couber em 3–500. */
export function motivoDaFrase(texto: string): string | null {
  const m = EXTRAI_MOTIVO.exec(texto);
  return m ? motivoValido(m[1]!) : null;
}
function motivoValido(bruto: string): string | null {
  const m = bruto.replace(/\s+/g, " ").replace(/[.!\s]+$/, "").trim();
  return m.length >= MOTIVO_MIN && m.length <= MOTIVO_MAX ? m : null;
}

/** Quem a pessoa citou: o código, ou o trecho depois de "proposta" na parte do pedido (sem a justificativa). */
function termoDoPedido(texto: string): string | null {
  return termoDaEdicao(cabecaDe(texto));
}

// ─── Texto ──────────────────────────────────────────────────────────────────

function resposta(f: Fluxo | null, reply: string, evento = "assinatura"): Resposta {
  return { fluxo: f, reply, evento };
}
function permitido(ctx: ContextoDoTurno): boolean {
  return !ctx.politicaIndisponivel && ctx.policy.includes("proposal.list") && ctx.policy.includes("proposal.send");
}
function alvoDe(p: PropostaListada): Alvo {
  return {
    id: p.id, codigo: p.codigo, titulo: p.titulo, estado: p.estado, status: p.status,
    nomes: p.nomes.length ? p.nomes : undefined, assinaturas: p.assinaturas?.length ? p.assinaturas : undefined,
  };
}
/** O pedido não é deste fluxo: o turno segue o atendimento normal, como se a detecção não tivesse disparado. */
const naoEComigo = (evento: string): PassoDoFluxo => ({ liberar: true, fluxo: null, evento });
const verbo = (op: OperacaoDeEscrita) => (op === "lembrar" ? "lembrar" : "cancelar");

const CANAL: Record<CanalDeAssinatura, string> = { email: "e-mail", whatsapp: "WhatsApp", sms: "SMS" };
const SITUACAO: Record<string, string> = { assinou: "assinou", pendente: "pendente", recusou: "recusou" };
const situacao = (s: string) => SITUACAO[s] ?? s;
const linhaDe = (a: AssinaturaDoAlvo) => `• ${a.nome} — ${situacao(a.status)}${a.canal ? ` — ${CANAL[a.canal]}` : ""}`;
const lista = (nomes: string[]) => (nomes.length <= 1 ? nomes.join("") : `${nomes.slice(0, -1).join(", ")} e ${nomes[nomes.length - 1]}`);
/** Texto do servidor (motivo de pulo, nome) entra em UMA linha e com teto: é dado, não instrução. */
const umaLinha = (s: string, max = 120) => s.replace(/\s+/g, " ").trim().slice(0, max);
const nomeDe = (alvo: Alvo) => `${alvo.codigo}${alvo.titulo ? ` (${alvo.titulo})` : ""}`;

/**
 * O resumo SEMPRE mostra quem assina. Lembrar sem ninguém pendente na projeção
 * não abre SIM (o servidor é a palavra final, mas um SIM inútil não se pede);
 * lista vazia não impede: pode ser projeção de servidor antigo.
 */
function resumo(f: FluxoAssinatura): Resposta {
  const alvo = f.alvo!;
  const todos = alvo.assinaturas ?? [];
  const pendentes = todos.filter((a) => a.status !== "assinou" && a.status !== "recusou");
  const assinaram = todos.filter((a) => a.status === "assinou").map((a) => a.nome);
  const recusaram = todos.filter((a) => a.status === "recusou").map((a) => a.nome);
  const rotulo = nomeDe(alvo);

  if (f.operacao === "lembrar") {
    if (todos.length && !pendentes.length) {
      const motivo = assinaram.length === todos.length
        ? `Todos já assinaram a proposta ${alvo.codigo}; não há a quem lembrar.`
        : `Não há ninguém pendente na proposta ${alvo.codigo} (${[assinaram.length ? `assinaram: ${lista(assinaram)}` : "", recusaram.length ? `recusaram: ${lista(recusaram)}` : ""].filter(Boolean).join("; ")}); não há a quem lembrar.`;
      return resposta(null, motivo, "assinatura_ninguem_pendente");
    }
    const quem = todos.length ? pendentes.map(linhaDe).join("\n") : "(sem signatários listados)";
    const ja = assinaram.length ? `\nJá assinaram: ${lista(assinaram)}.` : "";
    const rec = recusaram.length ? `\nRecusaram: ${lista(recusaram)}.` : "";
    return resposta({ ...f, etapa: "confirmacao" },
      `Lembrar a assinatura da proposta ${rotulo}?\nVai para quem ainda não assinou, pelo canal de cada um:\n${quem}${ja}${rec}\n\n${PEDE_SIM}`);
  }

  const viva = !SEM_ASSINATURA_VIVA.has(alvo.status ?? "");
  const aviso = viva ? " A assinatura em andamento será cancelada na ClickSign e ninguém mais conseguirá assinar." : "";
  const signatarios = todos.length || viva
    ? `\nSignatários:\n${todos.length ? todos.map(linhaDe).join("\n") : "(sem signatários listados)"}`
    : "";
  return resposta({ ...f, etapa: "confirmacao" },
    `Cancelar a proposta ${rotulo}?${aviso} Motivo: ${f.motivo}.${signatarios}\n\n${PEDE_SIM}`);
}

/** Achou a proposta: cancelar ainda precisa do motivo; o resto vai direto ao resumo. */
function seguirComAlvo(f: FluxoAssinatura, alvo: Alvo, aviso = ""): Resposta {
  const com: FluxoAssinatura = { ...f, alvo, candidatos: undefined };
  if (f.operacao === "cancelar" && !f.motivo) {
    return resposta({ ...com, etapa: "motivo" },
      `${aviso}Cancelar a proposta ${nomeDe(alvo)}.\nQual o motivo do cancelamento? (vai no histórico da proposta)`, "assinatura_pede_motivo");
  }
  const r = resumo(com);
  return aviso && r.fluxo ? { ...r, reply: `${aviso}${r.reply}` } : r;
}

// ─── Início ─────────────────────────────────────────────────────────────────

export function iniciarAssinatura(op: OperacaoDeEscrita, ctx: ContextoDoTurno, deps: DepsDoFluxo, termoDado?: string | null, motivoDado?: string): Promise<Resposta>;
/** `trocar` pode devolver `liberar` (pré-envio: o pedido segue o caminho normal). */
export function iniciarAssinatura(op: Operacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, termoDado?: string | null, motivoDado?: string): Promise<PassoDoFluxo>;
export async function iniciarAssinatura(
  op: Operacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, termoDado?: string | null, motivoDado?: string
): Promise<PassoDoFluxo> {
  const f: FluxoAssinatura = { kind: "assinatura", operacao: op, etapa: "selecao", atualizadoEm: ctx.agora };
  // Trocar não escreve nada e não tem recusa própria: sem a política de enviar, o pedido segue o caminho normal
  // (que decide com a política dele), sem nenhuma leitura daqui.
  if (op === "trocar") return permitido(ctx) ? iniciarTroca(ctx, deps, termoDado, false) : naoEComigo("assinatura_troca_sem_politica");
  if (!permitido(ctx)) {
    return resposta(null, ctx.politicaIndisponivel
      ? "Não consegui validar sua permissão agora. Nada foi alterado; tente de novo em instantes."
      : `${op === "lembrar" ? "Lembrar a assinatura de" : "Cancelar"} proposta pelo ${nomeDoAgente()} não está liberado para você. Faça pela tela de propostas do sistema.`,
    "assinatura_sem_politica");
  }
  if (op === "cancelar") {
    const motivo = motivoDado ?? motivoDaFrase(ctx.texto);
    if (motivo) f.motivo = motivo;
  }
  const termo = termoDado !== undefined ? termoDado : termoDoPedido(ctx.texto);
  // A busca lê a parte do pedido SEM a justificativa: "porque a Ana desistiu" não cita a proposta da Ana.
  const r = await buscarPropostas(deps, cabecaDe(ctx.texto), termo);
  if (!r) return resposta(null, "Não consegui consultar suas propostas agora. Nada foi alterado; tente de novo em instantes.", "assinatura_sem_resposta");
  if (r.termo) f.termo = r.termo;
  if (!r.itens.length) {
    return resposta(f, r.termo
      ? `Não achei proposta sua com "${r.termo}". Me diga o nome de outra pessoa da proposta, o endereço ou o código.`
      : `Qual proposta devo ${verbo(op)}? Me diga o nome do cliente, o endereço ou o código.`);
  }
  const uteis = r.itens.filter((p) => UTEIS[op].has(p.status));
  if (!uteis.length) {
    const onde = r.termo ? ` com "${r.termo}"` : " sua recente";
    const quadro = op === "lembrar"
      ? `Nenhuma proposta${onde} tem assinatura em andamento para lembrar`
      : `Nenhuma proposta${onde} pode ser cancelada agora`;
    const mais = r.total > r.itens.length ? "\n(Há mais propostas; me diga o nome ou o código.)" : "";
    return resposta(null, `${quadro}:\n${r.itens.slice(0, 5).map((p) => `• ${rotuloDaProposta(p)}`).join("\n")}${mais}`, "assinatura_nada_util");
  }
  // Uma só entre todas que casam: resumo. Sem termo, nunca assumir a mais recente.
  if (r.termo && r.total <= r.itens.length) {
    if (uteis.length === 1 && r.itens.length === 1) return seguirComAlvo(f, alvoDe(uteis[0]!));
    if (uteis.length === 1) {
      // As outras que casam ficam ditas: a pessoa pode ter falado de outra.
      const aviso = `Achei ${r.itens.length} propostas com "${r.termo}"; só a ${uteis[0]!.codigo} está em estado de ${op === "lembrar" ? "receber lembrete" : "ser cancelada"}.\n`;
      return seguirComAlvo(f, alvoDe(uteis[0]!), aviso);
    }
  }
  const candidatos = uteis.slice(0, 5).map(alvoDe);
  const cabeca = r.termo ? `Achei mais de uma proposta com "${r.termo}". Qual devo ${verbo(op)}?` : `Qual proposta devo ${verbo(op)}?`;
  const resto = r.total > candidatos.length ? `\n(${r.total} no total; se não estiver aqui, me diga o nome ou o código.)` : "";
  return resposta({ ...f, candidatos },
    `${cabeca}\n${candidatos.map((p, i) => `${i + 1}. ${rotuloDaProposta(p)}`).join("\n")}${resto}\n\nResponda com o número.`);
}

// ─── Trocar o contato de quem assina (Passo 4c, 26/10/2026) ─────────────────
//
// SÓ LEITURA, nenhum verbo novo. Depois do envio ninguém troca o signatário no mesmo
// envio (nem a tela): o caminho real é "Cancelar envelope" (a proposta volta para
// `falha_envio`, editável, NÃO é cancelada) → corrigir o contato → enviar de novo.
// Antes do envio o contato se troca pela edição da proposta (gestão, `proposal.update`):
// aqui o pedido só "cai fora". NUNCA oferecer `proposal.cancel`: cancelaria a proposta.

/** Estados terminais: não há mais assinatura a corrigir. */
const TERMINAIS = new Set(["convertida", "recusada_proponente", "recusada_vendedor", "expirada", "cancelada", "completa"]);

function estadoDe(alvo: Alvo): string {
  return umaLinha(alvo.estado ?? "", 60).toLowerCase() || (alvo.status ?? "").replace(/_/g, " ") || "num estado que não permite";
}

/**
 * Decide pelo status do alvo. `escolhida` = a pessoa já apontou esta proposta (número da lista ou
 * resposta à pergunta): pré-envio ganha frase própria; no 1º turno pré-envio é `null` (não é comigo).
 */
function respostaDaTroca(alvo: Alvo, escolhida: boolean): Resposta | null {
  const status = alvo.status ?? "";
  const rotulo = nomeDe(alvo);
  if (POS_ENVIO.has(status)) {
    const signatarios = alvo.assinaturas?.length ? `\nSignatários:\n${alvo.assinaturas.map(linhaDe).join("\n")}` : "";
    return resposta(null,
      `A proposta ${rotulo} já foi enviada para assinatura. Depois do envio não dá para trocar o contato de quem assina no mesmo envio, nem pela tela.\n` +
      "O caminho:\n" +
      '1. Na tela da proposta, use "Cancelar envelope". A proposta volta para edição; ela não é cancelada.\n' +
      "2. Me diga o contato certo que eu corrijo.\n" +
      `3. Peça para eu enviar de novo.${signatarios}`,
      "assinatura_troca_pos_envio");
  }
  if (PRE_ENVIO.has(status)) {
    return escolhida
      ? resposta(null, `A proposta ${rotulo} ainda não foi enviada: dá para corrigir o contato agora. Me diga o dado novo (por exemplo: troca o e-mail da Ana na proposta ${alvo.codigo} para ana@exemplo.com).`, "assinatura_troca_pre_envio")
      : null;
  }
  if (TERMINAIS.has(status)) {
    return resposta(null, `A proposta ${rotulo} está ${estadoDe(alvo)}; não há assinatura em andamento para corrigir.`, "assinatura_troca_terminal");
  }
  // Estado que este Max não conhece (servidor mais novo): não afirma nada sobre ele.
  return escolhida
    ? resposta(null, `A proposta ${rotulo} está ${estadoDe(alvo)}. Confira na tela de propostas se ainda dá para corrigir o contato.`, "assinatura_troca_estado_desconhecido")
    : null;
}

/**
 * `retomando` = a pessoa está respondendo a uma lista/pergunta deste fluxo: aí não dá para
 * "cair fora" em silêncio (a resposta dela seria solta de contexto), então tudo tem frase.
 */
async function iniciarTroca(ctx: ContextoDoTurno, deps: DepsDoFluxo, termoDado: string | null | undefined, retomando: boolean): Promise<PassoDoFluxo> {
  const f: FluxoAssinatura = { kind: "assinatura", operacao: "trocar", etapa: "selecao", atualizadoEm: ctx.agora };
  const termo = termoDado !== undefined ? termoDado : termoDoPedido(ctx.texto);
  const r = await buscarPropostas(deps, cabecaDe(ctx.texto), termo);
  if (!r) {
    return retomando
      ? resposta(null, "Não consegui consultar suas propostas agora. Nada foi alterado; tente de novo em instantes.", "assinatura_sem_resposta")
      : naoEComigo("assinatura_troca_sem_leitura");
  }
  if (r.termo) f.termo = r.termo;
  if (!r.itens.length) {
    return retomando
      ? resposta(f, r.termo
        ? `Não achei proposta sua com "${r.termo}". Me diga o nome de outra pessoa da proposta, o endereço ou o código.`
        : "Qual proposta tem o contato a trocar? Me diga o nome do cliente, o endereço ou o código.")
      : naoEComigo("assinatura_troca_sem_proposta");
  }
  // Uma só entre todas que casam: decide pelo status dela. Sem termo, nunca assumir a mais recente.
  if (r.termo && r.total <= r.itens.length && r.itens.length === 1) {
    return respostaDaTroca(alvoDe(r.itens[0]!), retomando) ?? naoEComigo("assinatura_troca_pre_envio_normal");
  }
  // Nenhuma já enviada entre as achadas: nada a orientar aqui, o pedido segue o caminho normal.
  if (!retomando && !r.itens.some((p) => POS_ENVIO.has(p.status))) return naoEComigo("assinatura_troca_sem_pos_envio");
  const candidatos = r.itens.slice(0, 5).map(alvoDe);
  const cabeca = r.termo ? `Achei mais de uma proposta com "${r.termo}". Em qual delas está o contato a trocar?` : "Em qual proposta está o contato a trocar?";
  const resto = r.total > candidatos.length ? `\n(${r.total} no total; se não estiver aqui, me diga o nome ou o código.)` : "";
  return resposta({ ...f, candidatos },
    `${cabeca}\n${candidatos.map((p, i) => `${i + 1}. ${rotuloDaProposta(p)}`).join("\n")}${resto}\n\nResponda com o número.`);
}

// ─── Recusas do servidor → frase fixa ───────────────────────────────────────

function pulados(body: Record<string, unknown>): { nome: string | null; motivo: string }[] {
  return (Array.isArray(body.pulados) ? body.pulados : [])
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}))
    .filter((x) => typeof x.motivo === "string")
    .map((x) => ({ nome: typeof x.nome === "string" ? umaLinha(x.nome, 80) : null, motivo: umaLinha(x.motivo as string) }));
}
const doPulado = (p: { nome: string | null; motivo: string }) => `${p.nome ?? "um signatário"} (${p.motivo})`;

/** Recusas do servidor → frase fixa. Nada aqui afirma que a operação aconteceu. */
function textoDaRecusa(f: FluxoAssinatura, status: number, body: Record<string, unknown>): string {
  const c = f.alvo!.codigo;
  const erro = String(body.error ?? "");
  const lembrar = f.operacao === "lembrar";
  const nada = lembrar ? "Nada foi enviado." : "Nada foi alterado.";
  if (status === 403 && body.reason === "politica_nao_concede") {
    return `${lembrar ? "Lembrar a assinatura de" : "Cancelar"} proposta pelo ${nomeDoAgente()} não está liberado para você. Faça pela tela de propostas do sistema. ${nada}`;
  }
  if (erro === "MODULE_DISABLED") return `Propostas estão desligadas para a sua imobiliária. ${nada}`;
  if (status === 403) return lembrar
    ? `Sua permissão no sistema não permite lembrar a assinatura da proposta ${c}. ${nada}`
    : `Sua permissão no sistema não permite cancelar a proposta ${c}. ${nada}`;
  if (status === 404) return `Não encontrei a proposta ${c} entre as suas. ${nada}`;
  const estado = typeof body.estado === "string" ? umaLinha(body.estado, 60).toLowerCase() : "num estado que não permite";
  if (lembrar) {
    if (erro === "estado_sem_lembrete") return `A proposta ${c} está ${estado}: não há assinatura em andamento para lembrar. ${nada}`;
    if (erro === "ninguem_pendente") return `Não há ninguém pendente na proposta ${c} para lembrar. ${nada}`;
    if (erro === "aceite_sem_lembrete") return `A proposta ${c} usa o aceite por WhatsApp, que não tem lembrete. ${nada}`;
    if (erro === "lembrete_recusado") {
      const p = pulados(body);
      return p.length
        ? `Não consegui lembrar ninguém na proposta ${c}:\n${p.map((x) => `• ${doPulado(x)}`).join("\n")}\n${nada}`
        : `Não consegui lembrar ninguém na proposta ${c} agora. ${nada}`;
    }
    return `O sistema não confirmou o lembrete da proposta ${c}. ${nada}`;
  }
  if (erro === "estado_nao_cancelavel") return `A proposta ${c} está ${estado} e não pode mais ser cancelada. ${nada}`;
  if (erro === "cancelamento_recusado") {
    return `A ClickSign não confirmou o cancelamento da assinatura da proposta ${c}. Confira o status na tela de propostas antes de tentar de novo.`;
  }
  if (erro === "cancelamento_falhou") {
    return `Não consegui confirmar o cancelamento da proposta ${c}. Confira o status na tela de propostas antes de tentar de novo.`;
  }
  return `O sistema não confirmou o cancelamento da proposta ${c}. ${nada}`;
}

/** O que `negaAcao` devolve para a ação DESTE fluxo — só ela vale como NÃO. */
const ACAO_NEGAVEL: Record<Operacao, string> = { lembrar: "enviar", cancelar: "cancelar", trocar: "alterar" };

// ─── Condução ───────────────────────────────────────────────────────────────

export async function conduzirAssinatura(f: FluxoAssinatura, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const confirmacao = lerConfirmacao(ctx.texto);
  const trocar = f.operacao === "trocar";
  // "cancelar" sozinho é o NÃO, inclusive dentro do fluxo de CANCELAR (como em todo fluxo do Max).
  if (confirmacao === "nao" || negaAcao(ctx.texto) === ACAO_NEGAVEL[f.operacao] || NEGA_O_VERBO.test(normalizar(ctx.texto)) ||
    (trocar && NEGA_A_TROCA.test(normalizar(ctx.texto))) ||
    /^(cancelar|pare|parar|desistir)[.!]?$/i.test(ctx.texto.trim())) {
    // Com escrita incerta, a chave fica: um novo pedido sobre a mesma proposta
    // confere o MESMO pedido antes de repetir.
    return f.chave
      ? resposta({ ...f, etapa: "resumo", atualizadoEm: ctx.agora }, "Parei por aqui. O pedido anterior pode já ter sido registrado: confira na tela de propostas.", "assinatura_cancelada")
      : resposta(null, `Parei por aqui. Nada foi ${f.operacao === "lembrar" ? "enviado" : "alterado"}.`, "assinatura_cancelada");
  }
  // Outro pedido de lembrar/cancelar (outra operação ou outra proposta) recomeça, salvo escrita em aberto.
  const outro = pedeAssinatura(ctx.texto);
  if (outro && !f.chave) return iniciarAssinatura(outro, ctx, deps);
  if (!permitido(ctx)) {
    return resposta({ ...f, etapa: f.etapa === "confirmacao" ? "resumo" : f.etapa }, "Não consegui validar sua permissão agora. Nada foi alterado.");
  }

  if (f.etapa === "selecao") {
    const n = /^\d+$/.test(ctx.texto.trim()) ? Number(ctx.texto.trim()) : 0;
    const alvo = f.candidatos?.[n - 1];
    if (alvo && trocar) return respostaDaTroca(alvo, true)!;
    if (alvo) return seguirComAlvo({ ...f, atualizadoEm: ctx.agora }, alvo);
    if (n) return resposta(f, "Esse número não está na lista. Responda com um número da lista, o nome do cliente ou o código.");
    // Resposta curta = o nome/endereço pedido; frase longa só com forma explícita
    // de busca. Outro assunto encerra a seleção (não fica pendurada).
    const curto = termoDaResposta(ctx.texto);
    const retomar = (termo?: string) => (trocar
      ? iniciarTroca(ctx, deps, termo, true)
      : iniciarAssinatura(f.operacao, ctx, deps, termo, f.motivo));
    if (curto) return retomar(curto);
    if (codigoCitado(ctx.texto) || pedeLista(ctx.texto) || (pedeBusca(ctx.texto) && termoDeBusca(ctx.texto))) {
      return retomar(undefined);
    }
    return { liberar: true, fluxo: null, evento: "assinatura_outro_assunto" };
  }
  if (f.etapa === "concluida") return { liberar: true, fluxo: null, evento: "assinatura_concluida" };
  // Trocar só existe na seleção (é leitura): qualquer outra etapa é estado inválido e não escreve nada.
  if (f.operacao === "trocar") return { liberar: true, fluxo: null, evento: "assinatura_troca_etapa_invalida" };

  if (f.etapa === "motivo") {
    // Outro pedido de proposta ou pergunta não é motivo: libera e o fluxo fica à espera.
    if (pedeGestao(ctx.texto) || /\?\s*$/.test(ctx.texto.trim())) return { liberar: true, fluxo: f, evento: "assinatura_outro_assunto" };
    const motivo = confirmacao === "sim" ? null : motivoValido(ctx.texto.replace(/^(?:o\s+)?(?:motivo|porque|pois)\s*(?:e|é|foi)?\s*:?\s*/i, ""));
    if (!motivo) {
      const longo = ctx.texto.trim().length > MOTIVO_MAX;
      return resposta({ ...f, atualizadoEm: ctx.agora },
        longo
          ? `O motivo ficou longo (no máximo ${MOTIVO_MAX} caracteres). Resuma, por favor.`
          : "Preciso do motivo do cancelamento, em poucas palavras (vai no histórico da proposta). Qual foi?",
        "assinatura_pede_motivo");
    }
    return resumo({ ...f, motivo, atualizadoEm: ctx.agora });
  }

  // Outro assunto libera o turno; a chave (se houver) fica no fluxo para o próximo SIM.
  if (confirmacao === "nenhum") return { liberar: true, fluxo: f, evento: "assinatura_outro_assunto" };
  if (f.etapa === "resumo" || confirmacao !== "sim") return resumo({ ...f, atualizadoEm: ctx.agora });

  const alvo = f.alvo!;
  const chave = f.chave ?? { verbo: VERBO[f.operacao], valor: ctx.messageId };
  const emCurso: FluxoAssinatura = { ...f, chave, atualizadoEm: ctx.agora };
  const args: Record<string, unknown> = f.operacao === "cancelar" ? { proposta_id: alvo.id, motivo: f.motivo } : { proposta_id: alvo.id };
  const r = await deps.acao(chave.verbo, args, chave.valor);
  if (!r || (r.status === 409 && r.body.error === "em_andamento")) {
    return resposta(emCurso, INCERTO, "assinatura_incerta");
  }
  if (r.status !== 200) return resposta(null, textoDaRecusa(f, r.status, r.body), `assinatura_${f.operacao}_${r.status}`);

  if (f.operacao === "cancelar") {
    const proposta = r.body.proposta && typeof r.body.proposta === "object" ? (r.body.proposta as Record<string, unknown>) : {};
    // 200 sem "cancelada" no corpo não é prova de cancelamento.
    if (proposta.status !== "cancelada") {
      return resposta(null, `O sistema respondeu, mas não confirmou o cancelamento da proposta ${alvo.codigo}. Confira o status na tela de propostas.`, "assinatura_cancelar_nao_confirmado");
    }
    const clicksign = SEM_ASSINATURA_VIVA.has(alvo.status ?? "") ? "" : " A assinatura na ClickSign foi encerrada.";
    return resposta(null, `Proposta ${alvo.codigo} cancelada.${clicksign}`, "proposta_cancelada");
  }

  const enviados = (Array.isArray(r.body.enviados) ? r.body.enviados : []).filter((n): n is string => typeof n === "string").map((n) => umaLinha(n, 80));
  const puladosDoServidor = pulados(r.body);
  const nao = puladosDoServidor.length ? `\nNão lembrei: ${puladosDoServidor.map(doPulado).join(", ")}.` : "";
  if (!enviados.length) {
    return resposta(null, `O sistema respondeu, mas não confirmou lembrete para ninguém na proposta ${alvo.codigo}.${nao}`, "assinatura_lembrete_vazio");
  }
  return resposta(null, `Lembrete enviado para ${lista(enviados)}.${nao}`, "assinatura_lembrete_enviado");
}
