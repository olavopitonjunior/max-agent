/**
 * Artefato de schema da ÚLTIMA migração com DDL.
 *
 * É o sentinela que o `migrate.ts` usa para decidir se um banco preexistente
 * está em dia (e portanto pode ter as migrações ADOTADAS, registradas sem
 * executar) ou se está incompleto (e aí o script aborta em vez de adivinhar).
 *
 * **Precisa acompanhar cada migração nova que mexa em schema.** Não depende de
 * disciplina: `scripts/__tests__/migrate.integration.test.ts` lê as migrações,
 * acha a última com DDL e falha se ela não for a declarada aqui. Esquecer isto
 * faria um banco parado na migração seguinte ser adotado como completo — a
 * mesma perda silenciosa de estado que o registro de migrações existe para
 * matar, um passo à frente.
 *
 * ── Por que mora num arquivo só dele ──────────────────────────────────────
 *
 * Ficava dentro do `migrate.ts`, que chama `main()` no topo do módulo. O teste
 * importava a constante e, com isso, EXECUTAVA o script — sem `DATABASE_URL`
 * (o caso do CI), o `main()` chamava `process.exit(1)` e derrubava a suíte
 * inteira. Passava na minha máquina porque o `.env.test` mascarava.
 *
 * Módulo de dado puro, sem efeito colateral, é o que torna a importação segura
 * de qualquer lugar.
 */
export const SENTINELA = {
  migracao: "009_reconcile_hardening.sql",
  tabela: "outbox",
  coluna: "report_attempts",
} as const;
