import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
// Separate from paid model evals: this command cannot select those files.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", include: ["scripts/eval-runtime.eval.ts"], maxWorkers: 1, minWorkers: 1 },
});
