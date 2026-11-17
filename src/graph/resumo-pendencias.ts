/**
 * Resposta a "minhas pendências" montada pelo CÓDIGO, a partir do resultado do `pending.summary`.
 *
 * Medido em produção (16/11/2026): o modelo recebia o resumo e escrevia "hoje tenho 4 pendências"
 * para 4 NEGÓCIOS com formulário em aberto (23 campos faltando), omitia a atividade atrasada e
 * falava em primeira pessoa. Contar, separar e escolher a pessoa gramatical não é trabalho para um
 * modelo pequeno (mesma decisão do Newton): aqui o texto é determinístico e os números são os do
 * servidor.
 *
 * Contrato (docs/max.md do ContractMaker): a forma de `pending.summary` não muda. O servidor não
 * manda a data de vencimento da atividade, só `whenLabel` ("sáb, 25/10", "hoje, 16/11 15:30"), então
 * o atraso é contado do dia/mês do rótulo até hoje em São Paulo (o ano é o mais recente que não
 * passa de hoje; atividade atrasada nunca está no futuro).
 *
 * Títulos de negócio e de atividade são dado de terceiros: entram só como texto de lista, e a
 * saída ainda passa pelo `sanitizar` do `compose`.
 */

export type BlocoDoResumo = "formularios" | "propostas" | "atividades" | "avisos";

const FUSO = "America/Sao_Paulo";
const DIA_MS = 86_400_000;
/** Teto de itens por bloco (o servidor já corta em 5; a regra vale também aqui). */
const MAX_ITENS = 5;

const fmtDia = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" });

/** Dia civil de `agora` em São Paulo, como [ano, mês, dia]. */
function hojeEmSp(agora: number): [number, number, number] {
  const [a, m, d] = fmtDia.format(new Date(agora)).split("-").map(Number);
  return [a, m, d];
}

const indiceDoDia = (a: number, m: number, d: number): number => Math.round(Date.UTC(a, m - 1, d) / DIA_MS);

/** Dia/mês do rótulo ("sáb, 25/10", "hoje, 16/11 15:30"), ou null se não houver. */
function diaMesDoRotulo(rotulo: string): [number, number] | null {
  const m = /(\d{1,2})\/(\d{1,2})/.exec(rotulo);
  if (!m) return null;
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  return mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31 ? [dia, mes] : null;
}

/**
 * Dias entre o dia do rótulo e hoje (SP). Positivo = no passado (atraso), 0 = hoje, negativo =
 * futuro. `sentido` resolve o ano que o rótulo não traz: o mais recente que não passa de hoje
 * ("passado") ou o mais próximo que não é anterior a hoje ("futuro").
 */
function distanciaEmDias(rotulo: string, agora: number, sentido: "passado" | "futuro"): number | null {
  const dm = diaMesDoRotulo(rotulo);
  if (!dm) return null;
  const [ano, mesHoje, diaHoje] = hojeEmSp(agora);
  const hoje = indiceDoDia(ano, mesHoje, diaHoje);
  const [dia, mes] = dm;
  let alvo = indiceDoDia(ano, mes, dia);
  if (sentido === "passado" && alvo > hoje) alvo = indiceDoDia(ano - 1, mes, dia);
  if (sentido === "futuro" && alvo < hoje) alvo = indiceDoDia(ano + 1, mes, dia);
  return hoje - alvo;
}

/** Quantos dias a atividade está atrasada (0 = venceu hoje), ou null se o rótulo não tem data. */
export function diasDeAtraso(whenLabel: string, agora: number): number | null {
  if (/^\s*hoje\b/i.test(whenLabel) && !diaMesDoRotulo(whenLabel)) return 0;
  const d = distanciaEmDias(whenLabel, agora, "passado");
  return d === null ? null : d;
}

// ── Leitura defensiva do resumo (o servidor é a fonte, mas a forma não é confiável a ponto de lançar) ──

