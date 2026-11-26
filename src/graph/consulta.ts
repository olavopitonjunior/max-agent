import type { DepsDoFluxo } from "./fluxos";
import { buscarPropostas, codigoCitado, paraListada, pedeBusca, pedeLista, termoDeBusca, type PropostaListada } from "./localizar";
import { ehAjusteDeLista, PEDE_TODOS, pedeListaDeEquipeImplicita, pedidoDeLista, responderListaFiltrada } from "./consulta-equipe";
import { normalizar } from "./tools";
import { normalizarParaIntencao } from "./formularios/intencao";

/**
 * Consultar propostas — listar, procurar pelo nome/endereço/código, ver o
 * status — respondida pelo SISTEMA, sem o modelo (09/10/2026).
 *
 * Teste de 09/10 com o modelo de produção: "procure a proposta da letícia"
 * respondeu "encontrei 1" com duas no sistema (a tool de leitura não busca: o
 * nano filtrava as 10 recentes de cabeça); "liste as minhas propostas" saiu sem
 * código e com "quer ver o resto?" sem resto; "me mostra a PROP-2026-0013"
 * respondeu "não tenho acesso a esse código". A busca é a mesma da conversão e
 * da exclusão (`proposal.list` com `busca`, todas as propostas da pessoa).
 */

const PROPOSTA = /\bpropostas?\b/;
/** Verbos e perguntas de consulta. "Tem/existe proposta…", "como está…", "status…". */
const CONSULTA = /\b(status|situacao|andamento|como (esta|anda|ficou|vai)|ja (foi |foram )?assinad\w*|tem (alguma )?propostas?|existe\w* (alguma )?propostas?|mostr\w*|ver|veja|abr[ae]|detalh\w*|quais|qual|consult\w*)\b/;
/** Criação nunca é consulta: "faz uma proposta", "nova proposta". */
const CRIACAO = /\b(nova|novo|outra)\s+proposta\b|\b(fa[zc]\w*|cri\w+|ger\w+|mont\w+|prepar\w+|elabor\w+|abr\w*|inici\w+|comec\w+)\s+(uma\s+|a\s+)?proposta\b|\buma proposta (de|pra|para|pro)\b/;

const ANDAMENTO = "andamento";
const ESTADOS: [RegExp, string][] = [
  // "em andamento" = qualquer proposta ainda viva; não confundir com a pergunta
  // "como está o andamento da proposta…" (26/10, smoke real).
  [/\bem (andamento|aberto)\b|\b(ativas?|vivas?)\b/, ANDAMENTO],
  [/\brascunhos?\b/, "rascunho"],
  [/\benviadas?\b/, "enviada"],
  [/\bassinadas?\b/, "assinada"],
  [/\brecusadas?\b/, "recusada"],
  [/\bexpiradas?\b/, "expirada"],
  [/\bcanceladas?\b/, "cancelada"],
  [/\bconvertidas?\b/, "convertida"],
];

/** O estado pedido ("quais estão em rascunho?"), normalizado. */
function estadoPedido(texto: string): string | null {
  const t = normalizar(texto);
  return ESTADOS.find(([re]) => re.test(t))?.[1] ?? null;
}

/**
 * Ajuste curto de uma lista pedida antes ("Que sou responsável", "Todos",
 * "Outubro 2026 pendentes e assinatura") herda o pedido anterior: devolve o
 * texto a interpretar — o ajuste primeiro (vale o mais novo), o pedido depois,
 * separados por ponto para a maiúscula do começo de frase não virar nome de
 * cliente. Sem ajuste ou sem pedido de lista nas últimas mensagens, devolve o
 * texto como veio. Caso real: gerente da Newcore, 02/11 à noite, em 4 mensagens
 * seguidas o Newton esqueceu o que ela tinha pedido.
 */
export function textoDaConsulta(
  texto: string,
  historico: { role: string; content: unknown }[],
  agora: Date = new Date()
): string {
  if (pedeConsulta(texto) || !ehAjusteDeLista(texto, agora)) return texto;
  // Só herda se a última resposta foi uma lista de propostas: ajuste solto, depois
  // de outro assunto, não é continuação (review do PR #166).
  const ultimaResposta = [...historico].reverse().find((m) => m.role === "assistant" && typeof m.content === "string");
  if (!ultimaResposta || !/\bPROP-\d{4}-\d+|\bpropostas?\b/i.test(ultimaResposta.content as string)) return texto;
  const anteriores = historico
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .map((m) => m.content as string)
    .slice(-4)
    .reverse();
  const ajustes = [PEDE_TODOS.test(texto) ? "da equipe" : texto];
  for (const t of anteriores) {
    if (pedeConsulta(t)) return [...ajustes, t].join(". ");
    if (!ehAjusteDeLista(t, agora)) return texto;
    ajustes.push(PEDE_TODOS.test(t) ? "da equipe" : t);
  }
  return texto;
}

