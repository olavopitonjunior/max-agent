import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * A transcrição nunca pode devolver uma PALAVRA que o grafo trate como
 * confirmação. Antes, 409 virava "ok" (copiado do `/notify`), e "ok" está no
 * `AFIRMA` do `lerConfirmacao`: um áudio recusado pelo ImobPro com 409 teria
 * confirmado a escrita pendente da pessoa.
 */
vi.mock("../orgs", () => ({
  orgById: vi.fn().mockResolvedValue({ apiToken: "tok-de-teste" }),
}));

const { transcribeMedia } = await import("../cm");

function mockFetch(init: { ok: boolean; status: number; body?: string }) {
  const fn = vi.fn().mockResolvedValue({
    ok: init.ok,
    status: init.status,
    text: async () => init.body ?? "",
    json: async () => JSON.parse(init.body ?? "{}"),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const MIDIA = { kind: "audio" as const, mimeType: "audio/ogg", data: Buffer.from("x") };

describe("transcribeMedia × status HTTP", () => {
  it.each([409, 402, 403, 413, 415, 500, 502])("%s devolve null, nunca texto", async (status) => {
    mockFetch({ ok: false, status, body: '{"error":"x"}' });
    expect(await transcribeMedia("org1", MIDIA)).toBeNull();
  });

  it("200 devolve o texto transcrito", async () => {
    mockFetch({ ok: true, status: 200, body: '{"text":" sim, pode mandar "}' });
    expect(await transcribeMedia("org1", MIDIA)).toBe("sim, pode mandar");
  });

  it("200 sem texto devolve null", async () => {
    mockFetch({ ok: true, status: 200, body: "{}" });
    expect(await transcribeMedia("org1", MIDIA)).toBeNull();
  });
});