interface Atividade { title: string; dealTitle: string; whenLabel: string; atrasada: boolean }
interface Formulario { dealTitle: string; total: number }
interface Proposta { codigo: string; dealTitle: string | null; status: string }
interface Aviso { titulo: string }
interface Avisos { disponivel: boolean; total: number; totalExato: boolean; itens: Aviso[] }

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string => (typeof v === "string" ? v.replace(/[\r\n]+/g, " ").trim() : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function bloco(v: unknown): { total: number; itens: Record<string, unknown>[]; raw: Record<string, unknown> } {
  const o = obj(v) ?? {};
  const itens = lista(o.itens).map(obj).filter((x): x is Record<string, unknown> => x !== null);
  // Total nunca menor que o que está listado.
  return { total: Math.max(num(o.total), itens.length), itens, raw: o };
}

const plural = (n: number, um: string, varios: string): string => `${n} ${n === 1 ? um : varios}`;

function horaDoRotulo(rotulo: string): string | null {
  return /(\d{2}:\d{2})/.exec(rotulo)?.[1] ?? null;
}

function maisN(total: number, mostrados: number): string[] {
  return total > mostrados ? [`• e mais ${total - mostrados}`] : [];
}

function secaoFormularios(v: unknown): { total: number; linhas: string[] } {
  const b = bloco(v);
  const itens: Formulario[] = b.itens.map((i) => ({ dealTitle: str(i.dealTitle) || "Negócio sem título", total: num(i.total) }));
  const mostrados = itens.slice(0, MAX_ITENS);
  const linhas = mostrados.map((f) => `• ${f.dealTitle} — ${f.total > 0 ? `faltam ${plural(f.total, "campo", "campos")}` : "formulário em aberto"}`);
  return { total: b.total, linhas: [...linhas, ...maisN(b.total, mostrados.length)] };
}

function secaoPropostas(v: unknown): { total: number; linhas: string[] } {
  const b = bloco(v);
  const itens: Proposta[] = b.itens.map((i) => ({ codigo: str(i.codigo), dealTitle: str(i.dealTitle) || null, status: str(i.status) }));
  const mostrados = itens.slice(0, MAX_ITENS);
  const linhas = mostrados.map((p) => `• ${[p.codigo || "Proposta", p.dealTitle].filter(Boolean).join(" — ")}${p.status ? ` · ${p.status}` : ""}`);
  return { total: b.total, linhas: [...linhas, ...maisN(b.total, mostrados.length)] };
}

function secaoAtividades(v: unknown, agora: number): { total: number; atrasadas: number; hoje: number; demais: number; linhas: string[] } {
  const b = bloco(v);
  const atrasadasTotal = Math.min(num(b.raw.atrasadas), b.total);
  const hojeTotal = Math.min(num(b.raw.hoje), Math.max(b.total - atrasadasTotal, 0));
  const demaisTotal = Math.max(b.total - atrasadasTotal - hojeTotal, 0);
  const itens: Atividade[] = b.itens.slice(0, MAX_ITENS).map((i) => ({
    title: str(i.title) || "Atividade sem título",
    dealTitle: str(i.dealTitle),
    whenLabel: str(i.whenLabel),
    atrasada: i.atrasada === true,
  }));
  const rotuloDoNegocio = (a: Atividade): string => (a.dealTitle ? ` (${a.dealTitle})` : "");
  const atrasadas = itens.filter((a) => a.atrasada);
  const doDia = itens.filter((a) => !a.atrasada && (/^\s*hoje\b/i.test(a.whenLabel) || distanciaEmDias(a.whenLabel, agora, "futuro") === 0));
  const proximas = itens.filter((a) => !atrasadas.includes(a) && !doDia.includes(a));

  const linhas: string[] = [];
  if (atrasadasTotal > 0) {
    linhas.push(`*Atrasadas (${atrasadasTotal})*`);
    for (const a of atrasadas) {
      const d = diasDeAtraso(a.whenLabel, agora);
      const hora = horaDoRotulo(a.whenLabel);
      const quando =
        d === null ? "atrasada" : d === 0 ? `venceu hoje${hora ? ` às ${hora}` : ""}` : `atrasada há ${plural(d, "dia", "dias")}`;
      linhas.push(`• ${a.title}${rotuloDoNegocio(a)} — ${quando}`);
    }
    linhas.push(...maisN(atrasadasTotal, atrasadas.length));
  }
  if (hojeTotal > 0) {
    if (linhas.length) linhas.push("");
    linhas.push(`*Hoje (${hojeTotal})*`);
    for (const a of doDia) linhas.push(`• ${a.title}${rotuloDoNegocio(a)} — ${horaDoRotulo(a.whenLabel) ?? "dia inteiro"}`);
    linhas.push(...maisN(hojeTotal, doDia.length));
  }
  if (demaisTotal > 0) {
    if (linhas.length) linhas.push("");
    linhas.push(`*Próximos dias (${demaisTotal})*`);
    for (const a of proximas) linhas.push(`• ${a.title}${rotuloDoNegocio(a)} — ${a.whenLabel}`);
    linhas.push(...maisN(demaisTotal, proximas.length));
  }
  return { total: b.total, atrasadas: atrasadasTotal, hoje: hojeTotal, demais: demaisTotal, linhas };
}

function lerAvisos(v: unknown): Avisos {
  const o = obj(v);
  if (!o || o.disponivel !== true) return { disponivel: false, total: 0, totalExato: true, itens: [] };
  const itens = lista(o.itens).map(obj).filter((x): x is Record<string, unknown> => x !== null).map((i) => ({ titulo: str(i.titulo) || str(i.corpo) })).filter((i) => i.titulo);
  return { disponivel: true, total: Math.max(num(o.total), itens.length), totalExato: o.totalExato !== false, itens };
}

export interface OpcoesDoResumo {
  /** Epoch ms de "agora" (injetável para teste). */
  agora: number;
  /** Blocos pedidos. Omitido = formulários, propostas e atividades (+ avisos se o resumo os trouxe). */
  blocos?: readonly BlocoDoResumo[];
}

/**
 * O texto do resumo para o usuário. Ordem por urgência: atividades (atrasada/hoje) primeiro, depois
 * formulários, propostas e avisos. O `compose` corta em 500 caracteres/6 linhas e guarda o resto
 * ("Quer ver o resto?"); o que não pode ficar no resto é o que vence, e os totais vão na primeira linha.
 * `resumo` é o item de `pending.summary`; só os blocos pedidos
 * entram (o servidor devolve os outros zerados, e "zero" de um bloco não consultado não é "nada").
 */
export function renderizarResumoDePendencias(resumo: unknown, opcoes: OpcoesDoResumo): string {
  const r = obj(resumo) ?? {};
  const pedidos = new Set<BlocoDoResumo>(opcoes.blocos ?? ["formularios", "propostas", "atividades", ...(Object.hasOwn(r, "avisos") ? (["avisos"] as const) : [])]);

  const resumos: string[] = [];
  const vazios: string[] = [];
  const secoes: string[][] = [];

  if (pedidos.has("atividades")) {
    const a = secaoAtividades(r.atividades, opcoes.agora);
    if (a.total > 0) {
      resumos.push(plural(a.total, "atividade aberta", "atividades abertas"));
      // Sem título próprio: Atrasadas / Hoje / Próximos dias já são os títulos (cada linha conta no teto de 6).
      secoes.push(a.linhas);
    } else vazios.push("atividades abertas");
  }
  if (pedidos.has("formularios")) {
    const f = secaoFormularios(r.formularios);
    if (f.total > 0) {
      resumos.push(`${plural(f.total, "negócio com formulário a preencher", "negócios com formulário a preencher")}`);
      secoes.push([`*Formulários a preencher* (${f.total})`, ...f.linhas]);
    } else vazios.push("formulários a preencher");
  }
  if (pedidos.has("propostas")) {
    const p = secaoPropostas(r.propostas);
    if (p.total > 0) {
      resumos.push(plural(p.total, "proposta em andamento", "propostas em andamento"));
      secoes.push([`*Propostas em andamento* (${p.total})`, ...p.linhas]);
    } else vazios.push("propostas em andamento");
  }
  if (pedidos.has("avisos")) {
    const av = lerAvisos(r.avisos);
    if (!av.disponivel) {
      secoes.push(["*Avisos*", "Os avisos não estão disponíveis agora."]);
    } else if (av.total > 0) {
      const n = av.totalExato ? String(av.total) : `mais de ${av.total}`;
      resumos.push(av.totalExato ? plural(av.total, "aviso", "avisos") : `mais de ${av.total} avisos`);
      secoes.push([`*Avisos* (${n})`, ...av.itens.slice(0, MAX_ITENS).map((i) => `• ${i.titulo}`), ...maisN(av.total, Math.min(av.itens.length, MAX_ITENS))]);
    } else vazios.push("avisos");
  }

  const cabeca =
    resumos.length > 0
      ? `Você tem ${juntar(resumos)}.`
      : vazios.length > 0
        ? `Você não tem ${juntar(vazios)}.`
        : "";
  // Parte do que foi pedido está vazio, parte não: o vazio não vira linha ("zero" só quando é tudo).
  return [cabeca, ...secoes.map((s) => s.join("\n"))].filter(Boolean).join("\n\n");
}

function juntar(partes: string[]): string {
  if (partes.length <= 1) return partes[0] ?? "";
  return `${partes.slice(0, -1).join(", ")} e ${partes[partes.length - 1]}`;
}

export const TEXTO_PENDENCIAS_FALHA = "Não consegui consultar suas pendências agora. Tente de novo em instantes.";
export const TEXTO_PENDENCIAS_SEM_PERMISSAO = "Não consigo mostrar pendências por aqui.";

/**
 * O texto final para o resultado da tool `minhas_pendencias`: falha, sem permissão ou resumo.
 * `null` = não é um resultado que este renderizador sabe responder (cai no modelo).
 */
export function respostaDePendencias(
  resultado: { items: unknown[] | null },
  pedido: { filtro?: unknown; comNegocio?: boolean },
  agora: number
): string | null {
  if (resultado.items === null) return TEXTO_PENDENCIAS_FALHA;
  const item = obj(resultado.items[0]);
  if (!item) return null;
  if (item.sem_permissao === true) return TEXTO_PENDENCIAS_SEM_PERMISSAO;
  const f = pedido.filtro;
  // Com `negocio_id` o servidor não devolve avisos; sem filtro, quem manda é o que o resumo trouxe.
  const blocos: BlocoDoResumo[] | undefined = f === "formularios" || f === "propostas" || f === "atividades" || f === "avisos" ? [f] : undefined;
  const base = blocos ?? (["formularios", "propostas", "atividades", ...(Object.hasOwn(item, "avisos") && !pedido.comNegocio ? (["avisos"] as const) : [])] as BlocoDoResumo[]);
  return renderizarResumoDePendencias(item, { agora, blocos: base });
}
