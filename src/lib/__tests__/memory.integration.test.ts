import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Memória entre conversas.
 *
 * Duas coisas sob teste, e as duas são políticas, não formatação:
 *
 * 1. **O que NÃO entra.** Documento, dado bancário e sequência de dígitos são
 *    recusados aqui, no código, e não só pedidos no prompt — prompt é pedido, e
 *    o custo de um CPF cair neste banco (que existe justamente pra NÃO ter os
 *    dados da aplicação) é alto demais pra depender de o modelo ter obedecido.
 * 2. **O teto.** Sem poda, a memória cresce sem limite e passa a ocupar o
 *    prompt inteiro — o oposto do ganho.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

vi.mock("../llm", () => ({
  complete: vi.fn(),
  DEFAULT_MODEL: "openai/gpt-5.4-nano",
}));
vi.mock("../cm", () => ({
  reportUsage: vi.fn().mockResolvedValue(undefined),
}));

const { loadFacts, saveFacts, extractFacts, renderFacts } = await import(
  "../memory"
);
const { query, db } = await import("../db");
const { complete } = await import("../llm");

const llm = complete as unknown as ReturnType<typeof vi.fn>;

const ORG = "org-memoria-test";
const PHONE = "5511900000009";

d("memory_facts (Postgres real)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await query(`DELETE FROM memory_facts WHERE org_id = $1`, [ORG]);
  });

  afterAll(async () => {
    await query(`DELETE FROM memory_facts WHERE org_id = $1`, [ORG]);
  });

  it("grava e lê", async () => {
    await saveFacts(ORG, PHONE, { area: "locação", chamar_de: "Neto" });

    expect(await loadFacts(ORG, PHONE)).toEqual({
      area: "locação",
      chamar_de: "Neto",
    });
  });

  /** Fato que muda sobrescreve — acumular criaria contradição na memória. */
  it("a mesma chave atualiza em vez de duplicar", async () => {
    await saveFacts(ORG, PHONE, { area: "locação" });
    await saveFacts(ORG, PHONE, { area: "vendas" });

    expect(await loadFacts(ORG, PHONE)).toEqual({ area: "vendas" });
  });

  it("memória é por (org, telefone): a mesma pessoa em duas casas não mistura", async () => {
    await saveFacts(ORG, PHONE, { area: "locação" });
    await saveFacts(`${ORG}-2`, PHONE, { area: "vendas" });

    expect(await loadFacts(ORG, PHONE)).toEqual({ area: "locação" });
    await query(`DELETE FROM memory_facts WHERE org_id = $1`, [`${ORG}-2`]);
  });

  describe("o que não pode virar memória", () => {
    it("recusa chave com cara de documento", async () => {
      await saveFacts(ORG, PHONE, { cpf: "algum valor", area: "locação" });

      expect(await loadFacts(ORG, PHONE)).toEqual({ area: "locação" });
    });

    it("recusa valor com cara de documento, mesmo com chave inocente", async () => {
      await saveFacts(ORG, PHONE, { observacao: "o pix dele é esse" });

      expect(await loadFacts(ORG, PHONE)).toEqual({});
    });

    /** Documento, telefone ou valor — todos têm dono melhor no ImobPro. */
    it("recusa sequência longa de dígitos", async () => {
      await saveFacts(ORG, PHONE, { referencia: "111.222.333-44" });

      expect(await loadFacts(ORG, PHONE)).toEqual({});
    });

    it("recusa vazio e corta o que passa do limite", async () => {
      await saveFacts(ORG, PHONE, {
        vazio: "   ",
        longo: "x".repeat(500),
      });

      const facts = await loadFacts(ORG, PHONE);
      expect(facts.vazio).toBeUndefined();
      expect(facts.longo.length).toBe(200);
    });

    /**
     * Achado no primeiro turno real de produção: o extrator gravou
     * `area_atuacao: "não informado"`. Ausência de fato ocupa uma das 20 vagas
     * E entra no prompt seguinte com cara de informação — num modelo pequeno,
     * que trata o que está no prompt como verdade.
     */
    it("recusa AUSÊNCIA de fato disfarçada de fato", async () => {
      await saveFacts(ORG, PHONE, {
        area_atuacao: "não informado",
        cidade: "não sei",
        origem: "sem informação",
        perfil: "desconhecido",
        obs: "n/a",
        outro: "-",
        real: "prefere ser chamado de Neto",
      });

      // Só o fato de verdade sobrevive.
      expect(await loadFacts(ORG, PHONE)).toEqual({
        real: "prefere ser chamado de Neto",
      });
    });

    /**
     * `nenhum` fica de fora da cerca de propósito. É a fronteira mais frágil da
     * lista: "filhos: nenhum" é fato durável e útil, e apagar um fato
     * verdadeiro é pior que guardar um pouco útil. A cerca existe contra o que
     * o extrator produziu de verdade ("não informado"), não contra tudo que
     * soa negativo.
     */
    it("`nenhum` é fato, não ausência — e continua gravado", async () => {
      await saveFacts(ORG, PHONE, { filhos: "nenhum" });

      expect(await loadFacts(ORG, PHONE)).toEqual({ filhos: "nenhum" });
    });

    it("mas não confunde negativa COM conteúdo com ausência", async () => {
      // "não trabalha com locação" é um fato durável e útil; a cerca não pode
      // ser um `includes("não")`.
      await saveFacts(ORG, PHONE, { area: "não trabalha com locação" });

      expect(await loadFacts(ORG, PHONE)).toEqual({
        area: "não trabalha com locação",
      });
    });
  });

  /**
   * O outro bug de 21/08: memória gravada por um caminho e lida por outro.
   * `saveFacts` e `loadFacts` normalizam pela `conversationKey`, então a forma
   * do telefone deixa de importar — que é exatamente o que faltava quando a
   * mesma pessoa acabou com duas memórias.
   */
  it("a forma do telefone não cria uma segunda pessoa", async () => {
    await saveFacts(ORG, "5511900000009", { area: "vendas" });

    for (const forma of ["+5511900000009", "11900000009", "(11) 90000-0009"]) {
      expect(await loadFacts(ORG, forma)).toEqual({ area: "vendas" });
    }

    // E gravar pela outra forma ATUALIZA, não duplica.
    await saveFacts(ORG, "+5511900000009", { area: "locação" });
    expect(await loadFacts(ORG, "5511900000009")).toEqual({ area: "locação" });
  });

  it("poda no teto: memória não cresce sem limite", async () => {
    const muitos = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`chave${i}`, `valor ${i}`])
    );
    await saveFacts(ORG, PHONE, muitos);

    expect(Object.keys(await loadFacts(ORG, PHONE)).length).toBeLessThanOrEqual(20);
  });
});

