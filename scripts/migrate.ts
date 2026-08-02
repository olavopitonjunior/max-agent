import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

/**
 * Migrações em SQL puro, aplicadas em ordem de nome.
 *
 * Sem ORM nem framework de migração de propósito: são cinco tabelas e o schema
 * muda raramente. O que importa é que cada arquivo seja idempotente
 * (`IF NOT EXISTS`), porque este script roda à mão e ninguém lembra o que já
 * aplicou.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL não configurada");
    process.exit(1);
  }

  const dir = join(process.cwd(), "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) {
    console.log("nenhuma migração encontrada");
    return;
  }

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    for (const file of files) {
      process.stdout.write(`→ ${file} ... `);
      await pool.query(readFileSync(join(dir, file), "utf8"));
      console.log("ok");
    }
    console.log(`\n${files.length} migração(ões) aplicada(s).`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("\nfalhou:", err instanceof Error ? err.message : err);
  process.exit(1);
});
