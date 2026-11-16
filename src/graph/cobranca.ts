import { limpo } from "./documentos";

/**
 * `charge.status` (PR-O4d-MA, par do contractmaker PR-O4d-CM, `docs/max.md` §19.6): as cobranças de
 * comissão de UM negócio.
 *
 * SÓ LEITURA, e é domínio de dinheiro. O Max diz QUE a cobrança existe, em que ESTADO está, quanto
 * vale e quando vence. Este módulo nunca produz link de pagamento, boleto, PIX, pagador nem nada
 * que o servidor não tenha mandado: quem emite, cobra, reenvia ou baixa segunda via é a pessoa, na
 * tela logada. A tool não tem verbo de ação, e o servidor nem manda esses dados.
 *
 * Sem filtro de provedor deste lado: o CM devolve todas as cobranças do negócio (asaas e rinne) e o
 * campo `provedor` de cada item informa a origem. O Max mostra tudo o que chegou.
 *
 * ── Parse ESTRITO (R54), o mesmo do `certidao.status` e do `document.list` ──────────────────────
 *
 * O conjunto de chaves do item é EXATO: chave a mais (um `invoiceUrl` que apareça um dia), chave a
 * menos, tipo errado, enum fora do mapa fechado, `valor` que não seja inteiro ≥ 0 (centavos) ou data
 * que não seja ISO derrubam o item, e um item inválido derruba a resposta inteira
 * (`falha_na_consulta`, ver o despachante). O objeto devolvido é montado campo a campo.
 */

/** Mapas fechados do CM (`scope-query-cobranca.ts`): o que não é conhecido lá chega como `"outro"`. */
export const TIPOS_DE_COBRANCA = ["comissao", "avulsa", "aluguel", "outros", "outro"] as const;
export type TipoDeCobranca = (typeof TIPOS_DE_COBRANCA)[number];

export const ESTADOS_DE_COBRANCA = [
  "aguardando",
  "em_analise",
  "confirmada",
  "paga",
  "paga_em_dinheiro",
  "vencida",
  "estorno_em_andamento",
  "estornada",
  "cancelada",
  "contestada",
  "em_negativacao",
  "outro",
] as const;
export type EstadoDeCobranca = (typeof ESTADOS_DE_COBRANCA)[number];

export const PROVEDORES_DE_COBRANCA = ["asaas", "rinne", "outro"] as const;
export type ProvedorDeCobranca = (typeof PROVEDORES_DE_COBRANCA)[number];

export interface CobrancaItem {
  id: string;
  negocioId: string;
  tipo: TipoDeCobranca;
  estado: EstadoDeCobranca;
  /** Centavos, inteiro ≥ 0. `null` só quando o número gravado no servidor não era finito. */
  valor: number | null;
  vencimento: string;
  pagoEm: string | null;
  canceladoEm: string | null;
  estornadoEm: string | null;
  provedor: ProvedorDeCobranca;
}

/** Chaves do item, na ordem do contrato (`docs/max.md` §19.6). */
export const CHAVES_DE_COBRANCA = [
  "id",
  "negocioId",
  "tipo",
  "estado",
  "valor",
  "vencimento",
  "pagoEm",
  "canceladoEm",
  "estornadoEm",
  "provedor",
] as const;

const ehObjeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** As chaves do objeto são EXATAMENTE estas (sem sobra, sem falta), em qualquer ordem. */
function chavesExatas(o: Record<string, unknown>, esperadas: readonly string[]): boolean {
  const reais = Object.keys(o);
  return reais.length === esperadas.length && esperadas.every((c) => Object.hasOwn(o, c));
}

const textoNaoVazio = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** ISO 8601 em UTC, como o `toISOString()` do CM (`2026-11-25T00:00:00.000Z`), e data que existe. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ehInstante = (v: unknown): v is string => typeof v === "string" && ISO_UTC.test(v) && !Number.isNaN(new Date(v).getTime());
const ehInstanteOuNulo = (v: unknown): v is string | null => v === null || ehInstante(v);

