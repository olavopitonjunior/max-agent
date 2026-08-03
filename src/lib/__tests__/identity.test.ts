import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * O telefone não identifica a imobiliária sozinho, e este arquivo protege a
 * regra que decorre disso: **um candidato segue, nenhum é desconhecido, dois ou
 * mais o Max pergunta — nunca escolhe.**
 *
 * A versão anterior parava no primeiro acerto, e em produção isso atribuía um
 * usuário da Fincasa ao RE/MAX Trio: resposta com a persona e a base da
 * imobiliária errada.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

vi.mock("../orgs", () => ({
  listOrgs: vi.fn(),
  orgById: vi.fn(),
}));

const { resolveIdentity, matchChoice, saveChoice, askWhichOrg } = await import(
  "../identity"
);
const { listOrgs, orgById } = await import("../orgs");
const { query, db } = await import("../db");

const list = listOrgs as unknown as ReturnType<typeof vi.fn>;
const byId = orgById as unknown as ReturnType<typeof vi.fn>;

const TRIO = { orgId: "org-trio", orgName: "RE/MAX Trio", apiToken: "t-trio" };
const ATIVA = { orgId: "org-ativa", orgName: "RE/MAX Ativa", apiToken: "t-ativa" };
const PHONE = "+5511900001234";

/** by-phone: 200 nas orgs listadas em `achaEm`, 404 no resto. */
function mockByPhone(achaEm: string[]) {
  const fn = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
    const token = init.headers.Authorization.replace("Bearer ", "");
    const org = [TRIO, ATIVA].find((o) => o.apiToken === token);
    if (org && achaEm.includes(org.orgId)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ userId: `u-${org.orgId}`, name: "Marcia" }),
      } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

