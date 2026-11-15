/**
 * Roda os evals determinísticos dos formulários v2 (Tarefa 18).
 *
 * Sem rede e sem chave: o modelo (`@/lib/llm`) e o servidor (`executarAcao`) são simulados em
 * `src/graph/__tests__/eval/formularios-v2/setup.ts`. Por isso NÃO usa `vitest.eval.config.ts` (aquele
 * chama o modelo real pelo OpenRouter) e não faz parte de `npm test` (o config padrão só coleta
 * `*.test.ts`).
 *
 * Uso: `npx tsx scripts/eval-formularios-v2.ts [filtro...]`. Os filtros vão direto ao vitest
 * (ex.: `foto`, `conta-sem-plus`). O código de saída é o do vitest.
 */
import { spawnSync } from "node:child_process";

const filtros = process.argv.slice(2);
const r = spawnSync("npx", ["vitest", "run", "-c", "vitest.eval-formularios-v2.config.ts", ...filtros], {
  stdio: "inherit",
  env: { ...process.env, AGENT_DEPLOY_PROFILE: "" },
});
process.exit(r.status ?? 1);
