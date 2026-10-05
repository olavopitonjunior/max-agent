import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "../http";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * No Next 14, GET de rota só-GET (os crons) vai para o Data Cache da Vercel e
 * fica lá entre deploys: um template consultado antes de existir na Meta ficou
 * "ausente" por dias (03–05/10/2026). O padrão do serviço é não guardar nada.
 */
describe("fetchWithTimeout — sem cache do Next", () => {
  it("no-store por padrão; quem passar `cache` explícito decide", async () => {
    const f = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", f);
    await fetchWithTimeout("https://graph.facebook.com/x", {}, 1000);
    await fetchWithTimeout("https://graph.facebook.com/x", { cache: "force-cache" }, 1000);
    expect((f.mock.calls[0] as unknown[])[1]).toMatchObject({ cache: "no-store" });
    expect((f.mock.calls[1] as unknown[])[1]).toMatchObject({ cache: "force-cache" });
  });
});

describe("fetchWithTimeout — timeout", () => {
  it("a mensagem diz quem estourou, sem a credencial que a Z-API levava no caminho", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      })
    );
    const erro = await fetchWithTimeout(
      "https://api.z-api.io/instances/INSTX123/token/TOKX456/send-text",
      {},
      10_000
    ).catch((e: Error) => e);
    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).toBe(
      "timeout de 10000ms em api.z-api.io/instances/***/token/***/send-text"
    );
  });
});
