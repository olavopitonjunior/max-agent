import { describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ query: vi.fn(), db: vi.fn() }));

const { cancelarPendentesPorPrefixo, linhaEnviada } = await import("../outbox");
const { query } = await import("../db");

describe("linhaEnviada (C1: só a linha ENVIADA prova que a ficha chegou)", () => {
  it("true só com linha status='sent' e dedupe_key exato", async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: "a" }] as never);
    expect(await linhaEnviada("ficha:s:1000")).toBe(true);
    const [sql, params] = vi.mocked(query).mock.calls.at(-1)!;
    expect(String(sql)).toMatch(/status = 'sent'/);
    expect(String(sql)).toMatch(/dedupe_key = \$1/);
    expect(params).toEqual(["ficha:s:1000"]);
  });

  it("sem linha enviada (pendente, derrubada, falha): false", async () => {
    vi.mocked(query).mockResolvedValueOnce([] as never);
    expect(await linhaEnviada("ficha:s:1000")).toBe(false);
  });

  it("chave vazia: false, sem consultar o banco", async () => {
    vi.mocked(query).mockClear();
    expect(await linhaEnviada("")).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});

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
