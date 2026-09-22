import { describe, expect, it } from "vitest";
import {
  CATALOGO,
  GENERICO,
  parametrosDoCorpo,
  templateDoKind,
  todosOsTemplates,
} from "../templates/catalog";

/**
 * As regras que a Meta aplica na análise de template, travadas aqui para que
 * um texto novo não seja reprovado dias depois da submissão.
 */
describe("regras da Meta sobre os textos", () => {
  const todos = todosOsTemplates();

  it("nome único, minúsculo, só letras/dígitos/_", () => {
    const nomes = todos.map((t) => t.name);
    expect(new Set(nomes).size).toBe(nomes.length);
    for (const n of nomes) expect(n).toMatch(/^[a-z][a-z0-9_]{0,511}$/);
  });

  it.each(todos.map((t) => [t.name, t]))("%s: variáveis em sequência, nem no começo nem no fim", (_n, t) => {
    const numeros = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    expect(numeros).toEqual(numeros.map((_, i) => i + 1));
    expect(t.vars.length).toBe(numeros.length);
    expect(t.exemplos.length).toBe(numeros.length);
    expect(t.body.trimStart().startsWith("{{")).toBe(false);
    expect(t.body.trimEnd().endsWith("}}")).toBe(false);
    // Nem terminar em "{{n}}." — a Meta trata pontuação final como fim.
    expect(t.body.trimEnd()).not.toMatch(/\{\{\d+\}\}[.!?]?$/);
    expect(t.body.length).toBeLessThanOrEqual(1024);
    expect(t.body).not.toMatch(/\n/);
  });

  it("exemplos não vazios e sem quebra de linha", () => {
    for (const t of todos) for (const e of t.exemplos) expect(e.trim()).not.toBe("");
  });
});

describe("cobertura dos tipos que o contractmaker manda", () => {
  /**
   * Os `kind` do motor de eventos e da rota avulsa (cm#887). Os do sino
   * (Notification.type) vão para o genérico, de propósito.
   */
  it.each([
    "stage_change",
    "form_completed",
    "form_reminder",
    "contract_sent",
    "contract_signed",
    "contract_signed_parte",
    "charge_created",
    "charge_paid",
    "charge_created_parte",
    "deal_sla_breached",
    "split_recipient_completion",
  ])("%s tem template próprio", (kind) => {
    expect(CATALOGO[kind]).toBeDefined();
    expect(templateDoKind(kind)).not.toBe(GENERICO);
  });

  it("tipo desconhecido, do sino ou ausente cai no genérico", () => {
    expect(templateDoKind("proposal_signed_proponente")).toBe(GENERICO);
    expect(templateDoKind(null)).toBe(GENERICO);
    expect(templateDoKind(undefined)).toBe(GENERICO);
    expect(templateDoKind("")).toBe(GENERICO);
  });
});

describe("parametrosDoCorpo", () => {
  const linha = {
    recipient_name: "Ana Maria Corretora",
    org_name: "RE/MAX Trio",
    title: "Status do negócio atualizado",
    params: { negocio: "Venda Apto 302", etapa: "Assinatura" },
  };

  it("monta na ordem de {{1}}, {{2}}… — primeiro nome, variáveis, org", () => {
    expect(parametrosDoCorpo(CATALOGO.stage_change, linha)).toEqual([
      "Ana",
      "Venda Apto 302",
      "Assinatura",
      "RE/MAX Trio",
    ]);
  });

  it("o genérico usa o TÍTULO, nunca o corpo livre", () => {
    expect(parametrosDoCorpo(GENERICO, linha)).toEqual(["Ana", "RE/MAX Trio", "Status do negócio atualizado"]);
  });

  /** A Meta recusa parâmetro vazio: emissor antigo (sem params) não pode quebrar o envio. */
  it("nada vazio: sem nome, sem org, sem params — tudo cai no fallback", () => {
    const p = parametrosDoCorpo(CATALOGO.deal_sla_breached, {
      recipient_name: "  ",
      org_name: "",
      title: "",
      params: null,
    });
    expect(p).toEqual(["cliente", "em andamento", "atual", "imobiliária"]);
    for (const v of p) expect(v.trim()).not.toBe("");
  });

  it("quebra de linha e excesso viram uma linha curta", () => {
    const [, negocio] = parametrosDoCorpo(CATALOGO.form_completed, {
      ...linha,
      params: { negocio: `Casa\n\tna praia ${"x".repeat(300)}` },
    });
    expect(negocio).not.toMatch(/[\n\t]/);
    expect(negocio.startsWith("Casa na praia")).toBe(true);
    expect(negocio.length).toBeLessThanOrEqual(120);
  });
});
