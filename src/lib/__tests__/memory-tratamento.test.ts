import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Prod 10/11/2026 (Max Fincasa): o extrator leu o próprio "Perfeito, João" do
 * assistente (João era o cliente do negócio) e gravou "como a pessoa prefere
 * ser chamada = João" para o Olavo. O nome de quem escreve vem do cadastro:
 * fato de tratamento não é gravado nem entra no prompt, mesmo se já estiver
 * no banco.
 */
const sql = vi.hoisted(() => ({ chamadas: [] as { texto: string; params: unknown[] }[] }));

vi.mock("../db", () => ({
  query: vi.fn(async (texto: string, params: unknown[]) => {
    sql.chamadas.push({ texto, params });
    return [];
  }),
  db: {},
}));
vi.mock("../llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "x" }));
vi.mock("../cm", () => ({ reportUsage: vi.fn().mockResolvedValue(undefined) }));

const { saveFacts, renderFacts, ehFatoDeTratamento } = await import("../memory");

beforeEach(() => {
  sql.chamadas.length = 0;
});

describe("fato de tratamento", () => {
  it.each([
    "como_pessoa_prefere_ser_chamada",
    "preferencia_nome",
    "apelido",
    "forma_de_tratamento",
    "nome_preferido",
  ])("reconhece a chave %s", (k) => {
    expect(ehFatoDeTratamento(k)).toBe(true);
  });

  it.each(["area_atuacao", "preferencia_resposta", "foco_atual"])("não pega fato comum: %s", (k) => {
    expect(ehFatoDeTratamento(k)).toBe(false);
  });

  it("saveFacts não grava tratamento, mas grava o resto", async () => {
    const n = await saveFacts("org1", "5511987654321", {
      como_pessoa_prefere_ser_chamada: "João",
      preferencia_nome: "João",
      area_atuacao: "vendas",
    });
    expect(n).toBe(1);
    const inserts = sql.chamadas.filter((c) => c.texto.includes("INSERT INTO memory_facts"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[2]).toBe("area_atuacao");
  });

  it("renderFacts ignora tratamento já gravado (linha envenenada do banco)", () => {
    const bloco = renderFacts({ como_pessoa_prefere_ser_chamada: "João", preferencia_nome: "Olavo", area_atuacao: "vendas" });
    expect(bloco).not.toContain("João");
    expect(bloco).not.toContain("preferencia_nome");
    expect(bloco).toContain("area_atuacao: vendas");
    expect(renderFacts({ como_pessoa_prefere_ser_chamada: "João" })).toBe("");
  });
});
