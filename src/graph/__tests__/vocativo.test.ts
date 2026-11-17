import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Bug 3 (prod 16/11): o Max chamou o Olavo de "João". O nome de quem fala vem SÓ do cadastro
 * (`displayName(identity)` → `userName` do prompt). A memória entre conversas nunca serve nem guarda
 * nome/tratamento: o extrator lia a PRÓPRIA resposta do bot ("Oi João!") e gravava "chamar_de: João",
 * que voltava ao prompt como verdade. Linhas antigas de `memory_facts` não são apagadas; são ignoradas na leitura.
 */

vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));
vi.mock("@/lib/cm", () => ({ reportUsage: vi.fn().mockResolvedValue(undefined) }));
const query = vi.fn();
vi.mock("@/lib/db", () => ({ query: (...a: unknown[]) => query(...a), db: vi.fn() }));

const { buildSystemPrompt } = await import("../prompt");
const { extractFacts, renderFacts, loadFacts, limparFato } = await import("@/lib/memory");
const { complete } = await import("@/lib/llm");
const llm = complete as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("vocativo: o nome de quem fala vem só do cadastro", () => {
  const base = { orgName: "RE/MAX Trio", hits: [] };

  it("fato 'nome: João' na memória + identidade Olavo: o prompt chama de Olavo e não carrega o João", () => {
    const facts = renderFacts({ nome: "João", chamar_de: "João", tratamento: "Sr. João", area: "locação" });
    const p = buildSystemPrompt({ ...base, userName: "Olavo", facts });
    expect(p).toContain("Olavo");
    expect(p).not.toContain("João");
    // O fato que não é nome continua servido.
    expect(p).toContain("area: locação");
  });

  it("o prompt diz que o nome vem só de nome_da_pessoa e que nome citado no histórico/fatos não vale", () => {
    const p = buildSystemPrompt({ ...base, userName: "Olavo" }).replace(/\s+/g, " ");
    expect(p).toMatch(/único nome/i);
    expect(p).toMatch(/nunca (use|chame)[^.]*outro nome/i);
  });

  it("sem nome no cadastro, o prompt manda não chamar a pessoa por nome nenhum", () => {
    const p = buildSystemPrompt({ ...base, userName: null }).replace(/\s+/g, " ");
    expect(p).toMatch(/n[ãa]o sabe o nome/i);
  });

  it("renderFacts descarta nome/tratamento mesmo que a linha já exista no banco", () => {
    const out = renderFacts({ nome: "João", chamar_de: "João", apelido: "Joãozinho", como_chamar: "João", area: "vendas" });
    expect(out).toBe(renderFacts({ area: "vendas" }));
    expect(out).not.toContain("João");
  });

  it("loadFacts ignora linhas antigas de nome (sem apagar nada)", async () => {
    query.mockResolvedValueOnce([
      { key: "chamar_de", value: "João" },
      { key: "nome_preferido", value: "João" },
      { key: "area", value: "locação" },
    ]);
    expect(await loadFacts("org1", "5511900000000")).toEqual({ area: "locação" });
    // Só SELECT: nenhuma linha foi apagada.
    expect(query.mock.calls.every((c) => /^\s*SELECT/i.test(String(c[0])))).toBe(true);
  });

  it("limparFato recusa nome, tratamento e 'prefere ser chamado de…' na escrita", () => {
    expect(limparFato("nome", "João")).toBeNull();
    expect(limparFato("chamar_de", "Neto")).toBeNull();
    expect(limparFato("tratamento", "doutor")).toBeNull();
    expect(limparFato("preferencia", "prefere ser chamado de Neto")).toBeNull();
    expect(limparFato("area", "locação")).toEqual(["area", "locação"]);
  });
});

describe("extractFacts: só o que a PESSOA disse", () => {
  const args = {
    orgId: "o1",
    phone: "p1",
    userText: "oi, quais as certidões do negócio X?",
    known: {},
  };

  it("a resposta do bot não entra no pedido de extração", async () => {
    llm.mockResolvedValue({ text: "{}", usage: { model: "m", promptTokens: 1, latencyMs: 1 } });
    await extractFacts({ ...args, replyText: "Oi João! Seguem as certidões." } as never);
    const enviado = String(llm.mock.calls[0]![0].messages[0].content);
    expect(enviado).toContain("certidões do negócio X");
    expect(enviado).not.toContain("João");
    expect(enviado).not.toContain("Assistente:");
  });

  it("o prompt de extração não pede 'como a pessoa prefere ser chamada'", async () => {
    llm.mockResolvedValue({ text: "{}", usage: { model: "m", promptTokens: 1, latencyMs: 1 } });
    await extractFacts(args);
    expect(String(llm.mock.calls[0]![0].system)).not.toMatch(/prefere ser chamada/i);
  });
});
