import { describe, it, expect } from "vitest";
import { sign, verifySignature } from "../hmac";

/**
 * Vetor fixo do HMAC do `/notify` — a metade daqui de um contrato de DOIS repos.
 *
 * A outra metade é `apps/web/src/lib/max/__tests__/hmac-parity.test.ts`, no
 * Contractmaker, com este mesmo vetor. Os valores são literais de propósito: se
 * alguém mudar o que entra na assinatura (separador, ordem, encoding), o teste
 * falha no repo que mudou — e não seis meses depois, num incidente.
 *
 * O modo de falha que isto previne é total e silencioso: divergindo os lados,
 * TODA notificação passa a ser recusada com 401, e nenhum dos dois repositórios
 * quebra sozinho.
 */
const SECRET = "segredo-de-teste-do-vetor";
const TIMESTAMP = "1800000000000";
const RAW_BODY = '{"orgId":"org-1","dedupeKey":"log-1"}';
const ASSINATURA =
  "1d46081c8a0cb08b6ec1866fbb142ccd17ed6e47f442547d6362113268f75fb8";

/**
 * Segundo vetor: o formato das LEITURAS de painel (`/api/admin/*`).
 *
 * O `/notify` assina o corpo; o painel assina `método.caminho com query` — GET
 * não tem corpo, e assinar corpo vazio deixava a query fora do HMAC, abrindo
 * replay cross-tenant de cinco minutos (é a razão de o `requireHmac` ter
 * ganhado `signQuery`).
 *
 * Este vetor não existia em repo nenhum, e o `/api/admin/conversations` nasceu
 * SEM tolerar o formato antigo — ou seja, uma divergência aqui derruba a
 * leitura do painel inteira, em silêncio. Literal de propósito, e idêntico ao
 * do Contractmaker: mudar um lado sem o outro tem que quebrar o teste do lado
 * que mudou.
 */
const ADMIN_PAYLOAD = "GET./api/admin/conversations?orgId=org-1&limit=20";
const ADMIN_ASSINATURA =
  "2878ff9c3bee22542de0e4a6a26e9f27f83e1e48a0afc5936be41d5afd578ac8";

describe("paridade do HMAC com o ImobPro", () => {
  it("o vetor fixo bate — não mudar sem mudar o outro repo junto", () => {
    expect(sign(TIMESTAMP, RAW_BODY, SECRET)).toBe(ASSINATURA);
  });

  it("o vetor do painel bate — mesmo contrato, outro formato", () => {
    expect(sign(TIMESTAMP, ADMIN_PAYLOAD, SECRET)).toBe(ADMIN_ASSINATURA);
  });

  /**
   * A prova que fecha o contrato: o valor que o Contractmaker calcula é aceito
   * pela verificação DESTE serviço, no formato que a rota do painel exige.
   */
  it("a assinatura do painel é ACEITA pela verificação com signQuery", () => {
    expect(
      verifySignature({
        timestamp: TIMESTAMP,
        signature: ADMIN_ASSINATURA,
        rawBody: ADMIN_PAYLOAD,
        secret: SECRET,
        now: Number(TIMESTAMP),
      })
    ).toEqual({ ok: true });
  });

  /** O que o Contractmaker produz é o que este serviço aceita. */
  it("a assinatura do vetor é ACEITA pela verificação", () => {
    expect(
      verifySignature({
        timestamp: TIMESTAMP,
        signature: ASSINATURA,
        rawBody: RAW_BODY,
        secret: SECRET,
        now: Number(TIMESTAMP),
      })
    ).toEqual({ ok: true });
  });

  it("é hex minúsculo de 64 caracteres (sha256)", () => {
    expect(ASSINATURA).toMatch(/^[0-9a-f]{64}$/);
  });
});
