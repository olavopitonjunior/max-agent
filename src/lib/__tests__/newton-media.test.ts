import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ZAPI_MEDIA_PREFIX,
  midiaDoBridge,
  newtonMediaAtiva,
  sniffMime,
  urlDeMidiaPermitida,
} from "../transport/newton-media";

/**
 * Contrato da mídia que o bridge do Newton repassa por URL. Sem rede: só a
 * validação do corpo, a allowlist de host e a conferência dos bytes.
 */

beforeEach(() => {
  vi.stubEnv("NEWTON_MEDIA_HOSTS", "media.zapi.example");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("newtonMediaAtiva", () => {
  it("nasce desligada e só liga com o texto exato 'true'", () => {
    expect(newtonMediaAtiva()).toBe(false);
    vi.stubEnv("NEWTON_MEDIA_INBOUND", "1");
    expect(newtonMediaAtiva()).toBe(false);
    vi.stubEnv("NEWTON_MEDIA_INBOUND", "TRUE");
    expect(newtonMediaAtiva()).toBe(false);
    vi.stubEnv("NEWTON_MEDIA_INBOUND", "true");
    expect(newtonMediaAtiva()).toBe(true);
  });
});

describe("urlDeMidiaPermitida: o que é recusado", () => {
  const recusadas = [
    "http://media.zapi.example/a.jpg",
    "https://evil.example/a.jpg",
    "https://media.zapi.example.evil.example/a.jpg",
    "https://xmedia.zapi.example/a.jpg",
    "https://user:pw@media.zapi.example/a.jpg",
    "https://media.zapi.example@evil.example/a.jpg",
    "https://127.0.0.1/a.jpg",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/a.jpg",
    "https://localhost/a.jpg",
    "https://media.zapi.example:8443/a.jpg",
    "ftp://media.zapi.example/a.jpg",
    "não é url",
    "",
  ];
  for (const u of recusadas) {
    it(`recusa ${JSON.stringify(u)}`, () => {
      expect(urlDeMidiaPermitida(u)).toBeNull();
    });
  }

  it("recusa string de 2049 chars, mesmo com host permitido", () => {
    const longa = "https://media.zapi.example/" + "a".repeat(2049 - "https://media.zapi.example/".length);
    expect(longa).toHaveLength(2049);
    expect(urlDeMidiaPermitida(longa)).toBeNull();
  });

  it("recusa o que não é string", () => {
    expect(urlDeMidiaPermitida(undefined)).toBeNull();
    expect(urlDeMidiaPermitida(null)).toBeNull();
    expect(urlDeMidiaPermitida(123)).toBeNull();
    expect(urlDeMidiaPermitida({ href: "https://media.zapi.example/a.jpg" })).toBeNull();
  });

  it("com NEWTON_MEDIA_HOSTS vazia recusa QUALQUER url", () => {
    vi.stubEnv("NEWTON_MEDIA_HOSTS", "");
    expect(urlDeMidiaPermitida("https://media.zapi.example/a.jpg")).toBeNull();
    vi.stubEnv("NEWTON_MEDIA_HOSTS", " , ,");
    expect(urlDeMidiaPermitida("https://media.zapi.example/a.jpg")).toBeNull();
    vi.unstubAllEnvs();
    expect(urlDeMidiaPermitida("https://media.zapi.example/a.jpg")).toBeNull();
  });
});

describe("urlDeMidiaPermitida: o que passa", () => {
  it("aceita o host exato", () => {
    expect(urlDeMidiaPermitida("https://media.zapi.example/instances/X/foto.jpeg")?.host).toBe("media.zapi.example");
  });

  it("sem curinga, subdomínio NÃO passa (host exato por padrão)", () => {
    expect(urlDeMidiaPermitida("https://cdn.media.zapi.example/a.jpg")).toBeNull();
  });

  it("domínio de nuvem na lista vale só para ele mesmo, não para o bucket de terceiro", () => {
    vi.stubEnv("NEWTON_MEDIA_HOSTS", "s3.amazonaws.com");
    expect(urlDeMidiaPermitida("https://s3.amazonaws.com/a.jpg")).not.toBeNull();
    expect(urlDeMidiaPermitida("https://bucket-de-terceiro.s3.amazonaws.com/a.jpg")).toBeNull();
  });

  it("`*.dominio` aceita subdomínio e recusa o apex", () => {
    vi.stubEnv("NEWTON_MEDIA_HOSTS", "*.zapi.example");
    expect(urlDeMidiaPermitida("https://media.zapi.example/a.jpg")?.host).toBe("media.zapi.example");
    expect(urlDeMidiaPermitida("https://a.b.zapi.example/a.jpg")?.host).toBe("a.b.zapi.example");
    expect(urlDeMidiaPermitida("https://zapi.example/a.jpg")).toBeNull();
    expect(urlDeMidiaPermitida("https://xzapi.example/a.jpg")).toBeNull();
    expect(urlDeMidiaPermitida("https://zapi.example.evil.example/a.jpg")).toBeNull();
  });

  it("curinga e host exato convivem na mesma lista", () => {
    vi.stubEnv("NEWTON_MEDIA_HOSTS", "*.zapi.example, exato.example");
    expect(urlDeMidiaPermitida("https://media.zapi.example/a.jpg")).not.toBeNull();
    expect(urlDeMidiaPermitida("https://exato.example/a.jpg")).not.toBeNull();
    expect(urlDeMidiaPermitida("https://sub.exato.example/a.jpg")).toBeNull();
  });

  it("lista separada por vírgula, sem diferença de caixa", () => {
    vi.stubEnv("NEWTON_MEDIA_HOSTS", " Outro.Example , media.zapi.example ");
    expect(urlDeMidiaPermitida("https://MEDIA.zapi.example/a.jpg")).not.toBeNull();
    expect(urlDeMidiaPermitida("https://outro.example/a.jpg")).not.toBeNull();
  });
});

describe("midiaDoBridge: o que é recusado", () => {
  const url = "https://media.zapi.example/instances/X/arq";

  it("tipo que não combina com o kind", () => {
    expect(midiaDoBridge({ mediaUrl: url, mediaKind: "image", mimeType: "application/pdf" })).toBeNull();
    expect(midiaDoBridge({ mediaUrl: url, mediaKind: "document", mimeType: "image/jpeg" })).toBeNull();
    expect(midiaDoBridge({ mediaUrl: url, mediaKind: "document", mimeType: "application/msword" })).toBeNull();
    expect(midiaDoBridge({ mediaUrl: url, mediaKind: "image", mimeType: "image/gif" })).toBeNull();
  });

  it("kind desconhecido (áudio, vídeo, ausente)", () => {
    expect(midiaDoBridge({ mediaUrl: url, mediaKind: "audio", mimeType: "audio/ogg" })).toBeNull();
    expect(midiaDoBridge({ mediaUrl: url, mediaKind: "video", mimeType: "video/mp4" })).toBeNull();
    expect(midiaDoBridge({ mediaUrl: url, mimeType: "image/jpeg" })).toBeNull();
  });

  it("url fora da allowlist ou mime que não é texto", () => {
    expect(midiaDoBridge({ mediaUrl: "https://evil.example/a.jpg", mediaKind: "image", mimeType: "image/jpeg" })).toBeNull();
    expect(midiaDoBridge({ mediaUrl: url, mediaKind: "image", mimeType: 5 })).toBeNull();
    expect(midiaDoBridge({})).toBeNull();
  });
});

describe("midiaDoBridge: o que passa", () => {
  const url = "https://media.zapi.example/instances/X/arq";

  it("normaliza o mime (minúsculo, sem parâmetros) e prefixa a referência", () => {
    const m = midiaDoBridge({ mediaUrl: url, mediaKind: "image", mimeType: "IMAGE/JPEG; charset=x" });
    expect(m).toEqual({ ref: `${ZAPI_MEDIA_PREFIX}${url}`, kind: "image", mimeType: "image/jpeg" });
    expect(m?.ref.startsWith("zapi:")).toBe(true);
  });

  it("aceita os cinco tipos de imagem e o PDF", () => {
    for (const mime of ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]) {
      expect(midiaDoBridge({ mediaUrl: url, mediaKind: "image", mimeType: mime })?.mimeType).toBe(mime);
    }
    expect(midiaDoBridge({ mediaUrl: url, mediaKind: "document", mimeType: "application/pdf" })).toMatchObject({
      kind: "document",
      mimeType: "application/pdf",
    });
  });
});

describe("sniffMime", () => {
  const ascii = (s: string) => Buffer.from(s, "latin1");

  it("nada reconhecível dá null: HTML, vazio, curto, executável", () => {
    expect(sniffMime(Buffer.from("<html>"))).toBeNull();
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
    expect(sniffMime(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffMime(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]))).toBeNull(); // MZ
    expect(sniffMime(ascii("RIFF\0\0\0\0WAVE"))).toBeNull(); // RIFF que não é WebP
    expect(sniffMime(Buffer.concat([Buffer.alloc(4), ascii("ftypmp42")]))).toBeNull(); // MP4
  });

  it("reconhece JPEG, PNG, WebP, PDF e HEIC/HEIF", () => {
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe("image/jpeg");
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffMime(Buffer.concat([ascii("RIFF"), Buffer.alloc(4), ascii("WEBPVP8 ")]))).toBe("image/webp");
    expect(sniffMime(ascii("%PDF-1.7\n"))).toBe("application/pdf");
    for (const marca of ["heic", "heix", "hevc"]) {
      expect(sniffMime(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), ascii(`ftyp${marca}`), Buffer.alloc(8)]))).toBe(
        "image/heic"
      );
    }
    for (const marca of ["mif1", "msf1", "heif"]) {
      expect(sniffMime(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), ascii(`ftyp${marca}`), Buffer.alloc(8)]))).toBe(
        "image/heif"
      );
    }
  });
});
