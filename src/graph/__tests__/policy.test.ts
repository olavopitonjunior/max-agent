import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Política de capabilities — PR 4 do copiloto.
 *
 * A ordem dos blocos abaixo não é estética: a **regra 3** da governança do Max
 * (`contractmaker/CLAUDE.md`) manda que capability nova nasça desligada, com o
 * caso NEGADO escrito antes do permitido. Então o negado vem primeiro, e o
 * permitido depois — se algum dia alguém inverter o default, é o primeiro bloco
 * que cai.
 */

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  // A chave de política vem do servidor por turn. Sem este mock os testes do
  // gate tocam o banco (`orgById`) e falham com "DATABASE_URL não configurada".
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
}));
vi.mock("@/lib/llm", () => ({
  complete: vi.fn(),
  DEFAULT_MODEL: "openai/gpt-5.4-nano",
}));

const { resolverPolitica, permite, CAPABILITIES } = await import("../policy");
const { buildGraph } = await import("../graph");
const { TOOL_PROPOR_FORM } = await import("../tools");
const { fetchProfile } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");

const profile = fetchProfile as unknown as ReturnType<typeof vi.fn>;
const llm = complete as unknown as ReturnType<typeof vi.fn>;

/**
 * `role` usa o vocabulário REAL do `OrgMembership.role` do ImobPro —
 * `owner | admin | finance | sales | viewer | custom | member`. A primeira
 * versão destes testes usava `"manager"`, que **não existe** naquele enum: um
 * fixture assim passa no teste e mente sobre o contrato, e o vetor de paridade
 * o teria congelado como se fosse chave válida.
 */
const gerente = {
  orgId: "org1",
  orgName: "RE/MAX Trio",
  kind: "user" as const,
  userId: "u1",
  userName: "Marcia Gerente",
};

/**
 * O papel NÃO mora mais no candidato — é a chave que o servidor resolve por
 * turn (`GET /api/agents/user-scope`). Guardá-lo no candidato o congelava,
 * porque a `phone_org_choice` não tem TTL.
 */
const PAPEL = "admin";
/** Papel que a política não conhece. */
const PAPEL_DESCONHECIDO = "viewer";

const corretorSemLogin = {
  orgId: "org1",
  orgName: "RE/MAX Trio",
  kind: "broker" as const,
  splitRecipientId: "sr1",
  label: "Wesley Cappozzi",
};

// ─── 1. NEGADO — regra 3 ────────────────────────────────────────────────────

