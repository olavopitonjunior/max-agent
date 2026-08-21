import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

/**
 * Testes de integração leem o banco de TESTE, nunca o de produção.
 *
 * Em produção o cron do outbox roda a cada minuto e chega a reivindicar as
 * linhas criadas pelos testes — despachando-as com o `sendText` de verdade, e
 * não com o mock. Além de deixar o teste instável, isso dispara tentativa de
 * envio real pela Z-API.
 */
loadEnv({ path: ".env.test" });

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // `scripts/` entrou depois do incidente de 21/08: o runner de migrações
    // destruiu dado em produção e não tinha uma linha de teste. Código que
    // toca o banco precisa de cobertura mesmo quando mora fora de `src/`.
    include: [
      "src/**/__tests__/**/*.test.ts",
      "scripts/**/__tests__/**/*.test.ts",
    ],
  },
});
