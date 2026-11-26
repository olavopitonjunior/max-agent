import { describe, it, expect, vi } from "vitest";
import { fenceToolResults } from "../prompt";
import { limparRotuloInterno } from "../lista-contagem";
import { pedeConsulta, responderConsulta } from "../consulta";

/**
 * Prod 26/11 (Fincasa): "quantas propostas eu tenho?" respondeu "No momento, eu só consigo listar *mostrando 5*
 * das suas propostas e há mais na fila." O rótulo interno da cerca vazou. A resposta honesta diz o total quando o
 * servidor o informa e, sem ele, "pelo menos N" (nunca um número inventado).
 */

const prop = (n: number) => ({ id: `p${n}`, codigo: `PROP-2026-000${n}`, titulo: `Imóvel ${n}`, status: "enviada", estado: "Enviada" });
const deps = (body: Record<string, unknown>, status = 200) => ({ acao: vi.fn().mockResolvedValue({ status, body }) }) as never;
const cinco = [1, 2, 3, 4, 5].map(prop);

describe("quantas propostas eu tenho", () => {
  it("é consulta (chega ao caminho determinístico)", () => {
    expect(pedeConsulta("quantas propostas eu tenho?")).toBe(true);
    expect(pedeConsulta("Quantas propostas tenho no sistema")).toBe(true);
  });

  it("com o total do servidor: diz o número, sem rótulo interno", async () => {
    const r = await responderConsulta(deps({ items: cinco, total: 23 }), "quantas propostas eu tenho?");
    expect(r.reply).toContain("23 propostas");
    expect(r.reply).not.toMatch(/mostrando/i);
  });

  it("uma só: singular", async () => {
    const r = await responderConsulta(deps({ items: [prop(1)], total: 1 }), "quantas propostas eu tenho?");
    expect(r.reply).toContain("1 proposta");
    expect(r.reply).not.toContain("1 propostas");
  });

  it("nenhuma: diz que não há", async () => {
    const r = await responderConsulta(deps({ items: [], total: 0 }), "quantas propostas eu tenho?");
    expect(r.reply).toContain("ainda não tem propostas");
  });

  it("sem total do servidor: 'pelo menos 5' e as mais recentes, sem inventar número nem vazar rótulo", async () => {
    const r = await responderConsulta(deps({ items: cinco }), "quantas propostas eu tenho?");
    expect(r.reply).toContain("pelo menos 5 propostas");
    expect(r.reply).toContain("PROP-2026-0001");
    expect(r.reply).not.toMatch(/mostrando|na fila/i);
    expect(r.reply).not.toMatch(/\*/);
  });

  it("servidor sem resposta: não afirma número", async () => {
    const r = await responderConsulta({ acao: vi.fn().mockResolvedValue(null) } as never, "quantas propostas eu tenho?");
    expect(r.reply).toContain("Não consegui consultar");
  });

  it("com situação a pergunta segue a consulta de sempre (não vira contagem solta)", async () => {
    const d = deps({ items: [prop(1), { ...prop(2), status: "cancelada", estado: "Cancelada" }], total: 2 });
    const r = await responderConsulta(d, "quantas propostas em aberto eu tenho?");
    expect(r.evento).not.toBe("consulta_contagem");
    expect(r.reply).toContain("PROP-2026-0001");
    expect(r.reply).not.toContain("PROP-2026-0002");
  });
});

describe("rótulo interno da cerca na resposta do modelo", () => {
  it("a instrução da lista cortada não oferece o rótulo e manda dizer 'mais de N'", () => {
    const f = fenceToolResults([{ tool: "listar_propostas", items: [1, 2, 3, 4, 5].map((n) => ({ n, titulo: `P${n}` })), truncated: true }]);
    expect(f).not.toMatch(/mostrando/i);
    expect(f).toContain("mais de 5");
    expect(f).toMatch(/nunca invente/i);
  });

  it("a frase real de prod perde o rótulo e os asteriscos", () => {
    const t = limparRotuloInterno("No momento, eu só consigo listar *mostrando 5* das suas propostas e há mais na fila.");
    expect(t).not.toMatch(/mostrando/i);
    expect(t).not.toContain("*");
    expect(t).toContain("5 das suas propostas");
  });

  it("a frase comum não é mexida", () => {
    const t = "Mostrando 3 atividades:\n1. a\n2. b\n3. c";
    expect(limparRotuloInterno(t)).toBe(t);
  });
});
