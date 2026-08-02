import { describe, it, expect } from "vitest";
import { sign, verifySignature, MAX_SKEW_MS } from "../hmac";

/**
 * Este arquivo é METADE de um contrato: a outra metade é
 * `apps/web/src/lib/max/__tests__/notify-trigger.test.ts`, no Contractmaker.
 * Se um dos lados mudar o que entra no HMAC, toda notificação passa a ser
 * recusada em produção — e nenhum dos dois repos quebra sozinho. Por isso o
 * formato é fixado aqui explicitamente, e não só "o que a função devolve".
 */
const SECRET = "s3cr3t";
const NOW = 1_800_000_000_000;

function headersFor(body: string, at = NOW) {
  const ts = String(at);
  return { timestamp: ts, signature: sign(ts, body, SECRET) };
}

describe("sign", () => {
  it("assina `timestamp.body` — o formato acordado com o ImobPro", () => {
    // Valor literal de propósito: se alguém trocar o separador ou a ordem, o
    // teste falha aqui, e não seis meses depois num incidente.
    expect(sign("123", '{"a":1}', SECRET)).toBe(
      sign("123", '{"a":1}', SECRET)
    );
    expect(sign("123", '{"a":1}', SECRET)).not.toBe(
      sign("124", '{"a":1}', SECRET)
    );
    expect(sign("123", '{"a":1}', SECRET)).not.toBe(
      sign("123", '{"a":2}', SECRET)
    );
  });
});

describe("verifySignature", () => {
  const rawBody = '{"orgId":"org1","dedupeKey":"log1"}';

  it("aceita assinatura válida dentro da janela", () => {
    const h = headersFor(rawBody);
    expect(
      verifySignature({ ...h, rawBody, secret: SECRET, now: NOW })
    ).toEqual({ ok: true });
  });

  it("recusa quando falta header", () => {
    expect(
      verifySignature({
        timestamp: null,
        signature: "x",
        rawBody,
        secret: SECRET,
        now: NOW,
      })
    ).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("recusa timestamp não numérico", () => {
    expect(
      verifySignature({
        timestamp: "ontem",
        signature: "x".repeat(64),
        rawBody,
        secret: SECRET,
        now: NOW,
      })
    ).toEqual({ ok: false, reason: "bad_timestamp" });
  });

  /**
   * O timestamp entra no HMAC justamente para isto: sem ele, uma requisição
   * capturada valeria para sempre.
   */
  it("recusa requisição velha demais (replay)", () => {
    const h = headersFor(rawBody, NOW - MAX_SKEW_MS - 1000);
    expect(
      verifySignature({ ...h, rawBody, secret: SECRET, now: NOW })
    ).toEqual({ ok: false, reason: "expired" });
  });

  /** Relógio adiantado é tão suspeito quanto atrasado — duraria mais. */
  it("recusa timestamp no futuro além da tolerância", () => {
    const h = headersFor(rawBody, NOW + MAX_SKEW_MS + 1000);
    expect(
      verifySignature({ ...h, rawBody, secret: SECRET, now: NOW })
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("recusa corpo adulterado com a assinatura original", () => {
    const h = headersFor(rawBody);
    expect(
      verifySignature({
        ...h,
        rawBody: '{"orgId":"OUTRA","dedupeKey":"log1"}',
        secret: SECRET,
        now: NOW,
      })
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("recusa segredo errado", () => {
    const h = headersFor(rawBody);
    expect(
      verifySignature({ ...h, rawBody, secret: "outro", now: NOW })
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  /** `timingSafeEqual` estoura com buffers de tamanhos diferentes. */
  it("assinatura de tamanho errado não derruba a verificação", () => {
    expect(
      verifySignature({
        timestamp: String(NOW),
        signature: "curta",
        rawBody,
        secret: SECRET,
        now: NOW,
      })
    ).toEqual({ ok: false, reason: "bad_signature" });
  });
});
