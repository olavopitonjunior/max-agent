import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPABILITIES, resolverPolitica, type MaxPolicy } from "../policy";
import { VERBOS_DE_LEITURA } from "../scope-contract";
import { catalog } from "@/lib/runtime/catalog";

vi.mock("@/lib/scope", async (orig) => ({ ...(await orig<typeof import("@/lib/scope")>()), consultarEscopo: vi.fn() }));
const { consultarEscopo } = await import("@/lib/scope");
const { despacharLeituras } = await import("../despachante");
const { ferramentasDoTurno } = await import("../tools");
const scope = vi.mocked(consultarEscopo);

/**
 * Paridade com o contractmaker (Modelos autônomos PR 7b, `template.decisions`).
 * Regra 1 da governança do Max: vetor fixo dos dois lados. Os literais abaixo
 * são COPIADOS de `lib/max/__tests__/query-vectors.ts` e de
 * `lib/max/__tests__/scope-query-decisoes.test.ts` do CM, nunca derivados das
 * constantes deste lado.
 */
const VETOR_DO_CM =
  '{"items":[{"chave":"extenso_ausente","rotulo":"Todo valor em dinheiro sai com o extenso ao lado?","modelosAfetados":3,"link":"https://imobpro.ia.br/templates/decisoes"}],"naoMedidos":1}';

const VERBOS_DE_LEITURA_DO_CM = [
  "deal.list", "deal.detail", "deal.pending", "proposal.list", "proposal.detail",
  "notification.list", "activity.list", "activity.get", "metrics.get",
  "property.list", "property.detail", "contract.status", "template.decisions", "pending.summary",
];

const CHAVES_PROIBIDAS = [
  "modelos", "name", "id", "status", "modalidade", "decisao", "decididaPor", "decididaEm", "resposta",
  "contexto", "opcoes", "pergunta", "afetados", "trecho", "draftReport", "googleDocId", "handlebarsSource",
];

