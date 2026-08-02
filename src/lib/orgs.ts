import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { query } from "./db";

/**
 * Configuração por tenant.
 *
 * Um service-user e um token do ImobPro por org RE/MAX — não por gosto, mas
 * porque lá o Bearer deriva a org do DONO do token e não existe header de org.
 * Um token = um usuário = uma org.
 *
 * Os tokens ficam cifrados: este banco guarda credencial que dá acesso de
 * escrita à plataforma, e um dump dele não pode virar acesso aos tenants.
 */

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const raw = process.env.MAX_ENCRYPTION_KEY;
  if (!raw) throw new Error("MAX_ENCRYPTION_KEY não configurada");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("MAX_ENCRYPTION_KEY deve ser 32 bytes em base64");
  }
  return buf;
}

/** Formato: `iv.authTag.ciphertext`, tudo em base64. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("payload cifrado malformado");
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export interface OrgConfig {
  orgId: string;
  orgName: string;
  apiToken: string;
}

/**
 * Cache de processo. As orgs mudam raramente (três tenants), e reler a cada
 * mensagem custaria uma query por turn. TTL curto para que desativar uma org
 * tenha efeito sem redeploy.
 */
let cache: { at: number; rows: OrgConfig[] } | null = null;
const CACHE_TTL_MS = 60_000;

export async function listOrgs(): Promise<OrgConfig[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;

  const rows = await query<{ org_id: string; org_name: string; api_token_enc: string }>(
    `SELECT org_id, org_name, api_token_enc FROM org_config WHERE active ORDER BY created_at`
  );
  const parsed = rows.map((r) => ({
    orgId: r.org_id,
    orgName: r.org_name,
    apiToken: decrypt(r.api_token_enc),
  }));
  cache = { at: Date.now(), rows: parsed };
  return parsed;
}

export async function isOrgKnown(orgId: string): Promise<boolean> {
  return (await orgById(orgId)) !== null;
}

/**
 * Org por id, com o cache como ATALHO e nunca como veredito negativo.
 *
 * O acerto vem do cache; o "não achei" força uma leitura direta antes de virar
 * resposta. A diferença importa porque este processo é serverless: o cache é
 * por INSTÂNCIA, não global. Cadastrado um tenant novo, as instâncias que já
 * tinham lido a lista antiga seguiriam devolvendo "org desconhecida" por até um
 * minuto — e cada uma dessas é um 403 no `/notify`, ou seja, uma notificação
 * PERDIDA, já que o ImobPro não retenta.
 *
 * Foi exatamente o que aconteceu no primeiro teste em produção: duas chamadas
 * idênticas, 202 numa instância e 403 na outra.
 *
 * O custo do caminho pessimista é baixo e limitado: só quem tem assinatura HMAC
 * válida chega aqui, então não dá pra usar isso como amplificador de query.
 */
export async function orgById(orgId: string): Promise<OrgConfig | null> {
  const hit = (await listOrgs()).find((o) => o.orgId === orgId);
  if (hit) return hit;

  const rows = await query<{ org_id: string; org_name: string; api_token_enc: string }>(
    `SELECT org_id, org_name, api_token_enc FROM org_config
      WHERE org_id = $1 AND active`,
    [orgId]
  );
  if (rows.length === 0) return null;

  // Achou fora do cache: ele está velho. Invalida para que a próxima leitura
  // traga a lista inteira atualizada, em vez de só esta org.
  cache = null;
  return {
    orgId: rows[0].org_id,
    orgName: rows[0].org_name,
    apiToken: decrypt(rows[0].api_token_enc),
  };
}

/** Só para os testes — invalida o cache entre cenários. */
export function __resetOrgCache(): void {
  cache = null;
}
