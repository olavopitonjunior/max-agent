import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * /api/admin/playground - roda um turno real do Max fora do WhatsApp.
 *
 * O que mais importa aqui nao e o formato da resposta: e que o gate de
 * ambiente e a autenticacao continuem sendo checados NESTA ordem (404 antes
 * de 401), que a IDENTIDADE (resolveIdentity, pelo telefone) seja checada
 * ANTES de qualquer efeito - inclusive antes do "novo", que ja limpa thread
 * de verdade -, que um requestId repetido nao rode o turno de novo, e que
 * runTurn/afterReply sejam de fato chamados com o InboundMessage certo -
 * mockar so o suficiente para isolar a rota do grafo e do banco de verdade.
 *
 * O formato de assinatura (corpo cru, sem signQuery) e o MESMO do
 * /notify//admin/forget, ja coberto pelos vetores genericos de
 * hmac-parity.test.ts - nao introduz formato novo, entao nao precisa de
 * vetor novo la.
 */

vi.mock("@/graph/graph", () => ({
  runTurn: vi.fn(),
  threadIdFor: vi.fn((orgId: string, phone: string) => `${orgId}:${phone}`),
}));
vi.mock("@/lib/identity", () => ({
  resolveIdentity: vi.fn().mockResolvedValue({ kind: "unknown", alreadyGreeted: true }),
}));
vi.mock("@/lib/db", () => ({
  query: vi.fn().mockResolvedValue([]),
}));

const { runTurn } = await import("@/graph/graph");
const { resolveIdentity } = await import("@/lib/identity");
const { query } = await import("@/lib/db");
const { sign } = await import("@/lib/hmac");

const rodarTurno = runTurn as unknown as ReturnType<typeof vi.fn>;
const identidade = resolveIdentity as unknown as ReturnType<typeof vi.fn>;
const consultar = query as unknown as ReturnType<typeof vi.fn>;

const SECRET = "s-playground";
const PATH = "/api/admin/playground";
const REQUEST_ID = "11111111-1111-1111-1111-111111111111";
const REQUEST_ID_2 = "22222222-2222-2222-2222-222222222222";

/** Identidade default usada pelos testes do caminho feliz: resolved + org-1. */
function identidadeOrg1() {
  identidade.mockResolvedValue({ kind: "resolved", org: {}, candidate: { orgId: "org-1" } });
}

/** Linha de conversation_turn que o SELECT final da rota devolveria. */
function linhaRastro(overrides: Record<string, unknown> = {}) {
  return {
    org_id: "org-1",
    kind: "text",
    inbound_text: "oi",
    transcript: null,
    reply_text: "resposta do max",
    route: "conversa",
    intent_json: null,
    tools_json: [],
    usage_json: [],
    timings_json: [],
    signals_json: null,
    degradado: false,
    latency_ms: 123,
    error: null,
    created_at: "2026-10-13T12:00:00.000Z",
    ...overrides,
  };
}

/**
 * A rota faz DUAS consultas por SQL de texto diferente, alem do DELETE de
 * limpeza: o dedupe ("ja_existe") e o SELECT final do rastro. O mock
 * generico (mockResolvedValue) nao distingue as duas - precisa de
 * mockImplementation olhando o SQL, igual aos outros testes de integracao
 * do repo que leem o banco real (turnlog.integration.test.ts).
 */
function mockConsultaPadrao(row: Record<string, unknown> | null = linhaRastro()) {
  consultar.mockImplementation(async (sql: string) => {
    if (sql.includes("ja_existe")) return [];
    if (sql.includes("DELETE FROM checkpoint")) return [];
    return row ? [row] : [];
  });
}

