/**
 * Provisionamento do acesso do Max a tenants do ImobPro, em SQL direto.
 *
 * Espelha `apps/web/src/lib/max/provisioning.ts`, que é a implementação
 * canônica e a que fica. Este script existe porque o client Prisma do checkout
 * principal está gerado em modo Accelerate (`--no-engine`), que exige URL
 * `prisma://` e derruba qualquer script de runtime contra `postgresql://` — e
 * regenerá-lo mexeria num `node_modules` compartilhado por várias sessões
 * abertas. Ver a memória `feedback_prisma_generate_no_engine`.
 *
 * Quando o client for regenerado com engine, use o script canônico
 * (`apps/web/scripts/provision-max-org.ts`) e apague este.
 *
 * Uso:
 *   node scripts/provision-tenants.mjs                # dry-run
 *   node scripts/provision-tenants.mjs --apply
 *
 * Env: CM_DATABASE_URL (produção do ImobPro), MAX_ENCRYPTION_KEY, DATABASE_URL
 *      (banco do Max, para gravar em org_config).
 */
import { randomBytes, createHash, createCipheriv } from "node:crypto";
import pg from "pg";

const APPLY = process.argv.includes("--apply");

/** Fase 2: ler persona, consultar base, reportar custo. Sem escrita, sem delegação. */
const SCOPES = ["agents:r", "agents:rw", "metrics:r"];

const ORGS = [
  { id: "cmr9nqe5u0001aqq47qeptccd", name: "RE/MAX Trio" },
  { id: "cmrxk7slg0003139t4e692s8y", name: "RE/MAX Ace" },
  { id: "cmrjq0ols000314ndrfymgw95", name: "RE/MAX Ativa" },
  { id: "cms7xmtks001gf13av1wf98tb", name: "Fincasa" },
];

/** Formato do Prisma `cuid()`: 'c' + 24 chars base36. Só precisa ser único. */
function cuid() {
  return "c" + randomBytes(16).toString("hex").slice(0, 24);
}

/** Idêntico a `generateRawToken` + `hashToken` de lib/auth/api-token.ts. */
function newToken() {
  const raw = "cmt_" + randomBytes(32).toString("base64url");
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
}

function encrypt(plain, keyB64) {
  const key = Buffer.from(keyB64, "base64");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

async function provision(cm, org) {
  const email = `max+${org.id}@agents.imobpro.local`;

  const existing = await cm.query(`SELECT id FROM "User" WHERE email = $1`, [email]);
  let userId = existing.rows[0]?.id;

  if (!userId) {
    userId = cuid();
    // `passwordHash` NULL: sem hash o provider Credentials não autentica.
    // `phone` NULL: `User.phone` é @unique GLOBAL e um usuário de serviço com
    // telefone apareceria no `by-phone` como se fosse gente — justo o caminho
    // em que o Max identifica quem está falando.
    await cm.query(
      `INSERT INTO "User" (id, email, name, "passwordHash", phone, "emailVerified", role, "createdAt", "updatedAt")
       VALUES ($1,$2,$3,NULL,NULL,now(),'user',now(),now())`,
      [userId, email, `Max (${org.name})`]
    );
  }

  await cm.query(
    `INSERT INTO "OrgMembership" (id, "userId", "orgId", role, "invitedAt")
     VALUES ($1,$2,$3,'viewer',now())
     ON CONFLICT ("userId","orgId") DO NOTHING`,
    [cuid(), userId, org.id]
  );

  // O invariante, verificado e não presumido: o Bearer resolve a org pela
  // PRIMEIRA membership do dono do token, e o token nem entra nessa conta. Com
  // duas, o Max escreveria no tenant errado — com 200 OK e audit da org errada.
  const { rows } = await cm.query(
    `SELECT COUNT(*)::int AS n FROM "OrgMembership" WHERE "userId" = $1`,
    [userId]
  );
  if (rows[0].n !== 1) {
    throw new Error(
      `${org.name}: usuário de serviço tem ${rows[0].n} memberships (esperado 1)`
    );
  }

  const anteriores = await cm.query(
    `SELECT id FROM "UserApiToken" WHERE "userId" = $1 AND "revokedAt" IS NULL`,
    [userId]
  );

  const { raw, hash } = newToken();
  const tokenId = cuid();
  await cm.query(
    `INSERT INTO "UserApiToken" (id, "userId", name, "hashedToken", scopes, "createdAt")
     VALUES ($1,$2,$3,$4,$5,now())`,
    [tokenId, userId, `Max (${org.name})`, hash, SCOPES]
  );

  // Revoga DEPOIS de emitir: na ordem inversa haveria uma janela sem
  // credencial válida.
  if (anteriores.rowCount > 0) {
    await cm.query(
      `UPDATE "UserApiToken" SET "revokedAt" = now() WHERE id = ANY($1::text[])`,
      [anteriores.rows.map((r) => r.id)]
    );
  }

  return { userId, tokenId, raw, rotated: anteriores.rowCount > 0 };
}

/**
 * Liga a feature do Max. `featureFlags` é merge incremental — sobrescrever o
 * objeto inteiro apagaria overrides que a org já tenha.
 */
async function enableFeature(cm, orgId, module, feature) {
  await cm.query(
    `INSERT INTO "OrgModule" (id, "orgId", module, enabled, "featureFlags", "createdAt", "updatedAt")
     VALUES ($1,$2,$3,true,$4::jsonb,now(),now())
     ON CONFLICT ("orgId", module) DO UPDATE
       SET enabled = true,
           "featureFlags" = "OrgModule"."featureFlags" || $4::jsonb,
           "updatedAt" = now()`,
    [cuid(), orgId, module, JSON.stringify({ [feature]: true })]
  );
}

async function main() {
  const cmUrl = process.env.CM_DATABASE_URL;
  const maxUrl = process.env.DATABASE_URL;
  const key = process.env.MAX_ENCRYPTION_KEY;
  if (!cmUrl || !maxUrl || !key) {
    console.error("faltam CM_DATABASE_URL, DATABASE_URL ou MAX_ENCRYPTION_KEY");
    process.exit(1);
  }

  if (!APPLY) {
    console.log("[dry-run] provisionaria e ligaria vendas.max em:");
    for (const o of ORGS) console.log(`  - ${o.name} (${o.id})`);
    console.log(`\nescopos: ${SCOPES.join(", ")}`);
    console.log("rode de novo com --apply");
    return;
  }

  const cm = new pg.Client({ connectionString: cmUrl });
  const max = new pg.Client({ connectionString: maxUrl });
  await cm.connect();
  await max.connect();

  try {
    for (const org of ORGS) {
      const r = await provision(cm, org);
      await enableFeature(cm, org.id, "vendas", "vendas.max");

      await max.query(
        `INSERT INTO org_config (org_id, org_name, api_token_enc, active)
         VALUES ($1,$2,$3,true)
         ON CONFLICT (org_id) DO UPDATE
           SET org_name = EXCLUDED.org_name,
               api_token_enc = EXCLUDED.api_token_enc,
               active = true`,
        [org.id, org.name, encrypt(r.raw, key)]
      );

      console.log(
        `${r.rotated ? "rotacionado" : "criado"}  ${org.name.padEnd(14)} user=${r.userId} token=${r.tokenId}`
      );
    }
    console.log("\nfeito. Os tokens crus foram cifrados direto no org_config do Max.");
  } finally {
    await cm.end();
    await max.end();
  }
}

main().catch((e) => {
  console.error("\nerro:", e.message);
  process.exit(1);
});
