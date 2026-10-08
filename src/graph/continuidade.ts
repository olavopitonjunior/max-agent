import type { ContextoDoTurno, DepsDoFluxo, PassoDoFluxo } from "./fluxos";
import { lerConfirmacao, normalizar } from "./tools";
import { imobproBase } from "@/lib/http";

interface Alvo { id: string; codigo: string; status: string }
export interface FluxoContinuidade {
  kind: "continuidade";
  etapa: "selecao" | "resumo" | "confirmacao" | "execucao" | "concluida";
  converter: boolean;
  alvo?: Alvo;
  candidatos?: Alvo[];
  chave?: { verbo: string; valor: string };
  completou?: boolean;
  resultado?: string;
  atualizadoEm: number;
}
type Resposta = Extract<PassoDoFluxo, { reply: string }>;
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const citaPessoa = (texto: string): boolean =>
  /\bproposta\s+(?:assinada\s+)?(?:da|do|de)\s+(?!(?:venda|locacao|compra|aluguel|imovel|apto|apartamento|casa|terreno|sala|loja)\b)\p{L}+/iu.test(texto);
/** Verbos de conversão, com as formas do WhatsApp ("transforma", "converte") e os erros comuns. */
const VERBO_CONVERSAO = String.raw`(?:conver(?:ter|ta|te|ti|tida|tido|sao)|(?:trans|tran|tras)f?orm(?:ar|a|e|ou|ada|ado|acao)|transfom(?:ar|a|e))`;
const conversao = new RegExp(String.raw`\b${VERBO_CONVERSAO}\b`);
/** "Vira negócio" só é conversão quando o sujeito é uma proposta que já existe. */
const virar = /\b(?:vira|virar|vire)\s+(?:um\s+)?(?:negocio|formulario)\b|\b(?:vira|virar|vire|passa|passar|sobe|subir)\b(?:\s+\S+){0,5}?\s+(?:em|pra|para|pro)\s+(?:um\s+)?(?:negocio|formulario)\b/;
const negacao = new RegExp(String.raw`\bnao\s+(?:e\s+(?:pra|para)\s+|(?:quero|pode|deve|precisa)\s+)?(?:a\s+)?(?:concluir|conclua|${VERBO_CONVERSAO}|virar|vire)\b`);
const indefinida = /\b(?:uma|um|nova|novo|outra)\s+proposta\b|\bproposta\s+nova\b/;

/** "Faz/cria/monta uma proposta do João" é criação: o nome é do cliente novo. */
const criaProposta = /\b(?:cri[ae]r?|fa[zc]a?|fazer|mont[ae]r?|ger[ae]r?|abr[ae]|abrir|prepar[ae]r?|elabor[ae]r?)\s+(?:(?:uma|um|a|o|nova|novo|outra|mais)\s+){0,2}proposta\b|\bnova\s+proposta\b|\bproposta\s+nova\b/;

/** Código, demonstrativo, estado ou origem: sempre uma proposta que já existe. */
function referenciaForte(t: string): boolean {
  return /\bprop-\d{4}-\d+\b/.test(t) ||
    /\b(?:essa|esta|aquela|dessa|desta|daquela|mesma)\s+proposta\b/.test(t) ||
    /\bproposta\s+(?:ja\s+)?(?:foi\s+|esta\s+)?(?:assinada|existente|aprovada|concluida)\b/.test(t) ||
    /\bassin\w*\s+(?:a|essa|esta)\s+proposta\b/.test(t) ||
    /\ba\s+partir\s+d[ae]\s+(?:\S+\s+)?proposta\b/.test(t);
}

/** Guarda conservadora da criação: referência existente exige continuar a proposta,
 * independentemente do verbo que o modelo tenha interpretado. "Proposta da X" só
 * refere quando o pedido é de negócio/formulário (o risco de negócio desvinculado)
 * e sem verbo de criação nem artigo indefinido. */
export function referenciaPropostaExistente(texto: string, tipo?: "venda" | "locacao" | "proposta"): boolean {
  const t = normalizar(texto);
  const criacao = indefinida.test(t) || criaProposta.test(t);
  // Proposta nova "igual a essa" não gera negócio desvinculado: o risco é só do negócio.
  if (tipo === "proposta" && criacao) return false;
  return referenciaForte(t) || (tipo !== "proposta" && citaPessoa(t) && !criacao);
}

/** Pedidos de continuidade nunca podem cair na criação de formulário avulso. */
export function pedeContinuidade(texto: string): boolean {
  const t = normalizar(texto).replace(/^max\b[\s,:-]*/, "");
  if (/^(como|quando|onde|qual|quais|quanto|por que|o que)\b/.test(t) || negacao.test(t)) return false;
  if (conversao.test(t) && /\b(proposta|prop-\d{4})\b/.test(t)) return true;
  if (virar.test(t) && !indefinida.test(t) && (referenciaForte(t) || citaPessoa(t))) return true;
  return (/\b(concluir|conclua|converter|converta)\b/.test(t) && (/\b(proposta|prop-\d{4}|negocio|formulario)\b/.test(t) || /^(pode )?(concluir|conclua|converter|converta)[.!]?$/.test(t))) ||
    /\b(formulario|negocio)\b.*\b(dess[ae]|dest[ae]|da proposta|proposta assinada)\b/.test(t) ||
    /\b(continuar|continue|seguir|seguir com|dar continuidade)\b.*\bproposta\b/.test(t);
}

