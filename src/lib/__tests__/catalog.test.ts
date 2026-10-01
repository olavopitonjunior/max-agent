import { describe, expect, it } from "vitest";
import {
  CATALOGO,
  parametrosDoCorpo,
  templateDoKind,
  todosOsTemplates,
} from "../templates/catalog";
import { botoesDaLinha } from "../outbox";

/**
 * As regras que a Meta aplica na análise de template, travadas aqui para que
 * um texto novo não seja reprovado dias depois da submissão — e a régua do
 * Olavo (01/10/2026), travada para não crescer sem ele saber.
 */
describe("regras da Meta sobre os textos", () => {
  const todos = todosOsTemplates();

  it("nome único, minúsculo, só letras/dígitos/_, com o prefixo max_", () => {
    const nomes = todos.map((t) => t.name);
    expect(new Set(nomes).size).toBe(nomes.length);
    for (const n of nomes) {
      expect(n).toMatch(/^[a-z][a-z0-9_]{0,511}$/);
      // WABA compartilhado com o app da FINCasa: o prefixo evita colisão.
      expect(n.startsWith("max_"), n).toBe(true);
    }
  });

  it.each(todos.map((t) => [t.name, t]))("%s: variáveis em sequência, nem no começo nem no fim", (_n, t) => {
    const numeros = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    expect(numeros).toEqual(numeros.map((_, i) => i + 1));
    expect(t.vars.length).toBe(numeros.length);
    expect(t.exemplos.length).toBe(numeros.length);
    expect(t.body.trimStart().startsWith("{{")).toBe(false);
    expect(t.body.trimEnd()).not.toMatch(/\{\{\d+\}\}[.!?]?$/);
    expect(t.body.length).toBeLessThanOrEqual(1024);
    expect(t.body).not.toMatch(/\n/);
  });

  it("exemplos não vazios e sem quebra de linha", () => {
    for (const t of todos) for (const e of t.exemplos) expect(e.trim()).not.toBe("");
  });

  it("textos de botão dentro do limite da Meta (25 caracteres)", () => {
    for (const t of todos) {
      const b = t.botao;
      if (!b) continue;
      expect(b.texto.length, t.name).toBeLessThanOrEqual(25);
      if (b.tipo === "url_e_ok") expect(b.ok.length, t.name).toBeLessThanOrEqual(25);
    }
  });
});

describe("a régua do Olavo (01/10/2026)", () => {
  /** Mudar esta lista é decisão de produto — não é refatoração. */
  it("só estes kinds têm template", () => {
    expect(Object.keys(CATALOGO).sort()).toEqual(
      [
        "contract_signed",
        "contract_signed_parte",
        "form_completed",
        "form_completed_parte",
        "form_reminder",
        "form_reminder_parte",
        "manual_message",
        "manual_message_parte",
        "onboarding_pending",
        "support_handoff",
        "survey_invite",
        "survey_invite_parte",
        "welcome",
      ].sort()
    );
  });

  it("nenhum texto, nome ou botão cita o nome do sistema", () => {
    for (const t of todosOsTemplates()) {
      const tudo = [t.name, t.body, t.botao?.texto, t.botao?.tipo === "url_e_ok" ? t.botao.ok : ""]
        .join(" ")
        .toLowerCase();
      expect(tudo, t.name).not.toMatch(/imob\s*pro|imobpro/);
    }
  });

  it("nenhum template fala de cobrança, pagamento ou comissão", () => {
    for (const t of todosOsTemplates()) {
      expect(t.body.toLowerCase(), t.name).not.toMatch(/cobran|pagamento|comiss|boleto|pix/);
    }
  });

  it("fora da régua não tem template — nem genérico", () => {
    for (const kind of [
      "stage_change",
      "contract_sent",
      "deal_sla_breached",
      "charge_created",
      "proposal_signed_proponente",
      "manual_documentos",
      "qualquer_coisa",
    ]) {
      expect(templateDoKind(kind), kind).toBeNull();
    }
    expect(templateDoKind(null)).toBeNull();
    expect(templateDoKind(undefined)).toBeNull();
    expect(templateDoKind("")).toBeNull();
  });

  it("pesquisa e mensagem da imobiliária usam o MESMO template para equipe e parte", () => {
    expect(templateDoKind("survey_invite")).toBe(templateDoKind("survey_invite_parte"));
    expect(templateDoKind("manual_message")).toBe(templateDoKind("manual_message_parte"));
  });
});

describe("botões", () => {
  it("parte só tem botão de URL quando o destino é público (formulário, pesquisa)", () => {
    expect(CATALOGO.form_completed_parte.botao).toBeNull();
    expect(CATALOGO.contract_signed_parte.botao).toBeNull();
    expect(CATALOGO.form_reminder_parte.botao?.tipo).toBe("url");
    expect(CATALOGO.survey_invite_parte.botao?.tipo).toBe("url");
  });

  it("os que entregam algo no aceite têm o botão OK", () => {
    expect(CATALOGO.manual_message.botao).toEqual({ tipo: "ok", texto: "OK" });
    expect(CATALOGO.support_handoff.botao).toEqual({ tipo: "ok", texto: "OK" });
  });

  it("botoesDaLinha preenche na ordem do template: URL com o id, OK e dúvida com o payload", () => {
    expect(botoesDaLinha(CATALOGO.form_completed, "r1")).toEqual([{ tipo: "url", param: "r1" }]);
    expect(botoesDaLinha(CATALOGO.manual_message, "r1")).toEqual([
      { tipo: "quick_reply", payload: "ok:r1" },
    ]);
    expect(botoesDaLinha(CATALOGO.onboarding_pending, "r1")).toEqual([
      { tipo: "url", param: "r1" },
      { tipo: "quick_reply", payload: "duvida:r1" },
    ]);
    expect(botoesDaLinha(CATALOGO.contract_signed_parte, "r1")).toEqual([]);
  });
});

describe("parametrosDoCorpo", () => {
  const linha = {
    recipient_name: "Ana Maria Corretora",
    org_name: "RE/MAX Trio",
    title: "Formulário concluído",
    params: { negocio: "Venda Apto 302" },
  };

  it("monta na ordem de {{1}}, {{2}}… — primeiro nome, org, variáveis", () => {
    expect(parametrosDoCorpo(CATALOGO.form_completed, linha)).toEqual([
      "Ana",
      "RE/MAX Trio",
      "Venda Apto 302",
    ]);
  });

  /** A Meta recusa parâmetro vazio: emissor sem params não pode quebrar o envio. */
  it("nada vazio: sem nome, sem org, sem params — tudo cai no fallback", () => {
    const p = parametrosDoCorpo(CATALOGO.contract_signed, {
      recipient_name: "  ",
      org_name: "",
      title: "",
      params: null,
    });
    expect(p).toEqual(["cliente", "imobiliária", "em andamento"]);
    const q = parametrosDoCorpo(CATALOGO.support_handoff, {
      recipient_name: "",
      org_name: "",
      title: "",
      params: null,
    });
    for (const v of q) expect(v.trim()).not.toBe("");
  });

  it("quebra de linha e excesso viram uma linha curta", () => {
    const [, , negocio] = parametrosDoCorpo(CATALOGO.form_completed, {
      ...linha,
      params: { negocio: `Casa\n\tna praia ${"x".repeat(300)}` },
    });
    expect(negocio).not.toMatch(/[\n\t]/);
    expect(negocio.startsWith("Casa na praia")).toBe(true);
    expect(negocio.length).toBeLessThanOrEqual(120);
  });
});
