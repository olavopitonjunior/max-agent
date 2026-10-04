/**
 * Custo REAL do WhatsApp do Max, como a Meta cobra (`pricing_analytics` da
 * WABA), por dia no fuso da WABA (`FUSO_CUSTOS`), categoria e tipo — gravado
 * em `meta_cost_daily`.
 *
 * A WABA é COMPARTILHADA com o app da FINCasa (outro número): o total da WABA
 * mistura os dois. O filtro é pela dimensão PHONE, contra o número de exibição
 * do Max lido da própria Meta (`display_phone_number` do `META_PHONE_NUMBER_ID`)
 * — nunca de configuração digitada, que poderia apontar para o número alheio.
 *
 * Os últimos dias são relidos a cada passada (a Meta consolida com atraso):
 * cada dia lido SUBSTITUI o gravado. Dia que a Meta ainda não devolveu fica
 * como está.
 */
import { db } from "../db";
import { fetchWithTimeout, META_TIMEOUT_MS } from "../http";
import { graphBase } from "../meta";

/** Uma semana: cobre cron parado por alguns dias e a consolidação tardia. */
export const DIAS_RELIDOS = 7;

/**
 * O dia da Meta é o do FUSO DA WABA, não UTC (medido em produção em
 * 04/10/2026: uma entrega às 02:07Z de 03/10 caiu no dia 02/10 da Meta — 23:07
 * em São Paulo). Custo e rateio usam este fuso; o sync confere que cada bucket
 * começa à meia-noite nele e avisa se não começar.
 */
export const FUSO_CUSTOS = "America/Sao_Paulo";

const partes = (epochMs: number) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: FUSO_CUSTOS,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(epochMs))
      .map((x) => [x.type, x.value])
  );
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
};

/** YYYY-MM-DD no fuso dos custos. */
export const diaNoFuso = (epochMs: number): string => partes(epochMs).dia;

/** Instante da meia-noite de `dia` (YYYY-MM-DD) no fuso dos custos, em ms. */
export function meiaNoiteNoFuso(dia: string): number {
  const [y, m, d] = dia.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  // Relógio do fuso − UTC num instante. Duas passadas: a segunda corrige o
  // dia de troca de horário de verão (São Paulo não tem desde 2019).
  const desvio = (epochMs: number) => {
    const { dia: dl, hora } = partes(epochMs);
    const [hh, mm] = hora.split(":").map(Number);
    const [ly, lm, ld] = dl.split("-").map(Number);
    return Date.UTC(ly, lm - 1, ld, hh, mm) - epochMs;
  };
  const d1 = desvio(guess);
  const r1 = guess - d1;
  const d2 = desvio(r1);
  return d2 === d1 ? r1 : guess - d2;
}

/** `AUTHENTICATION_INTERNATIONAL` (analytics) = `authentication-international` (webhook). */
export const normalizarCategoria = (c: string | null | undefined): string | null =>
  c ? c.toLowerCase().replace(/-/g, "_") : null;

export interface PontoMeta {
  start?: number;
  phone_number?: string;
  pricing_category?: string;
  pricing_type?: string;
  volume?: number;
  cost?: number;
}

export interface LinhaDeCusto {
  /** YYYY-MM-DD (UTC). */
  day: string;
  category: string;
  pricingType: string;
  volume: number;
  cost: number;
}

const digitos = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

async function graphGet<T>(caminho: string): Promise<T> {
  const token = (process.env.META_ACCESS_TOKEN ?? "").trim();
  if (!token) throw new Error("META_ACCESS_TOKEN ausente");
  const res = await fetchWithTimeout(
    `${graphBase()}${caminho}`,
    { headers: { Authorization: `Bearer ${token}` } },
    META_TIMEOUT_MS
  );
  const corpo = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok || corpo.error) throw new Error(`Graph API: ${corpo.error?.message ?? `HTTP ${res.status}`}`);
  return corpo;
}

/** Agrega os pontos do NOSSO número por (dia, categoria, tipo). Puro. */
export function agregarPontos(pontos: PontoMeta[], nossoNumero: string): LinhaDeCusto[] {
  const alvo = digitos(nossoNumero);
  const mapa = new Map<string, LinhaDeCusto>();
  for (const p of pontos) {
    if (!alvo || digitos(p.phone_number) !== alvo) continue;
    if (typeof p.start !== "number") continue;
    const day = diaNoFuso(p.start * 1000);
    const category = normalizarCategoria(p.pricing_category) ?? "desconhecida";
    const pricingType = (p.pricing_type ?? "desconhecido").toLowerCase();
    const k = `${day}|${category}|${pricingType}`;
    const l = mapa.get(k) ?? { day, category, pricingType, volume: 0, cost: 0 };
    l.volume += Number(p.volume) || 0;
    l.cost += Number(p.cost) || 0;
    mapa.set(k, l);
  }
  return [...mapa.values()].sort((a, b) =>
    `${a.day}|${a.category}|${a.pricingType}`.localeCompare(`${b.day}|${b.category}|${b.pricingType}`)
  );
}

