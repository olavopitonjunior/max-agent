import { afterEach, describe, expect, it, vi } from "vitest";
import { executarAcao, type VerboDeAcao } from "../acao";

vi.mock("../orgs", () => ({ orgById: async () => ({ apiToken: "test-token" }) }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const chamar = (verb: VerboDeAcao) => executarAcao({
  orgId: "org1", rawPhone: "5511999999999", subject: { kind: "user", userId: "u1" },
  verb, args: { alvo: "proposta", mime_type: "image/jpeg", base64: "AAAA" }, idempotencyKey: "wamid.FOTO1",
});

const responde = (status: number, body: Record<string, unknown>) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe("document.read: 502 leitura_indisponivel e desfecho canonico", () => {
  it("5xx comum continua sem resposta (null), como em qualquer verbo", async () => {
    responde(500, { error: "erro_interno" });
    expect(await chamar("document.read")).toBeNull();
    responde(502, { error: "outra_coisa" });
    expect(await chamar("document.read")).toBeNull();
  });

  it("502 leitura_indisponivel chega ao chamador (que repete UMA vez com chave nova)", async () => {
    responde(502, { error: "leitura_indisponivel" });
    expect(await chamar("document.read")).toEqual({ status: 502, body: { error: "leitura_indisponivel" } });
  });

  it("o mesmo codigo em outro verbo NAO vira desfecho canonico", async () => {
    responde(502, { error: "leitura_indisponivel" });
    expect(await chamar("proposal.status")).toBeNull();
  });

  it("422 documento_ilegivel e resposta de negocio (nao null)", async () => {
    responde(422, { error: "documento_ilegivel" });
    expect(await chamar("document.read")).toEqual({ status: 422, body: { error: "documento_ilegivel" } });
  });

  it("manda a chave de idempotencia (a messageId da midia)", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ campos: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await chamar("document.read");
    const init = (fetch.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    expect(init.headers).toHaveProperty("x-idempotency-key", "wamid.FOTO1");
  });
});
