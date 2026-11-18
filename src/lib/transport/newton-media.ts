import { isIP } from "node:net";

/**
 * Mídia do Newton que chega POR URL: o bridge (`whatsapp-newton-bridge`) não
 * baixa mais o arquivo da Z-API, repassa a URL em `mediaUrl` no corpo de
 * `POST /agents/newton/run`, e este serviço baixa na hora do turno
 * (`newtonBridgeAdapter.downloadMedia`).
 *
 * Aqui mora só o que não toca a rede: a flag, a allowlist de host, a validação
 * do corpo e a conferência dos bytes. A URL é um link não adivinhável para
 * documento de cliente: nada neste módulo a devolve em erro ou log.
 */

/** Prefixo da referência na fila (`inbound_queue.media_url`); `meta:` é o da Meta. */
export const ZAPI_MEDIA_PREFIX = "zapi:";

export type NewtonMediaKind = "image" | "document";

export interface MidiaDoBridge {
  /** `zapi:<url>` — o que vai para `inbound_queue.media_url`. */
  ref: string;
  kind: NewtonMediaKind;
  /** Minúsculo e sem parâmetros. */
  mimeType: string;
}

const MAX_URL_CHARS = 2048;

const MIMES_IMAGEM = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const MIMES_DOCUMENTO = new Set(["application/pdf"]);

/** Nasce desligada: só o texto exato `true` liga. Lida a cada chamada (testes e deploys). */
export function newtonMediaAtiva(): boolean {
  return process.env.NEWTON_MEDIA_INBOUND === "true";
}

function hostsPermitidos(): string[] {
  return (process.env.NEWTON_MEDIA_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * `https` sem usuário/senha nem porta, host IGUAL a um item de
 * `NEWTON_MEDIA_HOSTS`. Subdomínio só vale com entrada explícita `*.dominio`
 * (que não cobre o apex). Por isso a lista deve ter só hosts do storage da
 * Z-API, nunca um domínio de nuvem compartilhado com curinga. Env vazia recusa
 * tudo. IP literal e
 * `localhost` caem mesmo que alguém os ponha na lista: a mídia vem de storage
 * público, nunca de rede interna.
 */
export function urlDeMidiaPermitida(v: unknown): URL | null {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_URL_CHARS) return null;
  const hosts = hostsPermitidos();
  if (hosts.length === 0) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) return null;
  // `[::1]` chega com colchetes em `hostname`.
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0) return null;
  const permitido = hosts.some((h) => (h.startsWith("*.") ? host.endsWith(h.slice(1)) : host === h));
  return permitido ? url : null;
}

function mimeNormalizado(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.split(";")[0].trim().toLowerCase();
  return m || null;
}

/**
 * Valida o trio `mediaUrl`/`mediaKind`/`mimeType` do corpo do bridge. Qualquer
 * tropeço devolve `null` e a mensagem cai no comportamento de antes da mídia.
 */
export function midiaDoBridge(corpo: {
  mediaUrl?: unknown;
  mediaKind?: unknown;
  mimeType?: unknown;
}): MidiaDoBridge | null {
  const kind = corpo.mediaKind;
  if (kind !== "image" && kind !== "document") return null;
  const mimeType = mimeNormalizado(corpo.mimeType);
  if (!mimeType) return null;
  const permitidos = kind === "image" ? MIMES_IMAGEM : MIMES_DOCUMENTO;
  if (!permitidos.has(mimeType)) return null;
  const url = urlDeMidiaPermitida(corpo.mediaUrl);
  if (!url) return null;
  // `url.href` é o que foi validado; a string crua poderia diferir dele.
  return { ref: `${ZAPI_MEDIA_PREFIX}${url.href}`, kind, mimeType };
}

const MARCAS_HEIC = new Set(["heic", "heix", "hevc"]);
const MARCAS_HEIF = new Set(["mif1", "msf1", "heif"]);

/**
 * O tipo que os BYTES dizem (cabeçalho mágico), não o que o storage declarou:
 * a Z-API serve `application/octet-stream` para arquivo válido, e um servidor
 * comprometido serviria HTML com `application/pdf`.
 */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buf.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (buf.length >= 12) {
    if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
      return "image/webp";
    }
    if (buf.subarray(4, 8).toString("latin1") === "ftyp") {
      const marca = buf.subarray(8, 12).toString("latin1");
      if (MARCAS_HEIC.has(marca)) return "image/heic";
      if (MARCAS_HEIF.has(marca)) return "image/heif";
    }
  }
  return null;
}
