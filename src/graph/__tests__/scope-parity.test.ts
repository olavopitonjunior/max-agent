import { describe, it, expect, vi } from "vitest";
import {
  CAMPOS_PROIBIDOS_AO_BROKER,
  type DealProjetadoBroker,
  type DealProjetadoUser,
  type ScopeQueryRequest,
  type ScopeQueryResponse,
  VERBOS_DE_LEITURA,
} from "../scope-contract";
import { catalog, executableTool } from "@/lib/runtime/catalog";
import { VETOR_CERTIDAO_STATUS_USER } from "./certidao-status-vectors";
import { lerCertidaoStatus, CHAVES_DE_CERTIDAO_STATUS } from "../certidao-status";
import { VETOR_DOCUMENT_LIST_USER } from "./documentos-vectors";
import { lerDocumento, CHAVES_DE_DOCUMENTO } from "../documentos";

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
 * `certidao.status` (PR-O4b, 16/11/2026) vem depois de `pending.summary`; `document.list` (PR-O4c) é o último.
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
  "certidao.status",
  "document.list",
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
 * `certidao.status` (PR-O4b): vetor fixo copiado byte a byte do CM
 * (`apps/web/src/lib/max/__tests__/query-vectors.ts`, chave `certidao.status.user`, com `modelo`).
 * Só a forma do usuário: o corretor comissionado nunca recebe o verbo (o servidor responde
 * `{"items":[]}`), então não há vetor de corretor.
 */
describe("paridade do vetor certidao.status", () => {
  const corpo = JSON.parse(VETOR_CERTIDAO_STATUS_USER) as { items: Array<Record<string, unknown>>; truncated: unknown };

  it("certidao.status é leitura, atrás de MAX_EXTENDED_QUERIES (nasce desligada), com a capability de mesmo nome", () => {
    const t = catalog("org1").tools.find((x) => x.id === "certidao.status");
    expect(t).toMatchObject({
      executor: "scope-query",
      effect: "read",
      flag: "MAX_EXTENDED_QUERIES",
      permission: "certidao.status",
      policyCapability: "certidao.status",
    });
    vi.stubEnv("MAX_EXTENDED_QUERIES", "false");
    try {
      expect(executableTool("certidao.status", "scope-query", "org1")).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a ordem das chaves do item é a do CM (o corpo HTTP a preserva)", () => {
    for (const it of corpo.items) expect(Object.keys(it)).toEqual([...CHAVES_DE_CERTIDAO_STATUS]);
    expect(Object.keys(corpo)).toEqual(["items", "truncated"]);
    expect(corpo.truncated).toBe(false);
  });

  it("parse ESTRITO: cada item do vetor é aceito e reserializa idêntico", () => {
    const lidos = corpo.items.map((it) => lerCertidaoStatus(it));
    expect(lidos.every((x) => x !== null)).toBe(true);
    expect(JSON.stringify({ items: lidos, truncated: corpo.truncated })).toBe(VETOR_CERTIDAO_STATUS_USER);
  });

  it("parse ESTRITO: qualquer chave a mais, a menos ou de tipo errado é recusada, nunca repassada", () => {
    for (const it of corpo.items) {
      expect(lerCertidaoStatus({ ...it, novoCampo: 1 })).toBeNull();
      for (const k of Object.keys(it)) {
        const sem = { ...it };
        delete sem[k];
        expect(lerCertidaoStatus(sem), `sem ${k}`).toBeNull();
      }
    }
    expect(lerCertidaoStatus(null)).toBeNull();
    expect(lerCertidaoStatus("texto")).toBeNull();
    expect(lerCertidaoStatus([])).toBeNull();
  });
});

/**
 * `document.list` (PR-O4c): vetor fixo copiado byte a byte do CM
 * (`apps/web/src/lib/max/__tests__/query-vectors.ts`, chave `document.list.user`).
 * Só a forma do usuário: o corretor comissionado nunca recebe o verbo (o servidor responde
 * `{"items":[]}`), então não há vetor de corretor.
 */
describe("paridade do vetor document.list", () => {
  const corpo = JSON.parse(VETOR_DOCUMENT_LIST_USER) as { items: Array<Record<string, unknown>>; truncated: unknown };

  it("document.list é leitura, atrás de MAX_EXTENDED_QUERIES (nasce desligada), com a capability de mesmo nome", () => {
    const t = catalog("org1").tools.find((x) => x.id === "document.list");
    expect(t).toMatchObject({
      executor: "scope-query",
      effect: "read",
      flag: "MAX_EXTENDED_QUERIES",
      permission: "document.list",
      policyCapability: "document.list",
    });
    vi.stubEnv("MAX_EXTENDED_QUERIES", "false");
    try {
      expect(executableTool("document.list", "scope-query", "org1")).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a ordem das chaves do item é a do CM (o corpo HTTP a preserva)", () => {
    for (const it of corpo.items) expect(Object.keys(it)).toEqual([...CHAVES_DE_DOCUMENTO]);
    expect(Object.keys(corpo)).toEqual(["items", "truncated"]);
    expect(corpo.truncated).toBe(false);
  });

  it("parse ESTRITO: cada item do vetor é aceito e reserializa idêntico", () => {
    const lidos = corpo.items.map((it) => lerDocumento(it));
    expect(lidos.every((x) => x !== null)).toBe(true);
    expect(JSON.stringify({ items: lidos, truncated: corpo.truncated })).toBe(VETOR_DOCUMENT_LIST_USER);
  });

  it("parse ESTRITO: qualquer chave a mais ou a menos é recusada, nunca repassada", () => {
    for (const it of corpo.items) {
      expect(lerDocumento({ ...it, url: "https://x/y.pdf" })).toBeNull();
      for (const k of Object.keys(it)) {
        const sem = { ...it };
        delete sem[k];
        expect(lerDocumento(sem), `sem ${k}`).toBeNull();
      }
    }
    expect(lerDocumento(null)).toBeNull();
    expect(lerDocumento("texto")).toBeNull();
    expect(lerDocumento([])).toBeNull();
  });
});