describe("extração (sem banco)", () => {
  beforeEach(() => vi.clearAllMocks());

  const args = {
    orgId: "o1",
    phone: "p1",
    userText: "oi, sou o Neto, cuido da parte de locação aqui",
    replyText: "Oi Neto! Posso ajudar com o processo de locação.",
    known: {},
  };

  it("lê o JSON do modelo", async () => {
    llm.mockResolvedValue({
      text: '{"chamar_de":"Neto","area":"locação"}',
      usage: { model: "m", promptTokens: 1, latencyMs: 1 },
    });

    expect(await extractFacts(args)).toEqual({
      chamar_de: "Neto",
      area: "locação",
    });
  });

  /** Modelo nano cerca JSON em bloco de código o tempo todo. */
  it("aguenta cerca de código em volta do JSON", async () => {
    llm.mockResolvedValue({
      text: '```json\n{"area":"vendas"}\n```',
      usage: { model: "m", promptTokens: 1, latencyMs: 1 },
    });

    expect(await extractFacts(args)).toEqual({ area: "vendas" });
  });

  it("JSON quebrado vira vazio, não exceção", async () => {
    llm.mockResolvedValue({
      text: "claro! aqui estão os fatos:",
      usage: { model: "m", promptTokens: 1, latencyMs: 1 },
    });

    expect(await extractFacts(args)).toEqual({});
  });

  it("modelo fora do ar vira vazio", async () => {
    llm.mockRejectedValue(new Error("503"));

    expect(await extractFacts(args)).toEqual({});
  });

  /** Array não é mapa de fatos — devolver como está quebraria o `saveFacts`. */
  it("resposta que não é objeto vira vazio", async () => {
    llm.mockResolvedValue({
      text: '["Neto","locação"]',
      usage: { model: "m", promptTokens: 1, latencyMs: 1 },
    });

    expect(await extractFacts(args)).toEqual({});
  });

  it("o que já sabemos vai no pedido, pra não repetir", async () => {
    llm.mockResolvedValue({
      text: "{}",
      usage: { model: "m", promptTokens: 1, latencyMs: 1 },
    });

    await extractFacts({ ...args, known: { area: "locação" } });

    expect(llm.mock.calls[0][0].messages[0].content).toContain("area");
  });
});

describe("renderFacts", () => {
  it("sem fatos, não deixa cabeçalho órfão no prompt", () => {
    expect(renderFacts({})).toBe("");
  });

  it("lista o que sabe", () => {
    const out = renderFacts({ chamar_de: "Neto", area: "locação" });
    expect(out).toContain("chamar_de: Neto");
    expect(out).toContain("area: locação");
  });
});

afterAll(async () => {
  if (hasDb) await db().end();
});
