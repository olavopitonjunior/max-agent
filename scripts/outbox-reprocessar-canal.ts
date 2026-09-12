/**
 * Devolve a `pending` as notificações que viraram `failed` por CULPA DO CANAL
 * (assinatura da Z-API cancelada, credencial trocada) — para o cron despachar
 * quando o canal voltar.
 *
 * ⚠️ O `.env.local` deste repo aponta para PRODUÇÃO. O script imprime o host
 * antes de qualquer coisa e só escreve com `--apply`.
 *
 * Uso:
 *   npx tsx scripts/outbox-reprocessar-canal.ts --desde 2026-09-10            # lista
 *   npx tsx scripts/outbox-reprocessar-canal.ts --desde 2026-09-10 --exceto "TESTE —"
 *   npx tsx scripts/outbox-reprocessar-canal.ts --desde 2026-09-10 --exceto "TESTE —" --apply
 *   OUTBOX_ENV=.env.staging npx tsx scripts/outbox-reprocessar-canal.ts --desde ...
 *
 * `--desde` é obrigatório: reprocessar sem corte de idade ressuscita aviso de
 * semanas atrás no WhatsApp de cliente real. Só a data = meia-noite de São
 * Paulo. `--limite` (padrão 100) é o teto por execução. Em produção, rode
 * SEMPRE o dry-run antes, e `--apply` só com o `--exceto "TESTE —"` junto.
 *
 * O que ele NÃO faz: enviar. As linhas voltam a `pending` com `deliver_after`
 * na próxima janela (7h–22h) e saem pelo cron, com claim e marcador — o mesmo
 * caminho de qualquer notificação.
 */

import { config as loadEnv } from "dotenv";

loadEnv({ path: process.env.OUTBOX_ENV ?? ".env.local" });

import { reprocessarFalhasDeCanal } from "../src/lib/outbox-reprocesso";
import { db } from "../src/lib/db";

const USO =
  "uso: npx tsx scripts/outbox-reprocessar-canal.ts --desde <AAAA-MM-DD|ISO> [--exceto <texto>] [--limite N] [--apply]";

/**
 * Valor de uma flag. Flag presente SEM valor é erro, não "o próximo token":
 * `--exceto --apply` (esqueceu o texto) engoliria o `--apply` como valor e
 * rodaria em modo APPLY sem exclusão nenhuma — contra produção (achado do
 * code review).
 */
function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  if (i < 0) return undefined;
  const valor = process.argv[i + 1];
  if (valor === undefined || valor.startsWith("--")) {
    console.error(`${nome} exige um valor\n${USO}`);
    process.exit(1);
  }
  return valor;
}

/**
 * `--desde` só com a data é meia-noite de SÃO PAULO, não UTC: `new Date(
 * "2026-09-10")` é 2026-09-10T00:00Z = 21h do dia 9 no Brasil, e incluiria
 * três horas do dia anterior. Com hora explícita (ISO completo) vale o que
 * está escrito.
 */
function parseDesde(bruto: string): Date | null {
  const soData = /^\d{4}-\d{2}-\d{2}$/.test(bruto);
  const d = new Date(soData ? `${bruto}T00:00:00-03:00` : bruto);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const desdeArg = arg("--desde");
  const exceto = arg("--exceto");
  const limite = Number(arg("--limite") ?? "100");

  const desde = desdeArg ? parseDesde(desdeArg) : null;
  if (!desde) {
    console.error(USO);
    process.exit(1);
  }
  if (!Number.isInteger(limite) || limite <= 0) {
    console.error("--limite tem que ser inteiro positivo");
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL ausente — confira o .env.local ou OUTBOX_ENV");
    process.exit(1);
  }
  const { hostname, pathname } = new URL(url);
  console.log(`banco: ${hostname}${pathname}  (${apply ? "APLICANDO" : "dry-run"})`);

  const r = await reprocessarFalhasDeCanal({ apply, desde, exceto, limite });

  if (r.candidatas.length === 0) {
    console.log(`nenhuma linha \`failed\` por causa de canal desde ${desde.toISOString()}`);
    return;
  }
  if (r.truncado) {
    console.log(`(teto de ${limite} atingido — há mais candidatas; rode de novo depois)`);
  }

  for (const c of r.candidatas) {
    console.log(
      [
        c.excluida ? "  [excluída]" : "  [reprocessar]",
        c.created_at.toISOString(),
        c.org_name,
        JSON.stringify(c.title),
        `— ${(c.last_error ?? "").slice(0, 80)}`,
      ].join("  ")
    );
  }

  const alvo = r.candidatas.filter((c) => !c.excluida).length;
  if (!apply) {
    console.log(
      `\n${alvo} linha(s) seriam devolvidas a pending (vencendo em ${r.deliverAfter.toISOString()}). ` +
        `Rode com --apply para efetivar.`
    );
    return;
  }
  console.log(
    `\n${r.reprocessadas.length} linha(s) devolvida(s) a pending; vencem em ${r.deliverAfter.toISOString()}.`
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => db().end().catch(() => undefined));
