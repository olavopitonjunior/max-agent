import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * E1 do plano de evals do Newton: determinísticos, sem modelo. Cobre o que os
 * testes de perfil existentes (sem-nome-fixo, outbox-perfil, routes, prompt-perfil,
 * teto-de-tamanho) NÃO cobrem: o conjunto de tools do perfil, activity.write OFF,
 * a ausência da marca RE/MAX em textos e fontes, o silêncio para desconhecido e o
 * teto de tamanho sob o perfil newton. deal_party (403 e fila) já tem teste em
 * routes.test.ts e outbox-perfil.test.ts.
 *
 * Perfil newton fixado ANTES dos imports dinâmicos, porque `nomeDoAgente()` é
 * lido no import de alguns módulos (descrições de tool).
 */
vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
vi.stubEnv("MAX_EXTENDED_QUERIES", "true");
vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ "org-qa": ["queries"] }));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/db", () => ({ query: vi.fn().mockResolvedValue([]), db: vi.fn() }));
vi.mock("@/lib/orgs", async (orig) => ({
  ...(await orig<typeof import("@/lib/orgs")>()),
  isOrgKnown: vi.fn().mockResolvedValue(true),
  orgById: vi.fn().mockResolvedValue({ orgId: "org-qa", orgName: "Newcore QA", apiToken: "t" }),
}));
vi.mock("@/lib/runtime/privacy", async (orig) => ({ ...(await orig<typeof import("@/lib/runtime/privacy")>()), privacyEpoch: async () => 0 }));
vi.mock("@/lib/aceite", () => ({ interceptar: vi.fn().mockResolvedValue(null), repassarDesconhecido: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  resolveIdentity: vi.fn(),
  avisouPrimeiroAcessoHoje: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/turnlog", async (orig) => ({ ...(await orig<typeof import("@/lib/turnlog")>()), registrarTurn: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));
vi.mock("@/lib/acao", async (orig) => ({ ...(await orig<typeof import("@/lib/acao")>()), executarAcao: vi.fn() }));
vi.mock("@/lib/scope", async (orig) => ({ ...(await orig<typeof import("@/lib/scope")>()), consultarEscopo: vi.fn() }));

const tools = await import("../tools");
const policyMod = await import("../policy");
const prompt = await import("../prompt");
const compose = await import("../compose");
const { buildGraph, runTurn, RESET_DO_TURN } = await import("../graph");
const { MemorySaver } = await import("@langchain/langgraph");
const { complete } = await import("@/lib/llm");
const { fetchProfile } = await import("@/lib/cm");
const { resolveIdentity } = await import("@/lib/identity");
const { executarAcao } = await import("@/lib/acao");

const llm = vi.mocked(complete);
const acao = vi.mocked(executarAcao);
const identidade = vi.mocked(resolveIdentity);

afterAll(() => vi.unstubAllEnvs());

const { CAPABILITIES } = policyMod;
type Cap = (typeof CAPABILITIES)[number];
const SEM_ESCRITA_DE_ATIVIDADE: Cap[] = CAPABILITIES.filter((c) => c !== "activity.write");
const ESCRITAS_DE_ATIVIDADE = ["criar_atividade", "comentar_atividade", "concluir_atividade", "recusar_atividade"];

const usuario = { kind: "user" as const, orgId: "org-qa", orgName: "Newcore QA", userId: "u1", userName: "Olavo" };
const corretorComissionado = { kind: "broker" as const, orgId: "org-qa", orgName: "Newcore QA", splitRecipientId: "sr1", label: "Corretor" };

const FRASES = [
  "como estão meus negócios?",
  "o que está pendente nos meus negócios?",
  "tem proposta do Carlos?",
  "cria uma proposta pro João",
  "tenho notificações novas?",
  "quais são minhas atividades atrasadas?",
  "mostra a atividade 2",
  "quantos negócios eu tenho? resumo da carteira",
  "lista meus imóveis",
  "detalha o imóvel 3",
  "como está o contrato do negócio 1?",
];
const FRASES_DE_ESCRITA_DE_ATIVIDADE = [
  "cria uma atividade de ligação no negócio 1 para amanhã",
  "conclui a atividade 2",
  "comenta na tarefa 3: cliente não atendeu",
  "recusa a atividade 4, estou de férias",
  "marca como concluída a tarefa 1",
];

function ofertadas(texto: string, policy: readonly Cap[], identity: typeof usuario | typeof corretorComissionado = usuario): string[] {
  return tools.ferramentasDoTurno({ policy: [...policy], texto, identity }).entradas.map((e) => e.nome);
}

describe("newton: conjunto de tools", () => {
  const REGISTRADAS = [
    "comentar_atividade", "concluir_atividade", "criar_atividade", "detalhar_imovel", "listar_atividades",
    "listar_imoveis", "listar_negocios", "listar_notificacoes", "listar_propostas", "pendencias_do_negocio",
    "propor_criacao", "recusar_atividade", "resumo_carteira", "situacao_contrato", "ver_atividade",
  ];

  it("o registro do deploy é exatamente o núcleo (sem packs): 15 tools", () => {
    expect(tools.entradasDoDeploy().map((e) => e.nome).sort()).toEqual(REGISTRADAS);
    expect([...tools.NOMES_DE_TOOL].sort()).toEqual(REGISTRADAS);
  });

  it("com tudo ligado menos activity.write, a união do ofertado é o registro menos as 4 escritas de atividade", () => {
    const uniao = new Set(FRASES.flatMap((f) => ofertadas(f, SEM_ESCRITA_DE_ATIVIDADE)));
    expect([...uniao].sort()).toEqual(REGISTRADAS.filter((n) => !ESCRITAS_DE_ATIVIDADE.includes(n)));
  });

  it("controle positivo: com activity.write as 4 escritas passam a ser ofertadas", () => {
    const uniao = new Set(FRASES_DE_ESCRITA_DE_ATIVIDADE.flatMap((f) => ofertadas(f, CAPABILITIES)));
    for (const nome of ESCRITAS_DE_ATIVIDADE) expect(uniao.has(nome)).toBe(true);
  });

  it("activity.write OFF: nenhuma frase, de nenhuma pessoa, oferece escrita de atividade", () => {
    for (const frase of [...FRASES, ...FRASES_DE_ESCRITA_DE_ATIVIDADE]) {
      for (const identity of [usuario, corretorComissionado]) {
        const nomes = ofertadas(frase, SEM_ESCRITA_DE_ATIVIDADE, identity);
        for (const w of ESCRITAS_DE_ATIVIDADE) expect(nomes, `${frase} / ${identity.kind}`).not.toContain(w);
      }
    }
  });

  it("corretor comissionado (sem login) nunca recebe escrita, mesmo com tudo ligado", () => {
    for (const frase of [...FRASES, ...FRASES_DE_ESCRITA_DE_ATIVIDADE]) {
      const nomes = ofertadas(frase, CAPABILITIES, corretorComissionado);
      for (const w of [...ESCRITAS_DE_ATIVIDADE, "propor_criacao"]) expect(nomes, frase).not.toContain(w);
    }
  });

  it("política vazia (perfil fora do ar): nenhuma tool", () => {
    for (const frase of [...FRASES, ...FRASES_DE_ESCRITA_DE_ATIVIDADE]) expect(ofertadas(frase, [])).toEqual([]);
  });
});

describe("newton: activity.write OFF no grafo", () => {
  const SEM = { byRole: { "*": ["deal.list", "activity.list"] }, byRecipient: {}, brokerDefault: ["deal.list"] };
  const uso = { model: "openai/gpt-5.4-nano", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true };
  const referencias = { criadoEm: Date.now(), itens: [{ n: 1, tipo: "atividade", id: "atv_7", rotulo: "Enviar contrato" }] };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: SEM } as never);
  });

  it("o modelo nem vê as tools de escrita e, se a chamar mesmo assim, nada é escrito", async () => {
    llm.mockResolvedValue({ text: "Não consigo concluir atividade por aqui.", toolCalls: [{ name: "concluir_atividade", args: { numero: 1 } }], usage: uso } as never);
    const s = await buildGraph().compile().invoke({
      inbound: { messageId: "m1", fromPhone: "5511987654321", groupId: null, kind: "text", text: "conclui a atividade 1", mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null, buttonPayload: null },
      identity: usuario, reply: null, halt: null, propostaDescartada: false, referencias,
    } as never);
    const oferecidas = (llm.mock.calls[0]?.[0].tools ?? []).map((t) => t.name);
    expect(oferecidas.length).toBeGreaterThan(0);
    for (const w of ESCRITAS_DE_ATIVIDADE) expect(oferecidas).not.toContain(w);
    expect(acao).not.toHaveBeenCalled();
    expect(s.fluxo ?? null).toBeNull();
    expect(String(s.reply ?? "")).not.toMatch(/\bMax\b|RE\/?MAX/i);
  });
});

