import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VETOR_DOCUMENT_LIST_USER } from "./documentos-vectors";

/**
 * PR-O4c-MA — `listar_documentos` (par do contractmaker PR-O4c-CM, `docs/max.md` §19.5).
 *
 * Negado antes do permitido (regra 3): cada trava tem o seu caso de recusa isolado, e a
 * leitura só existe para quem a política concede E é usuário da plataforma. O corretor
 * comissionado nunca recebe o verbo (o servidor responde `{items:[]}` mesmo se a política
 * o concedesse), então a tool nem é oferecida a ele.
 *
 * O parse é ESTRITO (R54): campo desconhecido ou forma errada em QUALQUER item derruba a
 * resposta inteira (`falha_na_consulta`). Nunca se repassa item que o contrato não descreve.
 * O Max NUNCA envia arquivo nem URL: o `link` do contrato é um caminho relativo da tela.
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
const { lerDocumento, CHAVES_DE_DOCUMENTO } = await import("../documentos");
const { VERBOS_DE_LEITURA } = await import("../scope-contract");
const { consultarEscopo } = await import("@/lib/scope");
const { CAPABILITIES_RESERVADAS } = await import("@/lib/runtime/catalog");
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
const neg = { ...base, oferecidas: ["listar_documentos"], policy: ["document.list"] as never, referencias: mapa("negocio") };

const vetor = JSON.parse(VETOR_DOCUMENT_LIST_USER) as { items: Array<Record<string, unknown>>; truncated: boolean };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** O texto que o modelo recebe (o `resumo` único do resultado). */
function resumoDe(r: Awaited<ReturnType<typeof despacharLeituras>>): string {
  const item = r.resultados[0].items?.[0] as { resumo?: string } | undefined;
  return item?.resumo ?? "";
}

const ORIGEM = "https://staging.imobpro.ia.br";
beforeEach(() => {
  vi.clearAllMocks();
  // Rodada 1: o link sai ABSOLUTO, com o domínio da própria plataforma (`imobproBase()`).
  vi.stubEnv("CONTRACTMAKER_API_URL", ORIGEM);
});
afterEach(() => vi.unstubAllEnvs());

function ligar(): void {
  vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ org1: ["queries"] }));
  vi.stubEnv("MAX_EXTENDED_QUERIES", "true");
}

describe("listar_documentos — a oferta (negado primeiro)", () => {
  const TEXTO = "quais documentos tem o negócio 2?";
  const oferta = (identity: typeof gerente | typeof corretor, policy: string[], texto = TEXTO): string[] =>
    ferramentasDoTurno({ policy: policy as never, texto, identity }).entradas.map((e) => e.nome);

  it("NEGADO: sem a capability document.list a tool não é oferecida", () => {
    ligar();
    expect(oferta(gerente, [])).not.toContain("listar_documentos");
    expect(oferta(gerente, ["deal.list", "deal.detail", "contract.status", "certidao.status"])).not.toContain("listar_documentos");
  });

  it("NEGADO: o corretor comissionado não recebe a tool, mesmo com a capability na política", () => {
    ligar();
    expect(oferta(corretor, ["document.list"])).not.toContain("listar_documentos");
  });

  it("NEGADO: sem MAX_EXTENDED_QUERIES (nasce desligada) não há oferta", () => {
    expect(oferta(gerente, ["document.list"])).not.toContain("listar_documentos");
    vi.stubEnv("MAX_EXTENDED_QUERIES", "true");
    expect(oferta(gerente, ["document.list"])).not.toContain("listar_documentos");
  });

  it("NEGADO: frase que não fala de documento não a oferece", () => {
    ligar();
    expect(oferta(gerente, ["document.list"], "quais são meus negócios?")).not.toContain("listar_documentos");
  });

  it("permitido: usuário + capability + flag + frase de documento", () => {
    ligar();
    expect(oferta(gerente, ["document.list"])).toContain("listar_documentos");
    expect(oferta(gerente, ["document.list"], "tem algum anexo no negócio 1?")).toContain("listar_documentos");
  });

  it("a tool vem do verbo document.list, no fim da lista de verbos de leitura, sem produzir lista", () => {
    expect(VERBOS_DE_LEITURA[VERBOS_DE_LEITURA.length - 1]).toBe("document.list");
    const e = REGISTRO_DE_TOOLS.find((x) => x.nome === "listar_documentos");
    expect(e).toMatchObject({ tipo: "leitura", capability: "document.list", verb: "document.list", risco: "nenhum", confirmacao: false, soUsuario: true });
    // Não numera nada: o "n" da lista de negócios continua valendo no turno seguinte.
    expect((e as { refs?: unknown }).refs).toBeUndefined();
  });

  it("o modelo nunca vê id nem cursor: os parâmetros são só `numero` e `de`", () => {
    const e = REGISTRO_DE_TOOLS.find((x) => x.nome === "listar_documentos");
    const props = Object.keys((e!.def.parameters as { properties: Record<string, unknown> }).properties);
    expect(props.sort()).toEqual(["de", "numero"]);
    expect((e!.def.parameters as { required: string[] }).required).toEqual(["numero"]);
  });

  it("a descrição diz que só lista: não envia, não baixa, não gera", () => {
    const e = REGISTRO_DE_TOOLS.find((x) => x.nome === "listar_documentos");
    expect(e!.def.description).toMatch(/n[aã]o envia/i);
  });
});