export interface ResultadoSync {
  /** Só os 4 últimos dígitos — log não leva telefone. */
  numero: string;
  moeda: string;
  dias: string[];
  linhas: number;
  /** Pontos que a Meta devolveu (do Max ou não). */
  pontos: number;
}

export async function syncCustosMeta(agora = new Date(), dias = DIAS_RELIDOS): Promise<ResultadoSync> {
  const waba = (process.env.META_WABA_ID ?? "").trim();
  const pnid = (process.env.META_PHONE_NUMBER_ID ?? "").trim();
  if (!waba || !pnid) throw new Error("META_WABA_ID/META_PHONE_NUMBER_ID ausentes");

  const { display_phone_number } = await graphGet<{ display_phone_number?: string }>(
    `/${pnid}?fields=display_phone_number`
  );
  const nosso = digitos(display_phone_number);
  if (!nosso) throw new Error("número de exibição do Max não veio da Meta");

  const fim = Math.floor(agora.getTime() / 1000);
  // Janela em dias inteiros do fuso: de (hoje - dias + 1) 00:00 até agora.
  const hoje = diaNoFuso(agora.getTime());
  const [hy, hm, hd] = hoje.split("-").map(Number);
  const diasDaJanela = Array.from({ length: dias }, (_, i) =>
    new Date(Date.UTC(hy, hm - 1, hd - (dias - 1) + i)).toISOString().slice(0, 10)
  );
  const inicio = Math.floor(meiaNoiteNoFuso(diasDaJanela[0]) / 1000);

  const campo =
    `pricing_analytics.start(${inicio}).end(${fim}).granularity(DAILY)` +
    `.dimensions(["PHONE","PRICING_CATEGORY","PRICING_TYPE"])`;
  const r = await graphGet<{
    currency?: string;
    pricing_analytics?: { data?: Array<{ data_points?: PontoMeta[] }>; paging?: { next?: string } };
  }>(`/${waba}?fields=currency,${encodeURIComponent(campo)}`);
  // Página incompleta substituiria um dia inteiro por um pedaço dele.
  if (r.pricing_analytics?.paging?.next) {
    throw new Error("pricing_analytics paginado — nada gravado (resposta parcial)");
  }
  const pontos = (r.pricing_analytics?.data ?? []).flatMap((d) => d.data_points ?? []);
  const linhas = agregarPontos(pontos, nosso);
  const moeda = (r.currency ?? "").toUpperCase();
  // Bucket que não começa à meia-noite do fuso = a WABA mudou de fuso: o rateio
  // por dia passaria a cruzar dias errados. Grava (é o dado da Meta), mas avisa.
  const foraDoFuso = pontos.filter((p) => typeof p.start === "number" && partes(p.start * 1000).hora !== "00:00");
  if (foraDoFuso.length > 0) {
    console.warn(
      `[custos] ${foraDoFuso.length} bucket(s) da Meta fora da meia-noite de ${FUSO_CUSTOS} — o fuso da WABA mudou?`
    );
  }
  const descartados = pontos.length > 0 && linhas.length === 0;
  if (descartados) {
    // Meta respondeu, mas nenhum ponto é do Max: formato do número mudou, ou
    // a dimensão PHONE sumiu. Fechado (nada da FINCasa entra), mas à vista.
    const finais = [...new Set(pontos.map((p) => (p.phone_number ?? "").replace(/\D/g, "").slice(-4) || "sem"))];
    console.warn(`[custos] ${pontos.length} ponto(s) da Meta, nenhum do Max (finais: ${finais.join(",")})`);
  }

  // Dia que voltou da Meta substitui o gravado; dia sem nenhum ponto fica.
  const diasComDado = [...new Set(linhas.map((l) => l.day))];
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    if (diasComDado.length > 0) {
      await c.query(`DELETE FROM meta_cost_daily WHERE day = ANY($1::date[])`, [diasComDado]);
    }
    for (const l of linhas) {
      // Upsert: duas execuções do cron ao mesmo tempo não colidem na PK.
      await c.query(
        `INSERT INTO meta_cost_daily (day, category, pricing_type, volume, cost, currency, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (day, category, pricing_type)
           DO UPDATE SET volume = EXCLUDED.volume, cost = EXCLUDED.cost,
                         currency = EXCLUDED.currency, updated_at = now()`,
        [l.day, l.category, l.pricingType, l.volume, l.cost, moeda]
      );
    }
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
  return { numero: `…${nosso.slice(-4)}`, moeda, dias: diasDaJanela, linhas: linhas.length, pontos: pontos.length };
}