const MARCA = /\bMax\b|RE\s*\/?\s*MAX|REMAX/i;

describe("newton: nenhuma marca do Max", () => {
  it("o prompt, em todas as variantes de entrada, fala como Newton", () => {
    const hit = { id: "k1", title: "Como funciona o formulário", content: "O cliente preenche em 7 etapas.", similarity: 0.7, lowConfidence: false };
    const base = { orgName: "Newcore", userName: "Olavo" as string | null, hits: [] as (typeof hit)[] };
    const variantes = [
      { ...base },
      { ...base, hits: [hit], summary: "Falamos do AP1011.", facts: "- prefere respostas curtas" },
      { ...base, userName: null, podeEscrever: false },
      { ...base, criacao: "disponivel" as const },
      { ...base, criacao: "sem_login" as const },
      { ...base, criacao: "sem_politica" as const },
      { ...base, fromMedia: "audio" as const, propostaDescartada: true },
      { ...base, credito: true },
      { ...base, toolResults: [{ tool: "listar_negocios", items: [{ codigo: "AP1011" }], truncated: true }] },
      { ...base, toolResults: [{ tool: "listar_negocios", items: null, truncated: false, clarification: { field: "estado" as const, options: ["Documentação", "Assinatura"] } }] },
    ];
    for (const v of variantes) {
      const p = prompt.buildSystemPrompt(v);
      expect(p).not.toMatch(MARCA);
      expect(p).toContain("Você é o Newton");
    }
  });

  it("definições de tool (nome, descrição, parâmetros) não citam a marca", () => {
    for (const e of tools.entradasDoDeploy()) expect(JSON.stringify(e.def), e.nome).not.toMatch(MARCA);
  });

  it("textos fixos exportados pelo grafo e pela borda não citam a marca", async () => {
    const [credito, fluxos, atividades, captacao, capacidades, botao, inbound, suspensa] = await Promise.all([
      import("../credito"), import("../fluxos"), import("../atividades"), import("../captacao"), import("../capacidades"),
      import("@/lib/atividade-botao"), import("@/lib/inbound"), import("@/lib/org-suspensa"),
    ]);
    const mods: Record<string, unknown>[] = [credito, fluxos, atividades, captacao, capacidades, prompt, tools, compose, botao, inbound, suspensa];
    const textos: string[] = [];
    for (const m of mods) {
      for (const [nome, valor] of Object.entries(m)) {
        if (typeof valor === "string" && /^(TEXTO|SUFIXO)/.test(nome)) textos.push(valor);
        if (valor && typeof valor === "object" && /^TEXTO/.test(nome)) {
          for (const f of Object.values(valor as Record<string, unknown>)) {
            if (typeof f !== "function") continue;
            try { textos.push(String((f as (p: unknown) => unknown)({ link: "https://x.test", emBranco: 1, limite: 3 }))); } catch { /* sem amostra */ }
          }
        }
      }
    }
    const args = { tipo: "venda" as const, nomeCliente: "Ana" };
    textos.push(
      tools.textoProposta(args), tools.textoCriado({ url: "https://x.test/f", args }), tools.textoModuloDesligado(args),
      tools.textoSemPermissao(args), tools.textoFalhou(args), tools.textoCriacaoIndisponivel("sem_login", false),
      tools.textoCriacaoIndisponivel("sem_politica", true), tools.textoCriacaoIndisponivel("sem_politica", false),
      prompt.textoSemLeituraDeMidia(null), prompt.textoSemLeituraDeMidia("https://x.test"),
      fluxos.textoSemModelo("venda"), fluxos.textoSemModelo("locacao", "AP1"),
      capacidades.textoForaDoMax("contrato"), capacidades.textoForaDoMax("cobranca", "https://x.test"),
      capacidades.textoDoAndamentoDoContrato(), capacidades.textoDaNegacao("enviar", "não manda"),
      atividades.textoAtividadeNaoLiberada(), credito.textoEnvioIncerto("https://x.test"), credito.textoAindaNaoEncontrei("https://x.test"),
      captacao.textoCaptacaoSemPolitica(),
    );
    for (const c of [false, true]) for (const k of [false, true]) textos.push(capacidades.textoDeCapacidades(CAPABILITIES, true, c, k, k));
    textos.push(capacidades.textoDeCapacidades(SEM_ESCRITA_DE_ATIVIDADE, false));
    for (const op of ["criar", "comentar", "concluir", "recusar"] as const) for (const status of [400, 403, 404, 409, 422, 500]) textos.push(atividades.textoDoErro(op, status, {}));

    expect(textos.length).toBeGreaterThan(60);
    for (const t of textos) expect(t).not.toMatch(MARCA);
  });

  it("fontes: nenhuma linha de código (fora comentário e catálogo de template da Meta) cita RE/MAX", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const raiz = join(__dirname, "..", "..", "..");
    const arquivos = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const c = join(dir, n);
        if (statSync(c).isDirectory()) return n === "__tests__" ? [] : arquivos(c);
        return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [c] : [];
      });
    const PERMITIDOS = ["src/lib/templates/catalog.ts", "src/app/page.tsx"];
    const achados: string[] = [];
    for (const c of arquivos(join(raiz, "src"))) {
      const rel = relative(raiz, c);
      if (PERMITIDOS.includes(rel)) continue;
      readFileSync(c, "utf8").split("\n").forEach((l, i) => {
        const t = l.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        if (/RE\s*\/\s*MAX|REMAX/i.test(l)) achados.push(`${rel}:${i + 1}`);
      });
    }
    expect(achados).toEqual([]);
  });
});

