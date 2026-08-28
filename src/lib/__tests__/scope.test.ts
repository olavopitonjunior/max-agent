import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * O cliente do `scope-query` — e a rede de segurança da regra 5.
 *
 * Dois assuntos distintos moram aqui e não devem ser confundidos:
 *
 * 1. **Fail-closed de rede.** Toda falha vira `null`, nunca lista vazia. Lista
 *    vazia apresentada como fato mentiria para a pessoa sobre a carteira dela;
 *    `null` deixa quem chama dizer "não consegui consultar agora".
 * 2. **Defesa em profundidade da projeção.** A projeção que VALE é a do
 *    servidor. `descartarSeVazou` não a substitui — ela não sabe o que deveria
 *    vir, só o que nunca pode vir. Existe porque, se o ImobPro regredir a
 *    projeção, nenhum teste deste repo pegaria: todos mockam a resposta.
 */

vi.mock("../orgs", () => ({ orgById: vi.fn() }));

const { orgById } = await import("../orgs");
const { consultarEscopo, descartarSeVazou, subjectDe } = await import("../scope");
const { CAMPOS_PROIBIDOS_AO_BROKER } = await import("@/graph/scope-contract");
const mockOrgById = vi.mocked(orgById);

const ORG = { orgId: "org1", orgName: "RE/MAX Trio", apiToken: "cmt_x" } as never;
const PHONE = "+5511999063228";
const SUJEITO = { kind: "user" as const, userId: "u1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockOrgById.mockResolvedValue(ORG);
});
afterEach(() => vi.unstubAllGlobals());

function responde(init: { ok: boolean; status: number; body?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: init.ok,
      status: init.status,
      json: async () => init.body ?? {},
    })) as never
  );
}

describe("consultarEscopo — o caminho feliz", () => {
  it("devolve items e truncated", async () => {
    responde({ ok: true, status: 200, body: { items: [{ id: "d1" }], truncated: true } });
    const r = await consultarEscopo({
      orgId: "org1", rawPhone: PHONE, subject: SUJEITO, verb: "deal.list",
    });
    expect(r).toEqual({ items: [{ id: "d1" }], truncated: true });
  });

  it("manda phone JUNTO do subject — o servidor reconfere o vínculo", async () => {
    responde({ ok: true, status: 200, body: { items: [] } });
    await consultarEscopo({
      orgId: "org1", rawPhone: "(11) 99906-3228", subject: SUJEITO, verb: "deal.list",
    });
    const corpo = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as { body: string }).body
    );
    // O Max NÃO é acreditado a afirmar quem é a pessoa. Sem o telefone, um
    // token de tenant comprometido leria a carteira de qualquer um da org.
    expect(corpo.phone).toBe(PHONE);
    expect(corpo.subject).toEqual(SUJEITO);
  });
});

// ── FAIL-CLOSED DE REDE ────────────────────────────────────────────────────

describe("consultarEscopo — toda falha vira null, nunca lista vazia", () => {
  it.each([
    ["403 — sujeito não confere", 403],
    ["404", 404],
    ["500", 500],
  ])("%s devolve null", async (_n, status) => {
    responde({ ok: false, status });
    expect(
      await consultarEscopo({ orgId: "org1", rawPhone: PHONE, subject: SUJEITO, verb: "deal.list" })
    ).toBeNull();
  });

  it("timeout/exceção devolve null, não lança", async () => {
    // O nó de tools não pode morrer por causa disto — mataria o turn.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")) as never);
    await expect(
      consultarEscopo({ orgId: "org1", rawPhone: PHONE, subject: SUJEITO, verb: "deal.list" })
    ).resolves.toBeNull();
  });

  it("200 com items de forma errada devolve null — não vira lista vazia", async () => {
    responde({ ok: true, status: 200, body: { items: "nada disso" } });
    expect(
      await consultarEscopo({ orgId: "org1", rawPhone: PHONE, subject: SUJEITO, verb: "deal.list" })
    ).toBeNull();
  });

  it("org não configurada e telefone impossível não tocam a rede", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f as never);
    mockOrgById.mockResolvedValue(null as never);
    expect(await consultarEscopo({ orgId: "x", rawPhone: PHONE, subject: SUJEITO, verb: "deal.list" })).toBeNull();
    mockOrgById.mockResolvedValue(ORG);
    expect(await consultarEscopo({ orgId: "org1", rawPhone: "abc", subject: SUJEITO, verb: "deal.list" })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

// ── REGRA 5: AUSÊNCIA, NÃO PRESENÇA ────────────────────────────────────────

describe("descartarSeVazou — defesa em profundidade da projeção", () => {
  it("descarta a linha inteira se QUALQUER campo proibido vier", () => {
    for (const proibido of CAMPOS_PROIBIDOS_AO_BROKER) {
      const item = { id: "d1", etapa: "Documentação", [proibido]: "vazou" };
      // Descarta, não poda: podar produziria um item meio-certo que parece
      // correto no log; descartar produz uma ausência que alguém investiga.
      expect(descartarSeVazou([item], "broker")).toEqual([]);
    }
  });

  it("o item legítimo do broker passa — para o teste acima não ser vacuoso", () => {
    const ok = {
      id: "deal-1", etapa: "Documentação", pendencias: [],
      atualizadoEm: "2026-08-19T14:02:00.000Z", referencia: "Negócio #DEAL-1",
    };
    expect(descartarSeVazou([ok], "broker")).toEqual([ok]);
  });

  it("NÃO mexe no sujeito user — ele PODE ver os campos", () => {
    // A rede é só para broker. Aplicá-la ao usuário apagaria o dado legítimo
    // dele e a feature sumiria com cara de segurança.
    const doUsuario = { id: "d1", titulo: "Apto Rua X", cliente: "Maria", valor: 850000 };
    expect(descartarSeVazou([doUsuario], "user")).toEqual([doUsuario]);
  });

  it("grita alto quando descarta — se isto dispara, o outro lado quebrou", () => {
    descartarSeVazou([{ id: "d1", cliente: "Maria" }], "broker");
    expect(console.error).toHaveBeenCalled();
  });

  it("item que não é objeto não quebra a filtragem", () => {
    expect(descartarSeVazou([null, "x", 7], "broker")).toEqual([null, "x", 7]);
  });
});

describe("subjectDe", () => {
  it("deriva o subject dos dois tipos de identidade", () => {
    expect(subjectDe({ kind: "user", userId: "u1", orgId: "o", orgName: "n", userName: null }))
      .toEqual({ kind: "user", userId: "u1" });
    expect(subjectDe({ kind: "broker", splitRecipientId: "sr1", orgId: "o", orgName: "n", label: "W" }))
      .toEqual({ kind: "broker", splitRecipientId: "sr1" });
  });
});
