import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * `chaveDePolitica` — a função que implementa o fail-closed de REDE.
 *
 * ── Por que este arquivo existe ────────────────────────────────────────────
 *
 * Todo teste que passa pelo `gate` mocka `@/lib/cm` inteiro, inclusive esta
 * função. Ou seja: o corpo dela nunca rodava. O comentário no `graph.ts` e a
 * §13.4 do `docs/max.md` afirmam "falha vira `null`, nunca o último valor
 * conhecido" e "há teste travando isso" — e, sem este arquivo, a segunda
 * afirmação era FALSA. O que existia era um teste de que `resolverPolitica`
 * reage certo a um `null` fabricado à mão, que é outra coisa.
 *
 * Invertendo `!res.ok`, ou deixando de capturar o timeout, nenhum teste do
 * repositório ficaria vermelho. É a mesma classe de defeito que o PR 4 ensinou
 * a temer: justificativa confiante ao lado de código que não a sustenta.
 */

vi.mock("../orgs", () => ({
  orgById: vi.fn(),
}));

const { orgById } = await import("../orgs");
const { chaveDePolitica } = await import("../cm");
const mockOrgById = vi.mocked(orgById);

const ORG = {
  orgId: "org1",
  orgName: "RE/MAX Trio",
  apiToken: "cmt_abc",
} as never;

const PHONE = "+5511999063228";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.CM_BASE_URL ??= "https://imobpro.test";
  mockOrgById.mockResolvedValue(ORG);
});
afterEach(() => vi.unstubAllGlobals());

function respondeCom(init: {
  ok: boolean;
  status: number;
  body?: unknown;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: init.ok,
      status: init.status,
      json: async () => init.body ?? {},
    })) as never
  );
}

describe("chaveDePolitica — o caminho feliz", () => {
  it("200 com roleKey devolve a chave", async () => {
    respondeCom({ ok: true, status: 200, body: { roleKey: "sales" } });
    expect(await chaveDePolitica("org1", PHONE)).toBe("sales");
  });

  it("200 com chave de papel customizado devolve custom:<id>", async () => {
    respondeCom({
      ok: true,
      status: 200,
      body: { roleKey: "custom:cr_estagiario" },
    });
    expect(await chaveDePolitica("org1", PHONE)).toBe("custom:cr_estagiario");
  });
});

// ── O QUE ESTE ARQUIVO EXISTE PARA PROVAR ──────────────────────────────────

describe("chaveDePolitica — toda falha cai em null", () => {
  it("200 com roleKey null (membership degenerada) devolve null", async () => {
    respondeCom({ ok: true, status: 200, body: { roleKey: null } });
    expect(await chaveDePolitica("org1", PHONE)).toBeNull();
  });

  it("200 sem o campo devolve null — não inventa papel", async () => {
    respondeCom({ ok: true, status: 200, body: {} });
    expect(await chaveDePolitica("org1", PHONE)).toBeNull();
  });

  it("200 com roleKey de tipo errado devolve null", async () => {
    // Resposta vem de cast não validado; número no lugar de string não pode
    // virar chave nem lançar dentro do gate, que não tem catch.
    respondeCom({ ok: true, status: 200, body: { roleKey: 7 } });
    expect(await chaveDePolitica("org1", PHONE)).toBeNull();
  });

  it("404 (não é usuário desta casa) devolve null SEM warning", async () => {
    // 404 é resultado NORMAL: corretor comissionado não é usuário. Logar aqui
    // encheria o log de ruído a cada turn de corretor.
    respondeCom({ ok: false, status: 404 });
    expect(await chaveDePolitica("org1", PHONE)).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("5xx devolve null E loga — degradação não pode passar por 'não pode nada'", async () => {
    respondeCom({ ok: false, status: 502 });
    expect(await chaveDePolitica("org1", PHONE)).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it("timeout/exceção de rede devolve null, não lança", async () => {
    // O gate NÃO tem catch: uma exceção aqui mataria o turn inteiro.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("timeout de 8000ms")) as never
    );
    await expect(chaveDePolitica("org1", PHONE)).resolves.toBeNull();
  });

  it("org não configurada devolve null sem chamar a rede", async () => {
    mockOrgById.mockResolvedValue(null as never);
    const f = vi.fn();
    vi.stubGlobal("fetch", f as never);
    expect(await chaveDePolitica("org-fantasma", PHONE)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("telefone não normalizável devolve null sem chamar a rede", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f as never);
    expect(await chaveDePolitica("org1", "abc")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
