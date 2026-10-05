import { describe, it, expect, vi } from "vitest";
import { erroSemSegredo, semCredencial } from "@/lib/redigir";

/**
 * O erro que sai pelas rotas de admin vai para a tela do ImobPro. Credencial
 * e telefone não podem ir junto; o resto da mensagem (o que diz POR QUE
 * falhou) tem de continuar legível.
 */
describe("erroSemSegredo", () => {
  it("URL da Z-API: instância e token somem, o resto fica", () => {
    expect(
      erroSemSegredo("timeout de 10000ms em api.z-api.io/instances/ABC123/token/XYZ789/send-text")
    ).toBe("timeout de 10000ms em api.z-api.io/instances/***/token/***/send-text");
  });

  it("client-token, access_token, appsecret_proof e Bearer", () => {
    const t = semCredencial(
      "x/client-token/CT1 y?access_token=AT1&appsecret_proof=AP1&limit=5 Authorization: Bearer EAAB.c-d_e"
    );
    for (const segredo of ["CT1", "AT1", "AP1", "EAAB"]) expect(t).not.toContain(segredo);
    expect(t).toContain("&limit=5");
  });

  it("erro da Meta sem segredo passa intacto", () => {
    const msg = "meta #131049: This message was not delivered to maintain healthy ecosystem engagement.";
    expect(erroSemSegredo(msg)).toBe(msg);
  });

  it("telefone continua mascarado", () => {
    expect(erroSemSegredo("destinatário 5511987650002 inválido")).not.toContain("987650002");
  });

  it("não-string vira null", () => {
    expect(erroSemSegredo(null)).toBeNull();
    expect(erroSemSegredo(42)).toBeNull();
  });
});

describe("semCredencial — formatos de corpo de erro", () => {
  it("URL citada em JSON, uma ou duas vezes, e codificada", () => {
    for (const t of [
      '{"url":"https:\\/\\/api.z-api.io\\/instances\\/INST1\\/token\\/TOK1"}',
      JSON.stringify({ body: '{"url":"https:\\/\\/api.z-api.io\\/instances\\/INST1\\/token\\/TOK1"}' }),
      "instances%2FINST1%2Ftoken%2FTOK1%2Fsend",
    ]) {
      const r = semCredencial(t);
      expect(r).not.toContain("INST1");
      expect(r).not.toContain("TOK1");
    }
  });

  it("bearer minúsculo e client_token", () => {
    const r = semCredencial("authorization: bearer abc.def x?client_token=CT9&limit=5");
    expect(r).not.toContain("abc.def");
    expect(r).not.toContain("CT9");
    expect(r).toContain("&limit=5");
  });

  it("valor atual da credencial em env some em qualquer formato", () => {
    vi.stubEnv("META_ACCESS_TOKEN", "EAAGtokenAtualMuitoLongo123");
    try {
      expect(semCredencial("falhou com EAAGtokenAtualMuitoLongo123 no meio")).toBe("falhou com *** no meio");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("texto comum com 'token/' não é credencial", () => {
    expect(semCredencial("invalid token/expired session")).toBe("invalid token/expired session");
  });

  it("parâmetro dentro de JSON citado mantém o JSON válido", () => {
    const json = JSON.stringify({ body: '{"url":"https://x.io/a?token=abc123"}' });
    const r = semCredencial(json);
    expect(r).not.toContain("abc123");
    expect(() => JSON.parse(r)).not.toThrow();
  });

  it("data com hora não é telefone", () => {
    expect(erroSemSegredo("falhou em 2026-10-05 12:34:56 UTC")).toBe("falhou em 2026-10-05 12:34:56 UTC");
  });
});