/**
 * O pedido é CONSULTAR propostas? Exige falar de proposta (ou citar o código)
 * e um verbo/pergunta de consulta — e o que procurar (nome, código, estado) ou
 * o pedido da lista. Quem chama já descartou excluir/duplicar/editar,
 * conversão e envio, que vêm antes.
 */
export function pedeConsulta(texto: string, opts?: { tolerante?: boolean }): boolean {
  const t = normalizar(texto).replace(/^max\b[\s,:-]*/, "");
  const codigo = codigoCitado(texto);
  // v2: "nova porposta" também é criação (o guarda fica mais estrito, nunca mais frouxo).
  const criacao = CRIACAO.test(t) || (opts?.tolerante === true && CRIACAO.test(normalizarParaIntencao(t)));
  // "Outubro de 2026 somente as destinadas à Adélia como gerente, com o nome do corretor" (02/11).
  if (!criacao && !codigo && pedeListaDeEquipeImplicita(texto)) return true;
  if (!PROPOSTA.test(t) && !codigo) return false;
  if (criacao) return false;
  if (pedidoDeLista(texto)) return true;
  if (pedeContagem(texto)) return true;
  if (pedeLista(texto)) return true;
  if (!(pedeBusca(texto) || CONSULTA.test(t))) return false;
  return !!(codigo || termoDeBusca(texto) || estadoPedido(texto));
}

function linhaCurta(p: PropostaListada): string {
/**
 * "Quantas propostas eu tenho?": a pergunta é o NÚMERO, sem situação, nome nem código (com eles, a consulta de
 * sempre já responde). Respondida com o total do servidor; sem ele, nunca um número inventado (prod 26/11: o
 * modelo escreveu "só consigo listar *mostrando 5*... e há mais na fila").
 */
function pedeContagem(texto: string): boolean {
  const t = normalizar(texto);
  return /\bquantas\s+propostas\b/.test(t) && !codigoCitado(texto) && !estadoPedido(texto) && !termoDeBusca(texto) && !pedidoDeLista(texto);
}

async function responderContagem(deps: DepsDoFluxo): Promise<{ reply: string; evento: string }> {
  const r = await deps.acao("proposal.list", {});
  if (!r || r.status !== 200) return { reply: "Não consegui consultar suas propostas agora. Tente de novo em instantes.", evento: "consulta_sem_resposta" };
  const vistas = Array.isArray(r.body.items) ? r.body.items.length : 0;
  const total = Number(r.body.total);
  if (Number.isInteger(total) && total >= vistas && (total > 0 || vistas === 0)) {
    if (total === 0) return { reply: "Você ainda não tem propostas no sistema.", evento: "consulta_contagem" };
    return { reply: `Você tem ${total} ${total === 1 ? "proposta" : "propostas"}. Quer que eu liste as mais recentes?`, evento: "consulta_contagem" };
  }
  // Sem o total do servidor: o que se viu é só o piso. O texto diz "pelo menos" e lista, sem inventar número.
  const itens = (Array.isArray(r.body.items) ? r.body.items : []).map(paraListada).filter((p): p is PropostaListada => !!p);
  if (!itens.length) return { reply: "Você ainda não tem propostas no sistema.", evento: "consulta_contagem" };
  return {
    reply: `Você tem pelo menos ${itens.length} ${itens.length === 1 ? "proposta" : "propostas"}; não consegui o total exato agora. As mais recentes:\n${itens.slice(0, 10).map((p) => `• ${linhaCurta(p)}`).join("\n")}`,
    evento: "consulta_contagem",
  };
}

  return [p.codigo, p.titulo, p.estado ?? p.status].filter(Boolean).join(" — ");
}

/** Encerradas na visão do CM (status-view.ts): o rótulo vale quando o corpo não traz o status cru. */
const ENCERRADOS = ["convertida", "recusada_proponente", "expirada", "cancelada"];
const ROTULOS_ENCERRADOS = ["virou negocio", "recusada", "expirada", "cancelada"];
const encerrada = (p: PropostaListada) =>
  ENCERRADOS.includes(p.status) || ROTULOS_ENCERRADOS.includes(normalizar(p.estado ?? ""));

