import { query } from "./db";

/**
 * Limpa UMA thread das três tabelas que o `PostgresSaver` do LangGraph usa
 * para guardar checkpoint — mesmo efeito de "começar do zero" sem trocar de
 * número.
 *
 * Extraído de `scripts/turn.ts --novo` porque o playground
 * (`/api/admin/playground`, `novo: true`) precisa do MESMO comportamento: duas
 * cópias do mesmo DELETE em três tabelas é exatamente o tipo de duplicação que
 * diverge silenciosamente quando uma migration acrescenta uma quarta tabela ao
 * checkpointer e só um dos dois lugares é lembrado.
 *
 * Nunca lança: falha aqui é só o harness/playground não conseguir resetar —
 * não motivo para abortar quem chama. Em produção nada apaga histórico por
 * este caminho.
 */
export async function limparThreadDoCheckpointer(threadId: string): Promise<void> {
  for (const tabela of ["checkpoint_writes", "checkpoint_blobs", "checkpoints"]) {
    await query(`DELETE FROM ${tabela} WHERE thread_id = $1`, [threadId]).catch(
      () => undefined
    );
  }
}
