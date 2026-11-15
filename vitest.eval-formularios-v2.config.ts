import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Evals DETERMINÍSTICOS dos formulários v2 (spec §12, Tarefa 18).
 *
 * Por que não o `vitest.eval.config.ts`: aquele roda o grafo com o modelo de verdade (OpenRouter) e
 * custa dinheiro e rede. Aqui o modelo (`@/lib/llm`), o ImobPro (`@/lib/acao`), a mídia, o outbox e o
 * banco são simulados em `setup.ts`; nenhuma chamada sai da máquina e nenhuma chave é lida. Também
 * não entram no `npm test` (o config base só coleta `*.test.ts`): rodam por
 * `npx tsx scripts/eval-formularios-v2.ts` ou direto:
 *
 *   npx vitest run -c vitest.eval-formularios-v2.config.ts
 *
 * Em série (`fileParallelism: false`): o grafo guarda estado em módulo (memos do servidor v2).
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // Perfil vazio = Max. Os casos do Newton fixam o perfil com `vi.stubEnv`.
    env: { AGENT_DEPLOY_PROFILE: "" },
    fileParallelism: false,
    setupFiles: ["src/graph/__tests__/eval/formularios-v2/setup.ts"],
    include: ["src/graph/__tests__/eval/formularios-v2/**/*.eval.ts"],
  },
});