function resposta(f: FluxoContinuidade | null, reply: string, evento = "continuidade"): Resposta {
  return { fluxo: f, reply, evento };
}
function permitido(f: FluxoContinuidade, ctx: ContextoDoTurno): boolean {
  return !ctx.politicaIndisponivel && ctx.policy.includes("proposal.list") &&
    (!f.converter || ctx.policy.includes("proposal.create")) &&
    (!f.alvo || f.alvo.status === "completa" || f.alvo.status === "convertida" || ctx.policy.includes("proposal.send"));
}
function resumo(f: FluxoContinuidade): Resposta {
  const acao = f.alvo?.status === "assinada_proponente" && !f.completou
    ? `concluir a proposta ${f.alvo.codigo} sem enviar ao proprietário${f.converter ? " e convertê-la em negócio" : ""}`
    : `converter a proposta ${f.alvo?.codigo} em negócio`;
  return resposta({ ...f, etapa: "confirmacao" },
    `Posso ${acao}?${f.converter ? " Vou aproveitar os dados já preenchidos e o PDF assinado, sem criar formulário avulso." : ""}\n\nResponda SIM para confirmar ou NÃO para parar.`);
}
function alvoDe(v: unknown): Alvo | null {
  const p = obj(v);
  return typeof p.id === "string" && typeof p.status === "string" &&
    ["assinada_proponente", "completa", "convertida"].includes(p.status)
    ? { id: p.id, codigo: typeof p.codigo === "string" ? p.codigo : p.id, status: p.status } : null;
}

export async function iniciarContinuidade(ctx: ContextoDoTurno, deps: DepsDoFluxo, opts: { converter?: boolean } = {}): Promise<Resposta> {
  const f: FluxoContinuidade = {
    kind: "continuidade", etapa: "selecao", atualizadoEm: ctx.agora,
    converter: !!opts.converter || conversao.test(normalizar(ctx.texto)) || /\b(negocio|formulario)\b/.test(normalizar(ctx.texto)),
  };
  if (!ctx.policy.includes("proposal.list") || ctx.politicaIndisponivel) {
    return resposta(null, "Não consegui validar sua permissão para continuar essa proposta. Não criei outro formulário.", "continuidade_sem_politica");
  }
  const codigo = ctx.texto.match(/\bPROP-\d{4}-\d+\b/i)?.[0].toUpperCase();
  // Referência por pessoa não é um identificador inequívoco. Pedir código em
  // vez de escolher outra proposta porque só uma apareceu na primeira página.
  if (!codigo && citaPessoa(ctx.texto)) {
    return resposta(f, "Qual é o código dessa proposta (PROP-AAAA-NNNN)? Vou continuar a proposta indicada, sem abrir um formulário avulso.");
  }
  const r = await deps.acao(codigo ? "proposal.status" : "proposal.list", codigo ? { codigo } : {});
  if (!r || r.status !== 200) return resposta(f, "Não consegui consultar essa proposta agora. Nenhum formulário novo foi criado. Tente novamente informando o código da proposta.");
  const items: unknown[] = codigo ? [r.body.proposta] : Array.isArray(r.body.items) ? r.body.items : [];
  const candidatos = items.map(alvoDe).filter((p): p is Alvo => !!p);
  // Lista paginada não prova unicidade: pedir escolha/código, nunca assumir a mais recente.
  if (candidatos.length !== 1 || (!codigo && Number(r.body.total) > items.length)) {
    if (!candidatos.length) return resposta(f, "Não identifiquei uma proposta assinada para continuar. Qual é o código PROP-AAAA-NNNN? Não vou criar um formulário avulso.");
    return resposta({ ...f, candidatos }, `Qual proposta devo continuar?\n${candidatos.map((p, i) => `${i + 1}. ${p.codigo}`).join("\n")}\n\nResponda com o número ou com o código da proposta.`);
  }
  f.alvo = candidatos[0];
  if (!permitido(f, ctx)) return resposta(null, "Sua permissão atual não permite concluir/converter essa proposta pelo Max. Nenhum formulário novo foi criado.");
  if (!f.converter && f.alvo.status !== "assinada_proponente") return resposta(null, `A proposta ${f.alvo.codigo} já foi concluída. Se quiser, peça para convertê-la em negócio.`);
  return resumo(f);
}

