import type { DepsDoFluxo } from "./fluxos";
import { normalizar } from "./tools";

/**
 * Achar a proposta de que a pessoa fala — por código, pelo nome de quem está
 * nela, pelo título/endereço — em TODAS as propostas dela, não só nas 5 mais
 * recentes (decisão do Olavo, 09/10/2026).
 *
 * Prod 09/10: "transforme a proposta da Letícia" recebia "qual é o código?",
 * e "procure a da letícia" / "liste as minhas propostas" recebiam "informe o
 * número da lista" sem lista nenhuma. O corretor fala da proposta pelo nome do
 * cliente; o código é o último recurso, não o primeiro.
 *
 * Quem busca é o servidor (`proposal.list` com `busca`, sem acento e sem caixa,
 * no universo do usuário). O filtro local abaixo repete a regra sobre o que
 * voltou: um servidor antigo, que ignora `busca` e devolve as recentes, não
 * pode fazer o Max escolher a proposta de OUTRA pessoa.
 */

export interface PropostaListada {
  id: string;
  codigo: string;
  titulo?: string;
  status: string;
  estado?: string;
  nomes: string[];
}

/** Palavras que aparecem perto do nome sem ser nome (verbos, objetos do pedido). */
const NAO_E_NOME = new Set([
  "proposta", "propostas", "essa", "esta", "ela", "dela", "dele", "rascunho", "assinatura", "agora",
  "novamente", "favor", "whatsapp", "email", "mail", "novo", "nova", "mim", "venda", "locacao",
  "aluguel", "max", "sim", "selfie", "formulario", "negocio", "link", "contrato", "lista", "minhas",
  "minha", "meus", "todas", "codigo", "cliente", "clientes", "sistema", "assinada", "assinadas",
  "pdf", "status", "imobiliaria", "cpf", "cnpj", "rg", "telefone", "celular", "fone",
  // Tempo e verbos que vêm depois de "pra/de" sem ser nome ("pra corrigir", "de ontem").
  "ontem", "hoje", "amanha", "semana", "mes", "ano", "manha", "tarde", "noite", "passada", "passado",
  "corrigir", "ajustar", "mudar", "trocar", "alterar", "enviar", "mandar", "assinar", "ver", "conferir",
  "testar", "teste", "favor", "gentileza", "vez", "volta", "frente",
  "gerar", "criar", "fazer", "converter", "transformar", "virar", "concluir", "excluir", "apagar", "duplicar",
  "copiar", "editar", "aprovar", "cancelar", "preencher", "continuar", "seguir", "assinatura",
]);
const PREPOSICAO = /^(da|do|de|das|dos|pra|para|pro)$/;

const ESTADOS: Record<string, string> = {
  rascunho: "rascunho",
  enviada: "enviada",
  assinada: "assinada",
  assinadas: "assinada",
  recusada: "recusada",
  expirada: "expirada",
  cancelada: "cancelada",
  convertida: "convertida",
};

/** Código PROP-AAAA-NNNN citado, em maiúsculas. */
export function codigoCitado(texto: string): string | undefined {
  return texto.match(/\bPROP-\d{4}-\d+\b/i)?.[0].toUpperCase();
}

/**
 * O que a pessoa citou para achar a proposta: nomes (palavra com maiúscula fora
 * do começo, ou depois de "da/do/de/pra"), números de 3+ dígitos (endereço,
 * final do código). Normalizado e separado por espaço; `null` se nada.
 */
export function termoDeBusca(texto: string): string | null {
  const codigo = codigoCitado(texto);
  if (codigo) return codigo.toLowerCase();
  const palavras = texto.split(/\s+/).filter(Boolean);
  const muitosDigitos = (texto.match(/\d/g) ?? []).length >= 8;
  const citados: string[] = [];
  palavras.forEach((p, i) => {
    const limpa = p.replace(/[^\p{L}\p{N}-]/gu, "");
    const n = normalizar(limpa);
    if (!n || NAO_E_NOME.has(n) || ESTADOS[n]) return;
    const anterior = normalizar(palavras[i - 1] ?? "").replace(/[^a-z]/g, "");
    // 3 ou 4 dígitos: número do endereço, final do código. Mensagem com 8+
    // dígitos no total (CPF, telefone, mesmo picotado) não cede número nenhum —
    // iria para a busca e voltaria na resposta.
    const ehNumero = !muitosDigitos && /^\d{3,4}$/.test(n);
    // Maiúscula no começo de frase ("Concluir. Pode criar…") não é nome.
    const inicioDeFrase = i === 0 || /[.!?:]$/.test(palavras[i - 1] ?? "");
    const ehNome = n.length >= 3 && !/\d/.test(n) &&
      ((!inicioDeFrase && /^\p{Lu}/u.test(limpa)) || PREPOSICAO.test(anterior));
    if ((ehNumero || ehNome) && !citados.includes(n)) citados.push(n);
  });
  return citados.length ? citados.join(" ") : null;
}

