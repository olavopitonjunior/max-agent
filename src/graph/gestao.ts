import { conduzirFluxo, type ContextoDoTurno, type DepsDoFluxo, type Fluxo, type PassoDoFluxo } from "./fluxos";
import { buscarPropostas, codigoCitado, pedeBusca, pedeLista, rotuloDaProposta, termoDaResposta, termoDeBusca, type PropostaListada } from "./localizar";
import type { Capability } from "./policy";
import { lerConfirmacao, normalizar } from "./tools";
import { negaAcao } from "./capacidades";
import { imobproBase } from "@/lib/http";

/**
 * Excluir e duplicar proposta pelo WhatsApp (decisão do Olavo, 09/10/2026).
 *
 * Mesmo desenho da continuidade: localizar (código, nome, endereço, número da
 * lista) → resumo → SIM → o verbo do servidor, com a `messageId` do SIM como
 * chave e a chave guardada até o resultado ser conhecido. Quem decide se pode
 * é o servidor (política do Max + RBAC do tenant + "proposta do usuário"); o
 * Max só traduz o código de recusa em frase fixa.
 */

type Operacao = "excluir" | "duplicar" | "editar";
interface Alvo { id: string; codigo: string; titulo?: string; estado?: string; status?: string; nomes?: string[] }

export interface FluxoGestao {
  kind: "gestao";
  operacao: Operacao;
  etapa: "selecao" | "resumo" | "confirmacao" | "concluida";
  alvo?: Alvo;
  candidatos?: Alvo[];
  /** O que a pessoa digitou para achar a proposta — repetido no resumo. */
  termo?: string;
  /** Editar: o pedido original ("muda o valor… para 480 mil"), aplicado depois da escolha. */
  pedido?: string;
  chave?: { verbo: string; valor: string };
  resultado?: string;
  atualizadoEm: number;
}
type Resposta = Extract<PassoDoFluxo, { reply: string }>;

const VERBO: Record<Operacao, string> = { excluir: "proposal.delete", duplicar: "proposal.duplicate", editar: "proposal.update" };
// `proposal.update` usa a capability da criação, como no servidor.
const CAPABILITY: Record<Operacao, Capability> = { excluir: "proposal.delete", duplicar: "proposal.create", editar: "proposal.create" };
/** Estados em que o servidor aceita `proposal.update` (EDITABLE_STATUSES do ImobPro). */
const EDITAVEIS = new Set(["rascunho", "aguardando_aprovacao", "falha_envio"]);
export const CAMPOS_AJUSTAVEIS = "comprador ou inquilino, imóvel, valor, vendedor ou proprietário, pagamento, comissão e o canal da assinatura";

/**
 * O verbo age DIRETO sobre a proposta ("exclui a proposta da X", "apaga a
 * PROP-…", "faz uma cópia da proposta"). Review 09/10: verbo solto na frase
 * casava "remove o fiador da proposta" (edição), "me manda uma cópia da
 * proposta" (envio) e "a proposta foi excluída?" (status).
 */
const ALVO = String.raw`(?:a\s+|essa\s+|esta\s+|aquela\s+|minha\s+|uma\s+)?(?:proposta\b|prop-\d)`;
const EXCLUIR = new RegExp(String.raw`^(?:(?:pode|quero|preciso|por favor|favor)\s+)?(?:exclu(?:a|ir|i)|apag(?:a|ar|ue)|delet(?:a|ar|e)|remov(?:a|e|er)|tir(?:a|ar|e))\s+` + ALVO);
const DUPLICAR = new RegExp(String.raw`^(?:(?:pode|quero|preciso|por favor|favor)\s+)?(?:duplic(?:a|ar|ue)|clon(?:a|ar|e)|fa(?:z|ca|zer)\s+uma\s+copia\s+d[ae])\s+` + ALVO);
const NEGACAO = /\b(nao|nunca|jamais)\b/;

/**
 * Editar uma proposta EXISTENTE citada pelo nome ou código (09/10/2026): "muda
 * o valor da proposta da Letícia para 480 mil", "remove o fiador da proposta
 * da X", "na proposta PROP-…, corrige o e-mail". Teste de 09/10: o modelo
 * respondia "não consigo alterar proposta já feita", contra o "criar e ajustar"
 * que o próprio Max anuncia.
 */