function chamar(body: unknown, opts: { semAssinatura?: boolean; assinaturaErrada?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(Date.now());
  const headers: Record<string, string> = {};
  if (!opts.semAssinatura) {
    headers["x-max-timestamp"] = ts;
    headers["x-max-signature"] = opts.assinaturaErrada
      ? sign(ts, "corpo-errado", SECRET)
      : sign(ts, raw, SECRET);
  }
  return new NextRequest(`http://max.test${PATH}`, {
    method: "POST",
    headers,
    body: raw,
  });
}

describe("POST /api/admin/playground", () => {
  beforeEach(() => {
    vi.stubEnv("MAX_NOTIFY_SECRET", SECRET);
    rodarTurno.mockReset();
    identidade.mockReset().mockResolvedValue({ kind: "unknown", alreadyGreeted: true });
    consultar.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * Mutacao de controle: se alguem remover o if (MAX_PLAYGROUND !== "true")
   * da rota, este teste passa a falhar (a resposta viraria 200/401/409, nao
   * 404) - e a prova de que o gate esta realmente no caminho, nao so
   * documentado.
   */
  it("404 com MAX_PLAYGROUND ausente, mesmo com HMAC valido", async () => {
    delete process.env.MAX_PLAYGROUND;
    const { POST } = await import("@/app/api/admin/playground/route");
    const res = await POST(
      chamar({ orgId: "org-1", phone: "+5511999990000", text: "oi", requestId: REQUEST_ID })
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(rodarTurno).not.toHaveBeenCalled();
  });

  it("401 sem assinatura, com o gate ligado", async () => {
    vi.stubEnv("MAX_PLAYGROUND", "true");
    const { POST } = await import("@/app/api/admin/playground/route");
    const res = await POST(
      chamar(
        { orgId: "org-1", phone: "+5511999990000", text: "oi", requestId: REQUEST_ID },
        { semAssinatura: true }
      )
    );
    expect(res.status).toBe(401);
  });

  it("401 com assinatura errada, com o gate ligado", async () => {
    vi.stubEnv("MAX_PLAYGROUND", "true");
    const { POST } = await import("@/app/api/admin/playground/route");
    const res = await POST(
      chamar(
        { orgId: "org-1", phone: "+5511999990000", text: "oi", requestId: REQUEST_ID },
        { assinaturaErrada: true }
      )
    );
    expect(res.status).toBe(401);
  });

  it("400 com corpo invalido (telefone fora do E.164)", async () => {
    vi.stubEnv("MAX_PLAYGROUND", "true");
    const { POST } = await import("@/app/api/admin/playground/route");
    const res = await POST(
      chamar({ orgId: "org-1", phone: "11999990000", text: "oi", requestId: REQUEST_ID })
    );
    expect(res.status).toBe(400);
    expect(identidade).not.toHaveBeenCalled();
  });

  it("400 sem text quando novo nao e true", async () => {
    vi.stubEnv("MAX_PLAYGROUND", "true");
    const { POST } = await import("@/app/api/admin/playground/route");
    const res = await POST(chamar({ orgId: "org-1", phone: "+5511999990000", requestId: REQUEST_ID }));
    expect(res.status).toBe(400);
  });

  it("400 com requestId que nao e uuid", async () => {
    vi.stubEnv("MAX_PLAYGROUND", "true");
    const { POST } = await import("@/app/api/admin/playground/route");
    const res = await POST(
      chamar({ orgId: "org-1", phone: "+5511999990000", text: "oi", requestId: "nao-e-uuid" })
    );
    expect(res.status).toBe(400);
    expect(identidade).not.toHaveBeenCalled();
  });

  describe("identidade (resolveIdentity) decide ANTES de qualquer efeito", () => {
    /**
     * Bloqueante do code review: a identidade de verdade (pelo telefone) tem
     * que ser checada ANTES do runTurn e ANTES da limpeza de "novo" - nunca
     * depois. Estes quatro casos cobrem resolved-com-outra-org e os tres
     * kinds que nao sao "resolved".
     *
     * Mutacao de controle (verificado manualmente: comentar o if da rota faz
     * TODOS estes quatro testes falharem - viram 200 em vez de 409, e
     * rodarTurno passa a ser chamado).
     */
    it.each([
      ["resolved para OUTRA org", { kind: "resolved", org: {}, candidate: { orgId: "org-2" } }, "org-2"],
      ["pending", { kind: "pending", candidates: [] }, null],
      ["ambiguous", { kind: "ambiguous", candidates: [] }, null],
      ["unknown", { kind: "unknown", alreadyGreeted: true }, null],
    ] as const)("identidade %s -> 409, sem rodar turno nem limpar thread", async (_nome, resultado, orgIdEsperado) => {
      vi.stubEnv("MAX_PLAYGROUND", "true");
      identidade.mockResolvedValue(resultado);
      mockConsultaPadrao();

      const { POST } = await import("@/app/api/admin/playground/route");
      const res = await POST(
        chamar({
          orgId: "org-1",
          phone: "+5511999990000",
          text: "oi",
          novo: true,
          requestId: REQUEST_ID,
        })
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({
        error: "identidade_diverge",
        identidade: { kind: resultado.kind, orgId: orgIdEsperado },
      });
      expect(rodarTurno).not.toHaveBeenCalled();

      const limpezas = (consultar.mock.calls as unknown[][]).filter(
        (args) => typeof args[0] === "string" && args[0].includes("DELETE FROM checkpoint")
      );
      expect(limpezas).toHaveLength(0);
    });

    it("identidade resolvida para a MESMA org segue normalmente", async () => {
      vi.stubEnv("MAX_PLAYGROUND", "true");
      identidadeOrg1();
      mockConsultaPadrao();
      const afterReply = vi.fn().mockResolvedValue(undefined);
      rodarTurno.mockResolvedValue({ reply: "ok", afterReply });

      const { POST } = await import("@/app/api/admin/playground/route");
      const res = await POST(
        chamar({ orgId: "org-1", phone: "+5511999990000", text: "oi", requestId: REQUEST_ID })
      );

      expect(res.status).toBe(200);
      expect(rodarTurno).toHaveBeenCalledTimes(1);
    });
  });

  describe("requestId - replay", () => {
    it("message_id ja existe em conversation_turn -> 409 repetido, sem rodar de novo", async () => {
      vi.stubEnv("MAX_PLAYGROUND", "true");
      identidadeOrg1();
      consultar.mockImplementation(async (sql: string) => {
        if (sql.includes("ja_existe")) return [{ ja_existe: 1 }];
        return [];
      });

      const { POST } = await import("@/app/api/admin/playground/route");
      const res = await POST(
        chamar({ orgId: "org-1", phone: "+5511999990000", text: "oi", requestId: REQUEST_ID })
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({ error: "repetido" });
      expect(rodarTurno).not.toHaveBeenCalled();
    });

    it("requestId NOVO roda normalmente (dedupe vazio)", async () => {
      vi.stubEnv("MAX_PLAYGROUND", "true");
      identidadeOrg1();
      mockConsultaPadrao();
      const afterReply = vi.fn().mockResolvedValue(undefined);
      rodarTurno.mockResolvedValue({ reply: "resposta do max", afterReply });

      const { POST } = await import("@/app/api/admin/playground/route");
      const res = await POST(
        chamar({ orgId: "org-1", phone: "+5511999990000", text: "oi", requestId: REQUEST_ID_2 })
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(rodarTurno).toHaveBeenCalledTimes(1);
      expect(body.reply).toBe("resposta do max");
    });
  });

  it("caminho feliz: chama runTurn com o InboundMessage esperado (messageId = playground-<requestId>), aguarda afterReply e devolve reply + rastro SEM telefone", async () => {
    vi.stubEnv("MAX_PLAYGROUND", "true");
    identidadeOrg1();
    const afterReply = vi.fn().mockResolvedValue(undefined);
    rodarTurno.mockResolvedValue({ reply: "resposta do max", afterReply });
    mockConsultaPadrao();

    const { POST } = await import("@/app/api/admin/playground/route");
    const res = await POST(
      chamar({ orgId: "org-1", phone: "+5511999990000", text: "oi", requestId: REQUEST_ID })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(rodarTurno).toHaveBeenCalledTimes(1);
    const inbound = rodarTurno.mock.calls[0][0];
    expect(inbound).toMatchObject({
      fromPhone: "+5511999990000",
      kind: "text",
      text: "oi",
      groupId: null,
      mediaUrl: null,
      mimeType: null,
      senderName: null,
      replyToMessageId: null,
    });
    expect(String(inbound.messageId)).toBe(`playground-${REQUEST_ID}`);
    expect(afterReply).toHaveBeenCalledTimes(1);

    expect(body.reply).toBe("resposta do max");
    expect(body.threadId).toBe("org-1:+5511999990000");
    expect(body.rastro.orgId).toBe("org-1");
    expect(body.rastro.replyText).toBe("resposta do max");
    expect(body.rastro.identidade).toEqual({ kind: "resolved", orgId: "org-1" });
    expect(body.rastro.phone).toBeUndefined();
    expect(JSON.stringify(body.rastro)).not.toContain("+5511999990000");
  });

  it("'novo' limpa a thread certa (orgId:phone) e nao outra", async () => {
    vi.stubEnv("MAX_PLAYGROUND", "true");
    identidadeOrg1();
    mockConsultaPadrao();

    const { POST } = await import("@/app/api/admin/playground/route");
    const res = await POST(
      chamar({ orgId: "org-1", phone: "+5511999990000", novo: true, requestId: REQUEST_ID })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ reply: null, rastro: null, threadId: "org-1:+5511999990000" });
    expect(rodarTurno).not.toHaveBeenCalled();

    const threadsLimpas = (consultar.mock.calls as unknown[][])
      .filter((args) => typeof args[0] === "string" && args[0].includes("DELETE FROM checkpoint"))
      .map((args) => (args[1] as unknown[])[0] as string);
    expect(threadsLimpas.every((t) => t === "org-1:+5511999990000")).toBe(true);
    expect(threadsLimpas).not.toContain("org-2:+5511999990000");
    expect(threadsLimpas.length).toBeGreaterThan(0);
  });

  it("'novo' com text limpa a thread E roda o turno", async () => {
    vi.stubEnv("MAX_PLAYGROUND", "true");
    identidadeOrg1();
    const afterReply = vi.fn().mockResolvedValue(undefined);
    rodarTurno.mockResolvedValue({ reply: "comecei do zero", afterReply });
    mockConsultaPadrao(linhaRastro({ inbound_text: "oi de novo", reply_text: "comecei do zero", route: null, timings_json: null }));

    const { POST } = await import("@/app/api/admin/playground/route");
    const res = await POST(
      chamar({
        orgId: "org-1",
        phone: "+5511999990000",
        text: "oi de novo",
        novo: true,
        requestId: REQUEST_ID,
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(rodarTurno).toHaveBeenCalledTimes(1);
    expect(body.reply).toBe("comecei do zero");
  });
});
