import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VETOR_CERTIDAO_STATUS_USER } from "./certidao-status-vectors";

/**
 * PR-O4b-MA — `situacao_certidoes` (par do contractmaker PR-O4b-CM, `docs/max.md` §19.4).
 *
 * Negado antes do permitido (regra 3): cada trava tem o seu caso de recusa isolado, e a
 * leitura só existe para quem a política concede E é usuário da plataforma. O corretor
 * comissionado nunca recebe o verbo (o servidor responde `{items:[]}` mesmo se a política
 * o concedesse), então a tool nem é oferecida a ele.
 *
 * O parse é ESTRITO (R54): campo desconhecido ou forma errada em QUALQUER nível derruba a
 * resposta inteira (`falha_na_consulta`). Nunca se repassa item que o contrato não descreve.
 */

vi.mock("@/lib/scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/scope")>()),
  consultarEscopo: vi.fn(),
}));
vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));

const { despacharLeituras, autorizarChamada } = await import("../despachante");
const { ferramentasDoTurno, REGISTRO_DE_TOOLS } = await import("../tools");
const { lerCertidaoStatus } = await import("../certidao-status");
const { VERBOS_DE_LEITURA } = await import("../scope-contract");
const { consultarEscopo } = await import("@/lib/scope");
const escopo = vi.mocked(consultarEscopo);

const gerente = { orgId: "org1", orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "Marcia" };
const corretor = { orgId: "org1", orgName: "RE/MAX Trio", kind: "broker" as const, splitRecipientId: "sr1", label: "Rui" };

const mapa = (tipo: "proposta" | "negocio") => ({
  criadoEm: 1_000,
  turno: "t0",
  itens: [
    { n: 1, tipo, id: `${tipo}-id-1`, rotulo: "Um" },
    { n: 2, tipo, id: `${tipo}-id-2`, rotulo: "Dois" },
  ],
});

const base = { fromPhone: "+5511999990000", identity: gerente, turno: "t1", agora: 2_000 };
const neg = { ...base, oferecidas: ["situacao_certidoes"], policy: ["certidao.status"] as never, referencias: mapa("negocio") };

const vetor = JSON.parse(VETOR_CERTIDAO_STATUS_USER) as { items: Array<Record<string, unknown>>; truncated: boolean };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** O texto que o modelo recebe (o `resumo` único do resultado). */
function resumoDe(r: Awaited<ReturnType<typeof despacharLeituras>>): string {
  const item = r.resultados[0].items?.[0] as { resumo?: string } | undefined;
  return item?.resumo ?? "";
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

function ligar(): void {
  vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ org1: ["queries"] }));
  vi.stubEnv("MAX_EXTENDED_QUERIES", "true");
}

describe("situacao_certidoes — a oferta (negado primeiro)", () => {
  const TEXTO = "como estão as certidões do negócio 2?";
  const oferta = (identity: typeof gerente | typeof corretor, policy: string[], texto = TEXTO): string[] =>
    ferramentasDoTurno({ policy: policy as never, texto, identity }).entradas.map((e) => e.nome);

  it("NEGADO: sem a capability certidao.status a tool não é oferecida", () => {
    ligar();
    expect(oferta(gerente, [])).not.toContain("situacao_certidoes");
    expect(oferta(gerente, ["deal.list", "deal.detail", "contract.status"])).not.toContain("situacao_certidoes");
  });

  it("NEGADO: o corretor comissionado não recebe a tool, mesmo com a capability na política", () => {
    ligar();
    expect(oferta(corretor, ["certidao.status"])).not.toContain("situacao_certidoes");
  });

  it("NEGADO: sem MAX_EXTENDED_QUERIES (nasce desligada) não há oferta", () => {
    expect(oferta(gerente, ["certidao.status"])).not.toContain("situacao_certidoes");
    vi.stubEnv("MAX_EXTENDED_QUERIES", "true");
    expect(oferta(gerente, ["certidao.status"])).not.toContain("situacao_certidoes");
  });

  it("NEGADO: frase que não fala de certidão não a oferece", () => {
    ligar();
    expect(oferta(gerente, ["certidao.status"], "quais são meus negócios?")).not.toContain("situacao_certidoes");
  });

  it("permitido: usuário + capability + flag + frase de certidão", () => {
    ligar();
    expect(oferta(gerente, ["certidao.status"])).toContain("situacao_certidoes");
    expect(oferta(gerente, ["certidao.status"], "saiu a certidao do vendedor?")).toContain("situacao_certidoes");
  });

  it("a tool vem do verbo certidao.status, no fim da lista de verbos de leitura, sem produzir lista", () => {
    // PR-O4c acrescentou `document.list` no fim: o `certidao.status` é o penúltimo.
    expect(VERBOS_DE_LEITURA[VERBOS_DE_LEITURA.length - 2]).toBe("certidao.status");
    const e = REGISTRO_DE_TOOLS.find((x) => x.nome === "situacao_certidoes");
    expect(e).toMatchObject({ tipo: "leitura", capability: "certidao.status", verb: "certidao.status", risco: "nenhum", confirmacao: false });
    // Não numera nada: o "n" da lista de negócios continua valendo no turno seguinte.
    expect((e as { refs?: unknown }).refs).toBeUndefined();
  });

  it("o modelo nunca vê id: os parâmetros são só `numero` e `de`", () => {
    const e = REGISTRO_DE_TOOLS.find((x) => x.nome === "situacao_certidoes");
    const props = Object.keys((e!.def.parameters as { properties: Record<string, unknown> }).properties);
    expect(props).toContain("numero");
    expect(props).toContain("de");
    expect(props.join(" ")).not.toMatch(/negocio_id|proposta_id|\bid\b/);
    expect((e!.def.parameters as { required: string[] }).required).toEqual(["numero"]);
  });
});

