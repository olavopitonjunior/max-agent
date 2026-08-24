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
  role: "admin",
};

/** Mesmo usuário, papel que a política não conhece. */
const semPapelConhecido = { ...gerente, role: "viewer" };
/** Candidato gravado ANTES desta entrega: `phone_org_choice` sem `role`. */
const candidatoAntigo = { ...gerente, role: null };

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
      expect(resolverPolitica({ politica, sujeito: gerente })).toEqual([]);
      expect(resolverPolitica({ politica, sujeito: corretorSemLogin })).toEqual([]);
    }
  });

  it("política VAZIA não concede nada", () => {
    expect(resolverPolitica({ politica: {}, sujeito: gerente })).toEqual([]);
  });

  it("papel sem entrada em byRole não concede nada", () => {
    const politica = { byRole: { owner: ["deal.list"] } };
    expect(resolverPolitica({ politica, sujeito: semPapelConhecido })).toEqual([]);
  });

  /**
   * Papel desconhecido cai em nenhuma, e não num default. Adivinhar aqui seria
   * a política ALARGANDO — a única coisa que ela nunca pode fazer.
   */
  it("papel DESCONHECIDO não cai num default", () => {
    const politica = { byRole: { admin: ["deal.list"] } };
    for (const role of ["", "   ", "papel_que_nao_existe"]) {
      expect(resolverPolitica({ politica, sujeito: { ...gerente, role } })).toEqual([]);
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
    expect(resolverPolitica({ politica, sujeito: candidatoAntigo })).toEqual([]);
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
      resolverPolitica({ politica: politica as never, sujeito: gerente })
    ).not.toThrow();
  });

  /** Chave de protótipo não vira concessão acidental. */
  it("byRole['constructor'] não concede nada", () => {
    const politica = JSON.parse('{"byRole":{}}');
    expect(
      resolverPolitica({ politica, sujeito: { ...gerente, role: "constructor" } })
    ).toEqual([]);
  });

  it("corretor sem brokerDefault e sem override não recebe nada", () => {
    const politica = { byRole: { admin: ["deal.list"] } };
    expect(resolverPolitica({ politica, sujeito: corretorSemLogin })).toEqual([]);
  });

  /** `deny` vence `allow` — sempre, e sem exceção configurável. */
  it("deny vence allow, e vence o brokerDefault", () => {
    const politica = {
      brokerDefault: ["deal.list", "deal.pending"],
      byRecipient: { sr1: { allow: ["deal.detail"], deny: ["deal.list", "deal.detail"] } },
    };
    expect(resolverPolitica({ politica, sujeito: corretorSemLogin })).toEqual([
      "deal.pending",
    ]);
  });

  /**
   * Capability fora do catálogo é IGNORADA, nunca erro: um rollback para uma
   * versão com catálogo menor tem que conceder menos, não ficar indisponível.
   */
  it("capability desconhecida é ignorada, não quebra", () => {
    const politica = { byRole: { admin: ["deal.list", "deal.teleporte", ""] } };
    expect(resolverPolitica({ politica, sujeito: gerente })).toEqual([
      "deal.list",
    ]);
  });

  it("override com capability desconhecida também é ignorado", () => {
    const politica = {
      brokerDefault: ["deal.list"],
      byRecipient: { sr1: { allow: ["nao.existe"], deny: ["tambem.nao"] } },
    };
    expect(resolverPolitica({ politica, sujeito: corretorSemLogin })).toEqual([
      "deal.list",
    ]);
  });

  it("override de OUTRO corretor não alcança este", () => {
    const politica = {
      brokerDefault: ["deal.list"],
      byRecipient: { sr999: { deny: ["deal.list"] } },
    };
    expect(resolverPolitica({ politica, sujeito: corretorSemLogin })).toEqual([
      "deal.list",
    ]);
  });
});

// ─── 2. PERMITIDO ───────────────────────────────────────────────────────────

describe("o que a política concede", () => {
  it("papel com entrada em byRole recebe exatamente aquilo", () => {
    const politica = { byRole: { admin: ["deal.list", "deal.pending"] } };
    const r = resolverPolitica({ politica, sujeito: gerente });

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
      resolverPolitica({ politica, sujeito: corretorSemLogin }).sort()
    ).toEqual(["deal.list", "deal.pending"]);
  });

  it("o catálogo é o teto — byRole não inventa capability", () => {
    const politica = { byRole: { admin: [...CAPABILITIES, "extra.poder"] } };
    const r = resolverPolitica({ politica, sujeito: gerente });

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
   * Por isso `state.policy` é resolvido e NÃO é consumido neste PR. O consumo
   * entra no PR 6, junto das tools que a política de fato governa. Este teste é
   * o que faz essa decisão sobreviver a quem vier depois achando que "está
   * faltando ligar".
   */
  it("política ausente NÃO tira propor_criacao do prompt", async () => {
    profile.mockResolvedValue({ enabled: true, model: "x" });

    const r = await run("me manda o link do formulário pro João");

    expect(r.policy).toEqual([]);
    const tools = llm.mock.calls[0][0].tools;
    expect(tools?.map((t: { name: string }) => t.name)).toContain(TOOL_PROPOR_FORM);
  });

  /** E o mesmo vale com política presente porém sem `form.create`. */
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
