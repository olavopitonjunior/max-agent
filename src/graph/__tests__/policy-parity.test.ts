import { describe, it, expect } from "vitest";
import { resolverPolitica, type MaxPolicy } from "../policy";

/**
 * Vetor fixo do contrato de `GET /api/agents/profile` — a metade daqui.
 *
 * A outra metade é
 * `contractmaker/apps/web/src/lib/max/__tests__/policy-parity.test.ts`, com
 * este MESMO literal. É o análogo do `hmac-parity.test.ts` para a regra 1 da
 * governança do Max (`contractmaker/CLAUDE.md`): mudança de contrato exige PR
 * nos dois repos **e teste de vetor fixo dos dois lados**.
 *
 * ── Por que este contrato precisa do vetor tanto quanto o do HMAC ─────────
 *
 * O modo de falha do HMAC é barulhento à sua maneira: 401 em toda chamada, e
 * alguém percebe. O desta rota é **silencioso e assimétrico**: se o ImobPro
 * renomear `brokerDefault`, nada aqui quebra — este código lê um campo ausente,
 * resolve fail-closed, e o corretor comissionado simplesmente para de receber
 * as capabilities que a imobiliária configurou. Sem log, sem erro, sem teste
 * vermelho. Fail-closed é a postura certa e é justamente o que esconde a
 * divergência.
 *
 * O literal abaixo é literal de propósito, e não montado a partir dos tipos: um
 * fixture derivado do próprio código acompanharia a renomeação em silêncio, que
 * é o defeito que ele deveria pegar.
 *
 * ── Duas correções que o code review exigiu neste vetor, e as duas valem
 * registro porque um vetor normativo errado congela o erro nos dois repos:
 *
 * 1. **As chaves de `byRole` são valores REAIS de `OrgMembership.role`** —
 *    `owner | admin | finance | sales | viewer | custom | member`. A primeira
 *    versão usava `"manager"`, que não existe naquele enum.
 * 2. **O `allow` concede algo que o `brokerDefault` NÃO dá.** Antes ele
 *    repetia `deal.pending`, então nenhuma asserção conseguia mostrar que o
 *    caminho de alargamento é lido — a mesma armadilha que este arquivo já
 *    documentava para o `brokerDefault`. E `byRecipient.allow` é a ÚNICA porta
 *    de alargamento do sistema, aplicada justamente a quem não tem RBAC.
 */
const VETOR: MaxPolicy = {
  byRole: {
    admin: ["deal.list", "deal.pending"],
    sales: ["deal.list", "deal.detail", "proposal.list"],
  },
  byRecipient: {
    sr_wesley: { allow: ["deal.list"], deny: ["deal.detail"] },
  },
  brokerDefault: ["deal.pending"],
};

/** O JSON exato que trafega — o mesmo string do teste do outro repo. */
const VETOR_SERIALIZADO =
  '{"byRole":{"admin":["deal.list","deal.pending"],"sales":["deal.list","deal.detail","proposal.list"]},' +
  '"byRecipient":{"sr_wesley":{"allow":["deal.list"],"deny":["deal.detail"]}},' +
  '"brokerDefault":["deal.pending"]}';

const gerente = {
  orgId: "org1",
  orgName: "RE/MAX Trio",
  kind: "user" as const,
  userId: "u1",
  userName: "Marcia",
  role: "admin",
};

const corretor = {
  orgId: "org1",
  orgName: "RE/MAX Trio",
  kind: "broker" as const,
  splitRecipientId: "sr_wesley",
  label: "Wesley",
};

/**
 * Corretor SEM override no vetor — e ele existe por um motivo que só apareceu
 * quando o teste falhou.
 *
 * A primeira versão media "o `brokerDefault` é lido?" pelo Wesley, que TEM
 * override. Como o `allow` dele repete `deal.pending`, remover o
 * `brokerDefault` não mudava nada e o teste passava a afirmar algo que não
 * provava. Quem não tem override depende exclusivamente do `brokerDefault`, e
 * é nele que a chave some quando deixa de ser lida.
 */
