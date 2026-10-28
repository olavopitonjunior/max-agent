import { describe, it, expect } from "vitest";
import { escaparMarkdownWa } from "../escapar";
import { renderAvisoTexto } from "../render";
import type { Aviso } from "../schema";

const BASE: Aviso = {
  v: 1,
  evento: "contract_signed",
  nivel: "C",
  emoji: "✅",
  titulo: "Contrato assinado",
  negocio: "Venda Apto 302",
  frase: "Todas as partes assinaram o contrato de *Venda Apto 302*.",
  itens: ["item 1", "item 2"],
  itensExtras: 0,
  link: { rotulo: "Abrir negócio", url: "https://trio.imobpro.ia.br/deals/cmx1" },
  acoes: [{ id: "abrir" }],
  forma: null,
};

const CTX = { recipientName: "Ana Souza", orgName: "RE/MAX Trio", modo: "interativo" as const };

describe("escaparMarkdownWa", () => {
  it("quebra a sequência de marcação com U+2063 e não usa barra invertida", () => {
    const out = escaparMarkdownWa("Apto *302*_A ~x~ `c`");
    expect(out).not.toContain("*302*");
    expect(out).not.toContain("\\");
    expect(out).toContain("*⁣302*⁣_⁣A");
    expect(out.replace(/⁣/g, "")).toBe("Apto *302*_A ~x~ `c`");
  });

  it("texto sem marcação passa intacto", () => {
    expect(escaparMarkdownWa("RE/MAX Trio")).toBe("RE/MAX Trio");
  });
});