/** Lê UM item pelo contrato; `null` = fora do contrato (a resposta inteira vira falha). */
export function lerCobranca(item: unknown): CobrancaItem | null {
  if (!ehObjeto(item) || !chavesExatas(item, CHAVES_DE_COBRANCA)) return null;
  if (!(textoNaoVazio(item.id) && textoNaoVazio(item.negocioId))) return null;
  if (!TIPOS_DE_COBRANCA.includes(item.tipo as TipoDeCobranca)) return null;
  if (!ESTADOS_DE_COBRANCA.includes(item.estado as EstadoDeCobranca)) return null;
  if (!PROVEDORES_DE_COBRANCA.includes(item.provedor as ProvedorDeCobranca)) return null;
  // Dinheiro em centavos, inteiro seguro e ≥ 0: float (`12.5`), texto (`"1200"`), negativo e NaN caem.
  if (item.valor !== null && !(typeof item.valor === "number" && Number.isSafeInteger(item.valor) && item.valor >= 0)) return null;
  if (!ehInstante(item.vencimento)) return null;
  if (!(ehInstanteOuNulo(item.pagoEm) && ehInstanteOuNulo(item.canceladoEm) && ehInstanteOuNulo(item.estornadoEm))) return null;

  return {
    id: item.id,
    negocioId: item.negocioId,
    tipo: item.tipo as TipoDeCobranca,
    estado: item.estado as EstadoDeCobranca,
    valor: item.valor,
    vencimento: item.vencimento,
    pagoEm: item.pagoEm,
    canceladoEm: item.canceladoEm,
    estornadoEm: item.estornadoEm,
    provedor: item.provedor as ProvedorDeCobranca,
  };
}

// ─── Render (WhatsApp) ──────────────────────────────────────────────────────

/** Vazio, negado, sem módulo, sem permissão e negócio alheio chegam iguais (`{items:[]}`): o Max não distingue, e não vaza. */
export const SEM_COBRANCAS = "Não encontrei cobrança visível para você nesse negócio.";
/** Rodapé: o Max só consulta. Qualquer ação sobre a cobrança é na tela, onde a pessoa está logada. */
export const RODAPE_SO_CONSULTA = "Isso é só a consulta: qualquer ação sobre a cobrança é feita no sistema, na tela do negócio.";

const TIPO_LEGIVEL: Record<TipoDeCobranca, string> = {
  comissao: "Comissão",
  avulsa: "Cobrança avulsa",
  aluguel: "Aluguel",
  outros: "Outros",
  outro: "Cobrança",
};

const ESTADO_LEGIVEL: Record<EstadoDeCobranca, string> = {
  aguardando: "pendente",
  em_analise: "em análise",
  confirmada: "confirmada",
  paga: "paga",
  paga_em_dinheiro: "paga em dinheiro",
  vencida: "vencida",
  estorno_em_andamento: "estorno em andamento",
  estornada: "estornada",
  cancelada: "cancelada",
  contestada: "contestada",
  em_negativacao: "em negativação",
  outro: "situação não identificada",
};

const PROVEDOR_LEGIVEL: Record<ProvedorDeCobranca, string> = {
  asaas: "Asaas",
  rinne: "Rinne",
  outro: "outro provedor",
};

/**
 * Centavos inteiros -> "R$ 1.234,56". Só aritmética de inteiros (sem float, sem `toLocaleString`):
 * o separador de milhar e a vírgula são montados à mão, iguais em qualquer ICU.
 */
export function formatarReais(centavos: number): string {
  const reais = Math.trunc(centavos / 100);
  const resto = centavos % 100;
  const milhar = String(reais).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `R$ ${milhar},${String(resto).padStart(2, "0")}`;
}

const FUSO = "America/Sao_Paulo";

/** O vencimento é dia, não instante: o CM o grava à meia-noite ou ao meio-dia UTC. Lê-se o dia em UTC (em Brasília, 00:00Z viraria o dia anterior). */
function diaDoVencimento(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });
}

/** O pagamento é instante: o dia em Brasília. */
function diaDoPagamento(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", { timeZone: FUSO, day: "2-digit", month: "2-digit", year: "numeric" });
}

function linhaDaCobranca(c: CobrancaItem): string {
  const partes = [
    TIPO_LEGIVEL[c.tipo],
    ESTADO_LEGIVEL[c.estado],
    c.valor === null ? "valor não informado" : formatarReais(c.valor),
    `vence em ${diaDoVencimento(c.vencimento)}`,
  ];
  if (c.pagoEm) partes.push(`paga em ${diaDoPagamento(c.pagoEm)}`);
  partes.push(PROVEDOR_LEGIVEL[c.provedor]);
  return `- ${limpo(partes.join(" — "))}`;
}

/**
 * O resumo das cobranças de UM negócio, pronto para a conversa: uma linha por cobrança, PT-BR, sem
 * negrito (nada de `**`), sem id, sem link. Recebe itens JÁ lidos por `lerCobranca`, nunca o JSON cru.
 */
export function renderCobrancas(itens: readonly CobrancaItem[], truncado: boolean): string {
  if (itens.length === 0) return SEM_COBRANCAS;
  const linhas = ["Cobranças do negócio:", ...itens.map(linhaDaCobranca)];
  if (truncado) linhas.push(`Mostrando as ${itens.length} mais recentes.`);
  linhas.push(RODAPE_SO_CONSULTA);
  return linhas.join("\n");
}