const VERBO_EDICAO = String.raw`(?:mud|alter|troc|corrig|corrij|ajust|edit|atualiz|remov|tir|inclu|coloc|coloq|acrescent|adicion|substitu|bot)\w*`;
const PEDIDO = String.raw`^(?:(?:pode|consegue|quero|preciso|por favor|favor|pfv|pf)[\s,]+)*(?:que\s+(?:voce\s+|vc\s+)?)?`;
const EDITAR = new RegExp(String.raw`${PEDIDO}${VERBO_EDICAO}\b[^.?!]{0,80}?\b(?:proposta\b|prop-\d)`);
const EDITAR_NA = new RegExp(String.raw`^(?:n|d)?a\s+(?:proposta\b|prop-\d)[^.?!]{0,60}?[,:;]?\s*${VERBO_EDICAO}\b`);
/** "Tira/remove a proposta" é exclusão (resumo + SIM, eval 09/10) — nunca edição. */
const TIRAR_A_PROPOSTA = new RegExp(String.raw`${PEDIDO}(?:remov|tir)\w*\s+` + ALVO);
const PERGUNTA_DE_PROCESSO = /^(como|quando|onde|por que|porque|o que|qual|quais|quanto|posso|da pra|da para|e possivel)\b/;

/**
 * Quem a pessoa citou para achar a proposta a editar: o código, ou o trecho
 * logo depois de "proposta" até o começo da mudança ("da Letícia Andrade" em
 * "…da proposta da Letícia Andrade para 480 mil"). O valor novo nunca vira
 * termo de busca.
 */
export function termoDaEdicao(texto: string): string | null {
  const codigo = codigoCitado(texto);
  if (codigo) return codigo.toLowerCase();
  const depois = texto.match(/\bpropostas?\b([^,;:.!?]*)/i)?.[1] ?? "";
  const trecho = depois.split(/\s(?:para|pra|por|pelo|pela|com|que|e|no|na|ao)\s/i)[0] ?? "";
  return trecho.trim() ? termoDeBusca(`proposta ${trecho}`) : null;
}

/** Criação nunca é edição: "adiciona uma proposta do João", "inclui uma nova proposta". */
const CRIACAO = /\b(uma|nova|novo|outra)\s+proposta\b/;

/** O pedido é editar uma proposta existente, com alvo citado? */
export function pedeEdicao(texto: string): boolean {
  const t = normalizar(texto).replace(/^max\b[\s,:-]*/, "").trim();
  if (NEGACAO.test(t) || PERGUNTA_DE_PROCESSO.test(t) || CRIACAO.test(t)) return false;
  // "Pode mudar…?" é pedido; outra frase com "?" é pergunta.
  if (/\?\s*$/.test(texto) && !/^(pode|consegue)\b/.test(t)) return false;
  if (TIRAR_A_PROPOSTA.test(t)) return false;
  if (!EDITAR.test(t) && !EDITAR_NA.test(t)) return false;
  return !!termoDaEdicao(texto);
}

/** O pedido é excluir, duplicar ou editar uma proposta? Pergunta e negação não contam. */
export function pedeGestao(texto: string): Operacao | null {
  const t = normalizar(texto).replace(/^max\b[\s,:-]*/, "").trim();
  if (!/\?\s*$/.test(texto) && !NEGACAO.test(t)) {
    if (EXCLUIR.test(t)) return "excluir";
    if (DUPLICAR.test(t)) return "duplicar";
  }
  return pedeEdicao(texto) ? "editar" : null;
}

function resposta(f: Fluxo | null, reply: string, evento = "gestao"): Resposta {
  return { fluxo: f, reply, evento };
}
function permitido(op: Operacao, ctx: ContextoDoTurno): boolean {
  return !ctx.politicaIndisponivel && ctx.policy.includes("proposal.list") && ctx.policy.includes(CAPABILITY[op]);
}
function alvoDe(p: PropostaListada): Alvo {
  return { id: p.id, codigo: p.codigo, titulo: p.titulo, estado: p.estado, status: p.status, nomes: p.nomes.length ? p.nomes : undefined };
}

/**
 * Editar = abrir o fluxo de AJUSTE da proposta escolhida e aplicar nele o
 * pedido original: o mesmo resumo + SIM + `proposal.update` (PATCH só dos
 * campos ditos) do ajuste depois do rascunho. Só rascunho é editável; o resto
 * recebe o caminho (duplicar e ajustar a cópia, ou a tela).
 */