describe("fail-closed: o que a política NÃO concede", () => {
  /**
   * O caso que a regra 3 exige antes de qualquer outro. Ausência de política é
   * o estado de dois momentos distintos que querem a mesma resposta: o tenant
   * que nunca configurou nada, e a janela entre o deploy deste repo e o do
   * ImobPro (regra 2).
   */
  it("política AUSENTE não concede nada", () => {
    for (const politica of [null, undefined]) {
      expect(resolverPolitica({ politica, sujeito: gerente, role: PAPEL })).toEqual([]);
      expect(resolverPolitica({ politica, sujeito: corretorSemLogin, role: null })).toEqual([]);
    }
  });

  /**
   * **Buscar a chave por turn troca "papel congelado" por "papel
   * indisponível", e a degradação tem que cair no MENOR privilégio.**
   *
   * Guardar o último valor conhecido para usar quando a rota cai
   * reintroduziria exatamente o congelamento que esta entrega remove — e com
   * pior sincronismo, porque ninguém saberia de quando é. Rota fora do ar
   * resolve para NENHUMA capability, igual a papel desconhecido.
   */
  it("chave INDISPONÍVEL (null) não concede nada, mesmo com política rica", () => {
    const politica = {
      byRole: { admin: ["deal.list", "deal.detail"], sales: ["deal.list"] },
    };
    expect(resolverPolitica({ politica, sujeito: gerente, role: null })).toEqual([]);
  });

  /**
   * A chave de papel customizado é `custom:<id>`, e ela NÃO pode ser alcançada
   * por uma configuração feita para o literal `custom` — são pessoas
   * diferentes. Se colidissem, um tenant que configurou `byRole.custom` para o
   * usuário de serviço do próprio Max alargaria o teto de todo papel
   * customizado humano da casa.
   */
  it("custom:<id> não é alcançado por uma entrada em byRole.custom", () => {
    const politica = { byRole: { custom: ["deal.list", "deal.detail"] } };
    expect(
      resolverPolitica({ politica, sujeito: gerente, role: "custom:cr-estagiario" })
    ).toEqual([]);
  });

  /** E a chave certa alcança, para o teste acima não passar por vacuidade. */
  it("custom:<id> é alcançado pela entrada correspondente", () => {
    const politica = { byRole: { "custom:cr-estagiario": ["deal.list"] } };
    expect(
      resolverPolitica({ politica, sujeito: gerente, role: "custom:cr-estagiario" })
    ).toEqual(["deal.list"]);
  });

  /** Dois papéis customizados da mesma org NÃO compartilham teto. */
  it("custom:<a> não alcança o que foi concedido a custom:<b>", () => {
    const politica = {
      byRole: { "custom:cr-diretor": ["deal.list", "deal.detail"] },
    };
    expect(
      resolverPolitica({ politica, sujeito: gerente, role: "custom:cr-estagiario" })
    ).toEqual([]);
  });

  /**
   * **Candidato ANTIGO, gravado com `role`, não tem o papel dele respeitado.**
   *
   * A `phone_org_choice` não tem TTL: as linhas escritas antes desta entrega
   * carregam `role` no JSONB e continuam sendo devolvidas. Elas desserializam
   * sem erro — propriedade extra é ignorada —, e o ponto deste teste é que o
   * valor congelado ali é **inerte**: quem decide é a chave que o servidor
   * mandou, não o que estava guardado.
   *
   * Sem isto, um refactor que voltasse a ler `sujeito.role` como fallback
   * passaria despercebido, e o congelamento voltaria em silêncio.
   */
  it("role congelado num candidato antigo é IGNORADO — vale a chave do servidor", () => {
    const politica = {
      byRole: { admin: ["deal.list", "deal.detail"], viewer: [] as string[] },
    };
    // O JSONB gravado lá atrás dizia "admin". O servidor NÃO resolve hoje.
    const candidatoAntigo = { ...gerente, role: "admin" } as typeof gerente;

    // ⚠️ `role: null` é o caso que importa, e a primeira versão deste teste
    // passava `"viewer"` — um valor não-nulo. Com ele, um fallback
    // `params.role ?? sujeito.role` nunca chegaria a ler o papel congelado, e
    // a mutação de controle passava verde. O teste só sabe falhar quando o
    // servidor NÃO dá chave: é aí que o valor guardado poderia "socorrer".
    expect(
      resolverPolitica({ politica, sujeito: candidatoAntigo, role: null })
    ).toEqual([]);
  });

  it("política VAZIA não concede nada", () => {
    expect(resolverPolitica({ politica: {}, sujeito: gerente, role: PAPEL })).toEqual([]);
  });

  it("papel sem entrada em byRole não concede nada", () => {
    const politica = { byRole: { owner: ["deal.list"] } };
    expect(resolverPolitica({ politica, sujeito: gerente, role: PAPEL_DESCONHECIDO })).toEqual([]);
  });

  /**
   * Papel desconhecido cai em nenhuma, e não num default. Adivinhar aqui seria
   * a política ALARGANDO — a única coisa que ela nunca pode fazer.
   */
  it("papel DESCONHECIDO não cai num default", () => {
    const politica = { byRole: { admin: ["deal.list"] } };
    for (const role of ["", "   ", "papel_que_nao_existe"]) {
      expect(resolverPolitica({ politica, sujeito: gerente, role })).toEqual([]);
    }
  });

  /**
   * O candidato gravado na `phone_org_choice` ANTES desta entrega não tem
   * `role`. Aquela tabela não tem TTL e nunca revarre, então esse estado é
   * permanente para quem já desambiguou — e resolve para nada, que é o lado
   * seguro. Ver a dívida nomeada em `policy.ts` e na §6.3 da spec.
   */
  it("candidato SEM role (gravado antes desta entrega) não concede nada", () => {
    const politica = { byRole: { admin: ["deal.list"] } };
    expect(resolverPolitica({ politica, sujeito: gerente, role: null })).toEqual([]);
  });

  /**
   * Forma inválida vinda da rede não pode LANÇAR dentro do `gate`, que não tem
   * catch — o turn morreria. `maxPolicy` chega de um cast não validado em
   * `cm.ts`, então o guard tem que estar aqui.
   */
  it.each([
    ["string onde devia ser lista", { byRole: { admin: "deal.list" } }],
    ["número", { byRole: { admin: 7 } }],
    ["byRole não-objeto", { byRole: "nada disso" }],
    ["byRecipient não-objeto", { brokerDefault: ["deal.list"], byRecipient: 5 }],
  ])("forma inválida (%s) não lança — resolve vazio ou ignora", (_n, politica) => {
    expect(() =>
      resolverPolitica({ politica: politica as never, sujeito: gerente, role: PAPEL })
    ).not.toThrow();
  });

  /** Chave de protótipo não vira concessão acidental. */
  it("byRole['constructor'] não concede nada", () => {
    const politica = JSON.parse('{"byRole":{}}');
    expect(
      resolverPolitica({ politica, sujeito: gerente, role: "constructor" })
    ).toEqual([]);
  });

  it("corretor sem brokerDefault e sem override não recebe nada", () => {
    const politica = { byRole: { admin: ["deal.list"] } };
    expect(resolverPolitica({ politica, sujeito: corretorSemLogin, role: null })).toEqual([]);
  });

  /** `deny` vence `allow` — sempre, e sem exceção configurável. */
  it("deny vence allow, e vence o brokerDefault", () => {
    const politica = {
      brokerDefault: ["deal.list", "deal.pending"],
      byRecipient: { sr1: { allow: ["deal.detail"], deny: ["deal.list", "deal.detail"] } },
    };
    expect(resolverPolitica({ politica, sujeito: corretorSemLogin, role: null })).toEqual([
      "deal.pending",
    ]);
  });

  /**
   * Capability fora do catálogo é IGNORADA, nunca erro: um rollback para uma
   * versão com catálogo menor tem que conceder menos, não ficar indisponível.
   */
  it("capability desconhecida é ignorada, não quebra", () => {
    const politica = { byRole: { admin: ["deal.list", "deal.teleporte", ""] } };
    expect(resolverPolitica({ politica, sujeito: gerente, role: PAPEL })).toEqual([
      "deal.list",
    ]);
  });

  it("override com capability desconhecida também é ignorado", () => {
    const politica = {
      brokerDefault: ["deal.list"],
      byRecipient: { sr1: { allow: ["nao.existe"], deny: ["tambem.nao"] } },
    };
    expect(resolverPolitica({ politica, sujeito: corretorSemLogin, role: null })).toEqual([
      "deal.list",
    ]);
  });

  it("override de OUTRO corretor não alcança este", () => {
    const politica = {
      brokerDefault: ["deal.list"],
      byRecipient: { sr999: { deny: ["deal.list"] } },
    };
    expect(resolverPolitica({ politica, sujeito: corretorSemLogin, role: null })).toEqual([
      "deal.list",
    ]);
  });
});

