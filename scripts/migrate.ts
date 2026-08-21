import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { config as loadEnv } from "dotenv";
import { BASE, EM_DIA } from "./sentinela";

// `.env.test` primeiro só quando pedido — migrar produção é o default.
loadEnv({ path: process.env.MIGRATE_ENV ?? ".env.local" });

/**
 * Migrações em SQL puro, aplicadas UMA VEZ, em ordem de nome.
 *
 * ── Por que existe um registro, e não "reaplica tudo sempre" ──────────────
 *
 * A versão anterior reaplicava todos os arquivos a cada execução, apostando
 * que cada um fosse idempotente. A aposta era `IF NOT EXISTS` — que cobre DDL
 * e **não cobre migração de dados**. Três problemas reais nasceram disso, e o
 * primeiro custou dado em produção:
 *
 *  1. **A 009 apagava desfecho de entrega.** O backfill dela carimbava
 *     `reported_at` em toda linha `sent` pendente de report. Como o
 *     `reconcile()` só olha `WHERE reported_at IS NULL`, cada rodada de
 *     migração descartava, em silêncio, os desfechos que ainda não tinham sido
 *     contados ao Contractmaker. Aconteceu em 21/08: atingiu 2 de 2 linhas com
 *     desfecho, horas antes de a integração ser ligada. (A 009 ganhou cercas,
 *     mas a cerca conserta UM caso; o registro conserta a classe.)
 *  2. **A 006 ressuscita turn em voo.** O UPDATE dela devolve a `pending` toda
 *     linha `processing` que não seja a mais antiga do telefone. Rodar isso com
 *     a fila viva pode fazer uma conversa ser processada duas vezes.
 *  3. **A 004 só sobrevive por acidente de ordem.** Ela lê de `inbound_seen`,
 *     que a 005 dropa — funciona porque a 001 recria a tabela antes. Uma
 *     reordenação inocente quebraria a migração inteira.
 *
 * Com o registro, arquivo aplicado não roda de novo e nada disso pode repetir.
 *
 * ── Adoção do que já existe ───────────────────────────────────────────────
 *
 * Num banco que já está EM DIA (ver `SENTINELA`), as migrações antigas
 * obviamente já rodaram — seria absurdo (e, pelo item 2, perigoso) reaplicá-las
 * só para popular o registro. Nesse caso elas são ADOTADAS: entram no registro
 * sem executar, com aviso na saída dizendo exatamente quais. Banco novo roda
 * tudo normalmente; banco INCOMPLETO aborta em vez de adivinhar.
 * `MIGRATE_ADOPT=off` força a execução, se algum dia for preciso.
 *
 * ── Arquivo que muda depois de aplicado ───────────────────────────────────
 *
 * O checksum é guardado. Se um arquivo já aplicado mudar, o script AVISA e
 * não executa — porque executar de novo é exatamente o que causou o item 1.
 * Quem quiser reaplicar deliberadamente usa `MIGRATE_REPLAY=<arquivo>`, que é
 * verboso de propósito: reaplicar migração de dado precisa ser um ato
 * consciente, não o default.
 */