async function abrirEdicao(alvo: Alvo, f: FluxoGestao, ctx: ContextoDoTurno, deps: DepsDoFluxo, aviso = ""): Promise<Resposta> {
  const rotulo = rotuloDaProposta({ codigo: alvo.codigo, titulo: alvo.titulo });
  if (alvo.status && !EDITAVEIS.has(alvo.status)) {
    const estado = (alvo.estado ?? alvo.status).toLowerCase();
    return resposta(null,
      `A proposta ${rotulo} está ${estado}: só proposta ainda não enviada pode ser ajustada. ` +
      `Posso duplicá-la e ajustar a cópia (diga "duplica a proposta ${alvo.codigo}"), ou ajuste pela tela de propostas.`,
      "edicao_nao_editavel");
  }
  const ajuste: Fluxo = {
    kind: "proposta", etapa: "ajustes", dados: {}, propostaId: alvo.id, codigo: alvo.codigo,
    referencia: f.termo, rotulo: [alvo.titulo, alvo.nomes?.length ? `(${alvo.nomes.join(", ")})` : ""].filter(Boolean).join(" ") || undefined,
    atualizadoEm: ctx.agora,
  };
  const passo = await conduzirFluxo(ajuste, { ...ctx, texto: f.pedido ?? ctx.texto }, deps);
  const semReferencia = (x: Fluxo | null): Fluxo | null => (x?.kind === "proposta" ? { ...x, referencia: undefined } : x);
  if ("liberar" in passo) {
    return resposta(semReferencia(ajuste),
      `${aviso}O que você quer mudar na proposta ${rotulo}? Por aqui eu ajusto ${CAMPOS_AJUSTAVEIS}.`,
      "edicao_aberta");
  }
  return { ...passo, reply: `${aviso}${passo.reply}`, fluxo: semReferencia(passo.fluxo) };
}
function resumo(f: FluxoGestao): Resposta {
  // Editar nunca passa por aqui (vai ao fluxo de ajuste); defensivo contra um
  // `proposal.update` sem campos.
  if (f.operacao === "editar") return resposta(null, "Me diga de novo o que mudar e em qual proposta.", "edicao_sem_alvo");
  const rotulo = rotuloDaProposta(f.alvo!) + (f.termo ? `, achada por "${f.termo}"` : "");
  // A exclusão cancela antes a assinatura viva na ClickSign (runProposalDelete).
  const emAssinatura = /envi|assin|aguard/i.test(f.alvo!.estado ?? "");
  const texto = f.operacao === "excluir"
    ? `Excluir a proposta ${rotulo}? A exclusão é definitiva${emAssinatura ? " e a assinatura em andamento será cancelada" : ""}.`
    : `Duplicar a proposta ${rotulo}? Crio um rascunho novo com os mesmos dados; a original não muda.`;
  return resposta({ ...f, etapa: "confirmacao" }, `${texto}\n\nResponda SIM para confirmar ou NÃO para parar.`);
}
/** O que `negaAcao` devolve para a ação DESTE fluxo — só ela vale como NÃO ("não manda pro dono, só exclui" não cancela). */
const ACAO_NEGAVEL: Record<Operacao, string> = { excluir: "excluir", duplicar: "duplicar", editar: "alterar" };
const acaoNome = (op: Operacao) => (op === "excluir" ? "excluir" : op === "duplicar" ? "duplicar" : "ajustar");

