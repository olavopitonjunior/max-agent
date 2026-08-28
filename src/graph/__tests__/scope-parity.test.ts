import { describe, it, expect } from "vitest";
import {
  CAMPOS_PROIBIDOS_AO_BROKER,
  type DealProjetadoBroker,
  type DealProjetadoUser,
  type ScopeQueryRequest,
  type ScopeQueryResponse,
} from "../scope-contract";

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