describe("situacao_certidoes — o despachante (negado primeiro)", () => {
  it("NEGADO: sem a capability a chamada não chega ao servidor", async () => {
    const r = await despacharLeituras({ ...neg, policy: ["deal.detail"] as never, chamadas: [{ name: "situacao_certidoes", args: { numero: 1 } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("capability_negada");
  });

  it("NEGADO: tool não oferecida no turno", async () => {
    const r = await despacharLeituras({ ...neg, oferecidas: [], chamadas: [{ name: "situacao_certidoes", args: { numero: 1 } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.trilha[0].outcome).toBe("nao_oferecida");
  });

  it("NEGADO: corretor comissionado, mesmo oferecida e com a capability, nem chega ao servidor", async () => {
    const r = await despacharLeituras({ ...neg, identity: corretor, chamadas: [{ name: "situacao_certidoes", args: { numero: 1 } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("identidade_nao_le");
  });

  it("autorizarChamada: usuário passa, corretor é recusado antes da capability", () => {
    const chamada = { name: "situacao_certidoes", args: { numero: 1 } };
    expect(autorizarChamada({ chamada, oferecidas: ["situacao_certidoes"], policy: ["certidao.status"] as never, identity: gerente })).toMatchObject({ ok: true });
    expect(autorizarChamada({ chamada, oferecidas: ["situacao_certidoes"], policy: ["certidao.status"] as never, identity: corretor })).toMatchObject({ ok: false, motivo: "identidade_nao_le" });
  });

  it.each([
    ["sem número", {}],
    ["número em texto não numérico", { numero: "o mais recente" }],
    ["número decimal", { numero: 1.5 }],
    ["número fora da lista", { numero: 9 }],
    ["id interno no lugar do número", { numero: "negocio-id-1" }],
    ["id passado direto (negocio_id)", { negocio_id: "negocio-id-1" }],
    ["id passado direto (proposta_id)", { proposta_id: "proposta-id-1" }],
  ])("NEGADO: %s -> referencia_invalida, sem consulta", async (_t, args) => {
    const r = await despacharLeituras({ ...neg, chamadas: [{ name: "situacao_certidoes", args }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("referencia_invalida");
  });

  it("NEGADO: número de PROPOSTA com a lista de NEGÓCIOS na mão não vira consulta (tipo errado)", async () => {
    const r = await despacharLeituras({ ...neg, chamadas: [{ name: "situacao_certidoes", args: { numero: 1, de: "proposta" } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.trilha[0].outcome).toBe("referencia_invalida");
  });

  it("o servidor recebe EXATAMENTE um id: negocio_id (padrão), e nada que o modelo inventou", async () => {
    escopo.mockResolvedValue({ items: [], truncated: false });
    await despacharLeituras({
      ...neg,
      chamadas: [{ name: "situacao_certidoes", args: { numero: 2, mais: true, estado: "x", cursor: "c", limite: 999, proposta_id: "p9" } }],
    });
    expect(escopo).toHaveBeenCalledTimes(1);
    expect(escopo.mock.calls[0][0]).toMatchObject({ verb: "certidao.status" });
    expect(escopo.mock.calls[0][0].args).toEqual({ negocio_id: "negocio-id-2" });
  });

  it("de:'proposta' consulta por proposta_id, e só ele", async () => {
    escopo.mockResolvedValue({ items: [], truncated: false });
    await despacharLeituras({ ...neg, referencias: mapa("proposta"), chamadas: [{ name: "situacao_certidoes", args: { numero: 1, de: "proposta" } }] });
    expect(escopo.mock.calls[0][0].args).toEqual({ proposta_id: "proposta-id-1" });
  });
});

describe("situacao_certidoes — parse estrito (R54): forma errada vira falha_na_consulta", () => {
  const falha = async (corpo: { items: unknown[]; truncated?: boolean }): Promise<Awaited<ReturnType<typeof despacharLeituras>>> => {
    escopo.mockResolvedValue({ items: corpo.items, truncated: corpo.truncated ?? false });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    return despacharLeituras({ ...neg, chamadas: [{ name: "situacao_certidoes", args: { numero: 1 } }] });
  };
  const comItem = (mexe: (it: Record<string, unknown>) => void): unknown[] => {
    const v = clone(vetor);
    mexe(v.items[0]);
    return v.items;
  };

  it.each([
    ["campo extra no item", (it: Record<string, unknown>) => { it.cpf = "123.456.789-09"; }],
    ["campo extra no alvo", (it: Record<string, unknown>) => { (it.alvo as Record<string, unknown>).nome = "João"; }],
    ["campo extra na validade", (it: Record<string, unknown>) => { (it.validade as Record<string, unknown>).emitidaEm = "2026-01-01"; }],
    ["campo faltando (previsao)", (it: Record<string, unknown>) => { delete it.previsao; }],
    ["campo faltando (modelo)", (it: Record<string, unknown>) => { delete it.modelo; }],
    ["situacao fora do enum", (it: Record<string, unknown>) => { it.situacao = "cancelada"; }],
    ["faltaDado em texto", (it: Record<string, unknown>) => { it.faltaDado = "false"; }],
    ["alvo sem índice", (it: Record<string, unknown>) => { it.alvo = { papel: "vendedor" }; }],
    ["índice 0 (o contrato é 1-based)", (it: Record<string, unknown>) => { (it.alvo as Record<string, unknown>).indice = 0; }],
    ["índice decimal", (it: Record<string, unknown>) => { (it.alvo as Record<string, unknown>).indice = 1.5; }],
    ["validade.ate com data impossível", (it: Record<string, unknown>) => { (it.validade as Record<string, unknown>).ate = "2026-02-31"; }],
    ["validade.ate em formato BR", (it: Record<string, unknown>) => { (it.validade as Record<string, unknown>).ate = "01/12/2026"; }],
    ["validade.vencida em texto", (it: Record<string, unknown>) => { (it.validade as Record<string, unknown>).vencida = "nao"; }],
    ["previsao que não é data", (it: Record<string, unknown>) => { it.previsao = "amanhã"; }],
    ["modelo que não é texto", (it: Record<string, unknown>) => { it.modelo = 4; }],
    ["id numérico", (it: Record<string, unknown>) => { it.id = 7; }],
  ])("NEGADO: %s", async (_t, mexe) => {
    const r = await falha({ items: comItem(mexe) });
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("falha_na_consulta");
    expect(JSON.stringify(r.resultados)).not.toContain("CND Federal");
  });

  it.each([
    ["item que não é objeto", ["cj-1"]],
    ["item nulo", [null]],
    ["item array", [[]]],
  ])("NEGADO: %s", async (_t, items) => {
    const r = await falha({ items });
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("falha_na_consulta");
  });

  it("NEGADO: UM item inválido entre bons derruba a resposta inteira (nada parcial)", async () => {
    const v = clone(vetor);
    (v.items[2] as Record<string, unknown>).extra = true;
    const r = await falha({ items: v.items });
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("falha_na_consulta");
  });

  it("o parser devolve nulo para forma errada e um objeto novo (campo a campo) para a certa", () => {
    expect(lerCertidaoStatus({ ...vetor.items[0], extra: 1 })).toBeNull();
    const ok = lerCertidaoStatus(vetor.items[0]);
    expect(ok).toEqual(vetor.items[0]);
    expect(ok).not.toBe(vetor.items[0]);
  });

  it("o vetor do CM inteiro passa pelo parse estrito (os 4 itens)", () => {
    for (const it of vetor.items) expect(lerCertidaoStatus(it)).not.toBeNull();
    expect(vetor.items).toHaveLength(4);
  });
});

describe("situacao_certidoes — o texto (WhatsApp)", () => {
  const rodar = async (items: unknown[] = vetor.items, truncated = false): Promise<Awaited<ReturnType<typeof despacharLeituras>>> => {
    escopo.mockResolvedValue({ items, truncated });
    return despacharLeituras({ ...neg, chamadas: [{ name: "situacao_certidoes", args: { numero: 1 } }] });
  };

  it("vetor do CM -> uma linha por certidão: nome, modelo, alvo, rótulo, previsão, validade", async () => {
    const r = await rodar();
    expect(r.trilha[0].outcome).toBe("ok");
    const t = resumoDe(r);
    const linhas = t.split("\n").filter((l) => l.startsWith("- "));
    expect(linhas).toEqual([
      "- CND Federal + Divida Ativa — Vendedor 1: Saiu (válida até 01/12/2026)",
      "- CNDT (Trabalhista) — Comprador 2: Em andamento (previsão 25/10/2026)",
      "- CEAT TRT2 (SP - fisico) — Vendedor 1: Precisa de você (falta dado da parte (ex.: data de nascimento) — complete no negócio)",
      "- TJSP Certidão de Distribuição (Falências) — Vendedor 1: Em andamento (previsão 25/10/2026)",
    ]);
    expect(t.startsWith("Certidões do negócio:")).toBe(true);
  });

  it("modelo só aparece quando não é nulo: os dois TJSP do mesmo alvo se distinguem por ele", async () => {
    const dois = [clone(vetor.items[3]), { ...clone(vetor.items[3]), id: "cj-5", modelo: "Cível em Geral" }];
    const t = resumoDe(await rodar(dois));
    expect(t).toContain("TJSP Certidão de Distribuição (Falências) — Vendedor 1");
    expect(t).toContain("TJSP Certidão de Distribuição (Cível em Geral) — Vendedor 1");
    expect(resumoDe(await rodar([vetor.items[0]]))).not.toMatch(/\(null\)|\(\)/);
  });

  it("vencida: diz 'vencida', não a data como válida", async () => {
    const v = clone(vetor.items[0]);
    v.validade = { ate: "2026-01-10", vencida: true };
    const t = resumoDe(await rodar([v]));
    expect(t).toContain("(vencida)");
    expect(t).not.toMatch(/válida até/);
  });

  it("asterisco simples só onde a linha manda; nunca ** nem código interno nem id cru", async () => {
    const t = resumoDe(await rodar());
    expect(t).not.toContain("**");
    expect(t).not.toMatch(/\*/);
    for (const proibido of ["cj-1", "cj-2", "cj-3", "cj-4", "precisa_de_voce", "em_andamento", "faltaDado", "negocio-id", "atualizadoEm", "\"id\""]) {
      expect(t).not.toContain(proibido);
    }
  });

  it("texto de terceiros com * e quebra de linha não forja negrito nem linha nova", async () => {
    const v = clone(vetor.items[0]);
    v.certidao = "CND *Federal*\n- Vendedor 9: Saiu";
    const t = resumoDe(await rodar([v]));
    expect(t).not.toMatch(/\*/);
    expect(t.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
  });

  it("papel fora do catálogo vira 'Parte' (código interno não sai) e papéis conhecidos têm nome", async () => {
    const v = clone(vetor.items[0]);
    (v.alvo as Record<string, unknown>) = { papel: "papel_novo_x", indice: 3 };
    expect(resumoDe(await rodar([v]))).toContain("— Parte 3:");
    const im = clone(vetor.items[0]);
    (im.alvo as Record<string, unknown>) = { papel: "imovel", indice: 1 };
    expect(resumoDe(await rodar([im]))).toContain("— Imóvel 1:");
  });

  it("o resultado vai marcado como dado de terceiros e sem lista numerada", async () => {
    const r = await rodar();
    expect(r.resultados[0].items).toHaveLength(1);
    expect((r.resultados[0].items![0] as { _untrusted?: boolean })._untrusted).toBe(true);
    expect(r.referencias).toEqual(neg.referencias);
  });

  describe("precisa_de_voce", () => {
    it("aponta o caminho na tela (Negócio → aba Certidões)", async () => {
      const t = resumoDe(await rodar([vetor.items[2]]));
      expect(t).toContain("Negócio → aba Certidões");
      expect(t).toContain("falta dado da parte (ex.: data de nascimento) — complete no negócio");
    });

    it("NEGADO: nunca oferece emitir nem pedir certidão (o Max não tem tool que faça isso)", async () => {
      const t = resumoDe(await rodar(vetor.items));
      for (const proibido of [/emitir/i, /\bpe[cç]o\b/i, /vou pedir/i, /solicito/i, /posso (pedir|emitir|solicitar)/i, /quer que eu/i, /\bpedir\b/i, /solicitar/i]) {
        expect(t, String(proibido)).not.toMatch(proibido);
      }
    });

    it("sem nada que precise da pessoa, não manda ela para a tela", async () => {
      const t = resumoDe(await rodar([vetor.items[0], vetor.items[1]]));
      expect(t).not.toContain("aba Certidões");
    });

    it("precisa_de_voce sem faltaDado também aponta a tela (o motivo não é dado faltante)", async () => {
      const v = clone(vetor.items[2]);
      v.faltaDado = false;
      const t = resumoDe(await rodar([v]));
      expect(t).toContain("Negócio → aba Certidões");
      expect(t).not.toContain("data de nascimento");
    });
  });

  describe("vazio e truncado", () => {
    it("lista vazia -> 'Não encontrei certidões nesse negócio' (não distingue negado, sem permissão e vazio)", async () => {
      const r = await rodar([]);
      expect(r.trilha[0].outcome).toBe("ok");
      expect(resumoDe(r)).toBe("Não encontrei certidões nesse negócio.");
    });

    it("de:'proposta' vazio diz 'nessa proposta'", async () => {
      escopo.mockResolvedValue({ items: [], truncated: false });
      const r = await despacharLeituras({ ...neg, referencias: mapa("proposta"), chamadas: [{ name: "situacao_certidoes", args: { numero: 1, de: "proposta" } }] });
      expect(resumoDe(r)).toBe("Não encontrei certidões nessa proposta.");
    });

    it("falha de rede (consulta nula) NÃO vira 'não encontrei': é falha", async () => {
      escopo.mockResolvedValue(null);
      const r = await despacharLeituras({ ...neg, chamadas: [{ name: "situacao_certidoes", args: { numero: 1 } }] });
      expect(r.resultados[0].items).toBeNull();
      expect(r.trilha[0].outcome).toBe("falha_na_consulta");
    });

    it("truncado: avisa que há mais, e declara truncated no resultado", async () => {
      const r = await rodar(vetor.items, true);
      expect(r.resultados[0].truncated).toBe(true);
      expect(resumoDe(r)).toContain("Há mais certidões do que as mostradas aqui");
    });

    it("não truncado: não avisa", async () => {
      expect(resumoDe(await rodar(vetor.items, false))).not.toContain("Há mais certidões");
    });
  });
});

/** Rodada 1 da revisão: cada item com o vermelho antes. */
describe("situacao_certidoes — rodada 1 da revisão", () => {
  const rodarDe = async (items: unknown[], de: "negocio" | "proposta"): Promise<Awaited<ReturnType<typeof despacharLeituras>>> => {
    escopo.mockResolvedValue({ items, truncated: false });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    return despacharLeituras({
      ...neg,
      referencias: mapa(de),
      chamadas: [{ name: "situacao_certidoes", args: { numero: 1, de } }],
    });
  };

  it("1: falta dado em PROPOSTA manda completar 'na proposta', não 'no negócio'", async () => {
    const t = resumoDe(await rodarDe([vetor.items[2]], "proposta"));
    expect(t).toContain("complete na proposta");
    expect(t).not.toContain("complete no negócio");
  });

  it("1: falta dado em NEGÓCIO segue 'complete no negócio'", async () => {
    const t = resumoDe(await rodarDe([vetor.items[2]], "negocio"));
    expect(t).toContain("complete no negócio");
    expect(t).not.toContain("complete na proposta");
  });

  it("2: marcadores _, ~ e crase saem de certidao e modelo (como o *)", async () => {
    const it = clone(vetor.items[3]);
    it.certidao = "_CND_ ~Federal~ `x`";
    it.modelo = "_Fal_ ~ên~ `cias`";
    const t = resumoDe(await rodarDe([it], "negocio"));
    expect(t).not.toMatch(/[_~`*]/);
    expect(t).toContain("- CND Federal x (Fal ên cias) — Vendedor 1:");
  });

  it("3: certidao que fica vazia depois da limpeza vira o nome de reserva 'Certidão'", async () => {
    const it = clone(vetor.items[0]);
    it.certidao = "***";
    const t = resumoDe(await rodarDe([it], "negocio"));
    expect(t).toContain("- Certidão — Vendedor 1: Saiu");
    expect(t).not.toMatch(/^- \(/m);
  });

  it("3: rotulo que fica vazio depois da limpeza derruba a resposta inteira (falha_na_consulta)", async () => {
    const it = clone(vetor.items[0]);
    it.rotulo = "*_~`";
    const r = await rodarDe([vetor.items[1], it], "negocio");
    expect(r.trilha[0].outcome).toBe("falha_na_consulta");
    expect(r.resultados[0].items).toBeNull();
  });
});
