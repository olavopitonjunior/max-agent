import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * D3 (review) — fronteira do LLM dentro do grafo: cobertura que faltava.
 *
 *  (a) `depsDoFluxo.extrair` já tem teste em `consulta-e-edicao.test.ts`
 *      ("M1 (PII) — texto pro modelo vem tokenizado...").
 *  (b) `answer`: histórico + texto do turno chegam tokenizados ao `complete`;
 *      o que volta (texto livre OU `toolCalls.args`) sai destokenizado.
 *  (c) `compact`/`extractFacts`: `complete` é chamado SEM o telefone cru, e
 *      o que volta (resumo, fato) só carrega o token FIXO (`⟨TEL⟩`) — nunca
 *      o valor, nunca o token NUMERADO de um mapa que não sobrevive ao turno.
 */

vi.mock("@/lib/cm", () => ({
  fetchProfile: vi.fn().mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: null }),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  transcribeMedia: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({
  DEFAULT_MODEL: "openai/gpt-5.4-nano",
  complete: vi.fn(),
}));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  resolveIdentity: vi.fn(),
  saveChoice: vi.fn().mockResolvedValue(undefined),
}));

const { buildGraph, runTurn } = await import("../graph");
const { complete } = await import("@/lib/llm");
const { resolveIdentity } = await import("@/lib/identity");

const llm = complete as unknown as ReturnType<typeof vi.fn>;
const identidade = resolveIdentity as unknown as ReturnType<typeof vi.fn>;

