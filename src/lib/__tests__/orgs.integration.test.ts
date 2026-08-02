import { describe, it, expect, beforeEach, afterAll } from "vitest";

/**
 * Regressão de um bug encontrado testando em PRODUÇÃO, não em teste unitário:
 * duas chamadas idênticas ao `/notify`, com a mesma org recém-cadastrada,
 * responderam 202 e 403. A causa é que em serverless o cache de módulo é por
 * INSTÂNCIA — a que atendeu a segunda chamada ainda tinha a lista de antes do
 * INSERT.
 *
 * Cada 403 desses é uma notificação PERDIDA: o ImobPro não retenta.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const { encrypt, isOrgKnown, orgById, listOrgs, __resetOrgCache } = await import("../orgs");
const { query, db } = await import("../db");

const ORG = "org-cache-test";

d("orgs — cache não pode inventar 'org desconhecida'", () => {
  beforeEach(async () => {
    process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");
    await query(`DELETE FROM org_config WHERE org_id = $1`, [ORG]);
    __resetOrgCache();
  });

  afterAll(async () => {
    await query(`DELETE FROM org_config WHERE org_id = $1`, [ORG]);
    await db().end();
  });

  it("org cadastrada DEPOIS do cache aquecido é reconhecida na hora", async () => {
    // Aquece o cache sem a org — é o estado da instância que respondeu 403.
    await listOrgs();
    expect(await isOrgKnown(ORG)).toBe(false);

    await query(
      `INSERT INTO org_config (org_id, org_name, api_token_enc) VALUES ($1,$2,$3)`,
      [ORG, "RE/MAX Cache", encrypt("cmt_x")]
    );

    // Sem esperar o TTL: o "não achei" tem que ser confirmado no banco.
    expect(await isOrgKnown(ORG)).toBe(true);
    const org = await orgById(ORG);
    expect(org?.orgName).toBe("RE/MAX Cache");
    expect(org?.apiToken).toBe("cmt_x");
  });

  it("org inativa continua desconhecida", async () => {
    await query(
      `INSERT INTO org_config (org_id, org_name, api_token_enc, active) VALUES ($1,$2,$3,false)`,
      [ORG, "RE/MAX Off", encrypt("cmt_x")]
    );
    __resetOrgCache();
    expect(await isOrgKnown(ORG)).toBe(false);
  });

  it("org que nunca existiu segue devolvendo desconhecida", async () => {
    expect(await isOrgKnown("org-que-nao-existe")).toBe(false);
  });
});

describe("encrypt/decrypt", () => {
  it("ida e volta preserva o token", async () => {
    process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");
    const { encrypt: enc, decrypt } = await import("../orgs");
    const token = "cmt_abc123";
    expect(decrypt(enc(token))).toBe(token);
  });

  it("duas cifragens do mesmo texto diferem (IV aleatório)", async () => {
    process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");
    const { encrypt: enc } = await import("../orgs");
    expect(enc("x")).not.toBe(enc("x"));
  });
});
