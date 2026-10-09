import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Evals que rodam o GRAFO com o modelo de verdade (OpenRouter) e o ImobPro
 * simulado. Fora do `npm test`: custam centavos e dependem da rede.
 * Uso: OPENROUTER_API_KEY=... npx vitest run --config vitest.eval.config.ts
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["scripts/**/*.eval.ts"],
  },
});
