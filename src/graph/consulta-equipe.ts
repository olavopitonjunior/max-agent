import type { DepsDoFluxo } from "./fluxos";
import { codigoCitado, MESES, mesNoContexto, paraListada, termoDeBusca, type PropostaListada } from "./localizar";
import { normalizar } from "./tools";

/**
 * Lista de propostas por MÊS, por SITUAÇÃO (várias de uma vez) e, só por pedido
 * explícito, da EQUIPE ou de que a pessoa é RESPONSÁVEL (02/11/2026, caso da
 * gerente da Newcore).
 *
 * Teste real de 02/11: "Quero todas as propostas de outubro pendentes e
 * concluídas" virou busca pelo nome "outubro" e filtro "enviada"; "somente as
 * destinadas à Adélia como gerente, com o nome do corretor" não tinha como ser
 * atendido (a lista do servidor é só do criador). Regra do Olavo (05/10): a lista
 * padrão continua SÓ do que a pessoa criou; a da equipe é opt-in ("da equipe",
 * "de todos", "em que sou responsável", "como gerente").
 *
 * Quem filtra é o SERVIDOR (`proposal.list` com `escopo`, `mes`, `estados`):
 * aqui só se interpreta o pedido e se escreve a resposta, sem modelo.
 */

export type EscopoDeLista = "minhas" | "equipe" | "responsavel";

export interface PedidoDeLista {
  escopo: EscopoDeLista;
  /** "AAAA-MM" (mês de criação). */
  mes?: string;
  /** "outubro de 2026". */
  rotuloMes?: string;
  /** Códigos de `status` do servidor, sem repetição. */
  estados?: string[];
  /** "pendentes e concluídas". */
  rotuloEstados?: string;
  /** Nome de cliente/endereço citado, se houver. */
  busca?: string;
  /** Nome em "destinadas a X como gerente": lido como a própria pessoa, e a resposta diz isso. */
  nomeDoPapel?: string;
  /** Pediu "formulários" junto: não fazem parte desta lista. */
  comFormulario?: boolean;
}

const EQUIPE = /\b(da equipe|de todos|dos corretores|de todos os corretores|todos os corretores|da imobiliaria|de toda (a )?(equipe|imobiliaria)|toda a (equipe|imobiliaria))\b/;
const RESPONSAVEL = /\b(em que (eu )?sou (o |a )?(responsavel|gerente)|que sou (o |a )?(responsavel|gerente)|como (o |a )?(gerente|responsavel)|destinadas? ((a|ao|para|pra) )?\S+ como|(a|ao|para|pra) (?!(o|a|os|as|um|uma) )\S+ (gerente|responsavel)|sob (a )?minha responsabilidade|atribuidas? a mim|destinadas? a mim)\b/;
const NOME_DO_CORRETOR = /\b(nome do corretor|corretor de cada|qual corretor|de quem (e|sao))\b/;

/** Situações que o pedido nomeia → códigos de `status` do servidor. */
const GRUPOS: { re: RegExp; rotulo: string; estados: string[]; novo: boolean }[] = [
  {
    re: /\bpendentes?\b/, rotulo: "pendentes", novo: true,
    estados: ["rascunho", "aguardando_aprovacao", "falha_envio", "enviando", "enviada", "entregue", "visualizada", "assinada_proponente", "aguardando_vendedor"],
  },
  {
    re: /\b(concluidas?|completas?|finalizadas?)\b/, rotulo: "concluídas", novo: true,
    estados: ["completa", "convertida"],
  },
  {
    re: /\b(enviadas?( para| pra| p\/)? assinatura|enviadas?|aguardando assinatura|para assinatura|assinatura)\b/, rotulo: "enviadas para assinatura", novo: false,
    estados: ["enviando", "enviada", "entregue", "visualizada", "assinada_proponente", "aguardando_vendedor"],
  },
  { re: /\bassinadas?\b/, rotulo: "assinadas", novo: false, estados: ["assinada_proponente", "completa"] },
  { re: /\brascunhos?\b/, rotulo: "em rascunho", novo: false, estados: ["rascunho"] },
  { re: /\bcanceladas?\b/, rotulo: "canceladas", novo: false, estados: ["cancelada"] },
  { re: /\brecusadas?\b/, rotulo: "recusadas", novo: false, estados: ["recusada_proponente", "recusada_vendedor"] },
  { re: /\bexpiradas?\b/, rotulo: "expiradas", novo: false, estados: ["expirada"] },
];

/** Ano e mês de HOJE no relógio de Brasília. */
function hojeEmBrasilia(agora: Date): { ano: number; mes: number } {
  const partes = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(agora);
  const pega = (t: string) => Number(partes.find((x) => x.type === t)?.value);
  return { ano: pega("year"), mes: pega("month") };
}

const sa = (w: string | undefined) => normalizar(w ?? "").replace(/[^a-z0-9]/g, "");
const NOME_DO_MES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/**
 * O mês de CRIAÇÃO pedido: "de outubro", "outubro de 2026", "este mês", "mês
 * passado". Sem ano, o mais recente que já começou (em novembro, "outubro" é o
 * deste ano; em janeiro, "dezembro" é o do ano passado).
 */
