/**
 * Submete o catálogo (`src/lib/templates/catalog.ts`) à Meta e espelha o
 * resultado em `wa_template` (migration 016).
 *
 * ⚠️ O `.env.local` deste repo aponta para PRODUÇÃO. O script imprime o
 * ambiente antes de qualquer coisa e só CHAMA a Meta com `--apply`.
 *
 * Uso:
 *   npx tsx scripts/templates-sync.ts             # dry-run: mostra a tabela final
 *   npx tsx scripts/templates-sync.ts --apply      # submete os que faltam
 *   OUTBOX_ENV=.env.staging npx tsx scripts/templates-sync.ts
 *
 * ── O que o dry-run mostra (SEM chamar a Meta) ───────────────────────────
 * Para cada template do catálogo: se já existe em `wa_template` e com qual
 * status, ou "NOVO — seria submetido". É o checkpoint que o Olavo precisa ver
 * ANTES de qualquer submissão real — rejeição custa dias de nova análise, e
 * mudar o texto depois de aprovado exige resubmeter do zero.
 *
 * ── O que `--apply` faz ───────────────────────────────────────────────────
 * SÓ submete templates AUSENTES de `wa_template` (nunca enviados por este
 * script). Um `REJECTED` ou `PAUSED` não é resubmetido automaticamente: o
 * texto pode ter que mudar antes, e isso é decisão de gente, não de script.
 * Sucesso grava a linha como `PENDING` com o `meta_id` devolvido; o webhook
 * `message_template_status_update` atualiza para `APPROVED`/`REJECTED`
 * depois, quando a Meta terminar a análise.
 *
 * ── Botão ─────────────────────────────────────────────────────────────────
 * URL dinâmica com domínio FIXO e a variável só no fim — exigência da Meta
 * para botão de URL em template. `META_TEMPLATE_REDIRECT_BASE` (opcional)
 * antecipa a troca de domínio sem editar o script; o exemplo enviado à Meta é
 * um id de outbox que nunca é resolvido de verdade, só ilustra o formato.
 */

import { config as loadEnv } from "dotenv";

loadEnv({ path: process.env.OUTBOX_ENV ?? ".env.local" });

import { query, db } from "../src/lib/db";
import { todosOsTemplates, BOTAO_TEXTO, type TemplateDef } from "../src/lib/templates/catalog";
import { fetchWithTimeout, META_TIMEOUT_MS } from "../src/lib/http";

const APPLY = process.argv.includes("--apply");
const REDIRECT_BASE_PADRAO = "https://max-agent-olive.vercel.app";
const GRAPH_VERSION_PADRAO = "v24.0";
/** Id de outbox de exemplo, só para o formato do botão — nunca é resolvido. */
const EXEMPLO_ID_REDIRECT = "00000000-0000-0000-0000-000000000000";

function redirectBase(): string {
  return (process.env.META_TEMPLATE_REDIRECT_BASE ?? "").trim() || REDIRECT_BASE_PADRAO;
}

