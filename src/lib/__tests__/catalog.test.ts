import { describe, expect, it } from "vitest";
import {
  CATALOGO,
  botoesEmOrdem,
  parametroObrigatorioFaltando,
  parametrosDoCorpo,
  templateDoKind,
  templateUsavel,
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

  it("textos de botão dentro do limite da Meta (25 caracteres) — todos os botões, em qualquer variante", () => {
    for (const t of todos) {
      for (const b of botoesEmOrdem(t.botao)) {
        expect(b.texto.length, t.name).toBeLessThanOrEqual(25);
      }
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
        "proposal_completed",
        "proposal_delivered",
        "proposal_expired",
        "proposal_refused",
        "proposal_sent",
        "proposal_signed_proponente",
        "proposal_awaiting_decision",
        "support_handoff",
        "survey_invite",
        "survey_invite_parte",
        "welcome",
      ].sort()
    );
  });

  it("nenhum texto, nome ou botão cita o nome do sistema", () => {
    for (const t of todosOsTemplates()) {
      const textosDoBotao = botoesEmOrdem(t.botao).map((b) => b.texto);
      const tudo = [t.name, t.body, ...textosDoBotao].join(" ").toLowerCase();
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

  it("envio e assinatura do proponente não afirmam conclusão nem oferecem conversão", () => {
    const sent = templateDoKind("proposal_sent")!;
    const partial = templateDoKind("proposal_signed_proponente")!;
    expect(sent.body).toContain("foi enviada para assinatura");
    expect(partial.body).toContain("O proponente assinou");
    expect(templateDoKind("proposal_awaiting_decision")).toBe(partial);
    for (const def of [sent, partial]) {
      expect(def.body).not.toMatch(/todos os signatários|converter/i);
      expect(def.botao).toEqual({ tipo: "url", texto: "Abrir proposta" });
      expect(def.paramsObrigatorios).toEqual(["proposta"]);
      expect(templateUsavel(def, { recipient_name: "Ana", org_name: "Imob", title: "Proposta", params: {} })).toBe(false);
    }
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

  /**
   * Regressão: os botões antigos (`url`, `ok`, `url_e_ok`) continuam
   * idênticos depois da extensão com os botões de AÇÃO.
   */
  it("regressão: ok/dúvida/url continuam exatamente como antes", () => {
    expect(botoesEmOrdem(CATALOGO.manual_message.botao)).toEqual([
      { tipo: "quick_reply", texto: "OK", prefixo: "ok" },
    ]);
    expect(botoesEmOrdem(CATALOGO.onboarding_pending.botao)).toEqual([
      { tipo: "url", texto: "Continuar configuração" },
      { tipo: "quick_reply", texto: "Tenho uma dúvida", prefixo: "duvida" },
    ]);
    expect(botoesEmOrdem(CATALOGO.form_completed.botao)).toEqual([
      { tipo: "url", texto: "Abrir negócio" },
    ]);
  });

  it("botão de AÇÃO: 2 respostas rápidas (proposal_completed)", () => {
    expect(CATALOGO.proposal_completed.botao).toEqual({
      tipo: "acoes",
      acoes: [
        { texto: "Converter em negócio", acao: "converter" },
        { texto: "Agora não", acao: "agora_nao" },
      ],
    });
    expect(botoesDaLinha(CATALOGO.proposal_completed, "r1")).toEqual([
      { tipo: "quick_reply", payload: "acao:r1:converter" },
      { tipo: "quick_reply", payload: "acao:r1:agora_nao" },
    ]);
  });

  it("botão de AÇÃO + URL: URL primeiro (regra da Meta), ação depois (proposal_refused/expired)", () => {
    for (const def of [CATALOGO.proposal_refused, CATALOGO.proposal_expired]) {
      expect(def.botao).toEqual({
        tipo: "acao_e_url",
        acao: { texto: "Recriar proposta", acao: "recriar" },
        urlTexto: "Abrir proposta",
      });
      expect(botoesDaLinha(def, "r1"), def.name).toEqual([
        { tipo: "url", param: "r1" },
        { tipo: "quick_reply", payload: "acao:r1:recriar" },
      ]);
    }
  });

  it("proposal_delivered só tem o botão de URL", () => {
    expect(CATALOGO.proposal_delivered.botao).toEqual({ tipo: "url", texto: "Abrir proposta" });
    expect(botoesDaLinha(CATALOGO.proposal_delivered, "r1")).toEqual([{ tipo: "url", param: "r1" }]);
  });

  it("submissão (templates-sync) e envio (botoesDaLinha) usam a MESMA ordem — fonte única: botoesEmOrdem", () => {
    for (const def of [
      CATALOGO.proposal_completed,
      CATALOGO.proposal_refused,
      CATALOGO.proposal_expired,
      CATALOGO.proposal_delivered,
    ]) {
      const ordem = botoesEmOrdem(def.botao);
      const tiposDoEnvio = botoesDaLinha(def, "r1").map((b) => b.tipo);
      const tiposDaOrdem = ordem.map((b) => (b.tipo === "url" ? "url" : "quick_reply"));
      expect(tiposDoEnvio, def.name).toEqual(tiposDaOrdem);
    }
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

  it("v3 do lembrete: segue a ordem DELE — negócio antes da org", async () => {
    const { templatesDoKind } = await import("../templates/catalog");
    const [v3] = templatesDoKind("form_reminder");
    expect(v3.name).toBe("max_formulario_pendente_v3");
    expect(parametrosDoCorpo(v3, linha)).toEqual(["Ana", "Venda Apto 302", "RE/MAX Trio"]);
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

describe("v2 transacional (Meta reclassificou 7 como MARKETING em 03/10/2026)", () => {
  const comV2 = [
    "form_completed",
    "form_reminder",
    "form_reminder_parte",
    "welcome",
    "onboarding_pending",
    "support_handoff",
    "manual_message",
    "manual_message_parte",
  ];

  /** Só o `welcome` tem v4 (PR 3, 05/10/2026). */
  const comV4 = ["welcome"];

  it("ordem de preferência: versão mais nova primeiro; os outros só v1", async () => {
    const { templatesDoKind } = await import("../templates/catalog");
    const comV3 = ["form_reminder", "form_reminder_parte", "onboarding_pending", "manual_message", "manual_message_parte"];
    for (const k of comV2) {
      const lista = templatesDoKind(k);
      const v1 = lista[lista.length - 1];
      const sufixos = [...(comV4.includes(k) ? ["_v4"] : []), ...(comV3.includes(k) ? ["_v3"] : []), "_v2"];
      const esperado = [...sufixos.map((suf) => `${v1.name}${suf}`), v1.name];
      expect(lista.map((d) => d.name), k).toEqual(esperado);
    }
    for (const k of ["contract_signed", "contract_signed_parte", "form_completed_parte", "survey_invite"]) {
      expect(templatesDoKind(k), k).toHaveLength(1);
    }
    expect(templatesDoKind("stage_change")).toEqual([]);
  });

  it(
    "toda versão tem as MESMAS variáveis (em qualquer ordem); botões iguais ao v1 — " +
      "exceto o TEXTO do botão no v4 do welcome (\"Criar senha\", decisão do Olavo, 05/10/2026)",
    async () => {
      const { templatesDoKind } = await import("../templates/catalog");
      for (const k of comV2) {
        const lista = templatesDoKind(k);
        const v1 = lista[lista.length - 1];
        for (const d of lista) {
          const chave = (v: unknown) => JSON.stringify(v);
          expect(d.vars.map(chave).sort(), d.name).toEqual(v1.vars.map(chave).sort());
          if (d.name.endsWith("_v4")) continue;
          expect(d.botao, d.name).toEqual(v1.botao);
        }
      }
    }
  );

  it("v3 sem lembrete nem suspense — o que manteve os v2 em MARKETING", async () => {
    const { templatesDoKind } = await import("../templates/catalog");
    for (const k of comV2) {
      const d = templatesDoKind(k)[0];
      if (!d.name.endsWith("_v3")) continue;
      expect(d.body, d.name).not.toMatch(/ainda|incomplet|continue|enviou uma mensagem/i);
    }
  });

  it("v2 sem apresentação, convite ou suspense — o que levou ao MARKETING", async () => {
    const { templatesDoKind } = await import("../templates/catalog");
    for (const k of comV2) {
      for (const d of templatesDoKind(k).slice(0, -1))
        expect(d.body, d.name).not.toMatch(/Eu sou o Max|Se quiser saber|é só perguntar|avisa:|tem uma mensagem para você/i);
    }
  });
});

describe("parâmetro obrigatório (PR 3 — proposal_*, 05/10/2026)", () => {
  const base = { recipient_name: "Carlos", org_name: "RE/MAX Trio", title: "x" };

  it("templates antigos não têm paramsObrigatorios — sempre usáveis, mesmo sem params", () => {
    expect(CATALOGO.form_completed.paramsObrigatorios).toBeUndefined();
    expect(templateUsavel(CATALOGO.form_completed, { ...base, params: null })).toBe(true);
    expect(templateUsavel(CATALOGO.support_handoff, { ...base, params: null })).toBe(true);
  });

  it("proposal_completed: sem `proposta` não é usável; com `proposta`, é", () => {
    expect(CATALOGO.proposal_completed.paramsObrigatorios).toEqual(["proposta"]);
    expect(templateUsavel(CATALOGO.proposal_completed, { ...base, params: null })).toBe(false);
    expect(templateUsavel(CATALOGO.proposal_completed, { ...base, params: { proposta: "" } })).toBe(false);
    expect(templateUsavel(CATALOGO.proposal_completed, { ...base, params: { proposta: "  " } })).toBe(false);
    expect(
      templateUsavel(CATALOGO.proposal_completed, { ...base, params: { proposta: "PROP-1" } })
    ).toBe(true);
  });

  it("proposal_refused/proposal_delivered: faltando `proposta` OU `quem`, não é usável", () => {
    for (const def of [CATALOGO.proposal_refused, CATALOGO.proposal_delivered]) {
      expect(def.paramsObrigatorios, def.name).toEqual(["proposta", "quem"]);
      expect(templateUsavel(def, { ...base, params: { proposta: "PROP-1" } }), def.name).toBe(false);
      expect(templateUsavel(def, { ...base, params: { quem: "o proprietário" } }), def.name).toBe(false);
      expect(
        templateUsavel(def, { ...base, params: { proposta: "PROP-1", quem: "o proprietário" } }),
        def.name
      ).toBe(true);
    }
  });

  it("parametroObrigatorioFaltando aponta a PRIMEIRA chave que falta", () => {
    expect(parametroObrigatorioFaltando(CATALOGO.proposal_refused, { ...base, params: null })).toBe(
      "proposta"
    );
    expect(
      parametroObrigatorioFaltando(CATALOGO.proposal_refused, { ...base, params: { proposta: "PROP-1" } })
    ).toBe("quem");
    expect(
      parametroObrigatorioFaltando(CATALOGO.proposal_refused, {
        ...base,
        params: { proposta: "PROP-1", quem: "o proprietário" },
      })
    ).toBeNull();
    expect(parametroObrigatorioFaltando(CATALOGO.form_completed, { ...base, params: null })).toBeNull();
  });

  it("presente, os valores certos saem na ordem de {{1}}, {{2}}…", () => {
    expect(
      parametrosDoCorpo(CATALOGO.proposal_completed, {
        recipient_name: "Carlos Souza",
        org_name: "RE/MAX Trio",
        title: "x",
        params: { proposta: "PROP-0042 Apto Rua das Flores" },
      })
    ).toEqual(["Carlos", "PROP-0042 Apto Rua das Flores", "RE/MAX Trio"]);

    expect(
      parametrosDoCorpo(CATALOGO.proposal_refused, {
        recipient_name: "Carlos Souza",
        org_name: "RE/MAX Trio",
        title: "x",
        params: { proposta: "PROP-0042 Apto Rua das Flores", quem: "pelo proprietário" },
      })
    ).toEqual(["Carlos", "PROP-0042 Apto Rua das Flores", "RE/MAX Trio", "pelo proprietário"]);
  });
});
