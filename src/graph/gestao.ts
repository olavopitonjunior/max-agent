import type { ContextoDoTurno, DepsDoFluxo, Fluxo, PassoDoFluxo } from "./fluxos";
import { buscarPropostas, codigoCitado, pedeBusca, pedeLista, rotuloDaProposta, termoDaResposta, termoDeBusca, type PropostaListada } from "./localizar";
import type { Capability } from "./policy";
import { lerConfirmacao, normalizar } from "./tools";
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

type Operacao = "excluir" | "duplicar";
interface Alvo { id: string; codigo: string; titulo?: string; estado?: string }

export interface FluxoGestao {
  kind: "gestao";
  operacao: Operacao;
  etapa: "selecao" | "resumo" | "confirmacao" | "concluida";
  alvo?: Alvo;
  candidatos?: Alvo[];
  /** O que a pessoa digitou para achar a proposta — repetido no resumo. */
  termo?: string;
  chave?: { verbo: string; valor: string };
  resultado?: string;
  atualizadoEm: number;
}
type Resposta = Extract<PassoDoFluxo, { reply: string }>;

const VERBO: Record<Operacao, string> = { excluir: "proposal.delete", duplicar: "proposal.duplicate" };
const CAPABILITY: Record<Operacao, Capability> = { excluir: "proposal.delete", duplicar: "proposal.create" };

/**
 * O verbo age DIRETO sobre a proposta ("exclui a proposta da X", "apaga a
 * PROP-…", "faz uma cópia da proposta"). Review 09/10: verbo solto na frase
 * casava "remove o fiador da proposta" (edição), "me manda uma cópia da
 * proposta" (envio) e "a proposta foi excluída?" (status).
 */
const ALVO = String.raw`(?:a\s+|essa\s+|esta\s+|aquela\s+|minha\s+|uma\s+)?(?:proposta\b|prop-\d)`;
const EXCLUIR = new RegExp(String.raw`^(?:(?:pode|quero|preciso|por favor|favor)\s+)?(?:exclu(?:a|ir|i)|apag(?:a|ar|ue)|delet(?:a|ar|e)|remov(?:a|e|er))\s+` + ALVO);
const DUPLICAR = new RegExp(String.raw`^(?:(?:pode|quero|preciso|por favor|favor)\s+)?(?:duplic(?:a|ar|ue)|clon(?:a|ar|e)|fa(?:z|ca|zer)\s+uma\s+copia\s+d[ae])\s+` + ALVO);
const NEGACAO = /\b(nao|nunca|jamais)\b/;

/** O pedido é excluir ou duplicar uma proposta? Pergunta e negação não contam. */
export function pedeGestao(texto: string): Operacao | null {
  const t = normalizar(texto).replace(/^max\b[\s,:-]*/, "").trim();
  if (/\?\s*$/.test(texto) || NEGACAO.test(t)) return null;
  if (EXCLUIR.test(t)) return "excluir";
  if (DUPLICAR.test(t)) return "duplicar";
  return null;
}

function resposta(f: Fluxo | null, reply: string, evento = "gestao"): Resposta {
  return { fluxo: f, reply, evento };
}
function permitido(op: Operacao, ctx: ContextoDoTurno): boolean {
  return !ctx.politicaIndisponivel && ctx.policy.includes("proposal.list") && ctx.policy.includes(CAPABILITY[op]);
}
function alvoDe(p: PropostaListada): Alvo {
  return { id: p.id, codigo: p.codigo, titulo: p.titulo, estado: p.estado };
}
function resumo(f: FluxoGestao): Resposta {
  const rotulo = rotuloDaProposta(f.alvo!) + (f.termo ? `, achada por "${f.termo}"` : "");
  // A exclusão cancela antes a assinatura viva na ClickSign (runProposalDelete).
  const emAssinatura = /envi|assin|aguard/i.test(f.alvo!.estado ?? "");
  const texto = f.operacao === "excluir"
    ? `Excluir a proposta ${rotulo}? A exclusão é definitiva${emAssinatura ? " e a assinatura em andamento será cancelada" : ""}.`
    : `Duplicar a proposta ${rotulo}? Crio um rascunho novo com os mesmos dados; a original não muda.`;
  return resposta({ ...f, etapa: "confirmacao" }, `${texto}\n\nResponda SIM para confirmar ou NÃO para parar.`);
}
const acaoNome = (op: Operacao) => (op === "excluir" ? "excluir" : "duplicar");

export async function iniciarGestao(op: Operacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, termoDado?: string | null): Promise<Resposta> {
  const f: FluxoGestao = { kind: "gestao", operacao: op, etapa: "selecao", atualizadoEm: ctx.agora };
  if (!permitido(op, ctx)) {
    return resposta(null, ctx.politicaIndisponivel
      ? "Não consegui validar sua permissão agora. Nada foi alterado; tente de novo em instantes."
      : `${op === "excluir" ? "Excluir" : "Duplicar"} proposta pelo Max não está liberado para você. Faça pela tela de propostas do sistema.`,
    "gestao_sem_politica");
  }
  const r = await buscarPropostas(deps, ctx.texto, termoDado);
  if (!r) return resposta(null, "Não consegui consultar suas propostas agora. Nada foi alterado; tente de novo em instantes.", "gestao_sem_resposta");
  if (r.termo) f.termo = r.termo;
  if (!r.itens.length) {
    return resposta(f, r.termo
      ? `Não achei proposta sua com "${r.termo}". Me diga o nome de outra pessoa da proposta, o endereço ou o código.`
      : `Qual proposta devo ${acaoNome(op)}? Me diga o nome do cliente, o endereço ou o código.`);
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
  if (confirmacao === "nao" || /^(cancelar|pare|parar|desistir)[.!]?$/i.test(ctx.texto.trim())) {
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
    if (alvo) return resumo({ ...f, alvo, atualizadoEm: ctx.agora });
    if (n) return resposta(f, "Esse número não está na lista. Responda com um número da lista, o nome do cliente ou o código.");
    // Resposta curta = o nome/endereço pedido; frase longa só com forma explícita
    // de busca. Outro assunto encerra a seleção (não fica pendurada, review W2).
    const curto = termoDaResposta(ctx.texto);
    if (curto) return iniciarGestao(f.operacao, ctx, deps, curto);
    if (codigoCitado(ctx.texto) || pedeLista(ctx.texto) || (pedeBusca(ctx.texto) && termoDeBusca(ctx.texto))) return iniciarGestao(f.operacao, ctx, deps);
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
