import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { consultaGolden, reiniciar } from "../eval-simulador";

/**
 * O simulador do golden responde às consultas da Onda 4 e à busca por nome. Aqui ele passa pelo
 * DESPACHANTE de verdade (parse estrito dos vetores, filtro local da busca, numeração): se a forma
 * que o simulador devolve sair do contrato, a resposta vira `falha_na_consulta` e este teste quebra
 * antes de alguém gastar a bateria com o modelo real.
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

const { despacharLeituras } = await import("../../src/graph/despachante");
const { consultarEscopo } = await import("@/lib/scope");
const escopo = vi.mocked(consultarEscopo);

const usuario = { orgId: "org-eval", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };
const corretor = { orgId: "org-eval", orgName: "FINCasa", kind: "broker" as const, splitRecipientId: "sr-eval", label: "TESTE Corretor" };
const TOOLS = ["listar_negocios", "detalhar_negocio", "situacao_certidoes", "listar_documentos", "status_cobranca"];
const POLICY = ["deal.list", "deal.detail", "certidao.status", "document.list", "charge.status"] as never;
const base = { fromPhone: "+5511999990000", turno: "t1", agora: 2_000, oferecidas: TOOLS, policy: POLICY };

type Resultado = Awaited<ReturnType<typeof despacharLeituras>>;
const resumoDe = (r: Resultado): string => (r.resultados[0]!.items?.[0] as { resumo?: string } | undefined)?.resumo ?? "";
const titulos = (r: Resultado): string[] => (r.resultados[0]!.items as { titulo?: string }[]).map((i) => String(i.titulo));

beforeEach(() => {
  reiniciar({ golden: true });
  escopo.mockReset();
  escopo.mockImplementation((async (p: { verb: string; args?: Record<string, unknown> }) => consultaGolden(p)) as never);
  vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ "org-eval": ["queries"] }));
  vi.stubEnv("MAX_EXTENDED_QUERIES", "true");
});
afterEach(() => vi.unstubAllEnvs());

/** Busca pelo nome e devolve o mapa de referências, como o primeiro passo do turno. */
async function buscar(busca: string): Promise<Resultado> {
  return despacharLeituras({ ...base, identity: usuario, referencias: null, chamadas: [{ name: "listar_negocios", args: { busca } }] });
}

describe("deal.list do simulador: busca por nome", () => {
  it("sem busca a lista segue inteira (comportamento dos casos antigos)", async () => {
    const r = await despacharLeituras({ ...base, identity: usuario, referencias: null, chamadas: [{ name: "listar_negocios", args: {} }] });
    expect(r.resultados[0]!.items!.length).toBeGreaterThan(1);
    expect(consultaGolden({ verb: "deal.list" }).items).toHaveLength(NEGOCIOS_TOTAL());
  });

  it("'TESTE1' acha só o TESTE1, e o id nunca chega ao modelo", async () => {
    const r = await buscar("TESTE1");
    expect(titulos(r)).toEqual(["TESTE1"]);
    expect(JSON.stringify(r.resultados)).not.toContain("dn-teste1");
    expect(r.trilha[0]!.outcome).toBe("ok");
  });

  it("'joao silva' (sem acento, minúsculas) acha 'TESTE João Silva'", async () => {
    expect(titulos(await buscar("joao silva"))).toEqual(["TESTE João Silva"]);
  });

  it("nome inexistente: lista vazia (e o mapa de referências fica vazio)", async () => {
    const r = await buscar("TESTE Inexistente XYZ");
    expect(r.resultados[0]!.items).toEqual([]);
    expect(r.referencias?.itens).toEqual([]);
  });

  it("corretor comissionado com busca: nenhuma consulta ao servidor, marcada como indisponível", async () => {
    const r = await despacharLeituras({ ...base, identity: corretor, referencias: null, chamadas: [{ name: "listar_negocios", args: { busca: "TESTE1" } }] });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0]).toEqual(expect.objectContaining({ items: [], buscaIndisponivel: true }));
  });
});

describe("as consultas de UM negócio (O4), apontadas pelo número da lista", () => {
  async function comNumero(tool: string): Promise<Resultado> {
    const lista = await buscar("TESTE1");
    escopo.mockClear();
    return despacharLeituras({ ...base, identity: usuario, referencias: lista.referencias, chamadas: [{ name: tool, args: { numero: 1 } }] });
  }

  it("detalhar_negocio: o servidor recebe só o negocio_id e a resposta traz etapa sem id", async () => {
    const r = await comNumero("detalhar_negocio");
    expect(escopo).toHaveBeenCalledWith(expect.objectContaining({ verb: "deal.detail", args: { negocio_id: "dn-teste1" } }));
    expect(r.trilha[0]!.outcome).toBe("ok");
    expect(r.resultados[0]!.items).toEqual([expect.objectContaining({ n: 1, titulo: "TESTE1", etapa: "Formulário" })]);
    expect(JSON.stringify(r.resultados)).not.toContain("dn-teste1");
  });

  it("situacao_certidoes: o vetor passa no parse estrito e o resumo não traz id nem link", async () => {
    const r = await comNumero("situacao_certidoes");
    expect(r.trilha[0]!.outcome).toBe("ok");
    expect(resumoDe(r)).toMatch(/CND Federal/);
    expect(resumoDe(r)).not.toMatch(/cj-\d|https?:\/\//);
  });

  it("listar_documentos: o vetor passa no parse estrito; só a URL da tela do negócio aparece, nunca id nem link de arquivo", async () => {
    const r = await comNumero("listar_documentos");
    expect(r.trilha[0]!.outcome).toBe("ok");
    expect(resumoDe(r)).toMatch(/RG do vendedor/);
    expect(resumoDe(r)).not.toMatch(/\b(ct|env|att)-\d/);
    const urls = resumoDe(r).match(/https?:\/\/\S+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toMatch(/^https:\/\/imobpro\.ia\.br\/deals\//);
  });

  it("status_cobranca: o vetor passa (negocioId reescrito para o pedido), em reais, sem id nem link", async () => {
    const r = await comNumero("status_cobranca");
    expect(r.trilha[0]!.outcome).toBe("ok");
    expect(resumoDe(r)).toMatch(/R\$/);
    expect(resumoDe(r)).not.toMatch(/\bch-\d|https?:\/\//);
  });

  it("negócio que o simulador não conhece volta vazio nas quatro leituras", () => {
    for (const verb of ["deal.detail", "certidao.status", "document.list", "charge.status"]) {
      expect(consultaGolden({ verb, args: { negocio_id: "nao-existe" } }), verb).toEqual({ items: [], truncated: false });
    }
  });
});

function NEGOCIOS_TOTAL(): number {
  return consultaGolden({ verb: "deal.list", args: {} }).items.length;
}
