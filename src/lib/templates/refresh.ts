/**
 * Traz da Graph API o status de cada template do catálogo para `wa_template`.
 *
 * Por que existe: o webhook `message_template_status_update` NÃO chega a este
 * serviço (medido em 02/10/2026 — 8 templates APROVADOS na Meta ficaram
 * PENDING aqui). Como o dispatch é fail-closed, sem isto o Max nunca usaria
 * template aprovado. Roda de hora em hora na carona do `cron/inbound` e pelo
 * `templates-sync --refresh`.
 *
 * Cuidados (code review de 02/10):
 *  - lista os templates da WABA e casa pelo NOME e idioma do catálogo — o WABA
 *    é compartilhado com o app da FINCasa, e o resto dele não é deste serviço;
 *  - só grava APPROVED se o BODY na Meta for o texto do catálogo (espaços e
 *    aspas normalizados) e os botões tiverem os tipos na ordem do catálogo;
 *    um APPROVED local que passou a divergir vira DIVERGENTE (132000 senão);
 *  - template do catálogo que sumiu da Meta é reportado (`ausente`), e a
 *    linha local deixa de ser APPROVED — enviar daria 132001;
 *  - a escrita é condicional ao status lido antes: um webhook (se um dia
 *    chegar) que gravou no meio não é atropelado.
 */

import { query } from "../db";
import { log } from "../log";
import { fetchWithTimeout, META_TIMEOUT_MS } from "../http";
import { graphBase } from "../meta";
import { botoesEmOrdem, todosOsTemplates, type TemplateDef } from "./catalog";

export type ResultadoRefresh =
  | { name: string; acao: "igual"; status: string }
  | { name: string; acao: "atualizado"; de: string | null; para: string }
  | { name: string; acao: "diverge"; status: string }
  | { name: string; acao: "ausente"; de: string | null }
  | { name: string; acao: "erro"; erro: string };

/** Erro de credencial/permissão da Graph (token vencido, sem escopo). */
class ErroDeAcesso extends Error {}

/**
 * Texto comparável: a Meta pode devolver o BODY com espaços ou aspas
 * normalizados. Diferença só disso não pode deixar a régua muda.
 */
function normalizarTexto(t: string): string {
  return t.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();
}

/** Os botões na ordem e no tipo que o envio vai preencher (`botoesDaLinha`). */
function botoesConferem(def: TemplateDef, t: TemplateNaMeta): boolean {
  const naMeta = (t.components?.find((c) => c.type === "BUTTONS")?.buttons ?? []).map((b) => b.type);
  const esperado = botoesEmOrdem(def.botao).map((b) => (b.tipo === "url" ? "URL" : "QUICK_REPLY"));
  return naMeta.length === esperado.length && naMeta.every((tipo, i) => tipo === esperado[i]);
}

interface TemplateNaMeta {
  name: string;
  status: string;
  language: string;
  id: string;
  rejected_reason?: string;
  /** A Meta pode RECLASSIFICAR (UTILITY → MARKETING) depois de aprovar. */
  category?: string;
  components?: Array<{ type: string; text?: string; buttons?: Array<{ type: string }> }>;
}

/** Teto de páginas da listagem (100 por página): a WABA é compartilhada. */
const MAX_PAGINAS = 20;

/**
 * TODOS os templates da WABA numa listagem paginada — uma leitura por passada,
 * casada por nome e idioma aqui.
 *
 * Era uma busca `?name=` por template (22 chamadas por hora). Em produção, a
 * de `max_formulario_pendente_v3` voltou `ausente` em toda passada desde 03/10
 * enquanto a mesma consulta, de fora, achava o template APPROVED. Causa
 * provável (code review de 05/10): o Data Cache do Next 14 — GET de rota só-GET
 * fica em cache indefinidamente mesmo com `force-dynamic`, e a primeira busca
 * foi feita antes de o template existir. O `no-store` (aqui e no
 * `fetchWithTimeout`) é o conserto; a listagem custa 1–2 chamadas em vez de 22.
 */
async function lerListaDaMeta(): Promise<TemplateNaMeta[]> {
  const waba = (process.env.META_WABA_ID ?? "").trim();
  const token = (process.env.META_ACCESS_TOKEN ?? "").trim();
  if (!waba || !token) throw new Error("META_WABA_ID/META_ACCESS_TOKEN ausentes");
  let url: string | null =
    `${graphBase()}/${waba}/message_templates` +
    `?fields=name,status,language,id,rejected_reason,category,components&limit=100`;
  const todos: TemplateNaMeta[] = [];
  for (let pagina = 0; url && pagina < MAX_PAGINAS; pagina++) {
    const res = await fetchWithTimeout(
      url,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
      META_TIMEOUT_MS
    );
    const corpo = (await res.json().catch(() => ({}))) as {
      data?: TemplateNaMeta[];
      paging?: { next?: string };
      error?: { message?: string; code?: number };
    };
    if (!res.ok || !corpo.data) {
      const msg = `Graph API: ${corpo.error?.message ?? `HTTP ${res.status}`}`;
      const code = corpo.error?.code;
      if (res.status === 401 || res.status === 403 || code === 190 || code === 200 || code === 10) {
        throw new ErroDeAcesso(msg);
      }
      throw new Error(msg);
    }
    todos.push(...corpo.data);
    const next = corpo.paging?.next ?? null;
    // O token vai no header: nunca segui-lo para um host que veio do corpo.
    if (next && new URL(next).host !== new URL(graphBase()).host) {
      throw new Error("paginação da Graph apontou para outro host — nada gravado");
    }
    url = next;
  }
  // Página que sobrou além do teto: a lista estaria INCOMPLETA, e um template
  // que só aparece depois viraria "ausente" (e DELETED se estava APPROVED).
  if (url) throw new Error(`listagem de templates com mais de ${MAX_PAGINAS} páginas — nada gravado`);
  return todos;
}

