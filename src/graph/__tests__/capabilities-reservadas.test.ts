import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { CAPABILITIES, resolverPolitica, type Capability, type MaxPolicy } from "../policy";
import { VERBOS_DE_LEITURA } from "../scope-contract";
import { VERBOS_DE_ACAO } from "@/lib/acao";
import { catalog, CAPABILITIES_RESERVADAS } from "@/lib/runtime/catalog";
import { REGISTRO_DE_TOOLS, capabilitiesDeOferta, ferramentasDoTurno, selecionarTools } from "../tools";

/**
 * PR-O4cat (16/11/2026, par do contractmaker `feat/max-o4cat`): `certidao.status`,
 * `document.list` e `charge.status` entram no catálogo nas posições 34, 35 e 36,
 * INERTES: "reservada, verbo não implementado, nasce OFF". Nenhuma tool, nenhum verbo,
 * fora do padrão e do `brokerDefault`. Ligar uma delas na política (a org em
 * `/admin/max`) não pode oferecer nada ao modelo enquanto não houver verbo.
 *
 * PR-O4b (16/11/2026): `certidao.status` GANHOU verbo e tool (`situacao_certidoes`) e SAI da
 * lista de reservadas. Continua na posição 34, fora do padrão e do `brokerDefault`. Ficam
 * reservadas `document.list` e `charge.status`: o que vale para elas abaixo não mudou.
 *
 * PR-O4c (16/11/2026): `document.list` GANHOU verbo e tool (`listar_documentos`) e SAI da lista de
 * reservadas. Continua na posição 35, fora do padrão e do `brokerDefault`. Só `charge.status` segue
 * reservada (sem verbo, sem tool).
 *
 * Os literais abaixo são copiados do CM, de propósito (regra 1 da governança do Max):
 * derivar da constante deste lado acompanharia uma divergência em silêncio.
 */
const CATALOGO_34_A_36 = ["certidao.status", "document.list", "charge.status"] as const;
/** O que continua reservado (sem verbo, sem tool) depois do PR-O4c. */
const RESERVADAS = ["charge.status"] as const;

/** `POLITICA_PADRAO` do CM, como a rota `/api/agents/profile` a emite. */
const PADRAO_DO_CM: MaxPolicy = JSON.parse(
  '{"byRole":{"*":["deal.list","deal.pending","proposal.list","form.create","proposal.create","proposal.send","proposal.delete"]},' +
    '"byRecipient":{},"brokerDefault":["deal.list","deal.pending"]}'
) as MaxPolicy;

const gerente = { orgId: "org1", orgName: "Imob", kind: "user" as const, userId: "u1", userName: "Marcia" };
const corretor = {
  orgId: "org1",
  orgName: "Imob",
  kind: "broker" as const,
  splitRecipientId: "sr1",
  label: "Rui",
};

