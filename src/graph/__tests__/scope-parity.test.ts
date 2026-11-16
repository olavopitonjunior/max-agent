import { describe, it, expect, vi } from "vitest";
import {
  CAMPOS_PROIBIDOS_AO_BROKER,
  lerDealDetalhado,
  type DealDetalhadoBroker,
  type DealDetalhadoUser,
  type DealProjetadoBroker,
  type DealProjetadoUser,
  type ScopeQueryRequest,
  type ScopeQueryResponse,
  VERBOS_DE_LEITURA,
} from "../scope-contract";
import { catalog, executableTool } from "@/lib/runtime/catalog";
import { VETOR_DEAL_DETAIL_BROKER, VETOR_DEAL_DETAIL_USER } from "./deal-detail-vectors";

/**
 * Vetor fixo do contrato de `POST /api/agents/scope-query` — a metade daqui.
 *
 * A outra metade é
 * `contractmaker/apps/web/src/lib/max/__tests__/scope-parity.test.ts`, com
 * estes MESMOS literais. É o análogo do `policy-parity.test.ts` para a regra 1
 * da governança do Max: mudança de contrato exige PR nos dois repos **e teste
 * de vetor fixo dos dois lados**.
 *
 * Mora em `src/graph/` e não em `src/lib/` porque é contrato de **forma** (como
 * o da política), não de **transporte** (como o do HMAC).
 *
 * ⚠️ **A ordem das chaves importa** nas asserções de string. `projetarDeal` no
 * ImobPro monta `{ ...comum, referencia }` e `{ ...comum, titulo, cliente,
 * valor }` — os campos comuns primeiro, nesta ordem. Se alguém reordenar lá, a
 * comparação de fio quebra aqui, que é exatamente o ponto: `jsonb` não preserva
 * ordem, mas o corpo HTTP preserva, e é do corpo que este vetor fala.
 */

const REQUEST: ScopeQueryRequest = {
  verb: "deal.list",
  subject: { kind: "broker", splitRecipientId: "sr_wesley" },
  phone: "+5511987654321",
  args: { estado: "ativo", limite: 10 },
};

const REQUEST_SERIALIZADO =
  '{"verb":"deal.list","subject":{"kind":"broker","splitRecipientId":"sr_wesley"},' +
  '"phone":"+5511987654321","args":{"estado":"ativo","limite":10}}';

/** A projeção do BROKER — menos campos, mesmo verbo. */
const ITEM_BROKER: DealProjetadoBroker = {
  id: "deal-1",
  etapa: "Documentação",
  pendencias: ["certidão de ônus"],
  atualizadoEm: "2026-08-19T14:02:00.000Z",
  referencia: "Negócio #DEAL-1",
};

const ITEM_BROKER_SERIALIZADO =
  '{"id":"deal-1","etapa":"Documentação","pendencias":["certidão de ônus"],' +
  '"atualizadoEm":"2026-08-19T14:02:00.000Z","referencia":"Negócio #DEAL-1"}';

/** A projeção do USUÁRIO — mesmo verbo, mais campos. */
const ITEM_USER: DealProjetadoUser = {
  id: "deal-1",
  etapa: "Documentação",
  pendencias: ["certidão de ônus"],
  atualizadoEm: "2026-08-19T14:02:00.000Z",
  titulo: "Apto Rua das Flores, 123 — apto 42",
  cliente: "Maria Silva",
  valor: 850000,
};

const ITEM_USER_SERIALIZADO =
  '{"id":"deal-1","etapa":"Documentação","pendencias":["certidão de ônus"],' +
  '"atualizadoEm":"2026-08-19T14:02:00.000Z","titulo":"Apto Rua das Flores, 123 — apto 42",' +
  '"cliente":"Maria Silva","valor":850000}';

describe("paridade do contrato de scope-query", () => {
  it("o request serializa exatamente como o vetor", () => {
    expect(JSON.stringify(REQUEST)).toBe(REQUEST_SERIALIZADO);
  });

  it("a projeção do broker serializa exatamente como o vetor", () => {
    expect(JSON.stringify(ITEM_BROKER)).toBe(ITEM_BROKER_SERIALIZADO);
  });

  it("a projeção do usuário serializa exatamente como o vetor", () => {
    expect(JSON.stringify(ITEM_USER)).toBe(ITEM_USER_SERIALIZADO);
  });

  it("o vetor do broker NÃO contém nenhum campo proibido", () => {
    // Ausência, não presença: um teste de presença continua verde no dia em que
    // o ImobPro acrescenta um campo novo à projeção do broker.
    for (const proibido of CAMPOS_PROIBIDOS_AO_BROKER) {
      expect(ITEM_BROKER).not.toHaveProperty(proibido);
      expect(ITEM_BROKER_SERIALIZADO).not.toContain(`"${proibido}"`);
    }
  });

  it("o vetor do broker não carrega endereço, cliente nem valor no fio", () => {
    expect(ITEM_BROKER_SERIALIZADO).not.toContain("Rua das Flores");
    expect(ITEM_BROKER_SERIALIZADO).not.toContain("Maria Silva");
    expect(ITEM_BROKER_SERIALIZADO).not.toContain("850000");
  });

  it("a resposta envelopa em items, com truncated opcional", () => {
    const resposta: ScopeQueryResponse<DealProjetadoBroker> = {
      items: [ITEM_BROKER],
      truncated: false,
    };
    expect(JSON.stringify(resposta)).toBe(
      `{"items":[${ITEM_BROKER_SERIALIZADO}],"truncated":false}`
    );
  });
});

