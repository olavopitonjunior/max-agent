import { consultarEscopo, subjectDe } from "@/lib/scope";
import type { Candidate } from "@/lib/identity";
import { imobproBase } from "@/lib/http";

/**
 * Negócio citado PELO NOME ("pendências do negócio TESTE assinatura 4",
 * "status do contrato do TESTE1").
 *
 * O contrato do `deal.list` não tem filtro de texto (só `estado`/`limite`/
 * `cursor`) e o contrato com o ImobPro não muda aqui: lista-se a carteira
 * visível à pessoa e o casamento é pelo título, do lado de cá. Quem decide o
 * que a pessoa vê continua sendo o servidor.
 *
 * Duas regras que vêm de produção (10/11/2026):
 *  - nome que TERMINA em dígito ("TESTE1", "TESTE assinatura 4") nunca é índice
 *    de lista: o modelo lia "TESTE1" como "item 1" e consultava outro negócio;
 *  - 0 ou mais de 1 casamento nunca vira palpite: vira pergunta.
 */

export function normalizarNome(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A frase que vem depois de "negócio" / "contrato do" / "comprador do" /
 * "pendências do" / "status do". Cortada no fim da pergunta ou de um pedido de
 * cortesia. `null` quando não há nome (pergunta genérica) ou quando é só um
 * número de lista ("o negócio 3").
 */
export function nomeDeNegocioCitado(texto: string): { frase: string; explicita: boolean } | null {
  const t = texto.replace(/\s+/g, " ").trim();
  // `explicita`: a pessoa disse que é um NEGÓCIO/contrato/comprador. Nas demais
  // ("pendências do X", "status do X") X pode ser qualquer coisa ("da semana"),
  // então só vale quando casa com um negócio; nunca vira "não achei".
  const candidatos: { re: RegExp; explicita: boolean }[] = [
    { re: /\b(?:contrato|comprador(?:a)?|vendedor(?:a)?|locat[aá]ri[oa]|formul[aá]rio)\s+d[oa]s?\s+(?:neg[oó]cio\s+)?([^?!.;\n]+)/giu, explicita: true },
    { re: /\bneg[oó]cio\s+(?:d[oae]s?\s+)?([^?!.;\n]+)/giu, explicita: true },
    { re: /\b(?:pend[eê]ncias?|status|situa[cç][aã]o|proposta)\s+d[oa]s?\s+(?:neg[oó]cio\s+)?([^?!.;\n]+)/giu, explicita: false },
  ];
  for (const { re, explicita } of candidatos) {
    const todos = [...t.matchAll(re)];
    const m = todos[todos.length - 1];
    if (!m) continue;
    // "o formulário do comprador do TESTE1": o 1º casamento já engoliu o papel
    // ("comprador do TESTE1"); tira os papéis de cabeça para sobrar só o nome.
    const frase = m[1]
      .replace(/^(?:(?:contrato|comprador(?:a)?|vendedor(?:a)?|locat[aá]ri[oa]|formul[aá]rio)\s+d[oa]s?\s+(?:neg[oó]cio\s+)?)+/iu, "")
      .replace(/\s+(?:por favor|pf|pra mim|para mim|agora|aí|ai)\s*$/iu, "")
      .replace(/^["“'‘]+|["”'’]+$/gu, "")
      .trim();
    if (frase.length < 3) continue;
    if (/^\d+$/.test(frase)) continue; // "o negócio 3": referência de lista
    if (/^(?:que|meu|minha|dele|dela|esse|essa|este|esta|aquele|aquela|ultimo|ultima|mesmo|mesma|contrato|negocio|formulario|proposta|semana|mes|dia|hoje|ano|corretor|cliente|comprador|vendedor)\b/u.test(normalizarNome(frase))) continue;
    // Nome próprio ou código tem maiúscula ou dígito; "mais antigo" não: só
    // esses valem como "tem que existir um negócio com esse nome".
    return { frase: frase.slice(0, 120), explicita: explicita && /[\p{Lu}0-9]/u.test(frase) };
  }
  return null;
}

export interface NegocioCasado {
  id: string;
  titulo: string;
  /** A linha inteira da listagem (já projetada pelo servidor para esta pessoa). */
  item: Record<string, unknown>;
}

/** Há casamento EXATO (título igual à frase, sem acento/caixa)? */
function temExato(frase: string, achados: NegocioCasado[]): boolean {
  const f = normalizarNome(frase);
  return achados.some((n) => normalizarNome(n.titulo) === f);
}

/**
 * Casa a frase com os títulos: igual (sem acento/caixa) vence; senão, título
 * que COMEÇA pela frase em fronteira de palavra ("TESTE assinatura 1" casa
 * "TESTE assinatura 1 - à vista", nunca "TESTE assinatura 10"); senão, título
 * contido na frase ("o negócio da Maria Silva ..."), mas só título de 2+
 * palavras ("Maria" não é o negócio de "Maria Silva") e só quando `contido`
 * não foi desligado (o bloqueio de CRIAÇÃO desliga: abrir "Maria Silva Santos"
 * não pode ser barrado por existir "Maria Silva"). Item sem id ou sem título
 * string não entra.
 */
export function casarNegociosPorTitulo(frase: string, itens: unknown[], opcoes: { contido?: boolean } = {}): NegocioCasado[] {
  const f = normalizarNome(frase);
  if (!f) return [];
  const lista: NegocioCasado[] = [];
  for (const it of itens) {
    if (!it || typeof it !== "object") continue;
    const { id, titulo } = it as { id?: unknown; titulo?: unknown };
    if (typeof id === "string" && typeof titulo === "string" && titulo.trim()) lista.push({ id, titulo: titulo.trim(), item: it as Record<string, unknown> });
  }
  const exatos = lista.filter((n) => normalizarNome(n.titulo) === f);
  if (exatos.length) return exatos;
  const prefixo = lista.filter((n) => {
    const t = normalizarNome(n.titulo);
    return t.startsWith(f) && !/[a-z0-9]/.test(t.charAt(f.length) || " ");
  });
  if (prefixo.length) return prefixo;
  if (opcoes.contido === false) return [];
  return lista.filter((n) => {
    const t = normalizarNome(n.titulo);
    return t.length >= 4 && t.includes(" ") && f.startsWith(t) && !/[a-z0-9]/.test(f.charAt(t.length) || " ");
  });
}

export type ResolucaoPorNome =
  | { tipo: "um"; negocio: NegocioCasado }
  | { tipo: "varios"; negocios: NegocioCasado[] }
  | { tipo: "nenhum" }
  | { tipo: "indisponivel" };

/**
 * Resposta fixa para "criar formulário para o comprador do <negócio que já
 * existe>": reaproveitar o negócio em vez de abrir um segundo com o mesmo nome.
 */
export function textoDeNegocioExistente(res: Extract<ResolucaoPorNome, { tipo: "um" | "varios" }>): string {
  if (res.tipo === "um") {
    // O Max não tem verbo que gere o link do formulário de uma PARTE de negócio
    // já aberto (`form.create` só abre negócio novo). Em vez de prometer, entrega
    // o caminho que existe: o negócio no ImobPro, logado.
    const titulo = res.negocio.titulo.length > 80 ? `${res.negocio.titulo.slice(0, 77)}...` : res.negocio.titulo;
    return [
      `Esse negócio já existe: *${titulo}*. Não abri um negócio novo para não duplicar.`,
      "Eu não gero o link do formulário de uma parte de um negócio já aberto. Pelo ImobPro, logado, você manda o link dali:",
      new URL(`/deals/${res.negocio.id}`, imobproBase()).toString(),
      "Se quiser, te mostro as pendências ou a situação do contrato dele.",
    ].join("\n");
  }
  const mostrados = res.negocios.slice(0, MAX_OPCOES);
  const lista = mostrados.map((n, i) => `${i + 1}. ${n.titulo.length > 80 ? `${n.titulo.slice(0, 77)}...` : n.titulo}`).join("\n");
  return `Achei mais de um negócio com esse nome. Qual deles?\n${lista}\nMe diga o nome completo do que você quer.`;
}

/** Opções numeradas na pergunta de ambiguidade (o resto some: "nome completo"). */
const MAX_OPCOES = 3;

/** Páginas de `deal.list` varridas para achar o nome (limite do servidor por página). */
const PAGINAS_MAX = 3;
const POR_PAGINA = 50;

/**
 * Lista a carteira visível (até `PAGINAS_MAX` páginas) e casa pelo título.
 * Só um casamento EXATO interrompe a leitura: um casamento fraco (prefixo,
 * contido) na página 1 não pode esconder o exato da página 2.
 * Falha de rede/servidor = `indisponivel`; NUNCA vira "nenhum".
 */
export async function resolverNegocioPorNome(params: {
  frase: string;
  identity: Candidate;
  fromPhone: string;
  /** `false` no bloqueio de criação: título contido na frase não conta. */
  contido?: boolean;
}): Promise<ResolucaoPorNome> {
  const opcoes = { contido: params.contido };
  const subject = subjectDe(params.identity);
  const itens: unknown[] = [];
  let cursor: string | undefined;
  for (let pagina = 0; pagina < PAGINAS_MAX; pagina += 1) {
    const r = await consultarEscopo({
      orgId: params.identity.orgId,
      rawPhone: params.fromPhone,
      subject,
      verb: "deal.list",
      args: { limite: POR_PAGINA, ...(cursor ? { cursor } : {}) },
    });
    if (!r) return { tipo: "indisponivel" };
    itens.push(...r.items);
    if (temExato(params.frase, casarNegociosPorTitulo(params.frase, itens, opcoes)) || !r.nextCursor) break;
    cursor = r.nextCursor;
  }
  const casados = casarNegociosPorTitulo(params.frase, itens, opcoes);
  if (casados.length === 0) return { tipo: "nenhum" };
  if (casados.length === 1) return { tipo: "um", negocio: casados[0] };
  return { tipo: "varios", negocios: casados.slice(0, 5) };
}