describe("capabilities reservadas do PR-O4cat (inertes)", () => {
  it("estão no catálogo, ao FIM e nesta ordem: posições 34, 35 e 36 (0-based)", () => {
    expect(CAPABILITIES).toHaveLength(37);
    expect(CAPABILITIES.slice(34)).toEqual([...CATALOGO_34_A_36]);
    CATALOGO_34_A_36.forEach((c, i) => expect(CAPABILITIES.indexOf(c)).toBe(34 + i));
  });

  it("certidao.status e document.list saíram da lista de reservadas (têm verbo e tool); só charge.status fica", () => {
    expect([...CAPABILITIES_RESERVADAS]).toEqual([...RESERVADAS]);
    expect(CAPABILITIES_RESERVADAS).not.toContain("certidao.status");
    expect(CAPABILITIES_RESERVADAS).not.toContain("document.list");
    expect(VERBOS_DE_LEITURA as readonly string[]).toContain("certidao.status");
    expect(VERBOS_DE_LEITURA as readonly string[]).toContain("document.list");
  });

  it("o padrão do CM espelhado no MA não concede nenhuma das 3", () => {
    for (const role of ["owner", "admin", "finance", "sales", "viewer", "member", "custom:cr_x"]) {
      const efetivas = resolverPolitica({ politica: PADRAO_DO_CM, sujeito: gerente, role });
      for (const c of CATALOGO_34_A_36) expect(efetivas).not.toContain(c);
    }
  });

  it("brokerDefault não contém; o corretor comissionado não recebe nenhuma das 3", () => {
    for (const c of CATALOGO_34_A_36) expect(PADRAO_DO_CM.brokerDefault).not.toContain(c);
    const efetivas = resolverPolitica({ politica: PADRAO_DO_CM, sujeito: corretor, role: null });
    for (const c of CATALOGO_34_A_36) expect(efetivas).not.toContain(c);
  });

  it("são concedíveis (conhecidas): a org que liga em /admin/max as vê na política efetiva", () => {
    const ligada = JSON.parse(
      '{"byRole":{"*":["deal.list","certidao.status","document.list","charge.status"]}}'
    ) as MaxPolicy;
    expect(resolverPolitica({ politica: ligada, sujeito: gerente, role: "sales" })).toEqual([
      "deal.list",
      "certidao.status",
      "document.list",
      "charge.status",
    ]);
  });

  describe("nenhuma tool é oferecida por elas (não existe tool nova)", () => {
    const ligada = JSON.parse(
      '{"byRole":{"*":["deal.list","charge.status"]}}'
    ) as MaxPolicy;
    const semElas = JSON.parse('{"byRole":{"*":["deal.list"]}}') as MaxPolicy;
    const so1 = JSON.parse('{"byRole":{"*":["charge.status"]}}') as MaxPolicy;

    const efetivas = (p: MaxPolicy): Capability[] => resolverPolitica({ politica: p, sujeito: gerente, role: "sales" });

    // Texto largo de propósito: casa o prefiltro de tudo que fala de certidão, documento,
    // cobrança, negócio, proposta, atividade e imóvel.
    const TEXTO =
      "status das certidões, lista de documentos e status da cobrança do negócio, " +
      "propostas, atividades, pendências, contrato e imóvel";

    // A consulta nova (extended) só é oferecida com o rollout da org E a flag: liga os dois
    // para que "não muda a oferta" seja uma afirmação de verdade, e não efeito de flag desligada.
    beforeEach(() => {
      vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ org1: ["queries"] }));
      vi.stubEnv("MAX_EXTENDED_QUERIES", "true");
    });
    afterEach(() => vi.unstubAllEnvs());

    it("nenhuma entrada do registro declara uma delas como capability", () => {
      for (const e of REGISTRO_DE_TOOLS) {
        for (const c of capabilitiesDeOferta(e)) expect(RESERVADAS as readonly string[]).not.toContain(c);
      }
    });

    it("nenhum verbo (ação ou leitura) tem o nome delas", () => {
      for (const c of RESERVADAS) {
        expect(VERBOS_DE_ACAO as readonly string[]).not.toContain(c);
        expect(VERBOS_DE_LEITURA as readonly string[]).not.toContain(c);
      }
    });

    it("o catálogo de runtime não tem tool, permissão nem política ligadas a elas", () => {
      const tools = catalog("org1").tools;
      for (const c of RESERVADAS) {
        expect(tools.find((t) => t.id === c)).toBeUndefined();
        expect(tools.filter((t) => t.permission === c || t.policyCapability === c)).toEqual([]);
      }
    });

    it("ligar a reservada na política não muda a oferta: selecionarTools devolve o mesmo com e sem ela", () => {
      const com = selecionarTools({ policy: efetivas(ligada), texto: TEXTO, orgId: "org1" });
      const sem = selecionarTools({ policy: efetivas(semElas), texto: TEXTO, orgId: "org1" });
      expect(com.tools.map((t) => t.nome)).toEqual(sem.tools.map((t) => t.nome));
      expect(com.cortadas).toBe(sem.cortadas);
    });

    it("ligar a reservada não muda a oferta do turno (escrita + leitura), nem com a política só com ela", () => {
      const nomes = (p: MaxPolicy): string[] =>
        ferramentasDoTurno({ policy: efetivas(p), texto: TEXTO, identity: gerente }).entradas.map((e) => e.nome);
      expect(nomes(ligada)).toEqual(nomes(semElas));
      expect(nomes(so1)).toEqual([]);
    });

    it("certidao.status NÃO é mais inerte: ligada na política, com rollout e flag, oferece situacao_certidoes", () => {
      const comCertidao = JSON.parse('{"byRole":{"*":["certidao.status"]}}') as MaxPolicy;
      const nomes = ferramentasDoTurno({ policy: efetivas(comCertidao), texto: TEXTO, identity: gerente }).entradas.map((e) => e.nome);
      expect(nomes).toEqual(["situacao_certidoes"]);
    });

    it("document.list NÃO é mais inerte: ligada na política, com rollout e flag, oferece listar_documentos", () => {
      const comDocumentos = JSON.parse('{"byRole":{"*":["document.list"]}}') as MaxPolicy;
      const nomes = ferramentasDoTurno({ policy: efetivas(comDocumentos), texto: TEXTO, identity: gerente }).entradas.map((e) => e.nome);
      expect(nomes).toEqual(["listar_documentos"]);
    });
  });
});
