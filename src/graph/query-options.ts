/** Server-supplied stages, scoped to the current identity. Never inferred from a model. */
export interface StageClarification { field: "estado"; options: string[] }
export interface QueryOptions {
  subjectKey: string;
  createdAt: number;
  options: string[];
  offset: number;
  /** Mixed results ask for a stage name; their item numbers remain owned by the successful lists. */
  numbered?: boolean;
}
export const QUERY_OPTIONS_TTL = 30 * 60 * 1000;
const PAGE_SIZE = 3;
const normalize = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

export function readStageClarification(value: unknown): StageClarification | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.field !== "estado" || !Array.isArray(v.options) || v.options.length > 50 ||
      !v.options.every(x => typeof x === "string" && x.trim() && x.length <= 200 && !/[\r\n\x00-\x1f]/.test(x))) return null;
  return { field: "estado", options: [...new Set(v.options as string[])] };
}

/** Repair only an explicit, unambiguous stage phrase, never a guessed transaction type. */
export function explicitStage(text: string, options: string[]): string | null {
  const input = normalize(text);
  if (/\b(nao|exceto|menos|sem)\b/.test(input)) return null;
  const matches = options.filter(option => {
    const label = normalize(option).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\s)(?:em|na etapa|na fase|etapa|fase)\\s+["“]?${label}(?=$|[\\s.,!?"”])`).test(input);
  });
  return matches.length === 1 ? matches[0] : null;
}

export function renderQueryOptions(pending: QueryOptions): string {
  const labels = pending.options.slice(pending.offset, pending.offset + PAGE_SIZE)
    .map((s, i) => `${pending.offset + i + 1}) ${s.length > 65 ? s.slice(0, 62) + "…" : s}`);
  return ["Qual etapa deseja consultar? Responda com o número.", "0) Todas as etapas", ...labels,
    ...(pending.offset + PAGE_SIZE < pending.options.length ? ["Diga MAIS para outras etapas."] : [])].join("\n");
}

export type QueryChoice = { kind: "select"; stage?: string } | { kind: "more" } | { kind: "menu" } | { kind: "cancel" } | { kind: "invalid" } | { kind: "unrelated" };
export function queryChoice(text: string, pending: QueryOptions): QueryChoice {
  const input = normalize(text).replace(/[.!?]+$/, "").trim();
  if (/^(cancelar|cancela|deixa pra la)$/.test(input)) return { kind: "cancel" };
  if (input === "etapas") return { kind: "menu" };
  if (input === "mais" && pending.numbered !== false) return { kind: "more" };
  const number = /^(?:opcao\s*)?(\d{1,2})$/.exec(input);
  if (number && pending.numbered !== false) {
    const n = Number(number[1]);
    if (n === 0) return { kind: "select" };
    return n > pending.offset && n <= Math.min(pending.offset + PAGE_SIZE, pending.options.length)
      ? { kind: "select", stage: pending.options[n - 1] } : { kind: "invalid" };
  }
  const named = pending.options.filter(s => normalize(s) === input);
  if (named.length === 1) return { kind: "select", stage: named[0] };
  const explicit = explicitStage(text, pending.options);
  return explicit ? { kind: "select", stage: explicit } : { kind: "unrelated" };
}
export function nextQueryPage(pending: QueryOptions): QueryOptions {
  return { ...pending, offset: pending.offset + PAGE_SIZE < pending.options.length ? pending.offset + PAGE_SIZE : 0 };
}