const CPF = "111.444.777-35"; // DV válido
const uso = { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("answer — tokeniza antes do modelo, destokeniza o que volta", () => {
  const gerente = { orgId: "org1", orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "M" };

  it("texto livre: o modelo nunca vê o CPF cru, e a resposta final tem o CPF REAL", async () => {
    llm.mockImplementation(async (params: { messages: Array<{ content: string }> }) => {
      const enviado = JSON.stringify(params.messages);
      expect(enviado).not.toContain("11144477735");
      expect(enviado).toContain("⟨CPF_1⟩");
      return { text: "Seu CPF ⟨CPF_1⟩ está certo, sim.", toolCalls: [], usage: uso };
    });

    const r = await buildGraph().compile().invoke({
      inbound: { fromPhone: "+5511999990000", text: `meu cpf é ${CPF}, tá certo?`, messageId: "m1" },
      identity: gerente,
    } as never);

    expect(r.reply).toContain(CPF);
    expect(r.reply).not.toContain("⟨CPF");
  });

  it("histórico com CPF também chega tokenizado — não só a mensagem do turno", async () => {
    llm.mockImplementation(async (params: { messages: Array<{ content: string }> }) => {
      const enviado = JSON.stringify(params.messages);
      expect(enviado).not.toContain("11144477735");
      return { text: "Ok.", toolCalls: [], usage: uso };
    });

    await buildGraph().compile().invoke({
      inbound: { fromPhone: "+5511999990000", text: "e agora?", messageId: "m2" },
      identity: gerente,
      messages: [{ role: "user", content: `meu cpf é ${CPF}` }, { role: "assistant", content: "ok, anotado" }],
    } as never);

    expect(llm).toHaveBeenCalled();
  });

  /**
   * C1 (review) — faltava cobrir o OUTRO destino de `toolCalls.args`: tool
   * de LEITURA (`pendingToolCalls`/`toolLog`), não só a de escrita. Telefone
   * E CPF juntos, pra pegar os dois tokens numa chamada só. Troque
   * `destokenizarArgs(c.args, mapaTurno)` por `c.args` em `graph.ts` (nó
   * `answer`) e este teste quebra — verificado manualmente (ver relato).
   */
  it("tool de LEITURA: args com token (telefone e CPF) voltam com os valores reais em pendingToolCalls", async () => {
    const TEL = "11 98888-7777";
    llm.mockImplementation(async (params: { messages: Array<{ content: string }> }) => {
      const enviado = JSON.stringify(params.messages);
      expect(enviado).not.toContain("988887777");
      expect(enviado).not.toContain("11144477735");
      return {
        text: "",
        toolCalls: [
          { name: "listar_propostas", args: { nome_buscado: "⟨TEL_1⟩", observacao: "⟨CPF_1⟩" } },
        ],
        usage: uso,
      };
    });

    const r = await buildGraph().compile().invoke({
      inbound: {
        fromPhone: "+5511999990000",
        text: `quais minhas propostas? meu telefone é ${TEL} e meu cpf é ${CPF}`,
        messageId: "m3",
      },
      identity: gerente,
    } as never);

    expect(r.pendingToolCalls).toHaveLength(1);
    expect(r.pendingToolCalls[0].args).toEqual({ nome_buscado: TEL, observacao: CPF });
  });
});

describe("compact — resumo sai redigido (token fixo), nunca destokenizado", () => {
  const gerente = { orgId: "org1", orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "M" };
  const TEL = "11 97000-1234";

  it("o transcrito mandado pro resumo não leva o telefone cru; o resumo fica com ⟨TEL⟩", async () => {
    // 16+ mensagens (COMPACT_AT) pra disparar o nó `compact`; o telefone
    // mora numa das antigas (as que o `compact` de fato lê).
    const historico = Array.from({ length: 16 }, (_, i) =>
      i === 2
        ? { role: "user" as const, content: `me chama no ${TEL} se precisar` }
        : { role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant", content: `msg ${i}` }
    );

    llm.mockImplementation(async (params: { system: string; messages: Array<{ content: string }> }) => {
      const enviado = JSON.stringify(params.messages);
      expect(enviado).not.toContain("11970001234");
      if (params.system.startsWith("Resuma a conversa")) {
        expect(enviado).not.toMatch(/⟨TEL_\d+⟩/); // nunca numerado
        expect(enviado).toContain("⟨TEL⟩"); // fixo, sim
        // O modelo pode até ecoar o fixo no resumo — fica como está, sem mapa.
        return { text: "Cliente pediu contato; telefone citado: ⟨TEL⟩.", toolCalls: [], usage: uso };
      }
      return { text: "Ok!", toolCalls: [], usage: uso };
    });

    const r = await buildGraph().compile().invoke({
      inbound: { fromPhone: "+5511999990000", text: "e mais uma coisa", messageId: "mN" },
      identity: gerente,
      messages: historico,
    } as never);

    expect(r.summary).toBe("Cliente pediu contato; telefone citado: ⟨TEL⟩.");
    expect(r.summary).not.toContain(TEL.replace(/\s/g, ""));
  });
});

describe("compact/extractFacts — redigir (token fixo), nunca tokenizar (token numerado)", () => {
  const CANDIDATO = { orgId: "org-pii-llm", orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "Marcia" };
  const hasDb = Boolean(process.env.DATABASE_URL);
  const itDb = hasDb ? it : it.skip;
  const TEL_PESSOAL = "11 97000-1234"; // telefone pessoal citado na mensagem

  function msg(text: string, over: Record<string, unknown> = {}) {
    return {
      messageId: `m-${Math.random().toString(36).slice(2)}`,
      fromPhone: "5511900000321",
      groupId: null,
      kind: "text" as const,
      text,
      mediaUrl: null,
      mimeType: null,
      timestampMs: null,
      senderName: "Marcia",
      replyToMessageId: null,
      ...over,
    } as Parameters<typeof runTurn>[0];
  }

  beforeEach(() => {
    identidade.mockResolvedValue({ kind: "identified", candidate: CANDIDATO });
  });

  /**
   * `extractFacts` roda em `afterReply`, fora do `invoke` do grafo — por
   * isso `runTurn` de verdade (não `buildGraph().compile().invoke`), com
   * banco real para `memory_facts`/`conversation_turn`/checkpointer.
   *
   * Telefone, não CPF: o token fixo `⟨CPF⟩` contém a palavra "CPF", que a
   * cerca MAIS ANTIGA de `limpar` (a lista `suspeito`) já pega por acidente
   * — o que mascararia a ausência da cerca NOVA (`⟨` solto) neste teste.
   * `⟨TEL⟩` não tem esse problema: "TEL" não está em `suspeito`, e o valor
   * não tem dígito (`/\\d[\\d.\\-/\\s]{8,}/` também não pega). Só a cerca
   * nova (achado em review, `memory.ts`) descarta este caso.
   */
  itDb(
    "extractFacts: complete() não recebe o telefone cru nem token NUMERADO; fato com ⟨ nunca é gravado",
    async () => {
      llm.mockImplementation(async (params: { system: string; messages: Array<{ content: string }> }) => {
        const enviado = JSON.stringify(params.messages);
        expect(enviado).not.toContain("11970001234");

        // Distingue as duas chamadas pelo SYSTEM prompt — só a de extração
        // (`EXTRACT_SYSTEM`, memory.ts) importa aqui: ela usa `redigir`
        // (fixo); a do `answer` usa `tokenizar` (numerado) e tem teste
        // próprio acima — não é esta que teria que ficar sem `⟨TEL_1⟩`.
        if (params.system.includes("FATOS DURÁVEIS")) {
          expect(enviado).not.toMatch(/⟨TEL_\d+⟩/); // nunca numerado aqui
          expect(enviado).toContain("⟨TEL⟩"); // fixo, sim
          // Simula o modelo desobedecendo o prompt e devolvendo o PRÓPRIO
          // token como "fato" — é a cerca de `limpar` que tem de pegar isso.
          return { text: '{"telefone_pessoal":"⟨TEL⟩"}', toolCalls: [], usage: uso };
        }
        return { text: "Pode sim, Marcia!", toolCalls: [], usage: uso };
      });

      const { reply, afterReply } = await runTurn(
        msg(`meu telefone pessoal é ${TEL_PESSOAL}, pode seguir?`)
      );
      expect(reply).toBe("Pode sim, Marcia!");
      await afterReply();

      const { query, db } = await import("@/lib/db");
      const linhas = await query<{ key: string; value: string }>(
        `SELECT key, value FROM memory_facts WHERE org_id = $1 AND phone = $2`,
        [CANDIDATO.orgId, "5511900000321"]
      );
      // `limpar` (memory.ts) descarta o fato com `⟨` — não existe linha "telefone_pessoal".
      expect(linhas.find((l) => l.key === "telefone_pessoal")).toBeUndefined();

      await query(`DELETE FROM memory_facts WHERE org_id = $1`, [CANDIDATO.orgId]);
      await query(`DELETE FROM conversation_turn WHERE org_id = $1`, [CANDIDATO.orgId]);
      await db().end();
    },
    30_000
  );
});