/** Escreve só se o status local ainda é o lido antes (`antes`). */
async function gravar(
  def: TemplateDef,
  antes: string | null,
  t: { status: string; id: string | null; reason: string | null; category?: string | null }
): Promise<boolean> {
  if (antes === null) {
    const r = await query<{ name: string }>(
      `INSERT INTO wa_template (name, lang, status, meta_id, rejected_reason, category, updated_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, $7), now())
       ON CONFLICT (name) DO NOTHING RETURNING name`,
      [def.name, def.lang, t.status, t.id, t.status === "REJECTED" ? t.reason : null, t.category ?? null, def.category]
    );
    return r.length > 0;
  }
  const r = await query<{ name: string }>(
    `UPDATE wa_template
        SET status = $3, meta_id = COALESCE($4, meta_id),
            rejected_reason = $5, updated_at = now()
      WHERE name = $1 AND status = $2
      RETURNING name`,
    [def.name, antes, t.status, t.id, t.status === "REJECTED" ? t.reason : null]
  );
  return r.length > 0;
}

export async function refreshTemplates(): Promise<ResultadoRefresh[]> {
  const locais = new Map(
    (await query<{ name: string; status: string }>(`SELECT name, status FROM wa_template`)).map((r) => [
      r.name,
      r.status,
    ])
  );
  const out: ResultadoRefresh[] = [];
  let lista: TemplateNaMeta[];
  try {
    lista = await lerListaDaMeta();
  } catch (err) {
    // Sem a lista, nada é afirmado sobre nenhum template: um "ausente" aqui
    // apagaria APPROVED de verdade.
    const erro = err instanceof Error ? err.message : String(err);
    return todosOsTemplates().map((def) => ({ name: def.name, acao: "erro" as const, erro }));
  }
  for (const def of todosOsTemplates()) {
    const antes = locais.get(def.name) ?? null;
    try {
      const t = lista.find((x) => x.name === def.name && x.language === def.lang) ?? null;
      if (!t && antes !== null) {
        // Submetido e não listado: o diagnóstico que faltou em 03/10.
        log.warn("templates.ausente_na_lista", { name: def.name, listados: lista.length, antes });
      }
      if (!t) {
        // Sumiu da Meta (ou nunca foi submetido): o que estava APPROVED aqui
        // deixa de ser usado. Não submetido e ausente = nada a fazer.
        if (antes === "APPROVED") {
          await gravar(def, antes, { status: "DELETED", id: null, reason: null });
        }
        out.push({ name: def.name, acao: "ausente", de: antes });
        continue;
      }
      // Categoria: a Meta reclassificou 7 templates de UTILITY para MARKETING
      // em 03/10/2026 (mais caro, limite por pessoa — erro 131049). Fica
      // gravada para a métrica acusar.
      if (t.category && antes !== null) {
        await query(`UPDATE wa_template SET category = $2 WHERE name = $1 AND category IS DISTINCT FROM $2`, [
          def.name,
          t.category,
        ]);
      }
      const body = t.components?.find((c) => c.type === "BODY")?.text ?? null;
      const confere =
        body !== null && normalizarTexto(body) === normalizarTexto(def.body) && botoesConferem(def, t);
      if (t.status === "APPROVED" && !confere) {
        // Aprovado com OUTRO texto ou outros botões: o envio sairia com
        // parâmetros errados (132000). Se aqui já estava APPROVED, deixa de
        // estar — fail-closed como o resto.
        if (antes === "APPROVED") {
          await gravar(def, antes, { status: "DIVERGENTE", id: t.id, reason: null });
        }
        log.warn("templates.refresh_diverge", { name: def.name });
        out.push({ name: def.name, acao: "diverge", status: t.status });
        continue;
      }
      if (antes === t.status) {
        out.push({ name: def.name, acao: "igual", status: t.status });
        continue;
      }
      const reason = t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null;
      if (await gravar(def, antes, { status: t.status, id: t.id, reason, category: t.category ?? null })) {
        log.info("templates.status_atualizado", { name: def.name, de: antes, para: t.status, via: "refresh" });
        out.push({ name: def.name, acao: "atualizado", de: antes, para: t.status });
      } else {
        // Alguém gravou entre a leitura e aqui: a próxima passada reconcilia.
        out.push({ name: def.name, acao: "igual", status: antes ?? t.status });
      }
    } catch (err) {
      out.push({ name: def.name, acao: "erro", erro: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