export function mesPedido(texto: string, agora: Date = new Date()): { mes: string; rotulo: string } | null {
  const t = normalizar(texto);
  const hoje = hojeEmBrasilia(agora);
  const monta = (ano: number, m: number) => ({
    mes: `${ano}-${String(m).padStart(2, "0")}`,
    rotulo: `${NOME_DO_MES[m - 1]} de ${ano}`,
  });
  if (/\b(este|esse|neste|nesse|deste|desse) mes\b|\bmes atual\b/.test(t)) return monta(hoje.ano, hoje.mes);
  if (/\bmes passado\b|\bultimo mes\b/.test(t)) {
    return hoje.mes === 1 ? monta(hoje.ano - 1, 12) : monta(hoje.ano, hoje.mes - 1);
  }
  const palavras = texto.split(/\s+/).filter(Boolean);
  const i = palavras.findIndex((_, k) => mesNoContexto(palavras, k));
  if (i >= 0) {
    const m = MESES[normalizar(palavras[i]!.replace(/[^\p{L}]/gu, ""))]!;
    const ano = sa(palavras[i + 1]) === "de" && /^20[2-3]\d$/.test(sa(palavras[i + 2]))
      ? Number(sa(palavras[i + 2]))
      : /^20[2-3]\d$/.test(sa(palavras[i + 1])) ? Number(sa(palavras[i + 1])) : null;
    return monta(ano ?? (m > hoje.mes ? hoje.ano - 1 : hoje.ano), m);
  }
  return null;
}

/** Tira do texto as frases de PAPEL ("destinadas à Adélia como gerente") para o nome dela não virar busca de cliente. */
function semFrasesDePapel(texto: string): string {
  return texto
    .replace(/\b(destinad\w*|atribuid\w*)\s+((a|à|ao|para|pra)\s+)?\S+\s+como\s+(gerente|respons\w+)/gi, " ")
    .replace(/\b(a|ao|para|pra)\s+(?!(o|a|os|as|um|uma)\s)\S+\s+(gerente|respons\w+)/gi, " ")
    .replace(/\bcomo\s+(o\s+|a\s+)?(gerente|respons\w+)\b/gi, " ");
}

/**
 * O pedido é uma lista que o fluxo antigo (criadas por mim, sem período, um
 * estado de cada vez) não atende? `null` = fluxo antigo, nada muda.
 */
export function pedidoDeLista(texto: string, agora: Date = new Date()): PedidoDeLista | null {
  if (codigoCitado(texto)) return null;
  const t = normalizar(texto);
  const escopo: EscopoDeLista = RESPONSAVEL.test(t) ? "responsavel" : EQUIPE.test(t) ? "equipe" : "minhas";
  const mes = mesPedido(texto, agora);
  const grupos = GRUPOS.filter((g) => g.re.test(t));
  const estados = [...new Set(grupos.flatMap((g) => g.estados))];
  const novo = grupos.some((g) => g.novo) || grupos.length >= 2;
  if (escopo === "minhas" && !mes && !novo) return null;
  const busca = termoDeBusca(semFrasesDePapel(texto)) ?? undefined;
  // Com nome citado e só a situação, a situação é a PERGUNTA ("a da Letícia já foi
  // assinada e concluída?"), não filtro: o fluxo antigo mostra a real (review 09/10).
  if (escopo === "minhas" && !mes && busca) return null;
  const nomeDoPapel =
    texto.match(/\b(?:destinad\w*|atribuid\w*)\s+(?:(?:a|à|ao|para|pra)\s+)?(\S+)\s+como\b/i)?.[1] ??
    texto.match(/\b(?:a|à|ao|para|pra)\s+(?!(?:o|a|os|as|um|uma)\s)(\S+)\s+(?:gerente|respons\w+)/i)?.[1];
  return {
    escopo,
    ...(nomeDoPapel ? { nomeDoPapel: nomeDoPapel.replace(/[^\p{L}]/gu, "") } : {}),
    ...(/\bformul[aá]rios?\b/i.test(texto) ? { comFormulario: true } : {}),
    ...(mes ? { mes: mes.mes, rotuloMes: mes.rotulo } : {}),
    ...(estados.length ? { estados, rotuloEstados: grupos.map((g) => g.rotulo).join(" e ") } : {}),
    ...(busca ? { busca } : {}),
  };
}

/**
 * Pedido de lista que NÃO diz "propostas" ("Outubro de 2026 somente as
 * destinadas à Adélia como gerente, com o nome do corretor"): vale quando traz
 * o papel/equipe E o mês, ou o papel E o nome do corretor.
 */
export function pedeListaDeEquipeImplicita(texto: string): boolean {
  const t = normalizar(texto);
  const papel = RESPONSAVEL.test(t) || EQUIPE.test(t);
  return papel && (!!mesPedido(texto) || NOME_DO_CORRETOR.test(t));
}

const dia = (iso?: string) =>
  iso ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" }).format(new Date(iso)) : undefined;

