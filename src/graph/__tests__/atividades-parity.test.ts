import { describe, it, expect } from "vitest";
import { CAPABILITIES, resolverPolitica, type MaxPolicy } from "../policy";
import { VERBOS_DE_LEITURA } from "../scope-contract";
import { VERBOS_DE_ACAO } from "@/lib/acao";
import { catalog } from "@/lib/runtime/catalog";

/**
 * Paridade com o contractmaker (Atividades v2 / PR11, `MAX_CAPABILITIES` e os
 * verbos de `scope-action-atividade.ts` / `scope-query-atividade.ts`). Regra 1
 * da governança do Max: vetor fixo dos dois lados.
 *
 * O literal abaixo é literal de propósito (copiado do report do PR11 do CM; 28 itens com o PR 7b,
 * 30 com a série de pendências: `pending.summary` e `prefs.self` nas posições 28 e 29): derivar da constante deste lado acompanharia uma divergência em silêncio.
 */
const MAX_CAPABILITIES_DO_CM = [
  "deal.list", "deal.detail", "deal.pending",
  "proposal.list", "proposal.detail", "proposal.create", "proposal.send", "proposal.delete",
  "form.create", "notify.manual", "audio.reply",
  "credit.read", "credit.request",
  "captacao.create", "captacao.send", "captacao.list",
  "captacao.autorizacao.pedir", "captacao.autorizacao.decidir",
  "notification.list", "activity.list", "metrics.get", "property.list", "property.detail", "contract.status",
  "marketing.read", "marketing.generate",
  "activity.write",
  "template.decisions",
  "pending.summary",
  "prefs.self",
];

const gerente = { orgId: "org1", orgName: "Imob", kind: "user" as const, userId: "u1", userName: "Marcia" };

describe("paridade de atividades com o contractmaker", () => {
  it("a lista de capabilities é a do CM, literal a literal: activity.write no 26, template.decisions no 27, pending.summary no 28 e prefs.self no 29", () => {
    expect([...CAPABILITIES]).toEqual(MAX_CAPABILITIES_DO_CM);
    expect(CAPABILITIES).toHaveLength(30);
    expect(CAPABILITIES.indexOf("activity.write")).toBe(26);
    expect(CAPABILITIES.indexOf("template.decisions")).toBe(27);
    expect(CAPABILITIES.indexOf("pending.summary")).toBe(28);
    expect(CAPABILITIES.indexOf("prefs.self")).toBe(29);
  });

  it("os verbos de escrita existem como ação e activity.get como leitura", () => {
    for (const v of ["activity.create", "activity.comment", "activity.complete", "activity.refuse"]) {
      expect(VERBOS_DE_ACAO as readonly string[]).toContain(v);
    }
    expect(VERBOS_DE_LEITURA as readonly string[]).toContain("activity.get");
    expect(VERBOS_DE_LEITURA as readonly string[]).toContain("activity.list");
  });

  it("o catálogo mapeia cada verbo à capability do CM (get -> activity.list; escritas -> activity.write)", () => {
    const tools = catalog("org1").tools;
    const perm = (id: string) => tools.find((t) => t.id === id)?.permission;
    expect(perm("activity.get")).toBe("activity.list");
    expect(perm("activity.list")).toBe("activity.list");
    for (const v of ["activity.create", "activity.comment", "activity.complete", "activity.refuse"]) {
      expect(perm(v)).toBe("activity.write");
      expect(tools.find((t) => t.id === v)?.effect).toBe("write");
      expect(tools.find((t) => t.id === v)?.confirmation).toBe(true);
    }
  });

  it("fail-closed: o padrão do ImobPro não concede activity.write; só a org que liga", () => {
    const padrao = JSON.parse(
      '{"byRole":{"*":["deal.list","deal.pending","proposal.list","form.create","proposal.create","proposal.send","proposal.delete"]},' +
        '"byRecipient":{},"brokerDefault":["deal.list","deal.pending"]}'
    ) as MaxPolicy;
    expect(resolverPolitica({ politica: padrao, sujeito: gerente, role: "sales" })).not.toContain("activity.write");
    const ligada = JSON.parse('{"byRole":{"*":["activity.list","activity.write"]}}') as MaxPolicy;
    expect(resolverPolitica({ politica: ligada, sujeito: gerente, role: "sales" })).toEqual(["activity.list", "activity.write"]);
  });
});
