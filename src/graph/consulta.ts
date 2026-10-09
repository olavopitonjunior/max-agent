import type { DepsDoFluxo } from "./fluxos";
import { buscarPropostas, codigoCitado, pedeBusca, pedeLista, termoDeBusca, type PropostaListada } from "./localizar";
import { normalizar } from "./tools";

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

const ESTADOS: [RegExp, string][] = [
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
 * O pedido é CONSULTAR propostas? Exige falar de proposta (ou citar o código)
 * e um verbo/pergunta de consulta — e o que procurar (nome, código, estado) ou
 * o pedido da lista. Quem chama já descartou excluir/duplicar/editar,
 * conversão e envio, que vêm antes.
 */
export function pedeConsulta(texto: string): boolean {
  const t = normalizar(texto).replace(/^max\b[\s,:-]*/, "");
  const codigo = codigoCitado(texto);
  if (!PROPOSTA.test(t) && !codigo) return false;
  if (CRIACAO.test(t)) return false;
  if (pedeLista(texto)) return true;
  if (!(pedeBusca(texto) || CONSULTA.test(t))) return false;
  return !!(codigo || termoDeBusca(texto) || estadoPedido(texto));
}

function linhaCurta(p: PropostaListada): string {
  return [p.codigo, p.titulo, p.estado ?? p.status].filter(Boolean).join(" — ");
}

const casaEstado = (p: PropostaListada, estado: string) => normalizar(`${p.estado ?? ""} ${p.status}`).includes(estado);

/**
 * A resposta da consulta. Uma proposta: o detalhe com quem já assinou. Várias:
 * código, título e situação de cada uma (até 10), e quantas há ao todo.
 */
export async function responderConsulta(deps: DepsDoFluxo, texto: string): Promise<{ reply: string; evento: string }> {
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
  const sobre = [r.termo ? `"${r.termo}"` : "", estado ? `em ${estado}` : ""].filter(Boolean).join(" ");

  if (parcial) {
    return {
      reply: itens.length
        ? `Entre as suas ${r.itens.length} propostas mais recentes, ${itens.length} ${itens.length === 1 ? "está" : "estão"} em ${estado}:\n${itens.map((p) => `• ${linhaCurta(p)}`).join("\n")}`
        : `Nenhuma das suas ${r.itens.length} propostas mais recentes está em ${estado}. Para uma mais antiga, diga o nome do cliente ou o código.`,
      evento: "consulta_estado_parcial",
    };
  }
  if (!itens.length) {
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