/** "Liste/mostra/quais são as minhas propostas", "procure nas minhas propostas". */
export function pedeLista(texto: string): boolean {
  const t = normalizar(texto);
  return /\bpropostas\b/.test(t) && /\b(list\w*|mostr\w*|quais|ver|veja|minhas|todas|procur\w*|busc\w*)\b/.test(t);
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function paraListada(v: unknown): PropostaListada | null {
  const p = obj(v);
  if (typeof p.id !== "string" || typeof p.status !== "string") return null;
  const nomes = Array.isArray(p.signatarios)
    ? p.signatarios.map((s) => obj(s).nome).filter((n): n is string => typeof n === "string")
    : [];
  return {
    id: p.id,
    codigo: typeof p.codigo === "string" ? p.codigo : p.id,
    titulo: typeof p.titulo === "string" ? p.titulo : undefined,
    status: p.status,
    estado: typeof p.estado === "string" ? p.estado : undefined,
    nomes,
  };
}

/**
 * Todo token do termo casa com uma PALAVRA INTEIRA do código, do título ou de um
 * nome da proposta — nunca substring: "ana" não acha "Mariana", "202" não acha
 * todo código de 2026 (review 09/10). Nome com 4+ letras aceita prefixo
 * ("leti" → "Letícia"); número compara sem zeros à esquerda ("1" ≠, "0001" = "1"
 * só quando o termo tem 3+ dígitos, já garantido por `termoDeBusca`).
 */
export function casaComTermo(p: PropostaListada, termo: string): boolean {
  const palavras = normalizar(`${p.codigo} ${p.titulo ?? ""} ${p.nomes.join(" ")}`).split(/[^a-z0-9]+/).filter(Boolean);
  const semZeros = (x: string) => x.replace(/^0+(?=\d)/, "");
  return termo.split(/[^a-z0-9]+/).filter(Boolean).every((w) =>
    /^\d+$/.test(w)
      ? palavras.some((q) => /^\d+$/.test(q) && semZeros(q) === semZeros(w))
      : palavras.some((q) => q === w || (w.length >= 4 && q.startsWith(w))));
}

/**
 * Na SELEÇÃO, a resposta curta inteira é o termo ("Letícia", "leticia souza",
 * "rua das flores") — é exatamente o que o Max pediu ("me diga o nome"). Só até
 * 3 palavras e sem verbo/palavra de pedido; frase longa precisa da forma
 * explícita de busca ("procure a da X") para não sequestrar outro pedido.
 */
export function termoDaResposta(texto: string): string | null {
  const codigo = codigoCitado(texto);
  if (codigo) return codigo.toLowerCase();
  if ((texto.match(/\d/g) ?? []).length >= 8) return null;
  const palavras = normalizar(texto).replace(/^(a|o)\s+(da|do|de)\s+/, "").split(/[^a-z0-9]+/).filter(Boolean)
    .filter((w) => !/^(da|do|de|das|dos|a|o|e)$/.test(w));
  if (!palavras.length || palavras.length > 3) return null;
  if (palavras.some((w) => NAO_E_NOME.has(w) || ESTADOS[w] || w.length < 3 || /^\d{5,}$/.test(w))) return null;
  return palavras.join(" ");
}

/** "Procure/busque/ache a da X": a forma explícita de busca numa frase longa. */
export function pedeBusca(texto: string): boolean {
  return /\b(procur\w*|busc\w*|ach[ae]\w*|encontr\w*)\b/.test(normalizar(texto));
}

/**
 * Consulta o servidor. Com código: `proposal.status` (1 ou nenhuma). Com termo:
 * `proposal.list` com `busca`. Sem nada: as mais recentes. `null` = sem resposta.
 */
export async function buscarPropostas(
  deps: DepsDoFluxo,
  texto: string,
  /** Termo já decidido por quem chama (ex.: a resposta curta da seleção). */
  termoDado?: string | null
): Promise<{ itens: PropostaListada[]; total: number; termo: string | null } | null> {
  const codigo = codigoCitado(texto);
  if (codigo) {
    const r = await deps.acao("proposal.status", { codigo });
    if (!r) return null;
    if (r.status === 404) return { itens: [], total: 0, termo: codigo.toLowerCase() };
    if (r.status !== 200) return null;
    const p = paraListada(r.body.proposta);
    return { itens: p ? [p] : [], total: p ? 1 : 0, termo: codigo.toLowerCase() };
  }
  const termo = termoDado ?? termoDeBusca(texto);
  const r = await deps.acao("proposal.list", termo ? { busca: termo } : {});
  if (!r || r.status !== 200) return null;
  const brutos = (Array.isArray(r.body.items) ? r.body.items : []).map(paraListada).filter((p): p is PropostaListada => !!p);
  const itens = termo ? brutos.filter((p) => casaComTermo(p, termo)) : brutos;
  // Sem termo: o total do servidor. Com termo: se o servidor filtrou (ecoa
  // `busca`) e há mais casadas do que vieram, o total dele; se vimos todas, o
  // que casou AQUI (o filtro local é o mais estrito). Servidor antigo: o daqui.
  const totalDoServidor = Number(r.body.total) || 0;
  const filtrou = typeof r.body.busca === "string";
  const total = !termo ? Math.max(totalDoServidor, itens.length)
    : filtrou && totalDoServidor > brutos.length ? totalDoServidor : itens.length;
  return { itens, total, termo };
}

export function rotuloDaProposta(p: { codigo: string; titulo?: string; estado?: string }): string {
  return [p.codigo, p.titulo].filter(Boolean).join(" — ") + (p.estado ? ` (${p.estado})` : "");
}
