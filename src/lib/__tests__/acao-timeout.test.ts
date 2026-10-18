import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executarAcao, type VerboDeAcao } from "../acao";

vi.mock("../orgs", () => ({ orgById: async () => ({ apiToken: "test-token" }) }));

beforeEach(() => {
  vi.useFakeTimers();
  // AbortSignal.timeout usa o relógio nativo; ligar ao relógio controlado do teste.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), ms);
    return controller.signal;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const request = (verb: VerboDeAcao) => executarAcao({
  orgId: "org1", rawPhone: "5511999999999", subject: { kind: "user", userId: "u1" },
  verb, args: { proposta_id: "p1", metodo: "whatsapp" }, idempotencyKey: "same-send",
});

function upstream(delay: number) {
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(JSON.stringify({ enviada: true }), { status: 200 })), delay);
    init.signal!.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal!.reason); });
  }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("orçamento do envio de proposta", () => {
  it("aguarda envio de 25 segundos sem cortar após 8 segundos nem duplicar chamada", async () => {
    const fetch = upstream(25_000);
    const result = request("proposal.send");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await result).toEqual({ status: 200, body: { enviada: true } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].headers).toHaveProperty("x-idempotency-key", "same-send");
  });

  it("continua limitando consultas comuns a 8 segundos", async () => {
    upstream(25_000);
    const result = request("proposal.status");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await result).toBeNull();
  });

  it("encerra envio pendurado em 30 segundos como incerto, sem retry automático", async () => {
    const fetch = upstream(55_000);
    const result = request("proposal.send");
    let finished = false;
    void result.then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("credit.request: 503 de negócio × 5xx de falha (M3)", () => {
  const responde = (status: number, body: Record<string, unknown>) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("503 notConfigured chega ao fluxo (texto 'indisponível')", async () => {
    responde(503, { error: "Upestate não está configurada nesta instância.", notConfigured: true });
    expect(await request("credit.request")).toEqual({ status: 503, body: { error: "Upestate não está configurada nesta instância.", notConfigured: true } });
  });

  it("503 sem a marca e 500 seguem como sem resposta (envio incerto, nunca reenvia)", async () => {
    responde(503, { error: "gateway" });
    expect(await request("credit.request")).toBeNull();
    responde(500, { notConfigured: true });
    expect(await request("credit.request")).toBeNull();
  });
});

describe("captação (P9): orçamento do envio e idempotência", () => {
  afterEach(() => { delete process.env.IMOBPRO_CAPTACAO_SEND_TIMEOUT_MS; });

  it("captacao.send espera 30 s por padrão (o servidor corre 20 s e responde 202)", async () => {
    const fetch = upstream(25_000);
    const result = request("captacao.send");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await result).toEqual({ status: 200, body: { enviada: true } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].headers).toHaveProperty("x-idempotency-key", "same-send");
  });

  it("estoura em 30 s como incerto, uma única chamada, sem retry", async () => {
    const fetch = upstream(55_000);
    const result = request("captacao.send");
    let finished = false;
    void result.then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("IMOBPRO_CAPTACAO_SEND_TIMEOUT_MS muda o prazo; valor inválido cai no padrão", async () => {
    process.env.IMOBPRO_CAPTACAO_SEND_TIMEOUT_MS = "12000";
    upstream(55_000);
    const curto = request("captacao.send");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await curto).toBeNull();
    process.env.IMOBPRO_CAPTACAO_SEND_TIMEOUT_MS = "abc";
    expect((await import("../http")).captacaoSendTimeoutMs()).toBe(30_000);
    process.env.IMOBPRO_CAPTACAO_SEND_TIMEOUT_MS = "0";
    expect((await import("../http")).captacaoSendTimeoutMs()).toBe(30_000);
  });

  it.each(["captacao.options", "captacao.create", "captacao.preflight", "captacao.list"] as const)(
    "%s segue no teto comum de 8 s",
    async (verb) => {
      upstream(25_000);
      const result = request(verb);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await result).toBeNull();
    }
  );

  it("202 do envio é resposta de NEGÓCIO (chega ao fluxo)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ estado: "Enviando…" }), { status: 202 })));
    expect(await request("captacao.send")).toEqual({ status: 202, body: { estado: "Enviando…" } });
  });

  it("502 falha_envio do envio chega ao fluxo; 502 sem a marca e 500 seguem como sem resposta", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "falha_envio" }), { status: 502 })));
    expect(await request("captacao.send")).toEqual({ status: 502, body: { error: "falha_envio" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "gateway" }), { status: 502 })));
    expect(await request("captacao.send")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "falha_envio" }), { status: 500 })));
    expect(await request("captacao.send")).toBeNull();
    // A exceção é só do envio: outro verbo com 502 continua sem resposta.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "falha_envio" }), { status: 502 })));
    expect(await request("captacao.create")).toBeNull();
  });

  it("só as escritas levam x-idempotency-key; as leituras não recebem chave", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await executarAcao({ orgId: "org1", rawPhone: "5511999999999", subject: { kind: "user", userId: "u1" }, verb: "captacao.preflight", args: { captacaoId: "c1" } });
    await executarAcao({ orgId: "org1", rawPhone: "5511999999999", subject: { kind: "user", userId: "u1" }, verb: "captacao.create", args: { tipo: "venda", nome: "x" }, idempotencyKey: "m1" });
    const headers = fetch.mock.calls.map((c) => (c as unknown as [string, RequestInit])[1].headers as Record<string, string>);
    expect(headers[0]).not.toHaveProperty("x-idempotency-key");
    expect(headers[1]).toHaveProperty("x-idempotency-key", "m1");
  });
});