export async function iniciarGestao(
  op: Operacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, termoDado?: string | null, pedido?: string
): Promise<Resposta> {
  const f: FluxoGestao = { kind: "gestao", operacao: op, etapa: "selecao", atualizadoEm: ctx.agora };
  if (op === "editar") f.pedido = pedido ?? ctx.texto;
  if (!permitido(op, ctx)) {
    return resposta(null, ctx.politicaIndisponivel
      ? "Não consegui validar sua permissão agora. Nada foi alterado; tente de novo em instantes."
      : `${op === "excluir" ? "Excluir" : op === "duplicar" ? "Duplicar" : "Ajustar"} proposta pelo Max não está liberado para você. Faça pela tela de propostas do sistema.`,
    "gestao_sem_politica");
  }
  const termo = termoDado !== undefined ? termoDado : op === "editar" && !pedido ? termoDaEdicao(ctx.texto) : undefined;
  const r = await buscarPropostas(deps, ctx.texto, termo);
  if (!r) return resposta(null, "Não consegui consultar suas propostas agora. Nada foi alterado; tente de novo em instantes.", "gestao_sem_resposta");
  if (r.termo) f.termo = r.termo;
  if (!r.itens.length) {
    return resposta(f, r.termo
      ? `Não achei proposta sua com "${r.termo}". Me diga o nome de outra pessoa da proposta, o endereço ou o código.`
      : `Qual proposta devo ${acaoNome(op)}? Me diga o nome do cliente, o endereço ou o código.`);
  }
  if (op === "editar" && r.termo) {
    // A citada é a única — ou a única EDITÁVEL entre as que casam ("a da
    // Letícia": a assinada não muda mais; a em rascunho, sim). O resumo do
    // ajuste mostra o código antes do SIM.
    const editaveis = r.itens.filter((p) => EDITAVEIS.has(p.status));
    if (r.itens.length === 1 && r.total <= 1) return abrirEdicao(alvoDe(r.itens[0]!), f, ctx, deps);
    if (editaveis.length === 1 && r.total <= r.itens.length) {
      // As outras que casam ficam ditas: a pessoa pode ter falado de outra (review 09/10).
      const aviso = `Achei ${r.itens.length} propostas com "${r.termo}"; só a ${editaveis[0]!.codigo} ainda pode ser ajustada.\n`;
      return abrirEdicao(alvoDe(editaveis[0]!), f, ctx, deps, aviso);
    }
    if (!editaveis.length && r.total <= r.itens.length) {
      return resposta(null,
        `Nenhuma proposta com "${r.termo}" pode ser ajustada (só as ainda não enviadas):\n` +
        `${r.itens.slice(0, 5).map((p) => `• ${rotuloDaProposta(p)}`).join("\n")}\n` +
        "Posso duplicar uma delas e ajustar a cópia, ou ajuste pela tela de propostas.",
        "edicao_nada_editavel");
    }
  }
  // Uma só, e a busca disse o que procurar: resumo. Sem termo, nunca assumir a mais recente.
  if (r.termo && r.itens.length === 1 && r.total <= 1) return resumo({ ...f, alvo: alvoDe(r.itens[0]!) });
  const candidatos = r.itens.slice(0, 5).map(alvoDe);
  const cabeca = r.termo ? `Achei mais de uma proposta com "${r.termo}". Qual devo ${acaoNome(op)}?` : `Qual proposta devo ${acaoNome(op)}?`;
  const resto = r.total > candidatos.length ? `\n(${r.total} no total; se não estiver aqui, me diga o nome ou o código.)` : "";
  return resposta({ ...f, candidatos },
    `${cabeca}\n${candidatos.map((p, i) => `${i + 1}. ${rotuloDaProposta(p)}`).join("\n")}${resto}\n\nResponda com o número.`);
}

/** Recusas do servidor → frase fixa. Nada aqui afirma que a operação aconteceu. */
function textoDaRecusa(f: FluxoGestao, status: number, body: Record<string, unknown>): string {
  const c = f.alvo!.codigo;
  const erro = String(body.error ?? "");
  if (status === 403) return `Sua permissão no sistema não permite ${acaoNome(f.operacao)} a proposta ${c}. Nada foi alterado.`;
  if (status === 404) return `Não encontrei a proposta ${c} entre as suas. Nada foi alterado.`;
  if (erro === "ja_convertida") return `A proposta ${c} já virou negócio e não pode ser excluída pelo Max.`;
  if (erro === "ja_enviada") return `A proposta ${c} já foi enviada ao cliente: ela não pode ser excluída, só cancelada pela tela de propostas.`;
  if (erro === "estado_mudou") return `A proposta ${c} mudou de situação agora há pouco; nada foi excluído. Confira o status e peça de novo se ainda quiser.`;
  if (erro === "assinatura_ativa") return `A assinatura da proposta ${c} ainda está ativa na ClickSign e não deu para cancelar agora. Tente de novo em alguns minutos.`;
  if (erro === "nao_excluivel") return `A proposta ${c} está ${typeof body.estado === "string" ? body.estado.toLowerCase() : "num estado"} que não permite exclusão. Cancele a assinatura pela tela antes.`;
  if (erro === "MODULE_DISABLED") return "Propostas estão desligadas para a sua imobiliária. Nada foi alterado.";
  return `O sistema não confirmou ${f.operacao === "excluir" ? "a exclusão" : "a duplicação"} da proposta ${c}. Nada foi alterado pelo Max.`;
}