function graphBase(): string {
  const v = (process.env.META_GRAPH_VERSION ?? "").trim() || GRAPH_VERSION_PADRAO;
  return `https://graph.facebook.com/${v}`;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} não configurada — precisa pra --apply (dry-run não precisa)`);
  return v;
}

interface WaTemplateRow extends Record<string, unknown> {
  name: string;
  status: string;
  meta_id: string | null;
  rejected_reason: string | null;
}

async function estadoAtual(): Promise<Map<string, WaTemplateRow>> {
  const rows = await query<WaTemplateRow>(`SELECT name, status, meta_id, rejected_reason FROM wa_template`);
  return new Map(rows.map((r) => [r.name, r]));
}

function corpoDaSubmissao(def: TemplateDef) {
  const urlBotao = `${redirectBase()}/r/{{1}}`;
  return {
    name: def.name,
    language: def.lang,
    category: def.category,
    components: [
      {
        type: "BODY",
        text: def.body,
        ...(def.exemplos.length > 0 ? { example: { body_text: [def.exemplos] } } : {}),
      },
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "URL",
            text: BOTAO_TEXTO,
            url: urlBotao,
            example: [EXEMPLO_ID_REDIRECT],
          },
        ],
      },
    ],
  };
}

/**
 * `status`: a Meta às vezes já aprova UTILITY na hora — gravar o que ela
 * disse, não assumir PENDING (achado do code review, W3).
 *
 * `definitivo`: só 4xx é VALIDAÇÃO — a Meta olhou o template e recusou (texto,
 * variável, formato). 5xx, 429 e timeout são o TRANSPORTE falhando; a Meta
 * pode ter criado o template mesmo assim, e gravar REJECTED aí seria mentira
 * que trava resubmissão para sempre (achado do code review, W4). Nesses
 * casos não escreve nada — a próxima execução tenta de novo, e um
 * "already exists" ali é sinal pra rodar de novo o dry-run.
 */
async function submeter(
  def: TemplateDef
): Promise<{ id: string; status: string } | { erro: string; definitivo: boolean }> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${graphBase()}/${env("META_WABA_ID")}/message_templates`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env("META_ACCESS_TOKEN")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(corpoDaSubmissao(def)),
      },
      META_TIMEOUT_MS
    );
  } catch (err) {
    return { erro: err instanceof Error ? err.message : String(err), definitivo: false };
  }
  const corpo = (await res.json().catch(() => ({}))) as {
    id?: string;
    status?: string;
    error?: { message?: string };
  };
  if (!res.ok || !corpo.id) {
    return { erro: corpo.error?.message ?? `HTTP ${res.status}`, definitivo: res.status >= 400 && res.status < 500 };
  }
  return { id: corpo.id, status: corpo.status ?? "PENDING" };
}

async function main() {
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").host;
    } catch {
      return "?";
    }
  })();
  console.log(`[templates-sync] banco: ${host} — ${APPLY ? "APPLY (vai chamar a Meta)" : "dry-run"}\n`);

  const atual = await estadoAtual();
  const catalogo = todosOsTemplates();

  console.log("nome".padEnd(34) + "status atual".padEnd(16) + "ação");
  console.log("-".repeat(80));

  let novos = 0;
  for (const def of catalogo) {
    const existente = atual.get(def.name);
    if (!existente) {
      console.log(
        def.name.padEnd(34) + "—".padEnd(16) + (APPLY ? "submetendo…" : "NOVO — seria submetido")
      );
      novos += 1;
      if (APPLY) {
        const r = await submeter(def);
        if ("erro" in r) {
          if (!r.definitivo) {
            console.error(`  ✗ ${def.name}: ${r.erro} — transporte/servidor, NADA gravado (retente depois)`);
          } else {
            console.error(`  ✗ ${def.name}: ${r.erro}`);
            // DO NOTHING: só grava se ninguém tinha escrito ainda (a leitura
            // de `atual` no topo já confirmou ausência; DO NOTHING cobre a
            // corrida rara com um webhook chegando entre a leitura e aqui —
            // nunca sobrescreve um status que já existe (W3).
            await query(
              `INSERT INTO wa_template (name, lang, status, category, rejected_reason, updated_at)
               VALUES ($1, $2, 'REJECTED', $3, $4, now())
               ON CONFLICT (name) DO NOTHING`,
              [def.name, def.lang, def.category, r.erro.slice(0, 500)]
            );
          }
        } else {
          console.log(`  ✓ ${def.name} → meta_id ${r.id}, ${r.status}`);
          await query(
            `INSERT INTO wa_template (name, lang, status, category, meta_id, updated_at)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (name) DO NOTHING`,
            [def.name, def.lang, r.status, def.category, r.id]
          );
        }
      }
      continue;
    }
    const acao =
      existente.status === "APPROVED"
        ? "nada a fazer"
        : existente.status === "REJECTED"
          ? `rejeitado (${existente.rejected_reason ?? "sem motivo"}) — resubmissão é manual`
          : `aguardando a Meta (${existente.status})`;
    console.log(def.name.padEnd(34) + existente.status.padEnd(16) + acao);
  }

  console.log("-".repeat(80));
  if (!APPLY && novos > 0) {
    console.log(
      `\n${novos} template(s) novo(s). Revise os textos com o Olavo (ver ~/.claude/plans/max-templates-rascunho.md) ` +
        `antes de rodar com --apply — rejeição custa dias de nova análise.`
    );
  }
  await db().end();
}

main().catch((err) => {
  console.error("[templates-sync] falhou:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
