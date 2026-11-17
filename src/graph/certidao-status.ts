import { texto } from "./notificacao-projecao";

/**
 * `certidao.status` (PR-O4b-MA, par do contractmaker PR-O4b-CM, `docs/max.md` §19.4):
 * a situação das certidões de UM negócio ou de UMA proposta.
 *
 * Só leitura. Emitir certidão tem custo e fica na tela: este módulo não escreve
 * nenhuma frase que ofereça pedir ou emitir, porque o Max não tem tool que faça isso
 * (prometer efeito sem tool é encenar a ação).
 *
 * ── Parse ESTRITO (R54), o oposto do `lerDealDetalhado` ──────────────────────
 *
 * Aqui o conjunto de chaves é EXATO, em todos os níveis (`item`, `alvo`, `validade`):
 * chave a mais, chave a menos, tipo errado ou valor fora do enum derrubam o item, e
 * um item inválido derruba a resposta inteira (`falha_na_consulta`, ver o despachante).
 * Nunca se repassa um item que o contrato não descreve. É o que faz a divergência do
 * outro lado (um campo novo, um nome que mudou) virar linha vermelha em teste, e não
 * texto errado numa conversa. O objeto devolvido é montado campo a campo.
 */

export const SITUACOES_DE_CERTIDAO = ["saiu", "em_andamento", "precisa_de_voce", "nao_saiu"] as const;
export type SituacaoDeCertidao = (typeof SITUACOES_DE_CERTIDAO)[number];

export interface CertidaoStatusItem {
  id: string;
  /** Nome legível do catálogo do CM (nunca o rótulo gravado no job). */
  certidao: string;
  /** Modelo do pedido quando o tribunal tem vários (Cível, Falências...); senão `null`. */
  modelo: string | null;
  /** Papel do catálogo fechado do CM e posição 1-based. Nunca nome nem documento. */
  alvo: { papel: string; indice: number };
  situacao: SituacaoDeCertidao;
  /** Texto PT-BR do balde, o mesmo da tela. */
  rotulo: string;
  /** O motivo é dado faltante ou divergente do cadastro. */
  faltaDado: boolean;
  /** ISO da próxima checagem/prazo do portal. */
  previsao: string | null;
  /** Só para certidão que saiu e tem validade conhecida; `ate` é o dia civil AAAA-MM-DD. */
  validade: { ate: string; vencida: boolean } | null;
  atualizadoEm: string;
}

/** Chaves do item, na ordem do contrato (`docs/max.md` §19.4). */
export const CHAVES_DE_CERTIDAO_STATUS = [
  "id",
  "certidao",
  "modelo",
  "alvo",
  "situacao",
  "rotulo",
  "faltaDado",
  "previsao",
  "validade",
  "atualizadoEm",
] as const;

const ehObjeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** As chaves do objeto são EXATAMENTE estas (sem sobra, sem falta), em qualquer ordem. */
function chavesExatas(o: Record<string, unknown>, esperadas: readonly string[]): boolean {
  const reais = Object.keys(o);
  return reais.length === esperadas.length && esperadas.every((c) => Object.hasOwn(o, c));
}

const textoNaoVazio = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const textoOuNulo = (v: unknown): v is string | null => v === null || textoNaoVazio(v);
const DIA_CIVIL = /^\d{4}-\d{2}-\d{2}$/;
const ehInstante = (v: unknown): v is string => textoNaoVazio(v) && !Number.isNaN(new Date(v).getTime());

