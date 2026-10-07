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
