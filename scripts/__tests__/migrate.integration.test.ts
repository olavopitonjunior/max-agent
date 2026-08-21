import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { SENTINELA } from "../migrate";

/**
 * O runner de migrações, sob teste porque ele destruiu dado em produção.
 *
 * Em 21/08 o `migrate.ts` reaplicava todos os arquivos a cada execução, e o
 * backfill da 009 — sem cerca, na época — carimbava `reported_at` em toda
 * linha pendente de report. Cada `npm run db:migrate` descartava, em silêncio,
 * os desfechos de entrega que ainda não tinham chegado ao Contractmaker.
 *
 * O que este arquivo protege não é o formato da saída: é **o invariante que
 * torna aquilo impossível de repetir** — arquivo registrado não roda de novo —
 * e os dois modos em que o script decide sozinho o que fazer com um banco que
 * já existe. Um teste de formato quebraria à toa; estes quebram só se a
 * proteção sumir.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const RAIZ = join(__dirname, "..", "..");

/**
 * A trava que impede o sentinela de envelhecer em silêncio.
 *
 * O sentinela (`SENTINELA` em `scripts/migrate.ts`) precisa apontar para o
 * artefato da ÚLTIMA migração com DDL. Se alguém adicionar uma migração nova
 * que mexe em schema e não atualizar a constante, um banco parado nessa
 * migração passa a ser adotado como completo — reintroduzindo, um passo à
 * frente, a perda silenciosa que este runner existe para matar.
 *
 * "Lembrar de atualizar" não é garantia. Este teste é. E não precisa de banco:
 * é leitura de arquivo, então roda no CI também.
 */
describe("sentinela de adoção", () => {
  it("aponta para a última migração com DDL", () => {
    const dir = join(RAIZ, "migrations");
    const comDdl = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) =>
        /\b(CREATE\s+TABLE|ALTER\s+TABLE[\s\S]*?ADD\s+COLUMN)\b/i.test(
          readFileSync(join(dir, f), "utf8")
        )
      );

    expect(comDdl.at(-1)).toBe(SENTINELA.migracao);
  });

  it("o artefato apontado existe mesmo na migração declarada", () => {
    const sql = readFileSync(join(RAIZ, "migrations", SENTINELA.migracao), "utf8");
    expect(sql).toContain(SENTINELA.tabela);
    expect(sql).toContain(SENTINELA.coluna);
  });
});

/** Roda o script contra um banco específico e devolve a saída. */
function migrar(dbUrl: string, extra: Record<string, string> = {}): string {
  return execFileSync("npx", ["tsx", "scripts/migrate.ts"], {
    cwd: RAIZ,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: dbUrl, ...extra },
  });
}

async function comCliente<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Banco descartável, para não sujar o de teste com DDL de outro schema. */
const BANCO = "migrunner_test";
const base = process.env.DATABASE_URL ?? "";
const urlAdmin = base ? new URL(base) : null;
if (urlAdmin) urlAdmin.pathname = "/postgres";
const urlAlvo = base ? new URL(base) : null;
if (urlAlvo) urlAlvo.pathname = `/${BANCO}`;

async function recriarBanco() {
  await comCliente(urlAdmin!.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${BANCO}`);
    await c.query(`CREATE DATABASE ${BANCO}`);
  });
}

d("scripts/migrate.ts (Postgres real)", () => {
  beforeEach(recriarBanco);

  afterAll(async () => {
    if (!hasDb) return;
    await comCliente(urlAdmin!.toString(), (c) =>
      c.query(`DROP DATABASE IF EXISTS ${BANCO}`)
    );
  });

  it("banco novo: aplica tudo e registra", async () => {
    const saida = migrar(urlAlvo!.toString());
    expect(saida).toMatch(/aplicada\(s\)/);

    const n = await comCliente(urlAlvo!.toString(), async (c) =>
      Number((await c.query(`SELECT count(*) n FROM schema_migrations`)).rows[0].n)
    );
    expect(n).toBeGreaterThan(0);
  });

  /**
   * O invariante. Se este teste cair, o incidente de 21/08 volta a ser
   * possível: um `UPDATE` de migração passa a rodar de novo sobre dado vivo.
   */
  it("arquivo registrado NÃO roda de novo", async () => {
    migrar(urlAlvo!.toString());

    // Marca o banco de um jeito que só uma reexecução apagaria: a 010 apaga
    // fatos cujo valor é ausência-de-fato ("não informado").
    await comCliente(urlAlvo!.toString(), (c) =>
      c.query(
        `INSERT INTO memory_facts (org_id, phone, key, value)
         VALUES ('o','5511900000000','k','não informado')`
      )
    );

    const saida = migrar(urlAlvo!.toString());
    expect(saida).toMatch(/0 aplicada\(s\)/);

    const sobrou = await comCliente(urlAlvo!.toString(), async (c) =>
      Number((await c.query(`SELECT count(*) n FROM memory_facts`)).rows[0].n)
    );
    // A linha continua lá: prova que o SQL da 010 não tornou a rodar.
    expect(sobrou).toBe(1);
  });

  it("banco preexistente e em dia: ADOTA sem executar", async () => {
    migrar(urlAlvo!.toString());
    // Apaga só o registro: o schema continua completo, como num banco que
    // existia antes desta versão do script.
    await comCliente(urlAlvo!.toString(), (c) =>
      c.query(`DROP TABLE schema_migrations`)
    );

    const saida = migrar(urlAlvo!.toString());
    expect(saida).toMatch(/adotada\(s\), nenhuma executada/);

    const adotadas = await comCliente(urlAlvo!.toString(), async (c) =>
      Number(
        (await c.query(`SELECT count(*) n FROM schema_migrations WHERE adopted`))
          .rows[0].n
      )
    );
    expect(adotadas).toBeGreaterThan(0);
  });

  /**
   * O achado do orchestrator: a primeira versão usava `outbox` (criada na 001)
   * como sentinela, então um banco parado no meio seria adotado por inteiro e
   * ficaria com o registro MENTINDO sobre o schema. O sentinela agora é o
   * artefato da última migração com DDL, e banco incompleto aborta.
   */
  it("banco preexistente e INCOMPLETO: aborta em vez de adotar", async () => {
    migrar(urlAlvo!.toString());
    await comCliente(urlAlvo!.toString(), async (c) => {
      await c.query(`DROP TABLE schema_migrations`);
      // Desfaz a 009: o banco passa a parecer parado antes dela.
      await c.query(`ALTER TABLE outbox DROP COLUMN report_attempts`);
    });

    expect(() => migrar(urlAlvo!.toString())).toThrow();

    // E não deixou registro nenhum para trás — nada de meio-adotado.
    const existe = await comCliente(urlAlvo!.toString(), async (c) =>
      (
        await c.query(
          `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS e`
        )
      ).rows[0].e
    );
    // A tabela pode existir (é criada antes da checagem), mas vazia.
    if (existe) {
      const n = await comCliente(urlAlvo!.toString(), async (c) =>
        Number(
          (await c.query(`SELECT count(*) n FROM schema_migrations`)).rows[0].n
        )
      );
      expect(n).toBe(0);
    }
  });
});