/** Dia civil válido (rejeita 2026-02-31): o que a tela mostra como "válida até". */
function ehDiaCivil(v: unknown): v is string {
  if (typeof v !== "string" || !DIA_CIVIL.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Lê UM item pelo contrato; `null` = fora do contrato (a resposta inteira vira falha). */
export function lerCertidaoStatus(item: unknown): CertidaoStatusItem | null {
  if (!ehObjeto(item) || !chavesExatas(item, CHAVES_DE_CERTIDAO_STATUS)) return null;
  if (!(textoNaoVazio(item.id) && textoNaoVazio(item.certidao) && textoOuNulo(item.modelo) && textoNaoVazio(item.rotulo))) return null;
  // Rótulo que some na limpeza (só marcadores) deixaria a linha sem a situação: fora do contrato, como qualquer outro desvio.
  if (limpo(item.rotulo as string) === "") return null;
  if (!SITUACOES_DE_CERTIDAO.includes(item.situacao as SituacaoDeCertidao)) return null;
  if (typeof item.faltaDado !== "boolean") return null;
  if (!ehInstante(item.atualizadoEm)) return null;
  if (!(item.previsao === null || ehInstante(item.previsao))) return null;

  const a = item.alvo;
  if (!ehObjeto(a) || !chavesExatas(a, ["papel", "indice"])) return null;
  if (!textoNaoVazio(a.papel) || typeof a.indice !== "number" || !Number.isInteger(a.indice) || a.indice < 1) return null;

  let validade: CertidaoStatusItem["validade"] = null;
  if (item.validade !== null) {
    const v = item.validade;
    if (!ehObjeto(v) || !chavesExatas(v, ["ate", "vencida"])) return null;
    if (!ehDiaCivil(v.ate) || typeof v.vencida !== "boolean") return null;
    validade = { ate: v.ate, vencida: v.vencida };
  }

  return {
    id: item.id,
    certidao: item.certidao,
    modelo: item.modelo,
    alvo: { papel: a.papel, indice: a.indice },
    situacao: item.situacao as SituacaoDeCertidao,
    rotulo: item.rotulo,
    faltaDado: item.faltaDado,
    previsao: item.previsao,
    validade,
    atualizadoEm: item.atualizadoEm,
  };
}

// ─── Render (WhatsApp) ──────────────────────────────────────────────────────

/** Vazio, negado, outra org, sem módulo e inexistente chegam iguais (`{items:[]}`): o Max não distingue, e não vaza. */
export const SEM_CERTIDOES_NEGOCIO = "Não encontrei certidões nesse negócio.";
export const SEM_CERTIDOES_PROPOSTA = "Não encontrei certidões nessa proposta.";

/** Onde a pessoa resolve: a tela, não o Max. Sem verbo que ofereça emitir ou pedir certidão. */
export const ONDE_RESOLVER_NEGOCIO = "Veja e resolva na tela: Negócio → aba Certidões.";
export const ONDE_RESOLVER_PROPOSTA = "Veja e resolva na tela: Proposta → aba Certidões.";
export const FALTA_DADO_DA_PARTE = "falta dado da parte (ex.: data de nascimento) — complete no negócio";
export const FALTA_DADO_DA_PARTE_PROPOSTA = "falta dado da parte (ex.: data de nascimento) — complete na proposta";
/** Nome de reserva quando o nome vindo do servidor some depois da limpeza. */
const NOME_DE_RESERVA = "Certidão";
export const HA_MAIS_CERTIDOES = "Há mais certidões do que as mostradas aqui; o restante está na aba Certidões.";

/** Catálogo fechado do CM (`TARGET_KINDS`). Papel desconhecido vira "Parte": código interno nunca sai. */
const NOME_DO_PAPEL: Record<string, string> = {
  vendedor: "Vendedor",
  comprador: "Comprador",
  imovel: "Imóvel",
  diligenciado: "Diligenciado",
  conjuge_vendedor: "Cônjuge do vendedor",
  procurador_vendedor: "Procurador do vendedor",
  representante_vendedor: "Representante do vendedor",
  locatario: "Locatário",
  fiador: "Fiador",
  conjuge_fiador: "Cônjuge do fiador",
  locador: "Locador",
  conjuge_locatario: "Cônjuge do locatário",
};

/**
 * Texto vindo do servidor dentro de uma linha de WhatsApp: sem controle, sem os marcadores de
 * formatação (`*` negrito, `_` itálico, `~` riscado, crase monoespaçado: forjariam formatação) e
 * sem sobra de espaço.
 */
function limpo(v: string): string {
  return (texto(v) ?? "").replace(/[*_~`]+/g, "").replace(/\s+/g, " ").trim();
}

const FUSO = "America/Sao_Paulo";

/** "2026-12-01" -> "01/12/2026" (dia civil: sem fuso, sem Date). */
function diaCivilBr(ate: string): string {
  const [a, m, d] = ate.split("-");
  return `${d}/${m}/${a}`;
}

/** Instante ISO -> "25/10/2026" no horário de Brasília. */
function dataLocal(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("pt-BR", { timeZone: FUSO, day: "2-digit", month: "2-digit", year: "numeric" });
}

function nomeDoPapel(papel: string): string {
  return Object.hasOwn(NOME_DO_PAPEL, papel) ? NOME_DO_PAPEL[papel] : "Parte";
}

function linhaDaCertidao(c: CertidaoStatusItem, origem: "negocio" | "proposta"): string {
  const nome = limpo(c.certidao) || NOME_DE_RESERVA;
  const modelo = c.modelo ? limpo(c.modelo) : "";
  const alvo = `${nomeDoPapel(c.alvo.papel)} ${c.alvo.indice}`;
  const rotulo = limpo(c.rotulo);
  const detalhes: string[] = [];
  if (c.faltaDado) detalhes.push(origem === "proposta" ? FALTA_DADO_DA_PARTE_PROPOSTA : FALTA_DADO_DA_PARTE);
  if (c.previsao) {
    const quando = dataLocal(c.previsao);
    if (quando) detalhes.push(`previsão ${quando}`);
  }
  // `vencida` vale mais que a data: o CM só manda validade em certidão que saiu.
  if (c.validade) detalhes.push(c.validade.vencida ? "vencida" : `válida até ${diaCivilBr(c.validade.ate)}`);
  return `- ${nome}${modelo ? ` (${modelo})` : ""} — ${alvo}: ${rotulo}${detalhes.length ? ` (${detalhes.join("; ")})` : ""}`;
}

/**
 * O resumo das certidões de UM negócio/proposta, pronto para a conversa: uma linha por
 * certidão, PT-BR, sem negrito (nada de `**`), sem id nem código interno. Recebe itens JÁ
 * lidos por `lerCertidaoStatus`, nunca o JSON cru.
 *
 * Quando algo precisa da pessoa, fecha com o caminho na tela. Nunca oferece emitir nem pedir.
 */
export function renderCertidoes(itens: readonly CertidaoStatusItem[], origem: "negocio" | "proposta", truncado: boolean): string {
  if (itens.length === 0) return origem === "proposta" ? SEM_CERTIDOES_PROPOSTA : SEM_CERTIDOES_NEGOCIO;
  const linhas = [origem === "proposta" ? "Certidões da proposta:" : "Certidões do negócio:", ...itens.map((c) => linhaDaCertidao(c, origem))];
  if (itens.some((c) => c.situacao === "precisa_de_voce" || c.faltaDado)) {
    linhas.push(origem === "proposta" ? ONDE_RESOLVER_PROPOSTA : ONDE_RESOLVER_NEGOCIO);
  }
  if (truncado) linhas.push(HA_MAIS_CERTIDOES);
  return linhas.join("\n");
}