const corretorSemOverride = {
  orgId: "org1",
  orgName: "RE/MAX Trio",
  kind: "broker" as const,
  splitRecipientId: "sr_sem_override",
  label: "Outro",
};

describe("paridade do contrato da política (lado max-agent)", () => {
  /**
   * Parsear o JSON CRU, e não o objeto literal: é a rede que está sob teste,
   * não o TypeScript. Se o outro lado mudar um nome de chave, é aqui que
   * aparece.
   */
  it("parseia o vetor serializado exatamente como o ImobPro o emite", () => {
    const politica = JSON.parse(VETOR_SERIALIZADO) as MaxPolicy;

    expect(politica).toEqual(VETOR);
    expect(resolverPolitica({ politica, sujeito: gerente })).toEqual([
      "deal.list",
      "deal.pending",
    ]);
  });

  /**
   * O `allow` do vetor concede `deal.list`, que o `brokerDefault` NÃO dá — é
   * assim que esta asserção prova que o caminho de alargamento está sendo lido.
   */
  it("o override ALARGA além do brokerDefault, e o deny continua soberano", () => {
    const politica = JSON.parse(VETOR_SERIALIZADO) as MaxPolicy;

    expect(resolverPolitica({ politica, sujeito: corretor }).sort()).toEqual([
      "deal.list",
      "deal.pending",
    ]);
  });

  /**
   * **O teste que pega a renomeação silenciosa.**
   *
   * Cada chave é removida por vez, e o resultado tem que MUDAR. Se remover
   * `brokerDefault` não alterasse nada, é porque este lado não a estaria lendo —
   * que é exatamente o estado em que uma renomeação no ImobPro nos deixaria, e
   * que o fail-closed esconderia.
   */
  it.each([
    ["byRole", gerente, ["deal.list", "deal.pending"], [] as string[]],
    ["brokerDefault", corretorSemOverride, ["deal.pending"], [] as string[]],
    // Sem `byRecipient`, o corretor perde o `deal.list` que só o allow dava.
    ["byRecipient", corretor, ["deal.list", "deal.pending"], ["deal.pending"]],
  ] as const)(
    "remover %s muda o resultado — prova que a chave é LIDA",
    (chave, sujeito, comAChave, semAChave) => {
      const completa = JSON.parse(VETOR_SERIALIZADO) as MaxPolicy;
      expect(resolverPolitica({ politica: completa, sujeito }).sort()).toEqual(
        [...comAChave].sort()
      );

      const mutilada = JSON.parse(VETOR_SERIALIZADO) as Record<string, unknown>;
      delete mutilada[chave];
      expect(
        resolverPolitica({ politica: mutilada as MaxPolicy, sujeito }).sort()
      ).toEqual([...semAChave].sort());
    }
  );

  /**
   * A forma VAZIA é a que trafega na maioria das respostas — toda org que nunca
   * configurou nada. Tem que ser objeto com as três chaves, e o resultado tem
   * que ser nenhuma capability.
   */
  it("a forma vazia do outro lado resolve para nenhuma capability", () => {
    const vazia = JSON.parse('{"byRole":{},"byRecipient":{},"brokerDefault":[]}') as MaxPolicy;

    expect(resolverPolitica({ politica: vazia, sujeito: gerente })).toEqual([]);
    expect(resolverPolitica({ politica: vazia, sujeito: corretor })).toEqual([]);
  });

  /** O `deny` do vetor também é lido: ele tira o que o default concederia. */
  it("o deny do vetor tira o que o brokerDefault daria", () => {
    const politica = JSON.parse(VETOR_SERIALIZADO) as MaxPolicy;
    const comDetail = { ...politica, brokerDefault: ["deal.pending", "deal.detail"] };

    expect(resolverPolitica({ politica: comDetail, sujeito: corretor }).sort()).toEqual([
      "deal.list",
      "deal.pending",
    ]);
  });
});