const gerente = { orgId: "fixture-org", orgName: "Fixture", kind: "user" as const, userId: "u1", userName: "Marcia" };
const PADRAO = JSON.parse(
  '{"byRole":{"*":["deal.list","deal.pending","proposal.list","form.create","proposal.create","proposal.send","proposal.delete"]},' +
    '"byRecipient":{},"brokerDefault":["deal.list","deal.pending"]}'
) as MaxPolicy;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ "fixture-org": ["queries"] }));
  vi.stubEnv("MAX_EXTENDED_QUERIES", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("template.decisions — negado (fail-closed)", () => {
  it("o padrão do ImobPro não concede, nem a usuário nem a corretor", () => {
    expect(resolverPolitica({ politica: PADRAO, sujeito: gerente, role: "sales" })).not.toContain("template.decisions");
    expect(resolverPolitica({ politica: PADRAO, sujeito: { orgId: "fixture-org", orgName: "Fixture", kind: "broker", splitRecipientId: "sr1", name: "Corretor" } as never, role: null })).not.toContain("template.decisions");
  });

  it("sem a capability a tool nem é oferecida", () => {
    const nomes = ferramentasDoTurno({ identity: gerente, policy: ["deal.list"], texto: "quais decisões dos modelos estão pendentes?" }).entradas.map((e) => e.nome);
    expect(nomes).not.toContain("decisoes_pendentes_modelos");
  });

  it("sem a flag de consultas ampliadas a tool nem é oferecida", () => {
    vi.stubEnv("MAX_EXTENDED_QUERIES", "false");
    const nomes = ferramentasDoTurno({ identity: gerente, policy: ["template.decisions"], texto: "quais decisões dos modelos estão pendentes?" }).entradas.map((e) => e.nome);
    expect(nomes).not.toContain("decisoes_pendentes_modelos");
  });

  it("o vetor do CM não carrega nome de modelo, decisão, quem decidiu nem texto do modelo", () => {
    const corpo = JSON.parse(VETOR_DO_CM) as { items: Record<string, unknown>[] };
    for (const item of corpo.items) for (const k of CHAVES_PROIBIDAS) expect(Object.hasOwn(item, k), k).toBe(false);
  });

  it("negado no servidor (sem naoMedidos) não vira \"nenhuma pendência\"", async () => {
    scope.mockResolvedValue({ items: [], truncated: false });
    const r = await despacharLeituras({
      chamadas: [{ name: "decisoes_pendentes_modelos", args: {} }],
      oferecidas: ["decisoes_pendentes_modelos"], policy: ["template.decisions"], identity: gerente,
      fromPhone: "5511999990001", referencias: null, turno: "t1", agora: 1000,
    });
    expect(r.resultados[0]?.items).toBeNull();
    expect(r.trilha[0]?.outcome).toBe("falha_na_consulta");
  });

  it("o modelo não injeta argumento: a consulta sai sem args", async () => {
    scope.mockResolvedValue({ items: [], truncated: false, naoMedidos: 0 });
    await despacharLeituras({
      chamadas: [{ name: "decisoes_pendentes_modelos", args: { numero: 3, estado: "todas", orgId: "outra" } }],
      oferecidas: ["decisoes_pendentes_modelos"], policy: ["template.decisions"], identity: gerente,
      fromPhone: "5511999990001", referencias: null, turno: "t1", agora: 1000,
    });
    expect(scope).toHaveBeenCalledWith(expect.objectContaining({ verb: "template.decisions", args: {} }));
  });
});

describe("template.decisions — permitido", () => {
  it("a lista de capabilities tem template.decisions no índice 27 (antes de pending.summary e prefs.self)", () => {
    expect(CAPABILITIES).toHaveLength(33);
    expect(CAPABILITIES.indexOf("template.decisions")).toBe(27);
  });

  it("os verbos de leitura são os do CM, literal a literal", () => {
    expect([...VERBOS_DE_LEITURA]).toEqual(VERBOS_DE_LEITURA_DO_CM);
  });

  it("a org que liga a capability recebe a tool, e o catálogo a declara leitura sob a flag", () => {
    const ligada = JSON.parse('{"byRole":{"*":["template.decisions"]}}') as MaxPolicy;
    expect(resolverPolitica({ politica: ligada, sujeito: gerente, role: "sales" })).toEqual(["template.decisions"]);
    const nomes = ferramentasDoTurno({ identity: gerente, policy: ["template.decisions"], texto: "quais decisões dos modelos estão pendentes?" }).entradas.map((e) => e.nome);
    expect(nomes).toContain("decisoes_pendentes_modelos");
    const t = catalog("fixture-org").tools.find((x) => x.id === "template.decisions");
    expect(t).toMatchObject({ effect: "read", executor: "scope-query", permission: "template.decisions", flag: "MAX_EXTENDED_QUERIES", confirmation: false });
  });

  it("o vetor chega ao modelo inteiro, com naoMedidos e na ordem de chaves do CM", async () => {
    const corpo = JSON.parse(VETOR_DO_CM) as { items: unknown[]; naoMedidos: number };
    expect(Object.keys(corpo.items[0] as object)).toEqual(["chave", "rotulo", "modelosAfetados", "link"]);
    scope.mockResolvedValue({ items: corpo.items, truncated: false, naoMedidos: corpo.naoMedidos });
    const r = await despacharLeituras({
      chamadas: [{ name: "decisoes_pendentes_modelos", args: {} }],
      oferecidas: ["decisoes_pendentes_modelos"], policy: ["template.decisions"], identity: gerente,
      fromPhone: "5511999990001", referencias: null, turno: "t1", agora: 1000,
    });
    expect(r.resultados[0]).toEqual({ tool: "decisoes_pendentes_modelos", items: corpo.items, truncated: false, naoMedidos: 1 });
    expect(r.trilha[0]?.outcome).toBe("ok");
  });
});
