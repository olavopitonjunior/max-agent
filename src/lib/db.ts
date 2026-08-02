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

export async function query<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await db().query(sql, params);
  return res.rows as T[];
}