d("resolveIdentity", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    list.mockResolvedValue([TRIO, ATIVA]);
    byId.mockImplementation(async (id: string) =>
      [TRIO, ATIVA].find((o) => o.orgId === id) ?? null
    );
    await query(`DELETE FROM phone_org_choice WHERE phone = $1`, [PHONE]);
  });

  it("telefone em nenhuma org é desconhecido", async () => {
    mockByPhone([]);
    expect(await resolveIdentity(PHONE)).toEqual({ kind: "unknown" });
  });

  it("telefone em UMA org resolve direto, sem perguntar", async () => {
    mockByPhone([TRIO.orgId]);

    const r = await resolveIdentity(PHONE);

    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.org.orgId).toBe(TRIO.orgId);
  });

  /**
   * O caso que motivou o módulo. Antes, a primeira org da lista ganhava.
   */
  it("telefone em DUAS orgs não escolhe — devolve ambíguo", async () => {
    mockByPhone([TRIO.orgId, ATIVA.orgId]);

    const r = await resolveIdentity(PHONE);

    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates.map((c) => c.orgId).sort()).toEqual(
        [ATIVA.orgId, TRIO.orgId].sort()
      );
    }
  });

  it("a segunda mensagem sem escolha vira `pending`, não pergunta de novo do zero", async () => {
    mockByPhone([TRIO.orgId, ATIVA.orgId]);

    expect((await resolveIdentity(PHONE)).kind).toBe("ambiguous");
    expect((await resolveIdentity(PHONE)).kind).toBe("pending");
  });

  it("depois de escolher, resolve direto e não pergunta mais", async () => {
    mockByPhone([TRIO.orgId, ATIVA.orgId]);
    await resolveIdentity(PHONE);
    await saveChoice(PHONE, ATIVA.orgId);

    const r = await resolveIdentity(PHONE);

    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.org.orgId).toBe(ATIVA.orgId);
  });

  /**
   * A escolha é revogável: se o vínculo sumir do lado do ImobPro, apontar para
   * ele seria pior que perguntar de novo.
   */
  it("escolha para org que saiu do ar caduca em vez de valer para sempre", async () => {
    mockByPhone([TRIO.orgId, ATIVA.orgId]);
    await resolveIdentity(PHONE);
    await saveChoice(PHONE, ATIVA.orgId);

    byId.mockImplementation(async (id: string) =>
      id === ATIVA.orgId ? null : TRIO
    );
    mockByPhone([TRIO.orgId]);

    const r = await resolveIdentity(PHONE);

    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.org.orgId).toBe(TRIO.orgId);
  });

  /** Uma org fora do ar não pode virar "não achei" nas outras. */
  it("org que erra não impede as demais de responderem", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: { headers: Record<string, string> }) => {
        if (init.headers.Authorization.includes("t-trio")) throw new Error("ECONNRESET");
        return {
          ok: true,
          status: 200,
          json: async () => ({ userId: "u-ativa", name: "Marcia" }),
        } as unknown as Response;
      })
    );

    const r = await resolveIdentity(PHONE);

    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.org.orgId).toBe(ATIVA.orgId);
  });

  it("telefone inválido nem chega a varrer as orgs", async () => {
    const f = mockByPhone([TRIO.orgId]);
    expect(await resolveIdentity("123")).toEqual({ kind: "unknown" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("matchChoice", () => {
  const cands = [
    { orgId: "a", orgName: "RE/MAX Trio", kind: "user" as const, userId: "1", userName: null },
    { orgId: "b", orgName: "RE/MAX Ativa", kind: "user" as const, userId: "2", userName: null },
    { orgId: "c", orgName: "Fincasa", kind: "user" as const, userId: "3", userName: null },
  ];

  it("aceita o número da lista", () => {
    expect(matchChoice("2", cands)?.orgId).toBe("b");
    expect(matchChoice(" 3 ", cands)?.orgId).toBe("c");
  });

  it("número fora da lista não casa", () => {
    expect(matchChoice("0", cands)).toBeNull();
    expect(matchChoice("9", cands)).toBeNull();
  });

  it("aceita trecho do nome, ignorando acento e caixa", () => {
    expect(matchChoice("ativa", cands)?.orgId).toBe("b");
    expect(matchChoice("FINCASA", cands)?.orgId).toBe("c");
  });

  /**
   * O ponto mais importante: "RE/MAX" casa com duas, e escolher uma delas seria
   * repetir exatamente o erro que este módulo existe para corrigir.
   */
  it("termo AMBÍGUO não casa com nenhuma", () => {
    expect(matchChoice("RE/MAX", cands)).toBeNull();
    expect(matchChoice("re", cands)).toBeNull();
  });

  it("texto vazio ou sem relação não casa", () => {
    expect(matchChoice("", cands)).toBeNull();
    expect(matchChoice("bom dia", cands)).toBeNull();
  });
});

describe("askWhichOrg", () => {
  it("numera as opções e só oferece as orgs vinculadas", () => {
    const texto = askWhichOrg([
      { orgId: "a", orgName: "RE/MAX Trio", kind: "user", userId: "1", userName: null },
      { orgId: "b", orgName: "Fincasa", kind: "user", userId: "2", userName: null },
    ]);
    expect(texto).toContain("1. RE/MAX Trio");
    expect(texto).toContain("2. Fincasa");
    expect(texto).toContain("número ou o nome");
  });
});

/**
 * Corretor não é usuário da plataforma — a maioria não tem login. O `by-phone`
 * responde 404 para eles, e antes disso o 404 encerrava a org: quem só existia
 * como comissionado era simplesmente desconhecido para o Max, em todas as casas.
 */
d("corretor atribuído", () => {
  /** by-phone 404 em tudo; broker-scope 200 nas orgs de `achaEm`. */
  function mockBroker(achaEm: string[]) {
    const fn = vi.fn(
      async (url: string, init: { headers: Record<string, string> }) => {
        const token = init.headers.Authorization.replace("Bearer ", "");
        const org = [TRIO, ATIVA].find((o) => o.apiToken === token);
        const naoAchou = {
          ok: false,
          status: 404,
          json: async () => ({}),
        } as unknown as Response;

        if (!String(url).includes("/broker-scope")) return naoAchou;
        if (!org || !achaEm.includes(org.orgId)) return naoAchou;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            splitRecipientId: `sr-${org.orgId}`,
            label: "Carlos Corretor",
            dealIds: ["deal-1", "deal-2"],
            scanned: 2,
            truncated: false,
          }),
        } as unknown as Response;
      }
    );
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    list.mockResolvedValue([TRIO, ATIVA]);
    byId.mockImplementation(
      async (id: string) => [TRIO, ATIVA].find((o) => o.orgId === id) ?? null
    );
    await query(`DELETE FROM phone_org_choice WHERE phone = $1`, [PHONE]);
  });

  it("quem não é usuário mas é corretor atribuído é reconhecido", async () => {
    mockBroker([TRIO.orgId]);

    const r = await resolveIdentity(PHONE);

    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.candidate.kind).toBe("broker");
    expect(r.org.orgId).toBe(TRIO.orgId);
  });

  /**
   * A lista de negócios muda quando alguém entra ou sai da comissão. Congelada
   * na linha de escolha, ela daria acesso a negócio do qual o corretor já saiu.
   */
  it("o candidato NÃO carrega a lista de negócios", async () => {
    mockBroker([TRIO.orgId]);

    const r = await resolveIdentity(PHONE);

    if (r.kind !== "resolved") throw new Error("esperava resolved");
    expect(r.candidate).not.toHaveProperty("dealIds");
  });

  it("corretor nas duas casas é perguntado, não escolhido", async () => {
    mockBroker([TRIO.orgId, ATIVA.orgId]);

    const r = await resolveIdentity(PHONE);

    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.candidates.map((c) => c.orgId).sort()).toEqual(
      [ATIVA.orgId, TRIO.orgId].sort()
    );
  });

  /**
   * Quem é usuário E corretor na mesma casa entra como usuário: o escopo do
   * RBAC é o mais específico dos dois, e estreitá-lo para "só onde é
   * comissionado" tiraria acesso de um gerente que também vende.
   */
  it("usuário da plataforma não vira candidato de corretor na mesma org", async () => {
    const fn = mockByPhone([TRIO.orgId]);

    const r = await resolveIdentity(PHONE);

    if (r.kind !== "resolved") throw new Error("esperava resolved");
    expect(r.candidate.kind).toBe("user");
    const urls = fn.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/broker-scope") && u.includes("trio"))).toBe(
      false
    );
  });

  it("corretor não atribuído continua desconhecido", async () => {
    mockBroker([]);

    expect((await resolveIdentity(PHONE)).kind).toBe("unknown");
  });
});

/**
 * Teardown no NÍVEL DO ARQUIVO: o pool é compartilhado por todos os blocos, e
 * fechá-lo dentro de um `describe` derruba os que rodam depois — falha que
 * aparece como "Cannot use a pool after calling end on the pool" no bloco
 * seguinte, e não onde o pool foi fechado.
 */
afterAll(async () => {
  if (!hasDb) return;
  await query(`DELETE FROM phone_org_choice WHERE phone = $1`, [PHONE]);
  await db().end();
});
