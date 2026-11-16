import { describe, it, expect } from "vitest";
import { VERBOS_DE_ACAO, timeoutDoVerbo } from "../acao";
import { catalog } from "../runtime/catalog";
import { buscarNoRegistro } from "@/graph/tools";
import {
  ACEITOS_PELO_CM, RECUSADOS_ANTES_DE_ENVIAR, RECUSADOS_POR_CAMPO_EXTRA, argsMontadosPorEsteLado,
} from "./vetores-activity-postpone-cm";

/**
 * Paridade do verbo `activity.postpone` (reagendar para uma data) com o contractmaker (docs/max.md §19.0 do CM,
 * PR-O3-CM). Regra 1 do Max: vetor fixo dos dois lados. Os vetores em `vetores-activity-postpone-cm.ts` são os do
 * teste do CM, literais (`act1`, `2026-11-20`, `09:30`, a lista de recusados). Nada aqui espelha o schema do CM: cada
 * asserção é sobre a SAÍDA do código de produção deste lado (`iniciarAtividade` + `argsDoVerbo`).
 */
describe("paridade do verbo activity.postpone (reagendar para uma data) com o contractmaker", () => {
  it.each(ACEITOS_PELO_CM.map((v) => [JSON.stringify(v.entrada), v] as const))(
    "o que o CM aceita, este lado monta exatamente: %s",
    (_nome, v) => {
      expect(argsMontadosPorEsteLado(v.entrada)).toEqual(v.saida);
    },
  );

  it("a saída é {atividade_id, ate, hora?}: sem `dias`, sem `hora` quando não houve, sem campo além dos três", () => {
    for (const v of ACEITOS_PELO_CM) {
      const saida = argsMontadosPorEsteLado(v.entrada)!;
      expect(Object.keys(saida).every((k) => ["atividade_id", "ate", "hora"].includes(k))).toBe(true);
      expect(Object.keys(saida)).not.toContain("dias");
      expect("hora" in saida).toBe("hora" in v.entrada);
    }
  });

  it.each(RECUSADOS_ANTES_DE_ENVIAR.map((v) => [JSON.stringify(v), v] as const))(
    "o que o CM recusa e este lado já barra antes de enviar (nenhuma chamada montada): %s",
    (_nome, v) => {
      expect(argsMontadosPorEsteLado(v)).toBeNull();
    },
  );

  it.each(RECUSADOS_POR_CAMPO_EXTRA.map((v) => [JSON.stringify(v.entrada), v] as const))(
    "o que o CM recusa por campo extra, este lado nunca envia: %s",
    (_nome, v) => {
      const saida = argsMontadosPorEsteLado(v.entrada)!;
      expect(saida).toEqual({ atividade_id: "act1", ate: "2026-11-20" });
      expect(Object.keys(saida)).not.toContain(v.extra);
    },
  );

  it("o dia de hoje em SP vale e o de ontem não, na virada do dia (a mesma régua do CM)", () => {
    // 2026-11-16T02:00Z = 2026-11-15 23:00 em SP: o CM ainda aceita o dia 15 e recusa o 14.
    const quase = Date.parse("2026-11-16T02:00:00.000Z");
    expect(argsMontadosPorEsteLado({ atividade_id: "act1", ate: "2026-11-15" }, quase)).toEqual({ atividade_id: "act1", ate: "2026-11-15" });
    expect(argsMontadosPorEsteLado({ atividade_id: "act1", ate: "2026-11-14" }, quase)).toBeNull();
    // 03:00Z = 00:00 em SP do dia 16: o dia 15 virou passado.
    expect(argsMontadosPorEsteLado({ atividade_id: "act1", ate: "2026-11-15" }, Date.parse("2026-11-16T03:00:00.000Z"))).toBeNull();
  });

  it("a tool do modelo não tem como carregar `dias`, id ou org: só numero, ate e hora", () => {
    const e = buscarNoRegistro("reagendar_atividade")!;
    const p = e.def.parameters as { properties: Record<string, unknown>; additionalProperties: boolean };
    expect(Object.keys(p.properties).sort()).toEqual(["ate", "hora", "numero"]);
    expect(p.additionalProperties).toBe(false);
  });

  it("a lista literal tem o verbo UMA vez, logo após form.remind (mesma posição do CM)", () => {
    const lista: readonly string[] = VERBOS_DE_ACAO;
    expect(lista.filter((v) => v === "activity.postpone")).toHaveLength(1);
    const i = lista.indexOf("form.remind");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(lista.slice(i, i + 2)).toEqual(["form.remind", "activity.postpone"]);
  });

  it("reusa activity.write (sem capability nova), é escrita com confirmação e usa o teto comum", () => {
    expect(catalog().tools.find((t) => t.id === "activity.postpone")).toMatchObject({
      executor: "scope-action", effect: "write", confirmation: true, permission: "activity.write",
    });
    expect(timeoutDoVerbo("activity.postpone")).toBe(timeoutDoVerbo("activity.complete"));
  });
});
