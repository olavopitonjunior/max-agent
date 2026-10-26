import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

/**
 * O cliente do `scope-query` — e a rede de segurança da regra 5.
 *
 * Dois assuntos distintos moram aqui e não devem ser confundidos:
 *
 * 1. **Fail-closed de rede.** Toda falha vira `null`, nunca lista vazia. Lista
 *    vazia apresentada como fato mentiria para a pessoa sobre a carteira dela;
 *    `null` deixa quem chama dizer "não consegui consultar agora".
 * 2. **Defesa em profundidade da projeção.** A projeção que VALE é a do
 *    servidor. `descartarSeVazou` não a substitui — ela não sabe o que deveria
 *    vir, só o que nunca pode vir. Existe porque, se o ImobPro regredir a
 *    projeção, nenhum teste deste repo pegaria: todos mockam a resposta.
 */

vi.mock("../orgs", () => ({ orgById: vi.fn() }));

const { orgById } = await import("../orgs");
const { consultarEscopo, descartarSeVazou, limparArgs, subjectDe } = await import("../scope");
const { CAMPOS_PROIBIDOS_AO_BROKER } = await import("@/graph/scope-contract");
const mockOrgById = vi.mocked(orgById);

const ORG = { orgId: "org1", orgName: "RE/MAX Trio", apiToken: "cmt_x" } as never;
const PHONE = "+5511999063228";
const SUJEITO = { kind: "user" as const, userId: "u1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockOrgById.mockResolvedValue(ORG);
});
afterEach(() => vi.unstubAllGlobals());

function responde(init: { ok: boolean; status: number; body?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: init.ok,
      status: init.status,
      json: async () => init.body ?? {},
    })) as never
  );
}

describe("consultarEscopo — o caminho feliz", () => {
  it("devolve items e truncated", async () => {
    responde({ ok: true, status: 200, body: { items: [{ id: "d1" }], truncated: true } });
    const r = await consultarEscopo({
      orgId: "org1", rawPhone: PHONE, subject: SUJEITO, verb: "deal.list",
    });
    expect(r).toEqual({ items: [{ id: "d1" }], truncated: true });
  });

  it("manda phone JUNTO do subject — o servidor reconfere o vínculo", async () => {
    responde({ ok: true, status: 200, body: { items: [] } });
    await consultarEscopo({
      orgId: "org1", rawPhone: "(11) 99906-3228", subject: SUJEITO, verb: "deal.list",
    });
    const corpo = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as { body: string }).body
    );
    // O Max NÃO é acreditado a afirmar quem é a pessoa. Sem o telefone, um
    // token de tenant comprometido leria a carteira de qualquer um da org.
    expect(corpo.phone).toBe(PHONE);
    expect(corpo.subject).toEqual(SUJEITO);
  });
});

// ── FAIL-CLOSED DE REDE ────────────────────────────────────────────────────

