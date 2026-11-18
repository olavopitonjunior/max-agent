import { describe, expect, it } from "vitest";
import { camposDoPatchExtraido, TOOL_PATCH_V2 } from "../extracao";

const CPF = "52998224725"; // sintético válido

const janela = (...textos: string[]) => textos.join("\n");

describe("TOOL_PATCH_V2", () => {
  it("é uma tool só, com nome fixo (o texto do corretor nunca escolhe ferramenta)", () => {
    expect(TOOL_PATCH_V2.name).toBe("preencher_proposta_v2");
    expect(TOOL_PATCH_V2.parameters).toMatchObject({ type: "object" });
  });
});

describe("camposDoPatchExtraido: o que o modelo devolve vira campo lido, nunca gravação", () => {
  it("monta caminhos canônicos por posição e papel", () => {
    const texto = janela(`comprador João Silva CPF ${CPF}, vendedora Maria Souza, valor 500 mil`);
    const r = camposDoPatchExtraido(
      {
        compradores: [{ nome: "João Silva", cpf: CPF }],
        vendedores: [{ nome: "Maria Souza" }],
        negociacao: { valor: 500000 },
      },
      texto
    );
    const porPath = Object.fromEntries(r.map((c) => [c.path, c.valor]));
    expect(porPath["compradores[0].nome"]).toBe("João Silva");
    expect(porPath["compradores[0].cpf"]).toBe(CPF);
    expect(porPath["vendedores[0].nome"]).toBe("Maria Souza");
    expect(porPath["negociacao.valor"]).toBe("500000");
  });

  it("descarta CPF que o corretor não escreveu (alucinação do modelo)", () => {
    const r = camposDoPatchExtraido({ compradores: [{ nome: "João Silva", cpf: CPF }] }, "comprador João Silva");
    expect(r.map((c) => c.path)).toEqual(["compradores[0].nome"]);
  });

  it("descarta CPF com dígito verificador errado, mesmo escrito", () => {
    const r = camposDoPatchExtraido({ compradores: [{ cpf: "11111111112" }] }, "cpf 11111111112");
    expect(r).toEqual([]);
  });

  it("descarta valor que nenhuma mensagem cita", () => {
    const r = camposDoPatchExtraido({ negociacao: { valor: 999000 } }, "o imóvel é na Rua das Flores");
    expect(r).toEqual([]);
  });

  it("descarta nome que não aparece no texto", () => {
    const r = camposDoPatchExtraido({ compradores: [{ nome: "Carlos Inventado" }] }, "comprador João");
    expect(r).toEqual([]);
  });

  it("e-mail e telefone só valem se escritos", () => {
    const ok = camposDoPatchExtraido(
      { compradores: [{ email: "joao@exemplo.com", telefone: "11987654321" }] },
      "joao@exemplo.com e 11 98765-4321"
    );
    expect(ok.map((c) => c.path).sort()).toEqual(["compradores[0].email", "compradores[0].telefone"]);
    const ruim = camposDoPatchExtraido({ compradores: [{ email: "x@y.com", telefone: "11911112222" }] }, "sem contato");
    expect(ruim).toEqual([]);
  });

  it("campo fora da lista (chave inventada) é ignorado", () => {
    const r = camposDoPatchExtraido({ compradores: [{ nome: "João", senha: "x" } as never], hack: "1" } as never, "João");
    expect(r.map((c) => c.path)).toEqual(["compradores[0].nome"]);
  });

  it("imóvel e observações entram; saída sem ✅ e em uma linha", () => {
    const r = camposDoPatchExtraido(
      { imovel: { matricula: "12345", cidade: "Santos" }, observacoes: "entrada em 3x ✅\nsem pressa" },
      "matrícula 12345 em Santos, entrada em 3x sem pressa"
    );
    const porPath = Object.fromEntries(r.map((c) => [c.path, c.valor]));
    expect(porPath["imovel.matricula"]).toBe("12345");
    expect(porPath["imovel.cidade"]).toBe("Santos");
    expect(porPath["observacoes"]).not.toMatch(/✅|\n/);
  });

  it("entrada inválida (null, string, lista) vira lista vazia, nunca lança", () => {
    expect(camposDoPatchExtraido(null, "x")).toEqual([]);
    expect(camposDoPatchExtraido("oi" as never, "x")).toEqual([]);
    expect(camposDoPatchExtraido({ compradores: "João" } as never, "João")).toEqual([]);
  });

  it("confiança é alta só para o que o corretor escreveu literalmente", () => {
    const r = camposDoPatchExtraido({ compradores: [{ nome: "João Silva" }] }, "comprador João Silva");
    expect(r[0]!.confianca).toBeGreaterThanOrEqual(0.5);
  });
});