describe("renderAvisoTexto", () => {
  it("snapshot exato do exemplo do spec", () => {
    expect(renderAvisoTexto(BASE, CTX)).toBe(
      "Oi, Ana! ✅ *Contrato assinado*\n\n" +
        "Todas as partes assinaram o contrato de *Venda Apto 302*.\n\n" +
        "• item 1\n• item 2\n\n" +
        "👉 Abrir negócio: https://trio.imobpro.ia.br/deals/cmx1\n\n" +
        "_RE/MAX Trio_"
    );
  });

  it("sem recipientName começa por emoji e título", () => {
    const out = renderAvisoTexto(BASE, { ...CTX, recipientName: "" });
    expect(out.startsWith("✅ *Contrato assinado*")).toBe(true);
    expect(out).not.toContain("Oi,");
  });

  it("sem itens e sem link: não deixa linhas vazias sobrando", () => {
    const out = renderAvisoTexto({ ...BASE, itens: [], link: null, acoes: [] }, CTX);
    expect(out).toBe(
      "Oi, Ana! ✅ *Contrato assinado*\n\nTodas as partes assinaram o contrato de *Venda Apto 302*.\n\n_RE/MAX Trio_"
    );
  });

  it("escapa nome do destinatário, org e título", () => {
    const out = renderAvisoTexto(
      { ...BASE, titulo: "Etapa *nova*" },
      { ...CTX, recipientName: "A*na", orgName: "Imob_Sul" }
    );
    expect(out).toContain("Oi, A*⁣na!");
    expect(out).toContain("*Etapa *⁣nova*⁣*");
    expect(out).toContain("_Imob_⁣Sul_");
  });

  it("escapa os itens mas não a frase", () => {
    const out = renderAvisoTexto({ ...BASE, itens: ["Apto *302*"], frase: "Veja *Apto 302*." }, CTX);
    expect(out).toContain("• Apto *⁣302*⁣");
    expect(out).toContain("Veja *Apto 302*.");
  });

  it("6 itens viram 4 + '• e mais 2' (e soma itensExtras)", () => {
    const itens = ["a", "b", "c", "d", "e", "f"];
    const out = renderAvisoTexto({ ...BASE, itens } as Aviso, CTX);
    expect(out).toContain("• a\n• b\n• c\n• d\n• e mais 2");
    expect(out).not.toContain("• e\n");
    const out2 = renderAvisoTexto({ ...BASE, itens: ["a", "b", "c", "d"], itensExtras: 3 }, CTX);
    expect(out2).toContain("• d\n• e mais 3");
  });

  it("frase longa + itens: total <= 1500, itens cortados antes de mexer na frase", () => {
    const frase = "x".repeat(1300);
    const itens = ["a".repeat(30), "b".repeat(30), "c".repeat(30), "d".repeat(30)];
    const out = renderAvisoTexto({ ...BASE, frase, itens }, CTX);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toContain(frase); // frase intacta
    const n = Number(/• e mais (\d+)/.exec(out)![1]);
    const mostrados = (out.match(/^• (?!e mais)/gm) ?? []).length;
    expect(n).toBeGreaterThan(0);
    expect(mostrados + n).toBe(4);
  });

  it("frase de 1400: itens somem e a frase é a última a ceder", () => {
    const frase = "x".repeat(1400);
    const out = renderAvisoTexto({ ...BASE, frase, itens: ["a", "b", "c", "d"] }, CTX);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toContain("• e mais 4");
    expect(out).toContain("…");
  });

  it("frase gigante é truncada com reticências como último recurso", () => {
    const frase = "y".repeat(2000);
    const out = renderAvisoTexto({ ...BASE, frase, itens: ["a", "b"] }, CTX);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toContain("…");
    expect(out).toContain("• e mais 2");
    expect(out).toContain("https://trio.imobpro.ia.br/deals/cmx1");
  });

  it("modo numerado lista só ações que não são de link, em ordem", () => {
    const out = renderAvisoTexto(
      {
        ...BASE,
        acoes: [{ id: "reenviar_link" }, { id: "lembrar_amanha" }, { id: "ver_formulario" }],
      },
      { ...CTX, modo: "numerado", respondaNumerado: true }
    );
    expect(out).toContain("Responda:\n*1* · reenviar link\n*2* · lembrar amanhã\n\n_RE/MAX Trio_");
    expect(out).not.toContain("*3*");
    expect(out).toContain("👉 Abrir negócio:");
  });

  it("rótulos fixos de concluir, adiar e próximo passo", () => {
    const out = renderAvisoTexto(
      { ...BASE, acoes: [{ id: "concluir" }, { id: "adiar_1d" }, { id: "criar_atividade" }, { id: "abrir" }] },
      { ...CTX, modo: "numerado", respondaNumerado: true }
    );
    expect(out).toContain("*1* · concluir\n*2* · adiar 1 dia\n*3* · próximo passo");
    expect(out).not.toContain("*4*");
  });

  it("modo numerado só com ações de link: sem bloco Responda", () => {
    const out = renderAvisoTexto({ ...BASE, acoes: [{ id: "abrir" }, { id: "ver_proposta" }] }, { ...CTX, modo: "numerado", respondaNumerado: true });
    expect(out).not.toContain("Responda:");
  });

  it("modo numerado sem roteador (padrão): sem bloco Responda", () => {
    const out = renderAvisoTexto({ ...BASE, acoes: [{ id: "reenviar_link" }] }, { ...CTX, modo: "numerado" });
    expect(out).not.toContain("Responda:");
    expect(out).toContain("👉 Abrir negócio:");
  });

  it("modo interativo não numera nada", () => {
    const out = renderAvisoTexto({ ...BASE, acoes: [{ id: "concluir" }] }, CTX);
    expect(out).not.toContain("Responda:");
  });

  it("linkNoBotao omite a linha 👉 só quando há ação de link", () => {
    const comBotao = renderAvisoTexto(BASE, { ...CTX, linkNoBotao: true });
    expect(comBotao).not.toContain("👉");
    expect(comBotao).not.toContain("https://");
    const semAcaoDeLink = renderAvisoTexto({ ...BASE, acoes: [{ id: "concluir" }] }, { ...CTX, linkNoBotao: true });
    expect(semAcaoDeLink).toContain("👉 Abrir negócio:");
  });

  it("por padrão (linkNoBotao ausente) a linha 👉 fica", () => {
    expect(renderAvisoTexto(BASE, CTX)).toContain("👉 Abrir negócio: https://");
  });
});
