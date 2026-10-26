import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * `lerPreferencias` / `atualizarPreferencias` — o corpo HTTP de verdade.
 *
 * Os testes do grafo mockam `@/lib/cm` inteiro, então a URL, o Bearer, o corpo do PATCH e o
 * tratamento de status nunca rodavam lá. Regra do cliente: só 200 (GET com a forma do contrato)
 * e 200/422 do PATCH são respostas; o resto é `null` ("não consegui"), nunca um chute.
 */

vi.mock("../orgs", () => ({ orgById: vi.fn() }));

const { orgById } = await import("../orgs");
const { lerPreferencias, atualizarPreferencias } = await import("../cm");

const fetchMock = vi.fn();

const VIEW = {
  prefs: { types: { activity_due: { email: true, whatsapp: false } } },
  defaults: { morningReportAt: "08:00", dueSoonLeadMin: 120 },
  options: { morningReport: ["07:00", "07:30", "08:00"], dueSoon: [30, 60, 120] },
  tipos: [{ type: "activity_due", label: "Relatório da manhã (formulários e atividades)" }],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const PARAMS = { orgId: "org1", rawPhone: "5511987654321" };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MAX_WRITES_KILL;
  process.env.CM_BASE_URL ??= "https://imobpro.test";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(orgById).mockResolvedValue({ orgId: "org1", orgName: "Trio", apiToken: "cmt_abc" } as never);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.MAX_WRITES_KILL;
});

describe("lerPreferencias", () => {
  it("GET 200 com a forma do contrato: devolve a view e chama a rota certa, com Bearer", async () => {
    fetchMock.mockResolvedValue(json(VIEW));
    const v = await lerPreferencias(PARAMS);
    expect(v).toMatchObject({
      defaults: { morningReportAt: "08:00", dueSoonLeadMin: 120 },
      options: { morningReport: ["07:00", "07:30", "08:00"], dueSoon: [30, 60, 120] },
      tipos: [{ type: "activity_due", label: "Relatório da manhã (formulários e atividades)" }],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/agents/notification-preferences?phone=");
    expect(String(url)).toContain(encodeURIComponent("+5511987654321"));
    expect(init.headers.Authorization).toBe("Bearer cmt_abc");
  });

  it("404 -> null", async () => {
    fetchMock.mockResolvedValue(json({ error: "not_found" }, 404));
    expect(await lerPreferencias(PARAMS)).toBeNull();
  });

  it("5xx -> null", async () => {
    fetchMock.mockResolvedValue(json({ error: "boom" }, 503));
    expect(await lerPreferencias(PARAMS)).toBeNull();
  });

  it("erro de rede/timeout -> null (não lança)", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed"));
    expect(await lerPreferencias(PARAMS)).toBeNull();
    const timeout = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    fetchMock.mockRejectedValue(timeout);
    expect(await lerPreferencias(PARAMS)).toBeNull();
  });

  it("200 com corpo fora do contrato -> null", async () => {
    fetchMock.mockResolvedValue(json({ prefs: {} }));
    expect(await lerPreferencias(PARAMS)).toBeNull();
    fetchMock.mockResolvedValue(new Response("não é json", { status: 200 }));
    expect(await lerPreferencias(PARAMS)).toBeNull();
  });

  it("org sem token ou telefone impossível: nem chega à rede", async () => {
    vi.mocked(orgById).mockResolvedValueOnce(null as never);
    expect(await lerPreferencias(PARAMS)).toBeNull();
    expect(await lerPreferencias({ orgId: "org1", rawPhone: "abc" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("atualizarPreferencias", () => {
  const patch = { types: { activity_due: { email: false, whatsapp: false } } };

  it("200 ok:true -> sucesso com o opt-in; manda phone+patch no corpo, com Bearer", async () => {
    fetchMock.mockResolvedValue(json({ ok: true, prefs: { types: {} }, whatsappOptIn: "cleared" }));
    const r = await atualizarPreferencias({ ...PARAMS, patch });
    expect(r).toMatchObject({ ok: true, whatsappOptIn: "cleared" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/agents/notification-preferences");
    expect(init.method).toBe("PATCH");
    expect(init.headers.Authorization).toBe("Bearer cmt_abc");
    expect(JSON.parse(init.body)).toEqual({ phone: "+5511987654321", patch });
  });

  it("422 com allowed e subject: devolve a recusa (sem comparação estrita)", async () => {
    fetchMock.mockResolvedValue(json({ ok: false, code: "valor_invalido", allowed: ["07:00", 30, { x: 1 }], subject: "schedule.morningReportAt" }, 422));
    const r = await atualizarPreferencias({ ...PARAMS, patch });
    expect(r).toMatchObject({ ok: false, code: "valor_invalido", allowed: ["07:00", 30] });
    expect(r).toHaveProperty("subject", "schedule.morningReportAt");
  });

  it("422 com code que o contrato não conhece vira recusa_desconhecida", async () => {
    fetchMock.mockResolvedValue(json({ ok: false, code: "inventado_pelo_servidor" }, 422));
    expect(await atualizarPreferencias({ ...PARAMS, patch })).toMatchObject({ ok: false, code: "recusa_desconhecida" });
  });

  it.each([404, 500, 503])("status %s -> null (incerto)", async (status) => {
    fetchMock.mockResolvedValue(json({ error: "x" }, status));
    expect(await atualizarPreferencias({ ...PARAMS, patch })).toBeNull();
  });

  it("200 sem ok:true -> null", async () => {
    fetchMock.mockResolvedValue(json({ prefs: {} }));
    expect(await atualizarPreferencias({ ...PARAMS, patch })).toBeNull();
  });

  it("erro de rede/timeout -> null (não lança)", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed"));
    expect(await atualizarPreferencias({ ...PARAMS, patch })).toBeNull();
  });

  it("MAX_WRITES_KILL ligado: nada é enviado", async () => {
    process.env.MAX_WRITES_KILL = "true";
    fetchMock.mockResolvedValue(json({ ok: true, prefs: {}, whatsappOptIn: "unchanged" }));
    expect(await atualizarPreferencias({ ...PARAMS, patch })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(orgById).not.toHaveBeenCalled();
  });
});