describe("consultarEscopo — toda falha vira null, nunca lista vazia", () => {
  it.each([
    ["403 — sujeito não confere", 403],
    ["404", 404],
    ["500", 500],
  ])("%s devolve null", async (_n, status) => {
    responde({ ok: false, status });
    expect(
      await consultarEscopo({ orgId: "org1", rawPhone: PHONE, subject: SUJEITO, verb: "deal.list" })
    ).toBeNull();
  });

  it("timeout/exceção devolve null, não lança", async () => {
    // O nó de tools não pode morrer por causa disto — mataria o turn.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")) as never);
    await expect(
      consultarEscopo({ orgId: "org1", rawPhone: PHONE, subject: SUJEITO, verb: "deal.list" })
    ).resolves.toBeNull();
  });

  it("200 com items de forma errada devolve null — não vira lista vazia", async () => {
    responde({ ok: true, status: 200, body: { items: "nada disso" } });
    expect(
      await consultarEscopo({ orgId: "org1", rawPhone: PHONE, subject: SUJEITO, verb: "deal.list" })
    ).toBeNull();
  });

  it("org não configurada e telefone impossível não tocam a rede", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f as never);
    mockOrgById.mockResolvedValue(null as never);
    expect(await consultarEscopo({ orgId: "x", rawPhone: PHONE, subject: SUJEITO, verb: "deal.list" })).toBeNull();
    mockOrgById.mockResolvedValue(ORG);
    expect(await consultarEscopo({ orgId: "org1", rawPhone: "abc", subject: SUJEITO, verb: "deal.list" })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

// ── REGRA 5: AUSÊNCIA, NÃO PRESENÇA ────────────────────────────────────────

describe("descartarSeVazou — defesa em profundidade da projeção", () => {
  it("descarta a linha inteira se QUALQUER campo proibido vier", () => {
    for (const proibido of CAMPOS_PROIBIDOS_AO_BROKER) {
      const item = { id: "d1", etapa: "Documentação", [proibido]: "vazou" };
      // Descarta, não poda: podar produziria um item meio-certo que parece
      // correto no log; descartar produz uma ausência que alguém investiga.
      expect(descartarSeVazou([item], "broker")).toEqual([]);
    }
  });

  it("o item legítimo do broker passa — para o teste acima não ser vacuoso", () => {
    const ok = {
      id: "deal-1", etapa: "Documentação", pendencias: [],
      atualizadoEm: "2026-08-19T14:02:00.000Z", referencia: "Negócio #DEAL-1",
    };
    expect(descartarSeVazou([ok], "broker")).toEqual([ok]);
  });

  it("NÃO mexe no sujeito user — ele PODE ver os campos", () => {
    // A rede é só para broker. Aplicá-la ao usuário apagaria o dado legítimo
    // dele e a feature sumiria com cara de segurança.
    const doUsuario = { id: "d1", titulo: "Apto Rua X", cliente: "Maria", valor: 850000 };
    expect(descartarSeVazou([doUsuario], "user")).toEqual([doUsuario]);
  });

  it("grita alto quando descarta — se isto dispara, o outro lado quebrou", () => {
    descartarSeVazou([{ id: "d1", cliente: "Maria" }], "broker");
    expect(console.error).toHaveBeenCalled();
  });

  it("pega o campo proibido ANINHADO, não só no topo", () => {
    // A projeção de hoje é plana, mas esta função existe para pegar regressão
    // que ela não pode prever — e `deal.detail`/`proposal.detail` são os
    // verbos mais propensos a aninhar dado de cliente sob um sub-objeto.
    expect(descartarSeVazou([{ id: "d1", parte: { cliente: "Maria" } }], "broker")).toEqual([]);
    expect(descartarSeVazou([{ id: "d1", partes: [{ valor: 850000 }] }], "broker")).toEqual([]);
  });

  it("item que não é objeto não quebra a filtragem", () => {
    expect(descartarSeVazou([null, "x", 7], "broker")).toEqual([null, "x", 7]);
  });
});

describe("subjectDe", () => {
  it("deriva o subject dos dois tipos de identidade", () => {
    expect(subjectDe({ kind: "user", userId: "u1", orgId: "o", orgName: "n", userName: null }))
      .toEqual({ kind: "user", userId: "u1" });
    expect(subjectDe({ kind: "broker", splitRecipientId: "sr1", orgId: "o", orgName: "n", label: "W" }))
      .toEqual({ kind: "broker", splitRecipientId: "sr1" });
  });
});

describe("limparArgs — filtro vazio do modelo não derruba a leitura", () => {
  it("estado vazio some — era o 400 de 2026-10-06 (\"status das minhas propostas\")", () => {
    expect(limparArgs({ estado: "", limite: 10 })).toEqual({ limite: 10 });
  });

  it("só espaço, null e undefined também somem; string válida vai aparada", () => {
    expect(limparArgs({ estado: "  ", negocio_id: null, proposta_id: undefined })).toEqual({});
    expect(limparArgs({ estado: " enviada " })).toEqual({ estado: "enviada" });
  });

  it("limite que não é inteiro positivo some; o válido passa", () => {
    expect(limparArgs({ limite: 0 })).toEqual({});
    expect(limparArgs({ limite: -3 })).toEqual({});
    expect(limparArgs({ limite: 2.5 })).toEqual({});
    expect(limparArgs({ limite: "5" })).toEqual({});
    expect(limparArgs({ limite: 5 })).toEqual({ limite: 5 });
  });

  it("estado de negócio é nome de etapa (texto livre): segue intocado", () => {
    expect(limparArgs({ estado: "Em análise" }, "deal.list")).toEqual({ estado: "Em análise" });
    expect(limparArgs({ estado: "qualquer" })).toEqual({ estado: "qualquer" });
    expect(limparArgs(undefined)).toEqual({});
  });

  it("estado de PROPOSTA inventado some — senão a lista vazia vira \"você não tem propostas\"", () => {
    expect(limparArgs({ estado: "todas", limite: 10 }, "proposal.list")).toEqual({ limite: 10 });
    expect(limparArgs({ estado: "pendente" }, "proposal.list")).toEqual({});
  });

  it("estado de proposta válido passa, normalizado", () => {
    expect(limparArgs({ estado: "Enviada" }, "proposal.list")).toEqual({ estado: "enviada" });
    expect(limparArgs({ estado: "falha envio" }, "proposal.list")).toEqual({ estado: "falha_envio" });
    expect(limparArgs({ estado: "expirada" }, "proposal.list")).toEqual({ estado: "expirada" });
  });

  it("o corpo enviado ao servidor já vai limpo", async () => {
    responde({ ok: true, status: 200, body: { items: [], truncated: false } });
    await consultarEscopo({
      orgId: "org1",
      rawPhone: PHONE,
      subject: SUJEITO,
      verb: "proposal.list",
      args: { estado: "", limite: 10 },
    });
    const init = vi.mocked(fetch).mock.calls[0]![1] as { body: string };
    expect(JSON.parse(init.body).args).toEqual({ limite: 10 });
  });
});

/**
 * Espelho LITERAL do `bodySchema.args` do `POST /api/agents/scope-query`
 * (contractmaker `apps/web/src/app/api/agents/scope-query/route.ts`). Literal de
 * propósito: um fixture derivado do código acompanharia o desvio em silêncio.
 * Argumento que não passa aqui é 400 no servidor, e 400 vira `null` no cliente =
 * "a consulta não respondeu agora" (o `falha_na_consulta` de `listar_propostas`).
 */
const ARGS_DO_SERVIDOR = z.object({
  cursor: z.string().min(1).max(512).optional(),
  imovel_id: z.string().min(1).max(128).optional(),
  estado: z.string().min(1).optional(),
  opcoes_etapas: z.boolean().optional(),
  limite: z.number().int().positive().optional(),
  negocio_id: z.string().min(1).optional(),
  proposta_id: z.string().min(1).optional(),
  atividade_id: z.string().min(1).max(64).optional(),
  filtro: z.enum(["minhas", "atrasadas", "hoje", "formularios", "propostas", "atividades"]).optional(),
  blocos: z.array(z.enum(["formularios", "propostas", "atividades"])).max(3).optional(),
  dealId: z.string().min(1).max(128).optional(),
});

describe("proposal.list — o que o modelo manda nunca vira 400 no servidor", () => {
  // Formas que o nano já produziu ou pode produzir para a tool `listar_propostas`
  // (schema: só `estado` string e `limite` inteiro; `additionalProperties:false` NÃO é imposto no despacho).
  it.each([
    ["estado como lista", { estado: ["enviada", "entregue"], limite: 10 }],
    ["estado numérico", { estado: 2 }],
    ["estado objeto", { estado: { valor: "enviada" } }],
    ["estado booleano", { estado: true }],
    ["filtro inventado", { estado: "enviada", filtro: "abertas" }],
    ["blocos fora do enum", { blocos: ["tudo"] }],
    ["cursor gigante", { cursor: "x".repeat(600) }],
    ["campos de outras tools", { numero: 2, mais: true, atividade_id: "x".repeat(80), imovel_id: "y".repeat(200) }],
    ["opcoes_etapas em texto", { opcoes_etapas: "sim" }],
    ["dealId gigante", { dealId: "z".repeat(300) }],
  ])("%s", async (_nome, args) => {
    responde({ ok: true, status: 200, body: { items: [], truncated: false } });
    await consultarEscopo({ orgId: "org1", rawPhone: PHONE, subject: SUJEITO, verb: "proposal.list", args });
    const init = vi.mocked(fetch).mock.calls[0]![1] as { body: string };
    const enviado = JSON.parse(init.body).args as Record<string, unknown>;
    expect(ARGS_DO_SERVIDOR.safeParse(enviado).success).toBe(true);
    // Só o que a tool declara chega ao servidor.
    expect(Object.keys(enviado).every((k) => ["estado", "limite"].includes(k))).toBe(true);
  });

  it("estado válido e limite válido continuam passando", () => {
    expect(limparArgs({ estado: "Assinada Proponente", limite: 5, filtro: "x" }, "proposal.list")).toEqual({
      estado: "assinada_proponente",
      limite: 5,
    });
  });

  it("proposal.detail só leva proposta_id", () => {
    expect(limparArgs({ proposta_id: " p1 ", estado: "enviada", numero: 3 }, "proposal.detail")).toEqual({ proposta_id: "p1" });
  });
});

describe("etapas inválidas não são resultados vazios",()=>{
 it("preserva opções válidas sem confundir com itens",async()=>{
  responde({ok:true,status:200,body:{items:[],clarification:{field:"estado",options:["Formulário"]}}});
  expect(await consultarEscopo({orgId:"org1",rawPhone:PHONE,subject:SUJEITO,verb:"deal.list"})).toEqual({items:[],truncated:false,clarification:{field:"estado",options:["Formulário"]}});
 });
 it.each([{field:"estado",options:[42]},{field:"estado",options:["a\nb"]},{field:"estado",options:Array(51).fill("A")},{field:"wrong",options:[]}])("recusa opções malformadas",async clarification=>{
  responde({ok:true,status:200,body:{items:[],clarification}});
  expect(await consultarEscopo({orgId:"org1",rawPhone:PHONE,subject:SUJEITO,verb:"deal.list"})).toBeNull();
 });
});