describe("listar_documentos — o catálogo", () => {
  it("document.list saiu de CAPABILITIES_RESERVADAS; só charge.status segue reservada", () => {
    expect([...CAPABILITIES_RESERVADAS]).toEqual(["charge.status"]);
  });
});

describe("listar_documentos — o despachante (negado primeiro)", () => {
  it("NEGADO: sem a capability a chamada não chega ao servidor", async () => {
    const r = await despacharLeituras({ ...neg, policy: ["deal.detail"] as never, chamadas: [{ name: "listar_documentos", args: { numero: 1 } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("capability_negada");
  });

  it("NEGADO: tool não oferecida no turno", async () => {
    const r = await despacharLeituras({ ...neg, oferecidas: [], chamadas: [{ name: "listar_documentos", args: { numero: 1 } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.trilha[0].outcome).toBe("nao_oferecida");
  });

  it("NEGADO: corretor comissionado, mesmo oferecida e com a capability, nem chega ao servidor", async () => {
    const r = await despacharLeituras({ ...neg, identity: corretor, chamadas: [{ name: "listar_documentos", args: { numero: 1 } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("identidade_nao_le");
  });

  it("autorizarChamada: usuário passa, corretor é recusado antes da capability", () => {
    const chamada = { name: "listar_documentos", args: { numero: 1 } };
    expect(autorizarChamada({ chamada, oferecidas: ["listar_documentos"], policy: ["document.list"] as never, identity: gerente })).toMatchObject({ ok: true });
    expect(autorizarChamada({ chamada, oferecidas: ["listar_documentos"], policy: ["document.list"] as never, identity: corretor })).toMatchObject({ ok: false, motivo: "identidade_nao_le" });
  });

  it.each([
    ["sem número", {}],
    ["número em texto não numérico", { numero: "o mais recente" }],
    ["número decimal", { numero: 1.5 }],
    ["número fora da lista", { numero: 9 }],
    ["id interno no lugar do número", { numero: "negocio-id-1" }],
    ["id cru passado direto (negocio_id)", { negocio_id: "negocio-id-1" }],
    ["id cru passado direto (proposta_id)", { proposta_id: "proposta-id-1" }],
  ])("NEGADO: %s -> referencia_invalida, sem consulta", async (_t, args) => {
    const r = await despacharLeituras({ ...neg, chamadas: [{ name: "listar_documentos", args }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("referencia_invalida");
  });

  it("NEGADO: número de PROPOSTA com a lista de NEGÓCIOS na mão não vira consulta (tipo errado)", async () => {
    const r = await despacharLeituras({ ...neg, chamadas: [{ name: "listar_documentos", args: { numero: 1, de: "proposta" } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.trilha[0].outcome).toBe("referencia_invalida");
  });

  it("o servidor recebe EXATAMENTE um id: negocio_id (padrão), e nada que o modelo inventou", async () => {
    escopo.mockResolvedValue({ items: [], truncated: false });
    await despacharLeituras({
      ...neg,
      chamadas: [{ name: "listar_documentos", args: { numero: 2, mais: true, estado: "x", cursor: "c", limite: 999, proposta_id: "p9" } }],
    });
    expect(escopo).toHaveBeenCalledTimes(1);
    expect(escopo.mock.calls[0][0]).toMatchObject({ verb: "document.list" });
    expect(escopo.mock.calls[0][0].args).toEqual({ negocio_id: "negocio-id-2" });
  });

  it("de:'proposta' consulta por proposta_id, e só ele", async () => {
    escopo.mockResolvedValue({ items: [], truncated: false });
    await despacharLeituras({ ...neg, referencias: mapa("proposta"), chamadas: [{ name: "listar_documentos", args: { numero: 1, de: "proposta" } }] });
    expect(escopo.mock.calls[0][0].args).toEqual({ proposta_id: "proposta-id-1" });
  });
});

describe("listar_documentos — parse estrito (R54): forma errada vira falha_na_consulta", () => {
  const falha = async (corpo: { items: unknown[]; truncated?: boolean }): Promise<Awaited<ReturnType<typeof despacharLeituras>>> => {
    escopo.mockResolvedValue({ items: corpo.items, truncated: corpo.truncated ?? false });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    return despacharLeituras({ ...neg, chamadas: [{ name: "listar_documentos", args: { numero: 1 } }] });
  };
  const comItem = (mexe: (it: Record<string, unknown>) => void, i = 0): unknown[] => {
    const v = clone(vetor);
    mexe(v.items[i]);
    return v.items;
  };

  it.each([
    ["campo extra no item (url)", (it: Record<string, unknown>) => { it.url = "https://blob.example/x.pdf"; }],
    ["campo extra no item (mime)", (it: Record<string, unknown>) => { it.mime = "application/pdf"; }],
    ["campo faltando (versao)", (it: Record<string, unknown>) => { delete it.versao; }],
    ["campo faltando (categoria)", (it: Record<string, unknown>) => { delete it.categoria; }],
    ["campo faltando (link)", (it: Record<string, unknown>) => { delete it.link; }],
    ["origem fora do enum", (it: Record<string, unknown>) => { it.origem = "rascunho"; }],
    ["versao em texto", (it: Record<string, unknown>) => { it.versao = "2"; }],
    ["versao 0 (o contrato é 1-based)", (it: Record<string, unknown>) => { it.versao = 0; }],
    ["versao decimal", (it: Record<string, unknown>) => { it.versao = 1.5; }],
    ["categoria que não é texto", (it: Record<string, unknown>) => { it.categoria = 4; }],
    ["criadoEm que não é data", (it: Record<string, unknown>) => { it.criadoEm = "ontem"; }],
    ["nome vazio", (it: Record<string, unknown>) => { it.nome = "  "; }],
    ["id numérico", (it: Record<string, unknown>) => { it.id = 7; }],
    ["link https (URL externa)", (it: Record<string, unknown>) => { it.link = "https://imobpro.ia.br/deals/deal-1?tab=anexos"; }],
    ["link http", (it: Record<string, unknown>) => { it.link = "http://x/y"; }],
    ["link protocolo-relativo", (it: Record<string, unknown>) => { it.link = "//evil.example/x"; }],
    ["link sem barra inicial", (it: Record<string, unknown>) => { it.link = "deals/deal-1?tab=anexos"; }],
    ["link com ://  no meio", (it: Record<string, unknown>) => { it.link = "/redir?u=ftp://x"; }],
    ["link com espaço ou quebra de linha", (it: Record<string, unknown>) => { it.link = "/deals/1\n- Fake: x"; }],
    ["link relativo que o linkSeguro recusa (longo demais)", (it: Record<string, unknown>) => { it.link = `/deals/${"a".repeat(300)}`; }],
    ["redirect com http codificado (/redir?u=http%3A%2F%2Fx)", (it: Record<string, unknown>) => { it.link = "/redir?u=http%3A%2F%2Fx"; }],
    ["qualquer % no caminho", (it: Record<string, unknown>) => { it.link = "/deals/abc%20def?tab=anexos"; }],
    ["caminho com ..", (it: Record<string, unknown>) => { it.link = "/deals/x/../y"; }],
    ["host forjado (//evil.com)", (it: Record<string, unknown>) => { it.link = "//evil.com"; }],
    ["parametro a mais (?tab=x&u=y)", (it: Record<string, unknown>) => { it.link = "/deals/abc?tab=x&u=y"; }],
    ["rota desconhecida (/admin/x)", (it: Record<string, unknown>) => { it.link = "/admin/x"; }],
    ["rota conhecida sem id (/deals/)", (it: Record<string, unknown>) => { it.link = "/deals/"; }],
    ["rota conhecida com subcaminho (/deals/a/b)", (it: Record<string, unknown>) => { it.link = "/deals/a/b"; }],
    ["aba em maiusculas (?tab=ANEXOS)", (it: Record<string, unknown>) => { it.link = "/deals/abc?tab=ANEXOS"; }],
    ["fragmento (#x)", (it: Record<string, unknown>) => { it.link = "/deals/abc#x"; }],
    ["link nulo",(it: Record<string, unknown>) => { it.link = null; }],
    ["link vazio", (it: Record<string, unknown>) => { it.link = ""; }],
  ])("NEGADO: %s", async (_t, mexe) => {
    const r = await falha({ items: comItem(mexe) });
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("falha_na_consulta");
    expect(JSON.stringify(r.resultados)).not.toContain("Contrato de Compra");
  });

  it("NEGADO: versao em item que não é contrato (o contrato diz null nos demais)", async () => {
    const r = await falha({ items: comItem((it) => { it.versao = 3; }, 2) });
    expect(r.trilha[0].outcome).toBe("falha_na_consulta");
  });

  it("NEGADO: contrato sem versao", async () => {
    const r = await falha({ items: comItem((it) => { it.versao = null; }, 0) });
    expect(r.trilha[0].outcome).toBe("falha_na_consulta");
  });

  it.each([
    ["item que não é objeto", ["ct-1"]],
    ["item nulo", [null]],
    ["item array", [[]]],
  ])("NEGADO: %s", async (_t, items) => {
    const r = await falha({ items });
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("falha_na_consulta");
  });

  it("NEGADO: UM item inválido entre bons derruba a resposta inteira (nada parcial)", async () => {
    const v = clone(vetor);
    (v.items[2] as Record<string, unknown>).url = "https://x/y.pdf";
    const r = await falha({ items: v.items });
    expect(r.resultados[0].items).toBeNull();
    expect(r.trilha[0].outcome).toBe("falha_na_consulta");
  });

  it("o parser devolve nulo para forma errada e um objeto novo (campo a campo) para a certa", () => {
    expect(lerDocumento({ ...vetor.items[0], extra: 1 })).toBeNull();
    const ok = lerDocumento(vetor.items[0]);
    expect(ok).toEqual(vetor.items[0]);
    expect(ok).not.toBe(vetor.items[0]);
  });

  it("a ordem das chaves é a do CM e o vetor inteiro passa pelo parse estrito (os 3 itens)", () => {
    for (const it of vetor.items) {
      expect(Object.keys(it)).toEqual([...CHAVES_DE_DOCUMENTO]);
      expect(lerDocumento(it)).not.toBeNull();
    }
    expect(vetor.items).toHaveLength(3);
    expect(Object.keys(vetor)).toEqual(["items", "truncated"]);
  });
});

describe("listar_documentos — o texto (WhatsApp)", () => {
  const rodar = async (items: unknown[] = vetor.items, truncated = false): Promise<Awaited<ReturnType<typeof despacharLeituras>>> => {
    escopo.mockResolvedValue({ items, truncated });
    return despacharLeituras({ ...neg, chamadas: [{ name: "listar_documentos", args: { numero: 1 } }] });
  };

  it("vetor do CM -> uma linha por documento: nome, origem, categoria, data e caminho da tela", async () => {
    const r = await rodar();
    expect(r.trilha[0].outcome).toBe("ok");
    const t = resumoDe(r);
    expect(t.startsWith("Documentos do negócio:")).toBe(true);
    expect(t.split("\n").filter((l) => l.startsWith("- "))).toEqual([
      `- Contrato de Compra e Venda — Contrato aprovado v2, 19/10/2026 — abra no sistema: ${ORIGEM}/deals/deal-1?tab=contratos`,
      `- Contrato de Compra e Venda — Contrato assinado, 18/10/2026 — abra no sistema: ${ORIGEM}/deals/deal-1?tab=contratos`,
      `- RG do vendedor.pdf — Anexo (rg), 17/10/2026 — abra no sistema: ${ORIGEM}/deals/deal-1?tab=anexos`,
    ]);
  });

  it("data no fuso de Brasília: 02h UTC ainda é o dia anterior", async () => {
    const v = clone(vetor.items[2]);
    v.criadoEm = "2026-10-18T02:00:00.000Z";
    expect(resumoDe(await rodar([v]))).toContain("17/10/2026");
  });

  it("todo https?:// do resumo começa com a origem de imobproBase(); nunca blob, S3 nem ClickSign; sem **, id cru nem código interno", async () => {
    const t = resumoDe(await rodar());
    const urls = t.match(/https?:\/\/\S+/g) ?? [];
    expect(urls.length).toBe(3);
    for (const u of urls) expect(u.startsWith(`${ORIGEM}/`), u).toBe(true);
    for (const x of ["blob", "amazonaws", "clicksign"]) expect(t.toLowerCase(), x).not.toContain(x);
    expect(t).not.toContain("**");
    expect(t).not.toMatch(/\*/);
    for (const proibido of ["ct-1", "env-1", "att-1", "contrato_assinado", "\"id\"", "criadoEm", "versao", "origem", "negocio-id"]) {
      expect(t, proibido).not.toContain(proibido);
    }
  });

  it("o link vira 'abra no sistema: <URL absoluta da plataforma>' (o caminho do CM resolvido contra imobproBase())", async () => {
    const t = resumoDe(await rodar());
    for (const l of t.split("\n").filter((x) => x.startsWith("- "))) {
      expect(l.endsWith(`abra no sistema: ${l.slice(l.indexOf(ORIGEM))}`)).toBe(true);
      expect(l.slice(l.indexOf(ORIGEM)).startsWith(`${ORIGEM}/`)).toBe(true);
      expect(l.slice(l.indexOf(ORIGEM))).not.toMatch(/\s/);
    }
  });

  it("segue a base configurada: outra CONTRACTMAKER_API_URL muda a origem do link", async () => {
    vi.stubEnv("CONTRACTMAKER_API_URL", "https://imobpro.ia.br");
    const t = resumoDe(await rodar());
    expect(t).toContain("abra no sistema: https://imobpro.ia.br/deals/deal-1?tab=anexos");
    expect(t).not.toContain("staging");
  });

  it("id com 'http' dentro (cuid) no caminho PASSA: não é URL, só uma sequência de letras", async () => {
    const v = clone(vetor.items[2]);
    v.link = "/deals/chttpx9k2abc?tab=anexos";
    const r = await rodar([v]);
    expect(r.trilha[0].outcome).toBe("ok");
    expect(resumoDe(r)).toContain(`abra no sistema: ${ORIGEM}/deals/chttpx9k2abc?tab=anexos`);
  });

  it.each([
    ["/deals/deal-1", "/deals/deal-1"],
    ["/deals/deal-1?tab=anexos", "/deals/deal-1?tab=anexos"],
    ["/locacao/deals/deal-9?tab=documentos", "/locacao/deals/deal-9?tab=documentos"],
    ["/locacao/deals/deal_9", "/locacao/deals/deal_9"],
    ["/pipeline/propostas/prop-1", "/pipeline/propostas/prop-1"],
    ["/deals/chttpx9k2abc?tab=contratos", "/deals/chttpx9k2abc?tab=contratos"],
  ])("os 3 formatos do CM passam (%s)", async (link, esperado) => {
    const v = clone(vetor.items[2]);
    v.link = link;
    const r = await rodar([v]);
    expect(r.trilha[0].outcome).toBe("ok");
    expect(resumoDe(r)).toContain(`abra no sistema: ${ORIGEM}${esperado}`);
  });

  it("texto de terceiros com * _ ~ crase e quebra de linha não forja formatação nem linha nova", async () => {
    const v = clone(vetor.items[2]);
    v.nome = "RG *do* _vendedor_ ~x~ `y`\n- Fake: x";
    v.categoria = "_rg_ *x*";
    const t = resumoDe(await rodar([v]));
    expect(t).not.toMatch(/[*_~`]/);
    expect(t.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
  });

  it("nome que fica vazio depois da limpeza vira 'Documento'", async () => {
    const v = clone(vetor.items[2]);
    v.nome = "***";
    const t = resumoDe(await rodar([v]));
    expect(t).toContain("- Documento — Anexo");
  });

  it("categoria só aparece em anexo (nos contratos ela repete a origem) e sem sublinhado", async () => {
    const a = clone(vetor.items[2]);
    a.categoria = "contrato_assinado";
    const t = resumoDe(await rodar([a, vetor.items[0], vetor.items[1]]));
    expect(t).toContain("Anexo (contrato assinado)");
    expect(t).not.toMatch(/Contrato aprovado v2 \(/);
    expect(t).not.toMatch(/Contrato assinado \(/);
    const sem = clone(vetor.items[2]);
    sem.categoria = null;
    const t2 = resumoDe(await rodar([sem]));
    expect(t2).toContain("— Anexo, 17/10/2026");
    expect(t2).not.toMatch(/\(null\)|\(\)/);
  });

  it("o resultado vai marcado como dado de terceiros e sem lista numerada", async () => {
    const r = await rodar();
    expect(r.resultados[0].items).toHaveLength(1);
    expect((r.resultados[0].items![0] as { _untrusted?: boolean })._untrusted).toBe(true);
    expect(r.referencias).toEqual(neg.referencias);
  });

  it("proposta: cabeçalho 'da proposta' e link da proposta", async () => {
    escopo.mockResolvedValue({
      items: [{ ...vetor.items[2], link: "/pipeline/propostas/prop-1" }],
      truncated: false,
    });
    const r = await despacharLeituras({ ...neg, referencias: mapa("proposta"), chamadas: [{ name: "listar_documentos", args: { numero: 1, de: "proposta" } }] });
    const t = resumoDe(r);
    expect(t.startsWith("Documentos da proposta:")).toBe(true);
    expect(t).toContain(`abra no sistema: ${ORIGEM}/pipeline/propostas/prop-1`);
  });

  describe("vazio e truncado", () => {
    it("lista vazia -> 'Não encontrei documentos nesse negócio' (não distingue negado, sem permissão e vazio)", async () => {
      const r = await rodar([]);
      expect(r.trilha[0].outcome).toBe("ok");
      expect(resumoDe(r)).toBe("Não encontrei documentos nesse negócio.");
    });

    it("de:'proposta' vazio diz 'nessa proposta'", async () => {
      escopo.mockResolvedValue({ items: [], truncated: false });
      const r = await despacharLeituras({ ...neg, referencias: mapa("proposta"), chamadas: [{ name: "listar_documentos", args: { numero: 1, de: "proposta" } }] });
      expect(resumoDe(r)).toBe("Não encontrei documentos nessa proposta.");
    });

    it("falha de rede (consulta nula) NÃO vira 'não encontrei': é falha", async () => {
      escopo.mockResolvedValue(null);
      const r = await despacharLeituras({ ...neg, chamadas: [{ name: "listar_documentos", args: { numero: 1 } }] });
      expect(r.resultados[0].items).toBeNull();
      expect(r.trilha[0].outcome).toBe("falha_na_consulta");
    });

    it("truncado: 'Mostrando os N mais recentes' com N = itens mostrados, e declara truncated no resultado", async () => {
      const r = await rodar(vetor.items, true);
      expect(r.resultados[0].truncated).toBe(true);
      expect(resumoDe(r)).toContain("Mostrando os 3 mais recentes");
    });

    it("não truncado: não avisa", async () => {
      expect(resumoDe(await rodar(vetor.items, false))).not.toMatch(/mais recentes/i);
    });
  });
});