const casaEstado = (p: PropostaListada, estado: string) =>
  estado === ANDAMENTO ? !encerrada(p) : normalizar(`${p.estado ?? ""} ${p.status}`).includes(estado);
/** "em rascunho", "em andamento" (nunca "em em…"). */
const emEstado = (estado: string) => `em ${estado === ANDAMENTO ? "andamento" : estado}`;

/**
 * A resposta da consulta. Uma proposta: o detalhe com quem já assinou. Várias:
 * código, título e situação de cada uma (até 10), e quantas há ao todo.
  if (pedeContagem(texto)) return responderContagem(deps);
 */
export async function responderConsulta(deps: DepsDoFluxo, texto: string): Promise<{ reply: string; evento: string }> {
  // Mês, várias situações, equipe/responsável: o servidor filtra (02/11, caso da gerente da Newcore).
  const filtrada = pedidoDeLista(texto);
  if (filtrada) {
    const r = await responderListaFiltrada(deps, filtrada);
    // Plataforma antiga e pedido que o fluxo de sempre já atendia (só situações, nas
    // minhas): não troca uma resposta que funcionava por uma recusa.
    if (!(r.evento === "consulta_filtro_indisponivel" && filtrada.escopo === "minhas" && !filtrada.mes)) return r;
  }
  const r = await buscarPropostas(deps, texto);
  // Com quem/código citado, o estado é a PERGUNTA ("a do Carlos já foi
  // assinada?"), não filtro: mostra a proposta com a situação real (review 09/10).
  const estado = r?.termo ? null : estadoPedido(texto);
  if (!r) return { reply: "Não consegui consultar suas propostas agora. Tente de novo em instantes.", evento: "consulta_sem_resposta" };
  const itens = estado ? r.itens.filter((p) => casaEstado(p, estado)) : r.itens;
  // O servidor não filtra por estado: com o filtro aplicado aqui, o total dele
  // não vale mais — e, se ele tinha mais do que mandou, a resposta diz que olhou
  // só as mais recentes (nunca "você não tem" sobre o que não viu).
  const total = estado ? itens.length : r.total;
  const parcial = !!estado && r.total > r.itens.length;
  const sobre = [r.termo ? `"${r.termo}"` : "", estado ? emEstado(estado) : ""].filter(Boolean).join(" ");

  if (parcial) {
    return {
      reply: itens.length
        ? `Entre as suas ${r.itens.length} propostas mais recentes, ${itens.length} ${itens.length === 1 ? "está" : "estão"} ${emEstado(estado!)}:\n${itens.map((p) => `• ${linhaCurta(p)}`).join("\n")}`
        : `Nenhuma das suas ${r.itens.length} propostas mais recentes está ${emEstado(estado!)}. Para uma mais antiga, diga o nome do cliente ou o código.`,
      evento: "consulta_estado_parcial",
    };
  }
  if (!itens.length) {
    // Sem nenhuma viva (só encerradas, ou nenhuma): diz isso, sem listar a encerrada (26/10).
    if (estado === ANDAMENTO && !r.termo) return { reply: "Nenhuma proposta em andamento no momento. Para ver uma encerrada, diga o nome do cliente ou o código.", evento: "consulta_vazia" };
    return {
      reply: sobre
        ? `Não achei proposta sua ${r.termo ? `com ${sobre}` : sobre}. Confira o nome, o endereço ou o código (PROP-…).`
        : "Você ainda não tem propostas no sistema.",
      evento: "consulta_vazia",
    };
  }
  if (itens.length === 1 && total <= 1) {
    const p = itens[0]!;
    const assinaturas = p.assinaturas?.length ? `\nAssinaturas: ${p.assinaturas.map((a) => `${a.nome} (${a.status})`).join(", ")}.` : "";
    return { reply: `${p.codigo}${p.titulo ? ` — ${p.titulo}` : ""}: ${p.estado ?? p.status}.${assinaturas}`, evento: "consulta_uma" };
  }
  const mostradas = itens.slice(0, 10);
  const cabeca = sobre ? `Achei ${total} propostas ${r.termo ? `com ${sobre}` : sobre}:` : `Suas propostas mais recentes${total > mostradas.length ? ` (${mostradas.length} de ${total})` : ""}:`;
  const resto = total > mostradas.length ? "\nPara achar outra, diga o nome do cliente, o endereço ou o código." : "";
  return { reply: `${cabeca}\n${mostradas.map((p) => `• ${linhaCurta(p)}`).join("\n")}${resto}`, evento: "consulta_lista" };
}