export async function conduzirGestao(f: FluxoGestao, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const confirmacao = lerConfirmacao(ctx.texto);
  // "Não exclui não", "não converte ainda": negar a ação é o NÃO ao resumo (eval 09/10).
  if (confirmacao === "nao" || negaAcao(ctx.texto) === ACAO_NEGAVEL[f.operacao] || /^(cancelar|pare|parar|desistir)[.!]?$/i.test(ctx.texto.trim())) {
    // Com escrita incerta, a chave fica: um novo pedido sobre a mesma proposta
    // confere o MESMO pedido antes de repetir (review 09/10, W4).
    return f.chave
      ? resposta({ ...f, etapa: "resumo", atualizadoEm: ctx.agora }, "Parei por aqui. O pedido anterior pode já ter sido registrado: confira na tela de propostas.", "gestao_cancelada")
      : resposta(null, "Parei por aqui. Nada foi alterado.", "gestao_cancelada");
  }
  // Outro pedido de gestão (outra operação ou outra proposta) recomeça, salvo escrita em aberto.
  const outro = pedeGestao(ctx.texto);
  if (outro && !f.chave) return iniciarGestao(outro, ctx, deps);
  if (!permitido(f.operacao, ctx)) {
    return resposta({ ...f, etapa: f.alvo ? "resumo" : "selecao" }, "Não consegui validar sua permissão agora. Nada foi alterado.");
  }

  if (f.etapa === "selecao") {
    const n = /^\d+$/.test(ctx.texto.trim()) ? Number(ctx.texto.trim()) : 0;
    const alvo = f.candidatos?.[n - 1];
    if (alvo && f.operacao === "editar") return abrirEdicao(alvo, f, ctx, deps);
    if (alvo) return resumo({ ...f, alvo, atualizadoEm: ctx.agora });
    if (n) return resposta(f, "Esse número não está na lista. Responda com um número da lista, o nome do cliente ou o código.");
    // Resposta curta = o nome/endereço pedido; frase longa só com forma explícita
    // de busca. Outro assunto encerra a seleção (não fica pendurada, review W2).
    const curto = termoDaResposta(ctx.texto);
    if (curto) return iniciarGestao(f.operacao, ctx, deps, curto, f.pedido);
    if (codigoCitado(ctx.texto) || pedeLista(ctx.texto) || (pedeBusca(ctx.texto) && termoDeBusca(ctx.texto))) return iniciarGestao(f.operacao, ctx, deps, undefined, f.pedido);
    return { liberar: true, fluxo: null, evento: "gestao_outro_assunto" };
  }
  if (f.etapa === "concluida") return { liberar: true, fluxo: null, evento: "gestao_concluida" };
  // Outro assunto libera o turno; a chave (se houver) fica no fluxo para o próximo SIM (W1).
  if (confirmacao === "nenhum") return { liberar: true, fluxo: f, evento: "gestao_outro_assunto" };
  if (f.etapa === "resumo" || confirmacao !== "sim") return resumo({ ...f, atualizadoEm: ctx.agora });

  const alvo = f.alvo!;
  const chave = f.chave ?? { verbo: VERBO[f.operacao], valor: ctx.messageId };
  const emCurso: FluxoGestao = { ...f, chave, atualizadoEm: ctx.agora };
  const r = await deps.acao(chave.verbo, { proposta_id: alvo.id }, chave.valor);
  if (!r || (r.status === 409 && r.body.error === "em_andamento")) {
    return resposta(emCurso, `Ainda não confirmei o resultado. Responda SIM para verificar o mesmo pedido, sem repeti-lo.`, "gestao_incerta");
  }

  if (f.operacao === "excluir") {
    if (r.status === 200) return resposta(null, `Proposta ${alvo.codigo} excluída.`, "proposta_excluida");
    // Retry de uma exclusão incerta que já tinha passado: a proposta não existe mais.
    if (r.status === 404 && f.chave) return resposta(null, `A proposta ${alvo.codigo} não existe mais entre as suas.`, "exclusao_404_retry");
    return resposta(null, textoDaRecusa(f, r.status, r.body), `exclusao_${r.status}`);
  }

  const nova = (r.body.proposta && typeof r.body.proposta === "object" ? r.body.proposta : {}) as Record<string, unknown>;
  if (r.status === 201 && typeof nova.id === "string") {
    const codigo = typeof nova.codigo === "string" ? nova.codigo : "novo";
    const link = typeof nova.link === "string" ? `\n${new URL(nova.link, imobproBase()).toString()}` : "";
    // O rascunho novo fica aberto para ajuste e envio, como um rascunho retomado.
    const proposta: Fluxo = {
      kind: "proposta", etapa: "ajustes", dados: {}, propostaId: nova.id,
      codigo: typeof nova.codigo === "string" ? nova.codigo : undefined, atualizadoEm: ctx.agora,
    };
    return resposta(proposta,
      `Criei o rascunho ${codigo} a partir da ${alvo.codigo}, com os mesmos dados. A original não mudou.${link}\n\nMe diga o que trocar, ou peça para enviar para assinatura.`,
      "proposta_duplicada");
  }
  return resposta(null, textoDaRecusa(f, r.status, r.body), `duplicacao_${r.status}`);
}
