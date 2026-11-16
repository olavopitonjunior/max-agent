import { describe, it, expect, afterEach } from "vitest";
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
 * Os literais abaixo são copiados do CM, de propósito (regra 1 da governança do Max):
 * derivar da constante deste lado acompanharia uma divergência em silêncio.
 */
const RESERVADAS = ["certidao.status", "document.list", "charge.status"] as const;

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
    expect(CAPABILITIES.slice(34)).toEqual([...RESERVADAS]);
    RESERVADAS.forEach((c, i) => expect(CAPABILITIES.indexOf(c)).toBe(34 + i));
    expect([...CAPABILITIES_RESERVADAS]).toEqual([...RESERVADAS]);
  });

  it("o padrão do CM espelhado no MA não concede nenhuma das 3", () => {
    for (const role of ["owner", "admin", "finance", "sales", "viewer", "member", "custom:cr_x"]) {
      const efetivas = resolverPolitica({ politica: PADRAO_DO_CM, sujeito: gerente, role });
      for (const c of RESERVADAS) expect(efetivas).not.toContain(c);
    }
  });

  it("brokerDefault não contém; o corretor comissionado não recebe nenhuma das 3", () => {
    for (const c of RESERVADAS) expect(PADRAO_DO_CM.brokerDefault).not.toContain(c);
    const efetivas = resolverPolitica({ politica: PADRAO_DO_CM, sujeito: corretor, role: null });
    for (const c of RESERVADAS) expect(efetivas).not.toContain(c);
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
      '{"byRole":{"*":["deal.list","certidao.status","document.list","charge.status"]}}'
    ) as MaxPolicy;
    const semElas = JSON.parse('{"byRole":{"*":["deal.list"]}}') as MaxPolicy;
    const so3 = JSON.parse(
      '{"byRole":{"*":["certidao.status","document.list","charge.status"]}}'
    ) as MaxPolicy;

    const efetivas = (p: MaxPolicy): Capability[] => resolverPolitica({ politica: p, sujeito: gerente, role: "sales" });

    // Texto largo de propósito: casa o prefiltro de tudo que fala de certidão, documento,
    // cobrança, negócio, proposta, atividade e imóvel.
    const TEXTO =
      "status das certidões, lista de documentos e status da cobrança do negócio, " +
      "propostas, atividades, pendências, contrato e imóvel";

    const envOriginal = process.env.MAX_EXTENDED_QUERIES;
    afterEach(() => {
      if (envOriginal === undefined) delete process.env.MAX_EXTENDED_QUERIES;
      else process.env.MAX_EXTENDED_QUERIES = envOriginal;
    });

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

    it("ligar as 3 na política não muda a oferta: selecionarTools devolve o mesmo com e sem elas", () => {
      process.env.MAX_EXTENDED_QUERIES = "true";
      const com = selecionarTools({ policy: efetivas(ligada), texto: TEXTO, orgId: "org1" });
      const sem = selecionarTools({ policy: efetivas(semElas), texto: TEXTO, orgId: "org1" });
      expect(com.tools.map((t) => t.nome)).toEqual(sem.tools.map((t) => t.nome));
      expect(com.cortadas).toBe(sem.cortadas);
    });

    it("ligar as 3 não muda a oferta do turno (escrita + leitura), nem com a política só com elas", () => {
      process.env.MAX_EXTENDED_QUERIES = "true";
      const nomes = (p: MaxPolicy): string[] =>
        ferramentasDoTurno({ policy: efetivas(p), texto: TEXTO, identity: gerente }).entradas.map((e) => e.nome);
      expect(nomes(ligada)).toEqual(nomes(semElas));
      expect(nomes(so3)).toEqual([]);
    });
  });
});
