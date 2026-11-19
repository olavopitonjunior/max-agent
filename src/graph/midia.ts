/**
 * Mídia de origem ("como o cliente chegou até a imobiliária"): catálogo e política vêm das options do CM
 * (`proposal.options` / `captacao.options`); sem `midias` (CM antigo) o Max não pergunta nem manda o campo.
 * Módulo próprio (sem dependência de fluxos/captação) para os dois fluxos usarem sem import circular.
 */
import { normalizar } from "./tools";

export interface MidiaDeOrigem {
  id: string;
  label: string;
}

// ─── Mídia de origem ───────────────────────────────────────────────────────
//
// O CM exige "como o cliente chegou até a imobiliária" em 11 de 12 orgs. O catálogo (`midias`) e a política
// (`midia`) chegam em `proposal.options`/`captacao.options`; sem eles (CM antigo) o Max não pergunta nem manda nada.

export type PoliticaDeMidia = "required" | "optional" | "hidden";

/** `[{id,label}]` do CM → catálogo limpo (uma linha, sem marcação do WhatsApp). */
export function lerMidias(raw: unknown): MidiaDeOrigem[] {
  if (!Array.isArray(raw)) return [];
  const vistos = new Set<string>();
  const out: MidiaDeOrigem[] = [];
  for (const x of raw) {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const label = typeof o.label === "string" ? o.label.replace(/[*_~`\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "";
    if (!id || !label || vistos.has(id)) continue;
    vistos.add(id);
    out.push({ id, label });
  }
  return out.slice(0, 30);
}

/** `midia` das options: string (captação) ou `{proponente, vendedor}` (proposta). */
export function lerPoliticaDeMidia(raw: unknown, papel?: "proponente" | "vendedor"): PoliticaDeMidia | undefined {
  const v = papel && raw && typeof raw === "object" ? (raw as Record<string, unknown>)[papel] : raw;
  return v === "required" || v === "optional" || v === "hidden" ? v : undefined;
}

/** O que as options dizem da mídia do PROPONENTE; vazio = CM antigo (nada muda). */
export function lerCatalogoDeMidias(body: Record<string, unknown>): { midias?: MidiaDeOrigem[]; midiaPolitica?: PoliticaDeMidia } {
  const midias = lerMidias(body.midias);
  if (!midias.length) return {};
  const midiaPolitica = lerPoliticaDeMidia(body.midia, "proponente");
  if (midiaPolitica === "hidden") return {};
  return { midias, ...(midiaPolitica ? { midiaPolitica } : {}) };
}

export function rotuloDaMidia(id: string, midias?: MidiaDeOrigem[]): string {
  return midias?.find((m) => m.id === id)?.label ?? id;
}

export function textoPerguntaMidia(midias: MidiaDeOrigem[], aviso = ""): string {
  return (
    `${aviso}Como o cliente chegou até a imobiliária?\n` +
    midias.map((m, i) => `${i + 1}. ${m.label}`).join("\n") +
    "\n\nResponda com o número ou o nome."
  );
}

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const soPalavras = (t: string) => normalizar(t).replace(/[^a-z0-9]+/g, " ").trim();

/** As mídias cujo nome (ou id) aparece como palavra no texto; havendo mais de uma, fica a de nome mais longo ("Google Ads" × "Google"). */
function midiasNoTexto(t: string, midias: MidiaDeOrigem[]): { m: MidiaDeOrigem; ini: number }[] {
  const achadas: { m: MidiaDeOrigem; ini: number; tam: number }[] = [];
  for (const m of midias) {
    for (const nome of [soPalavras(m.label), soPalavras(m.id)]) {
      if (!nome) continue;
      const x = new RegExp(`(?:^| )${escapar(nome)}(?= |$)`).exec(t);
      if (x) {
        achadas.push({ m, ini: x.index + (x[0].startsWith(" ") ? 1 : 0), tam: nome.length });
        break;
      }
    }
  }
  const maior = Math.max(0, ...achadas.map((a) => a.tam));
  return achadas.filter((a) => a.tam === maior);
}

/** Resposta à lista: número ("2") ou nome ("instagram", "foi pelo Google Ads"). */
export function lerMidia(texto: string, midias: MidiaDeOrigem[]): MidiaDeOrigem | null {
  const t = soPalavras(texto);
  const n = /^(?:opcao |numero |n )?(\d{1,2})$/.exec(t);
  if (n) return midias[Number(n[1]) - 1] ?? null;
  const achadas = midiasNoTexto(t, midias);
  return achadas.length === 1 ? achadas[0]!.m : null;
}

const SINAL_DE_ORIGEM = /\b(veio|vieram|vem|chegou|chegaram|origem|midia|fonte|captad[oa]s?|conheceu|achou|encontrou|pel[oa]s?|via|atraves|foi|indicad[oa]s?)\b/;

/**
 * O que o corretor já escreveu ("o cliente veio pelo Instagram", "mídia de origem: indicação"): só vale com um
 * sinal de origem logo antes do nome — "o imóvel está no site da construtora" não é a mídia.
 */
export function midiaNoTexto(texto: string, midias: MidiaDeOrigem[]): MidiaDeOrigem | null {
  const t = soPalavras(texto);
  const achadas = midiasNoTexto(t, midias).filter((a) => SINAL_DE_ORIGEM.test(t.slice(Math.max(0, a.ini - 45), a.ini)));
  return achadas.length === 1 ? achadas[0]!.m : null;
}