function linha(p: PropostaListada, comCorretor: boolean): string {
  const partes = [p.codigo, p.titulo, p.estado ?? p.status];
  if (comCorretor) partes.push(`corretor: ${p.corretor ?? "não informado"}`);
  const criada = dia(p.criadoEm);
  if (criada) partes.push(`criada em ${criada}`);
  return `• ${partes.filter(Boolean).join(" — ")}`;
}

const DICA_EQUIPE = (mes?: string) =>
  `Para ver as de toda a equipe ou as em que você é responsável, peça "propostas da equipe${mes ? ` de ${mes.split(" de ")[0]}` : ""}" ou "em que sou responsável".`;

export async function responderListaFiltrada(
  deps: DepsDoFluxo,
  pedido: PedidoDeLista
): Promise<{ reply: string; evento: string }> {
  const args: Record<string, unknown> = { escopo: pedido.escopo };
  if (pedido.mes) args.mes = pedido.mes;
  if (pedido.estados) args.estados = pedido.estados;
  if (pedido.busca) args.busca = pedido.busca;
  const r = await deps.acao("proposal.list", args);
  if (!r || r.status !== 200) {
    return { reply: "Não consegui consultar as propostas agora. Tente de novo em instantes.", evento: "consulta_sem_resposta" };
  }
  // Servidor antigo ignora `escopo`/`mes`/`estados` e não ecoa o escopo: mostrar a
  // lista dele seria responder outra pergunta com cara de resposta certa.
  if (typeof r.body.escopo !== "string") {
    return {
      reply: "Ainda não consigo filtrar por mês, situação ou equipe por aqui. Posso listar suas propostas mais recentes ou procurar pelo nome do cliente ou pelo código.",
      evento: "consulta_filtro_indisponivel",
    };
  }
  const itens = (Array.isArray(r.body.items) ? r.body.items : []).map(paraListada).filter((p): p is PropostaListada => !!p);
  const total = Math.max(Number(r.body.total) || 0, itens.length);
  const sobre = [pedido.rotuloMes ? `em ${pedido.rotuloMes}` : "", pedido.rotuloEstados ? `(${pedido.rotuloEstados})` : "", pedido.busca ? `com "${pedido.busca}"` : ""]
    .filter(Boolean).join(" ");
  const quem = pedido.escopo === "equipe" ? "da equipe" : pedido.escopo === "responsavel" ? "em que você é responsável" : "criadas por você";

  if (!itens.length) {
    return {
      reply: [
        `Não achei propostas ${quem}${sobre ? ` ${sobre}` : ""}.`,
        pedido.escopo === "minhas" ? DICA_EQUIPE(pedido.rotuloMes) : "",
        pedido.nomeDoPapel ? `(Entendi "${pedido.nomeDoPapel}" como você. Se for outra pessoa, ela mesma precisa pedir.)` : "",
      ].filter(Boolean).join("\n"),
      evento: "consulta_vazia",
    };
  }
  const comCorretor = pedido.escopo !== "minhas" || itens.some((p) => p.corretor);
  const notas = [
    pedido.nomeDoPapel ? `\n(Entendi "${pedido.nomeDoPapel}" como você. Se for outra pessoa, ela mesma precisa pedir.)` : "",
    pedido.comFormulario ? "\n(Formulários não entram nesta lista; peça-os à parte.)" : "",
  ].join("");
  const cabeca = `${total} ${total === 1 ? "proposta" : "propostas"} ${quem}${sobre ? ` ${sobre}` : ""}:`;
  const resto = total > itens.length ? `\nMostrando ${itens.length} de ${total}. Para afunilar, diga o nome do cliente ou a situação.` : "";
  const truncado = r.body.truncado === true ? "\n(A busca olhou só as 500 mais recentes; diga o mês para afunilar.)" : "";
  const dica = pedido.escopo === "minhas" ? `\n${DICA_EQUIPE(pedido.rotuloMes)}` : "";
  return { reply: `${cabeca}\n${itens.map((p) => linha(p, comCorretor)).join("\n")}${resto}${truncado}${dica}${notas}`, evento: "consulta_lista_filtrada" };
}

/** Palavras que só fazem sentido como AJUSTE de uma lista pedida antes ("Todos", "Que sou responsável"). */
const AJUSTE = /\b(responsavel|gerente|todos|todas|equipe|corretor\w*)\b/;

/**
 * A mensagem é um ajuste curto de uma lista ("Que sou responsável", "Todos",
 * "Outubro 2026 pendentes e assinatura")? Sozinha ela não pede nada: só vale
 * herdando o pedido anterior (caso da gerente da Newcore, 02/11 à noite).
 * "Sim", "ok", "obrigada" NÃO são ajuste.
 */
export function ehAjusteDeLista(texto: string, agora: Date = new Date()): boolean {
  const t = normalizar(texto);
  if (t.split(/\s+/).filter(Boolean).length > 10) return false;
  return !!mesPedido(texto, agora) || GRUPOS.some((g) => g.re.test(t)) || AJUSTE.test(t);
}

/** "Todos" sozinho, respondendo à pergunta "só as suas ou de toda a equipe?". */
export const PEDE_TODOS = /^\s*(todos|todas|toda a equipe|de todos)\W*$/i;