/**
 * Os verbos de leitura, literal do `VERBOS_DE_LEITURA` do ImobPro
 * (`contractmaker/apps/web/src/lib/max/`). Literal de propósito: derivar da
 * constante deste lado acompanharia uma divergência em silêncio. Verbo que o
 * ImobPro aceita e este lado não conhece nunca é chamado; o contrário volta 400.
 * `pending.summary` (24/10/2026) é o último.
 */
const VERBOS_DE_LEITURA_DO_IMOBPRO = [
  "deal.list",
  "deal.detail",
  "deal.pending",
  "proposal.list",
  "proposal.detail",
  "notification.list",
  "activity.list",
  "activity.get",
  "metrics.get",
  "property.list",
  "property.detail",
  "contract.status",
  "template.decisions",
  "pending.summary",
];

describe("paridade dos verbos de leitura", () => {
  it("é a mesma lista, na mesma ordem, dos dois lados", () => {
    expect([...VERBOS_DE_LEITURA]).toEqual(VERBOS_DE_LEITURA_DO_IMOBPRO);
  });

  it("pending.summary está no catálogo como leitura, SEM flag (o gate é a capability), com a capability de mesmo nome", () => {
    const t = catalog("org1").tools.find((x) => x.id === "pending.summary");
    expect(t).toMatchObject({
      executor: "scope-query",
      effect: "read",
      enabled: true,
      status: "current",
      permission: "pending.summary",
      policyCapability: "pending.summary",
    });
    expect(t).not.toHaveProperty("flag");
  });

  it("pending.summary executa com MAX_EXTENDED_QUERIES desligada; activity.list não", () => {
    vi.stubEnv("MAX_EXTENDED_QUERIES", "false");
    try {
      expect(executableTool("pending.summary", "scope-query", "org1")).toBeDefined();
      expect(executableTool("activity.list", "scope-query", "org1")).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("os outros verbos de consulta nova continuam atrás de MAX_EXTENDED_QUERIES", () => {
    const t = catalog("org1").tools.find((x) => x.id === "activity.list");
    expect(t).toMatchObject({ flag: "MAX_EXTENDED_QUERIES" });
  });
});

/**
 * `deal.detail` enriquecido (PR-O4a): os literais vivem em `deal-detail-vectors.ts`,
 * copiados byte a byte do `query-vectors.ts` do contractmaker (#3167).
 */
describe("paridade de deal.detail (vetores do CM #3167)", () => {
  const user = JSON.parse(VETOR_DEAL_DETAIL_USER) as ScopeQueryResponse<DealDetalhadoUser>;
  const broker = JSON.parse(VETOR_DEAL_DETAIL_BROKER) as ScopeQueryResponse<DealDetalhadoBroker>;

  it("o vetor do usuário re-serializa idêntico (ordem de chave do contrato)", () => {
    expect(JSON.stringify(user)).toBe(VETOR_DEAL_DETAIL_USER);
  });

  it("o vetor do broker re-serializa idêntico (ordem de chave do contrato)", () => {
    expect(JSON.stringify(broker)).toBe(VETOR_DEAL_DETAIL_BROKER);
  });

  it("o detalhe do usuário começa pelas 7 chaves de deal.list, na mesma ordem", () => {
    expect(Object.keys(user.items[0]).slice(0, 7)).toEqual(Object.keys(ITEM_USER));
    expect(Object.keys(user.items[0]).slice(7)).toEqual(["tipo", "partes", "contrato", "proposta", "assinatura", "link"]);
  });

  it("o vetor do broker NÃO contém nenhum campo proibido (ausência, em qualquer profundidade)", () => {
    for (const proibido of [...CAMPOS_PROIBIDOS_AO_BROKER, "nome", "link", "proposta", "url"]) {
      expect(VETOR_DEAL_DETAIL_BROKER).not.toContain(`"${proibido}"`);
    }
    expect(VETOR_DEAL_DETAIL_BROKER).not.toMatch(/Maria|João|Apto Centro|850000/);
  });

  it("o parser aceita os dois vetores, do jeito que vieram", () => {
    expect(lerDealDetalhado(user.items[0], "user")).toEqual(user.items[0]);
    expect(lerDealDetalhado(broker.items[0], "broker")).toEqual(broker.items[0]);
  });

  it("a mesma resposta em outro sujeito NÃO é aceita (user lê com forma de broker e vice-versa)", () => {
    expect(lerDealDetalhado(user.items[0], "broker")).toBeNull();
    expect(lerDealDetalhado(broker.items[0], "user")).toBeNull();
  });
});

describe("lerDealDetalhado — parse defensivo (chave extra é removida; obrigatória ausente derruba)", () => {
  const user = JSON.parse(VETOR_DEAL_DETAIL_USER).items[0] as Record<string, unknown>;
  const broker = JSON.parse(VETOR_DEAL_DETAIL_BROKER).items[0] as Record<string, unknown>;

  // O CM pode ganhar campo ADITIVO: isso não pode derrubar o Max em produção. O parse monta o objeto
  // campo a campo a partir da allowlist, então a chave extra nunca é copiada nem renderizada.
  it.each([
    ["cpf no topo (user)", { ...user, cpf: "52998224725" }, "user", user],
    ["cpf no topo (broker)", { ...broker, cpf: "52998224725" }, "broker", broker],
    ["email, url e dataJson no topo (user)", { ...user, email: "a@b.c", url: "https://x", dataJson: { a: 1 } }, "user", user],
    [
      "email aninhado em partes (user)",
      { ...user, partes: [{ papel: "vendedor", nome: "João Souza", email: "a@b.c" }, { papel: "comprador", nome: "Maria Silva", cpf: "52998224725" }] },
      "user",
      user,
    ],
    [
      "nome aninhado em partes (broker)",
      { ...broker, partes: [{ papel: "vendedor", nome: "João Souza" }, { papel: "comprador", cpf: "52998224725" }] },
      "broker",
      broker,
    ],
    ["campo extra em contrato", { ...user, contrato: { ...(user.contrato as object), url: "https://x" } }, "user", user],
    ["campo extra em proposta", { ...user, proposta: { ...(user.proposta as object), cpf: "52998224725" } }, "user", user],
    ["campo extra em assinatura (user)", { ...user, assinatura: { ...(user.assinatura as object), signatarios: ["a"] } }, "user", user],
    ["campo extra em assinatura (broker)", { ...broker, assinatura: { ...(broker.assinatura as object), signatarios: ["a"] } }, "broker", broker],
    ["link e titulo no broker", { ...broker, link: "/deals/deal-1", titulo: "Apto" }, "broker", broker],
  ] as const)("%s -> item mantido, chave extra ausente do objeto parseado", (_t, item, kind, esperado) => {
    const lido = lerDealDetalhado(item, kind);
    expect(lido).toEqual(esperado);
    expect(JSON.stringify(lido)).not.toMatch(/52998224725|a@b\.c|https:\/\/x|dataJson|signatarios/);
    if (kind === "broker") expect(JSON.stringify(lido)).not.toMatch(/João|titulo|"link"|Apto/);
  });

  it("chave obrigatória ausente derruba o item (fail-closed), em qualquer nível", () => {
    const sem = (o: Record<string, unknown>, k: string) => Object.fromEntries(Object.entries(o).filter(([c]) => c !== k));
    const casos: [string, unknown, "user" | "broker"][] = [
      ["id", sem(user, "id"), "user"],
      ["link (user)", sem(user, "link"), "user"],
      ["referencia (broker)", sem(broker, "referencia"), "broker"],
      ["partes[].nome (user)", { ...user, partes: [{ papel: "vendedor" }] }, "user"],
      ["partes[].papel (broker)", { ...broker, partes: [{}] }, "broker"],
      ["contrato.versao", { ...user, contrato: sem(user.contrato as Record<string, unknown>, "versao") }, "user"],
      ["assinatura.total", { ...user, assinatura: sem(user.assinatura as Record<string, unknown>, "total") }, "user"],
      ["assinatura.pendentes (broker)", { ...broker, assinatura: sem(broker.assinatura as Record<string, unknown>, "pendentes") }, "broker"],
    ];
    for (const [, item, kind] of casos) expect(lerDealDetalhado(item, kind)).toBeNull();
  });

  it.each([
    ["sem etapa", (({ etapa: _e, ...r }) => r)(user)],
    ["pendencias não é lista", { ...user, pendencias: "x" }],
    ["tipo desconhecido", { ...user, tipo: "permuta" }],
    ["contagem negativa", { ...user, assinatura: { ...(user.assinatura as object), pendentes: -1 } }],
    ["contagem decimal", { ...user, assinatura: { ...(user.assinatura as object), total: 1.5 } }],
    ["versão não numérica", { ...user, contrato: { ...(user.contrato as object), versao: "2" } }],
  ])("forma inválida (%s) -> null", (_t, item) => {
    expect(lerDealDetalhado(item, "user")).toBeNull();
  });

  it.each([null, undefined, "x", 3, [], [{}]])("não-objeto %j -> null", (v) => {
    expect(lerDealDetalhado(v, "user")).toBeNull();
    expect(lerDealDetalhado(v, "broker")).toBeNull();
  });

  it("null em contrato, proposta e assinatura é válido (a chave existe, o valor é null)", () => {
    expect(lerDealDetalhado({ ...user, contrato: null, proposta: null, assinatura: null }, "user")).not.toBeNull();
    expect(lerDealDetalhado({ ...broker, contrato: null, assinatura: null }, "broker")).not.toBeNull();
  });
});
