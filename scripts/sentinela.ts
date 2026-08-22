/**
 * Os dois artefatos de schema que o `migrate.ts` consulta para decidir o que
 * fazer com um banco — e são DOIS porque as perguntas são duas.
 *
 *  · `BASE` responde "este banco já existe?". Vem da PRIMEIRA migração e nunca
 *    muda. Ausente = banco novo, aplica tudo.
 *  · `EM_DIA` responde "está atualizado?". Vem da ÚLTIMA migração com DDL e
 *    muda a cada uma. Presente = pode ADOTAR (registrar sem executar);
 *    ausente com `BASE` presente = banco incompleto, e aí o script aborta em
 *    vez de adivinhar.
 *
 * Juntar as duas num artefato só quebra os dois lados: se `BASE` virar o
 * artefato novo, um banco antigo parado no meio é tratado como NOVO e recebe
 * todas as migrações de volta — inclusive o UPDATE da 006, que devolve a
 * `pending` linha em `processing` e pode reprocessar conversa com a fila viva.
 * Se `EM_DIA` virar o artefato da 001, um banco parado no meio é ADOTADO como
 * completo e o registro passa a mentir sobre o schema. Já errei nas duas
 * direções em 21/08: a segunda no code review, a primeira ao tentar corrigir a
 * segunda com um sentinela só.
 *
 * **`EM_DIA` precisa acompanhar cada migração nova que mexa em schema.** Não
 * depende de disciplina: `scripts/__tests__/migrate.integration.test.ts` lê as
 * migrações, acha a última com DDL e falha se não for a declarada.
 *
 * ── Por que num arquivo só dele ───────────────────────────────────────────
 *
 * Ficava dentro do `migrate.ts`, que chama `main()` no topo do módulo. O teste
 * importava a constante e, com isso, EXECUTAVA o script — sem `DATABASE_URL`
 * (o caso do CI), o `main()` chamava `process.exit(1)` e derrubava a suíte.
 * Módulo de dado puro é o que torna a importação segura de qualquer lugar.
 */

/** Existe desde a 001. Diz apenas: este banco não é vazio. */
export const BASE = { tabela: "outbox" } as const;

/** Artefato da última migração com DDL. Diz: o schema está completo. */
export const EM_DIA = {
  migracao: "013_connection_state.sql",
  tabela: "connection_state",
  coluna: "connected",
} as const;
