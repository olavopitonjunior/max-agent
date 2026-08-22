import { describe, it, expect, vi, afterEach } from "vitest";
import { sign, verifySignature } from "../hmac";
import { reportAlert } from "../cm";

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

/** Vetor do alerta de canal (F7) — a outra metade está no Contractmaker, em
 *  `apps/web/src/lib/max/__tests__/hmac-parity.test.ts`, com este literal. */
const ALERTA_RAW_BODY =
  '{"evento":"zapi_desconectada","at":"2026-08-22T03:14:00.000Z","represadas":4}';
const ALERTA_ASSINATURA =
  "456c4fc09a08ab9f57ad5e33b6c792dea0bd1d71b4d39103153664b9c0492f34";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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

  /**
   * Terceiro vetor: o corpo do ALERTA DE CANAL
   * (`POST /api/webhooks/max/alert`, F7).
   *
   * O algoritmo é o mesmo dos anteriores; o que este trava é o **corpo**. A
   * assinatura é sobre a string crua e `JSON.stringify` preserva ordem de
   * inserção, então a ORDEM das chaves é parte do contrato quer se queira ou
   * não — melhor que esteja escrita num lugar que quebra.
   */
  it("o vetor do alerta de canal bate", () => {
    expect(sign(TIMESTAMP, ALERTA_RAW_BODY, SECRET)).toBe(ALERTA_ASSINATURA);
  });

  /**
   * E a prova que fecha: quem monta o corpo em produção é `reportAlert()`, e é
   * ELE que produz este byte. Reafirmar o literal contra uma cópia à mão
   * provaria só que a cópia bate com ela mesma — e a ordem das chaves, que é
   * o que este vetor existe para travar, mora justamente no objeto que aquela
   * função monta.
   */
  it("é `reportAlert()` que produz este corpo e esta assinatura", async () => {
    vi.stubEnv("MAX_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("CONTRACTMAKER_API_URL", "https://cm.test");
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    // O timestamp entra na assinatura; sem congelá-lo o hex seria outro a cada
    // execução, e o vetor deixaria de ser comparável com o do outro repo.
    vi.setSystemTime(Number(TIMESTAMP));

    const ok = await reportAlert({
      evento: "zapi_desconectada",
      at: "2026-08-22T03:14:00.000Z",
      represadas: 4,
    });

    expect(ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://cm.test/api/webhooks/max/alert");
    expect(init.body).toBe(ALERTA_RAW_BODY);
    expect(init.headers["x-max-timestamp"]).toBe(TIMESTAMP);
    expect(init.headers["x-max-signature"]).toBe(ALERTA_ASSINATURA);
  });

  it("é hex minúsculo de 64 caracteres (sha256)", () => {
    expect(ASSINATURA).toMatch(/^[0-9a-f]{64}$/);
    expect(ALERTA_ASSINATURA).toMatch(/^[0-9a-f]{64}$/);
  });
});