export async function conduzirContinuidade(f: FluxoContinuidade, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  if (lerConfirmacao(ctx.texto) === "nao" || /^(cancelar|pare|parar|desistir)[.!]?$/i.test(ctx.texto.trim())) {
    return resposta(null, "Parei a continuidade por aqui. A proposta e qualquer operação já registrada continuam preservadas.");
  }
  if (!permitido(f, ctx)) return resposta({ ...f, etapa: f.alvo ? "resumo" : "selecao" }, "Não consegui validar sua permissão para continuar agora. Não criei outro formulário.");
  if (!f.chave && f.alvo && pedeContinuidade(ctx.texto)) {
    const texto = /\bPROP-\d{4}-\d+\b/i.test(ctx.texto) || citaPessoa(ctx.texto) ? ctx.texto : `${ctx.texto} ${f.alvo.codigo}`;
    return iniciarContinuidade({ ...ctx, texto }, deps);
  }
  if (lerConfirmacao(ctx.texto) === "nenhum" && f.etapa !== "selecao" && !pedeContinuidade(ctx.texto)) {
    return { liberar: true, fluxo: f, evento: "continuidade_outro_assunto" };
  }
  if (f.etapa === "selecao") {
    const codigo = ctx.texto.match(/\bPROP-\d{4}-\d+\b/i)?.[0];
    if (codigo) return iniciarContinuidade({ ...ctx, texto: `${f.converter ? "converter" : "concluir"} ${codigo}` }, deps);
    const n = /^\d+$/.test(ctx.texto.trim()) ? Number(ctx.texto.trim()) : 0;
    const alvo = f.candidatos?.[n - 1];
    if (alvo && !permitido({ ...f, alvo }, ctx)) return resposta(f, "Sua permissão atual não permite continuar essa proposta. Escolha outra ou responda NÃO para parar.");
    return alvo ? resumo({ ...f, alvo, atualizadoEm: ctx.agora }) : resposta(f, "Informe o número da lista ou o código da proposta. Não abri outro formulário.");
  }
  if (f.etapa === "concluida") return resposta(f, f.resultado ?? "Essa operação já foi concluída.");
  if (f.etapa === "resumo") return resumo({ ...f, atualizadoEm: ctx.agora });
  if (lerConfirmacao(ctx.texto) !== "sim") return resumo({ ...f, atualizadoEm: ctx.agora });
  if (!f.alvo) return resposta(null, "Preciso identificar a proposta antes de continuar. Informe o código.");
  let proximo: FluxoContinuidade = { ...f, etapa: "execucao", atualizadoEm: ctx.agora };
  const args = { proposta_id: f.alvo.id };
  if (f.alvo.status === "assinada_proponente" && !f.completou) {
    const key = f.chave?.valor ?? ctx.messageId;
    proximo.chave = { verbo: "proposal.complete", valor: key };
    const r = await deps.acao("proposal.complete", args, key);
    if (!r || (r.status === 409 && r.body.error === "em_andamento")) {
      return resposta(proximo, `Ainda não confirmei o resultado da conclusão de ${f.alvo.codigo}. Responda SIM para verificar o mesmo pedido, sem duplicá-lo.`);
    }
    if (r.status !== 200 || r.body.status !== "completa") return resposta(null, "A plataforma não autorizou a conclusão dessa proposta. Não criei outro formulário; consulte o status comigo antes de continuar.");
    proximo = { ...proximo, completou: true, chave: undefined };
  }
  if (!f.converter) {
    const resultado = `Proposta ${f.alvo.codigo} concluída sem enviar ao proprietário.`;
    return resposta({ ...proximo, etapa: "concluida", chave: undefined, resultado }, resultado);
  }
  const key = proximo.chave?.valor ?? ctx.messageId;
  proximo.chave = { verbo: "proposal.convert", valor: key };
  const r = await deps.acao("proposal.convert", args, key);
  if (!r || (r.status === 409 && ["dossier_pending", "em_andamento"].includes(String(r.body.error)))) {
    return resposta(proximo, r?.body.error === "dossier_pending"
      ? `A proposta ${f.alvo.codigo} está concluída. O PDF final ainda está sendo preparado. Responda SIM para retomar a conversão da mesma proposta; os dados estão preservados.`
      : `Ainda não confirmei o resultado da conversão de ${f.alvo.codigo}. Responda SIM para verificar o mesmo pedido, sem criar outro negócio.`);
  }
  const negocio = obj(r.body.negocio);
  if ((r.status === 201 || (r.status === 409 && r.body.error === "already_converted")) && typeof negocio.link === "string") {
    const link = new URL(negocio.link, imobproBase()).toString();
    const resultado = `Proposta ${f.alvo.codigo} convertida em negócio, com os dados e o PDF assinado preservados.\n${link}`;
    return resposta({ ...proximo, etapa: "concluida", chave: undefined, resultado }, resultado, "proposta_convertida");
  }
  return resposta({ ...proximo, etapa: "resumo", chave: undefined }, r.body.error === "gerente_obrigatorio"
    ? "A proposta continua preservada, mas falta definir o gerente responsável para a conversão. Não criei formulário avulso."
    : "A plataforma não confirmou a conversão. A proposta foi preservada; nenhum formulário avulso foi criado.");
}
