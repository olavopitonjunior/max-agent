import { afterEach, describe, expect, it, vi } from "vitest";
import { executarAcao, type VerboDeAcao } from "../acao";

vi.mock("../orgs", () => ({ orgById: async () => ({ apiToken: "test-token" }) }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const chamar = (verb: VerboDeAcao, idempotencyKey: string | undefined = "wamid.CORRIGE1") => executarAcao({
  orgId: "org1", rawPhone: "5511999999999", subject: { kind: "user", userId: "u1" },
  verb, args: { proposta_id: "p1", pedido: "trocar a multa para 10 por cento" }, idempotencyKey,
});

const responde = (status: number, body: Record<string, unknown>) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

const VERBOS_DE_TEXTO: VerboDeAcao[] = ["proposal.text.suggest", "proposal.text.apply", "captacao.text.suggest", "captacao.text.apply"];

describe("correção de texto: desfechos canônicos 5xx chegam ao fluxo (nunca viram 'sem resposta')", () => {
  it("5xx sem código conhecido continua sendo null, como em qualquer verbo", async () => {
    for (const v of VERBOS_DE_TEXTO) {
      responde(500, { error: "erro_interno" });
      expect(await chamar(v), v).toBeNull();
    }
  });

  it("502 documento_indisponivel, 502 redacao_indisponivel e 503 nao_configurado chegam como estão", async () => {
    for (const v of VERBOS_DE_TEXTO) {
      responde(502, { error: "documento_indisponivel" });
      expect(await chamar(v), v).toEqual({ status: 502, body: { error: "documento_indisponivel" } });
      responde(502, { error: "redacao_indisponivel" });
      expect(await chamar(v), v).toEqual({ status: 502, body: { error: "redacao_indisponivel" } });
      responde(503, { error: "nao_configurado" });
      expect(await chamar(v), v).toEqual({ status: 503, body: { error: "nao_configurado" } });
    }
  });

  it("os mesmos códigos em outro verbo NÃO viram desfecho canônico", async () => {
    responde(502, { error: "documento_indisponivel" });
    expect(await chamar("proposal.update")).toBeNull();
  });

  it("409 e 429 são respostas de negócio e passam com o corpo inteiro", async () => {
    responde(409, { error: "requer_cancelamento", instrumento: "envelope", consomeEnvioDoPlano: true });
    expect(await chamar("proposal.text.apply")).toEqual({
      status: 409, body: { error: "requer_cancelamento", instrumento: "envelope", consomeEnvioDoPlano: true },
    });
    responde(429, { error: "limite_de_sugestoes" });
    expect(await chamar("captacao.text.suggest")).toEqual({ status: 429, body: { error: "limite_de_sugestoes" } });
  });

  it("é escrita: manda x-idempotency-key e recusa a chamada sem chave dentro de uma execução", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ estado: "nenhum_paragrafo" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await chamar("proposal.text.suggest", "wamid.CHAVE");
    const init = (fetch.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    expect(init.headers).toHaveProperty("x-idempotency-key", "wamid.CHAVE");
  });

  it("MAX_WRITES_KILL=true desliga a escrita (aplicar texto é escrita)", async () => {
    vi.stubEnv("MAX_WRITES_KILL", "true");
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await chamar("proposal.text.apply")).toEqual({ status: 503, body: { error: "writes_disabled" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
