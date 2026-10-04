/**
 * Backfill do custo real da Meta (`meta_cost_daily`) — o cron relê só os
 * últimos 7 dias; para períodos anteriores (primeiro deploy, cron parado mais
 * de uma semana), roda isto.
 *
 *   npx tsx scripts/custos-sync.ts --dias=60            # grava (banco do .env.local)
 *   OUTBOX_ENV=.env.test npx tsx scripts/custos-sync.ts --dias=3
 *
 * Precisa de META_ACCESS_TOKEN, META_WABA_ID e META_PHONE_NUMBER_ID no
 * ambiente. Imprime o host do banco antes de gravar — `.env.local` é PRODUÇÃO.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: process.env.OUTBOX_ENV ?? ".env.local" });

async function main() {
  const arg = process.argv.find((a) => a.startsWith("--dias="));
  const dias = arg ? Number(arg.split("=")[1]) : 30;
  if (!Number.isInteger(dias) || dias < 1 || dias > 400) {
    throw new Error("--dias precisa ser um inteiro entre 1 e 400");
  }
  const host = new URL(process.env.DATABASE_URL ?? "postgres://-").host;
  console.log(`[custos-sync] banco: ${host} — ${dias} dia(s)`);

  const { syncCustosMeta } = await import("../src/lib/custos/meta-analytics");
  const r = await syncCustosMeta(new Date(), dias);
  console.log(
    `[custos-sync] ${r.linhas} linha(s) de ${r.pontos} ponto(s), moeda ${r.moeda || "?"}, número ${r.numero}, ` +
      `${r.dias[0]} → ${r.dias.at(-1)}`
  );
  const { db } = await import("../src/lib/db");
  await db().end();
}

main().catch((err) => {
  console.error("[custos-sync] falhou:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
