import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * I5 — selo do corpo da ficha no outbox.
 *
 * A ficha "lido — confira" carrega valores de documento (nome, CPF mascarado,
 * endereço). Sem selo, ela ficaria em claro na coluna `outbox.body` até a linha ser
 * limpa. Aqui o corpo é cifrado (AES-256-GCM, subchave HKDF própria derivada da
 * `MAX_ENCRYPTION_KEY`) e amarrado a `org|telefone` (AAD): a linha copiada para outro
 * destinatário não abre. Só `node:crypto`: este módulo não importa nada do projeto
 * (o outbox o carrega sem puxar o grafo).
 */

export const PREFIXO_DO_SELO = "ficha-selada:v1:";
const TAMANHO_DA_TAG = 16;

function chaveDoSelo(): Buffer {
  const raw = process.env.MAX_ENCRYPTION_KEY;
  if (!raw) throw new Error("MAX_ENCRYPTION_KEY não configurada");
  const mestra = Buffer.from(raw, "base64");
  if (mestra.length !== 32) throw new Error("MAX_ENCRYPTION_KEY deve ser 32 bytes em base64");
  return Buffer.from(hkdfSync("sha256", mestra, Buffer.alloc(0), "max-formularios-ficha-outbox", 32));
}

/** A chave existe e tem o formato certo? (nunca lança) */
export function seloDisponivel(): boolean {
  try {
    chaveDoSelo();
    return true;
  } catch {
    return false;
  }
}

export function estaSelado(body: string): boolean {
  return typeof body === "string" && body.startsWith(PREFIXO_DO_SELO);
}

/** Cifra o corpo. Lança sem chave: quem chama NÃO agenda a ficha (ela vai no turno). */
export function selarCorpo(texto: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chaveDoSelo(), iv, { authTagLength: TAMANHO_DA_TAG });
  c.setAAD(Buffer.from(aad, "utf8"));
  const enc = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return PREFIXO_DO_SELO + [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

/** Abre o corpo selado. Qualquer falha (sem prefixo, AAD errado, chave rotacionada, adulterado) lança. */
export function abrirCorpo(body: string, aad: string): string {
  if (!estaSelado(body)) throw new Error("corpo não selado");
  const [iv, tag, dado] = body.slice(PREFIXO_DO_SELO.length).split(".");
  if (!iv || !tag || !dado) throw new Error("selo malformado");
  const tagBuf = Buffer.from(tag, "base64");
  if (tagBuf.length !== TAMANHO_DA_TAG) throw new Error("selo malformado: tag de tamanho inválido");
  const d = createDecipheriv("aes-256-gcm", chaveDoSelo(), Buffer.from(iv, "base64"), { authTagLength: TAMANHO_DA_TAG });
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(tagBuf);
  return Buffer.concat([d.update(Buffer.from(dado, "base64")), d.final()]).toString("utf8");
}