describe("newton: pessoa desconhecida", () => {
  const MSG = { messageId: "newton:d1", fromPhone: "5511900004444", groupId: null, kind: "text" as const, text: "oi", mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Estranho", replyToMessageId: null, buttonPayload: null };

  beforeEach(() => vi.clearAllMocks());

  it("número desconhecido: sem resposta, sem modelo, na primeira mensagem e insistindo", async () => {
    identidade.mockResolvedValue({ kind: "unknown", alreadyGreeted: false } as never);
    const r1 = await runTurn(MSG);
    identidade.mockResolvedValue({ kind: "unknown", alreadyGreeted: true } as never);
    const r2 = await runTurn({ ...MSG, messageId: "newton:d2", text: "alô?" });
    expect(r1.reply).toBeNull();
    expect(r2.reply).toBeNull();
    expect(llm).not.toHaveBeenCalled();
  });
});

describe("newton: teto e continuação", () => {
  const { limitarTamanho, TETO_CARACTERES, TETO_LINHAS, SUFIXO_RESTO } = compose;
  const dentro = (t: string) => t.length <= TETO_CARACTERES && t.split("\n").length <= TETO_LINHAS;
  const uso = { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true };
  const frase = (i: number) => `A etapa ${i} do negócio segue em andamento com a documentação.`;
  const longo = Array.from({ length: 20 }, (_, i) => frase(i)).join(" ");

  async function turno(app: unknown, texto: string, id: string) {
    return (app as { invoke: (s: unknown, c: unknown) => Promise<Record<string, unknown>> }).invoke(
      { ...RESET_DO_TURN, inbound: { fromPhone: "+5511999990000", text: texto, messageId: id }, identity: usuario },
      { configurable: { thread_id: "org-qa:teto-newton" } }
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x" } as never);
  });

  it("valores do teto: 500 caracteres e 6 linhas", () => {
    expect(TETO_CARACTERES).toBe(500);
    expect(TETO_LINHAS).toBe(6);
  });

  it("texto que cabe volta intacto; excesso é cortado sem perder palavra", () => {
    const curto = "Dois negócios parados.\nAP1011 e AP1020.";
    expect(limitarTamanho(curto)).toEqual({ texto: curto, resto: null });
    const r = limitarTamanho(longo);
    expect(dentro(r.texto)).toBe(true);
    expect(`${r.texto.replace(`\n${SUFIXO_RESTO}`, "")} ${r.resto}`).toBe(longo);
  });

  it("no grafo: resposta longa sai cortada, 'sim' manda o resto SEM modelo, outra mensagem descarta o resto", async () => {
    const app = buildGraph().compile({ checkpointer: new MemorySaver() });
    llm.mockResolvedValue({ text: longo, toolCalls: [], usage: uso } as never);
    const t1 = await turno(app, "me explica o andamento de tudo", "n1");
    expect(dentro(t1.reply as string)).toBe(true);
    expect(t1.restoDaResposta).not.toBeNull();

    llm.mockClear();
    const t2 = await turno(app, "sim", "n2");
    expect(llm).not.toHaveBeenCalled();
    expect(dentro(t2.reply as string)).toBe(true);

    llm.mockResolvedValue({ text: longo, toolCalls: [], usage: uso } as never);
    await turno(app, "me explica o andamento de tudo outra vez", "n3");
    llm.mockResolvedValue({ text: "Bom dia.", toolCalls: [], usage: uso } as never);
    const t4 = await turno(app, "bom dia", "n4");
    expect(t4.restoDaResposta).toBeNull();
    llm.mockResolvedValue({ text: "Sim o quê?", toolCalls: [], usage: uso } as never);
    expect((await turno(app, "sim", "n5")).reply).toBe("Sim o quê?");
  });
});
