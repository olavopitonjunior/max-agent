import { describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ query: vi.fn(), db: vi.fn() }));

const { cancelarPendentesPorPrefixo } = await import("../outbox");
const { query } = await import("../db");

describe("cancelarPendentesPorPrefixo", () => {
  it("derruba só linhas pendentes da chave e devolve quantas", async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: "a" }, { id: "b" }] as never);
    const n = await cancelarPendentesPorPrefixo("ficha:org1|u1:");
    expect(n).toBe(2);
    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    expect(String(sql)).toMatch(/status = 'dropped'/);
    expect(String(sql)).toMatch(/status = 'pending'/);
    expect(String(sql)).toMatch(/starts_with/);
    expect(params).toEqual(["ficha:org1|u1:", expect.any(String)]);
  });

  it("prefixo vazio não cancela nada (nunca varre a fila inteira)", async () => {
    vi.mocked(query).mockClear();
    expect(await cancelarPendentesPorPrefixo("")).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
