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
    /**
     * Arquivos em SÉRIE, não em paralelo. Os testes de integração compartilham
     * UM Postgres, e o outbox é global por desenho: `dispatchDue` reivindica
     * toda linha vencida, de qualquer org, e `contarVencidas` conta todas.
     * Rodando em paralelo, o arquivo da conexão enfileira 4 vencidas para
     * medir `represadas: 4` no mesmo instante em que o do outbox despacha
     * "tudo que está vencido" — e um dos dois lê o número do outro. Passava
     * por sorte de timing (2 execuções verdes em 12/09 antes de a suíte
     * crescer e a janela abrir); com mais casos, falhava em toda execução,
     * sempre em pares diferentes. Cada arquivo sozinho sempre passou.
     *
     * O custo é duração (~3s → ~8s). A alternativa — escopar as contagens
     * por org — mudaria o código de produção para servir ao teste.
     */
    fileParallelism: false,
    // `scripts/` entrou depois do incidente de 21/08: o runner de migrações
    // destruiu dado em produção e não tinha uma linha de teste. Código que
    // toca o banco precisa de cobertura mesmo quando mora fora de `src/`.
    include: [
      "src/**/__tests__/**/*.test.ts",
      "scripts/**/__tests__/**/*.test.ts",
    ],
  },
});