// ─── 2. PERMITIDO ───────────────────────────────────────────────────────────

describe("o que a política concede", () => {
  it("papel com entrada em byRole recebe exatamente aquilo", () => {
    const politica = { byRole: { admin: ["deal.list", "deal.pending"] } };
    const r = resolverPolitica({ politica, sujeito: gerente, role: PAPEL });

    expect(r).toEqual(["deal.list", "deal.pending"]);
    expect(permite(r, "deal.list")).toBe(true);
    expect(permite(r, "proposal.create")).toBe(false);
  });

  it("corretor recebe o brokerDefault, com allow somando", () => {
    const politica = {
      brokerDefault: ["deal.pending"],
      byRecipient: { sr1: { allow: ["deal.list"] } },
    };
    expect(
      resolverPolitica({ politica, sujeito: corretorSemLogin, role: null }).sort()
    ).toEqual(["deal.list", "deal.pending"]);
  });

  it("o catálogo é o teto — byRole não inventa capability", () => {
    const politica = { byRole: { admin: [...CAPABILITIES, "extra.poder"] } };
    const r = resolverPolitica({ politica, sujeito: gerente, role: PAPEL });

    expect(r).toHaveLength(CAPABILITIES.length);
    expect(r).not.toContain("extra.poder");
  });
});

// ─── 3. A janela de deploy ──────────────────────────────────────────────────

