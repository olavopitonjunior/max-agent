import { Pool } from "pg";

/**
 * Pool único por instância de function.
 *
 * Em serverless cada invocação pode reusar o processo, então guardar o pool no
 * escopo do módulo evita abrir conexão por request. `max: 3` porque o Neon
 * cobra por conexão e a Vercel pode ter muitas instâncias vivas ao mesmo
 * tempo — a connection string DEVE ser a *pooled* do Neon.
 */
let pool: Pool | null = null;

export function db(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL não configurada");
    pool = new Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

/**
 * Pool PRÓPRIA do checkpointer do LangGraph — separada, mas com teto.
 *
 * O `PostgresSaver` segura um client dedicado em transação (BEGIN/COMMIT) a
 * cada escrita de checkpoint. Na pool compartilhada de `max: 3`, três turns
 * quentes seguravam os três clients e as queries da fila estouravam o
 * `connectionTimeoutMillis` (achado do code review). Na direção oposta, o
 * `fromConnString` de antes criava uma pool SEM teto — furando a
 * contabilidade de conexões do Neon. Duas pools pequenas e explícitas é o
 * meio-termo: 3 + 2, somando 5 por instância.
 */
let ckptPool: Pool | null = null;

export function checkpointerPool(): Pool {
  if (!ckptPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL não configurada");
    ckptPool = new Pool({
      connectionString,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return ckptPool;
}

export async function query<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await db().query(sql, params);
  return res.rows as T[];
}