const LEDGER = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  adopted    boolean NOT NULL DEFAULT false
)`;

/**
 * Serializa execuções concorrentes.
 *
 * `max: 1` no Pool limita conexões DENTRO de um processo e não impede dois
 * processos (CI e gente, ou duas abas) de lerem o registro antes de escrever,
 * executarem o mesmo arquivo em paralelo e o `ON CONFLICT DO UPDATE` engolir a
 * dupla execução sem erro. Para DDL idempotente é inofensivo; para migração de
 * DADO é a mesma perda silenciosa que motivou este arquivo, só que por corrida.
 */
const LOCK_ID = 8_142_073; // arbitrário e fixo: só precisa ser exclusivo nosso

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

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

  const replay = process.env.MIGRATE_REPLAY;
  /**
   * `max: 2`, e o segundo slot não é folga: é a conexão que segura o advisory
   * lock do começo ao fim. Com `max: 1` — como era antes de o lock existir — a
   * trava tomava a única conexão e todo o resto ficava esperando por ela:
   * deadlock imediato, e silencioso (o script simplesmente pendura).
   */
  const pool = new Pool({ connectionString: url, max: 2 });

  // Conexão dedicada: advisory lock de sessão morre junto com a sessão, e uma
  // conexão devolvida ao pool poderia soltá-lo cedo demais.
  const trava = await pool.connect();

  try {
    await trava.query(`SELECT pg_advisory_lock($1)`, [LOCK_ID]);
    await pool.query(LEDGER);

    const { rows } = await pool.query<{ filename: string; checksum: string }>(
      `SELECT filename, checksum FROM schema_migrations`
    );
    const registro = new Map(rows.map((r) => [r.filename, r.checksum]));

    /**
     * Adoção só é legítima quando o banco está em dia — e o sentinela precisa
     * ser o artefato da migração MAIS NOVA com DDL, nunca o da primeira.
     *
     * A primeira versão disto usava `outbox` (criada na 001) e tinha o mesmo
     * defeito que este arquivo existe para matar: um banco parado na 007 tem
     * `outbox`, logo "não é novo", logo receberia as dez adotadas — o registro
     * passaria a AFIRMAR que está tudo aplicado enquanto o schema fica atrás do
     * código, em silêncio. Perda silenciosa de estado, de novo.
     *
     * São DOIS artefatos, e a distinção é o que faz isto funcionar (ver
     * `scripts/sentinela.ts`): `BASE` diz se o banco já existe, `EM_DIA` diz
     * se está completo. Existe sem estar em dia = incompleto, e aí o script
     * NÃO adivinha: aborta e diz o que fazer.
     */
    const sentinela = await pool.query<{ existe: boolean; em_dia: boolean }>(
      `SELECT to_regclass('public.' || $1) IS NOT NULL AS existe,
              EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = $2 AND column_name = $3) AS em_dia`,
      [BASE.tabela, EM_DIA.tabela, EM_DIA.coluna]
    );
    const { existe: tem_outbox, em_dia } = sentinela.rows[0];
    const bancoNovo = registro.size === 0 && !tem_outbox;
    const forcarExecucao = process.env.MIGRATE_ADOPT === "off";

    if (registro.size === 0 && tem_outbox && !em_dia && !forcarExecucao) {
      console.error(
        `banco INCOMPLETO: tem \`${BASE.tabela}\` mas não tem ` +
          `\`${EM_DIA.tabela}.${EM_DIA.coluna}\`\n` +
          `(da ${EM_DIA.migracao}). Adotar aqui registraria como aplicadas\n` +
          "migrações que nunca rodaram — exatamente o silêncio que o registro\n" +
          "existe para evitar.\n\n" +
          "Se as migrações realmente precisam rodar neste banco:\n" +
          "  MIGRATE_ADOPT=off npm run db:migrate\n\n" +
          "Antes, leia a 006: o UPDATE dela devolve a `pending` linha em\n" +
          "`processing`, e com a fila viva isso pode reprocessar uma conversa."
      );
      process.exit(1);
    }

    const adotar = registro.size === 0 && tem_outbox && em_dia && !forcarExecucao;

    if (adotar) {
      console.log(
        "banco preexistente e registro vazio — as migrações abaixo serão\n" +
          "ADOTADAS (entram no registro sem executar). Use MIGRATE_ADOPT=off\n" +
          "para executá-las mesmo assim.\n"
      );
    }

    let aplicadas = 0;
    let puladas = 0;
    const divergentes: string[] = [];

    for (const file of files) {
      const sql = readFileSync(join(dir, file), "utf8");
      const soma = checksum(sql);
      const registrada = registro.get(file);
      const forcada = replay === file;

      if (registrada && !forcada) {
        if (registrada !== soma) divergentes.push(file);
        puladas += 1;
        continue;
      }

      /**
       * `forcada` vence a adoção. Sem esta checagem, um `MIGRATE_REPLAY=` numa
       * primeira execução (banco em dia, registro vazio — exatamente o cenário
       * de estrear este script) adotava o arquivo em silêncio em vez de
       * reaplicá-lo: o operador pedia uma coisa e recebia outra, sem log.
       */
      if (adotar && !forcada) {
        await pool.query(
          `INSERT INTO schema_migrations (filename, checksum, adopted)
           VALUES ($1, $2, true)
           ON CONFLICT (filename) DO NOTHING`,
          [file, soma]
        );
        console.log(`· ${file} — adotada`);
        continue;
      }

      process.stdout.write(`→ ${file} ${forcada ? "(REPLAY) " : ""}... `);
      const client = await pool.connect();
      try {
        /**
         * A migração e o registro dela entram juntos: falha no meio não deixa
         * um arquivo marcado como aplicado sem ter aplicado.
         *
         * **Efeito colateral que vale saber**: dentro de transação o Postgres
         * recusa `CREATE INDEX CONCURRENTLY`. Hoje é irrelevante — as tabelas
         * são pequenas e o lock dura milissegundos —, mas quem um dia precisar
         * indexar `outbox` ou `inbound_queue` cheias vai bater aqui, e um
         * `CREATE INDEX` comum nessas tabelas trava ESCRITA em produção pelo
         * tempo da construção. Nesse dia, a saída é rodar o índice fora deste
         * runner, à mão, e registrar o arquivo com `MIGRATE_REPLAY`.
         */
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum)
           VALUES ($1, $2)
           ON CONFLICT (filename)
           DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
          [file, soma]
        );
        await client.query("COMMIT");
        console.log("ok");
        aplicadas += 1;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }

    if (adotar) {
      console.log(`\n${files.length} migração(ões) adotada(s), nenhuma executada.`);
    } else {
      console.log(
        `\n${aplicadas} aplicada(s), ${puladas} já registrada(s).` +
          (aplicadas === 0 ? " Nada a fazer." : "")
      );
    }

    if (divergentes.length > 0) {
      console.warn(
        `\n⚠️  ${divergentes.length} arquivo(s) MUDARAM depois de aplicados e ` +
          `NÃO foram executados:\n` +
          divergentes.map((f) => `   · ${f}`).join("\n") +
          `\n\n   Se a mudança precisa ir ao banco, reaplique de propósito:\n` +
          `   MIGRATE_REPLAY=<arquivo> npm run db:migrate\n` +
          `   Antes disso, leia o arquivo: reaplicar migração de DADO pode ` +
          `destruir estado\n   (foi assim que a 009 apagou desfechos de entrega ` +
          `em 21/08).`
      );
    }
  } finally {
    // Ordem importa: soltar o lock antes de fechar o pool. `pool.end()` mata a
    // sessão e o Postgres liberaria sozinho, mas soltar explicitamente deixa o
    // rastro correto em `pg_locks` se alguém estiver investigando um travamento.
    await trava.query(`SELECT pg_advisory_unlock($1)`, [LOCK_ID]).catch(() => undefined);
    trava.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("\nfalhou:", err instanceof Error ? err.message : err);
  process.exit(1);
});