describe("resolução no gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llm.mockResolvedValue({
      text: "resposta",
      toolCalls: [],
      usage: { model: "m", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true },
    });
  });

  function inbound(text: string) {
    return {
      messageId: "m1",
      fromPhone: "5511987654321",
      groupId: null,
      kind: "text" as const,
      text,
      mediaUrl: null,
      mimeType: null,
      timestampMs: null,
      senderName: "Marcia",
      replyToMessageId: null,
    };
  }

  async function run(text: string, identity: typeof gerente | typeof corretorSemLogin = gerente) {
    const app = buildGraph().compile();
    return app.invoke({
      inbound: inbound(text),
      identity,
      reply: null,
      halt: null,
      draft: null,
      bloqueios: [],
      policy: [],
    });
  }

  it("o gate resolve e guarda a política no estado", async () => {
    profile.mockResolvedValue({
      enabled: true,
      model: "x",
      maxPolicy: { byRole: { admin: ["deal.list"] } },
    });

    const r = await run("como funciona o formulário?");

    expect(r.policy).toEqual(["deal.list"]);
  });

  it("perfil sem maxPolicy resolve para nenhuma capability", async () => {
    profile.mockResolvedValue({ enabled: true, model: "x" });

    const r = await run("como funciona o formulário?");

    expect(r.policy).toEqual([]);
  });

  it("perfil INDISPONÍVEL não derruba o turn e resolve fail-closed", async () => {
    profile.mockRejectedValue(new Error("502"));

    const r = await run("como funciona o formulário?");

    expect(r.policy).toEqual([]);
    expect(r.reply).toBe("resposta");
  });

  /**
   * **A garantia anti-regressão da janela de deploy — o teste mais importante
   * deste PR.**
   *
   * Este repo entra antes do ImobPro (regra 2), então em produção a política
   * chega AUSENTE por um tempo, e ausente é fail-closed. `propor_criacao` é a
   * única capability que o Max exerce hoje: se a oferta de tool passasse a
   * consultar a política agora, o Max **pararia de propor criação de
   * formulário** nessa janela — em silêncio, sem erro, sem teste vermelho, e só
   * descoberto por conversa real.
   *
   * ── ATUALIZADO NO PR 6a: a alegação ESTREITOU, não afrouxou ────────────
   *
   * Antes: "`state.policy` é resolvido e NÃO é consumido". Isso deixou de ser
   * verdade — o 6a consome a política para as tools de LEITURA, que nascem
   * gateadas (regra 3).
   *
   * O que continua verdadeiro, e é o que este teste trava: **`propor_criacao`
   * NÃO passa pela política.** Ela é oferecida por `podeEscrever &&
   * shouldOfferTools`, como sempre foi. Gateá-la exigiria `form.create`, que
   * nenhuma org concede — não existe editor nem rota de escrita da política —,
   * e o Max pararia de propor formulário em produção, em silêncio.
   *
   * O gate dela é do **PR 6c**, junto do editor que torna `form.create`
   * concedível. Só lá estes dois testes mudam. Quem chegar antes disso achando
   * que "está faltando ligar" vai encontrar este parágrafo.
   */
  it("política ausente NÃO tira propor_criacao do prompt", async () => {
    profile.mockResolvedValue({ enabled: true, model: "x" });

    const r = await run("me manda o link do formulário pro João");

    expect(r.policy).toEqual([]);
    const tools = llm.mock.calls[0][0].tools;
    expect(tools?.map((t: { name: string }) => t.name)).toContain(TOOL_PROPOR_FORM);
  });

  /**
   * E o mesmo vale com política presente porém sem `form.create`.
   *
   * O `(ainda)` do nome tem vencimento: **PR 6c**, quando o editor tornar
   * `form.create` concedível. Sem este ponteiro o "ainda" vira permanente — é a
   * mesma classe de dívida que a §6.3 da spec teve o cuidado de nomear.
   */
  it("política que NÃO concede form.create também não tira a tool (ainda)", async () => {
    profile.mockResolvedValue({
      enabled: true,
      model: "x",
      maxPolicy: { byRole: { admin: ["deal.list"] } },
    });

    const r = await run("me manda o link do formulário pro João");

    expect(permite(r.policy, "form.create")).toBe(false);
    const tools = llm.mock.calls[0][0].tools;
    expect(tools?.map((t: { name: string }) => t.name)).toContain(TOOL_PROPOR_FORM);
  });
});
