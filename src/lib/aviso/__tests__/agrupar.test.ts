import { describe, expect, it } from "vitest";
import { acaoDeLinkDoResumo, interativoDoResumo, resumoDaRajada } from "../agrupar";
import { AVISO_TEXTO_TOTAL_MAX } from "../render";
import type { Aviso } from "../schema";

/** Texto do resumo da rajada (M8): sem banco. O despacho tem teste à parte. */

const BASE: Aviso = {
  v: 1,
  evento: "stage_change",
  nivel: "A",
  emoji: "📌",
  titulo: "Etapa mudou",
  negocio: "Venda Apto 302",
  frase: "x",
  itens: [],
  itensExtras: 0,
  link: { rotulo: "Abrir negócio", url: "https://trio.imobpro.ia.br/deals/cmx1" },
  acoes: [{ id: "abrir" }],
  forma: null,
};

const aviso = (over: Partial<Aviso> = {}): Aviso => ({ ...BASE, ...over });

describe("resumoDaRajada", () => {
  it("formato do plano: cabeçalho, uma linha por aviso, assinatura da org", () => {
    const t = resumoDaRajada(
      [aviso({ emoji: "📌", titulo: "Etapa: Proposta" }), aviso({ emoji: "⏳", titulo: "Formulário aguardando" })],
      { orgName: "RE/MAX Trio", link: null }
    );
    expect(t).toBe(
      "📌 *Venda Apto 302* andou bastante agora:\n• 📌 Etapa: Proposta\n• ⏳ Formulário aguardando\n\n_RE/MAX Trio_"
    );
  });

  it("sem botão (Newton): a linha 👉 Abrir negócio vem antes da assinatura e não há bloco Responda", () => {
    const t = resumoDaRajada([aviso(), aviso({ titulo: "Outro" })], {
      orgName: "RE/MAX Trio",
      link: "https://trio.imobpro.ia.br/deals/cmx1",
    });
    expect(t).toContain("\n\n👉 Abrir negócio: https://trio.imobpro.ia.br/deals/cmx1\n\n_RE/MAX Trio_");
    expect(t).not.toContain("Responda");
  });

  it("escapa os dados: negócio, título e org não formatam", () => {
    const t = resumoDaRajada(
      [aviso({ negocio: "Apto *302* _A_", titulo: "Etapa *nova*" }), aviso({ titulo: "b" })],
      { orgName: "Imob_X", link: null }
    );
    expect(t).toContain("📌 *Apto ∗302∗ ＿A＿* andou bastante agora:");
    expect(t).toContain("• 📌 Etapa ∗nova∗");
    expect(t).toContain("_Imob＿X_");
  });

  it("sem nome de negócio em nenhum aviso: cabeçalho neutro", () => {
    const t = resumoDaRajada([aviso({ negocio: null }), aviso({ negocio: null })], { orgName: "", link: null });
    expect(t.startsWith("📌 Este negócio andou bastante agora:")).toBe(true);
    expect(t.endsWith("_")).toBe(false);
  });

  it("usa o primeiro nome de negócio que existir", () => {
    const t = resumoDaRajada([aviso({ negocio: null }), aviso({ negocio: "Casa 9" })], { orgName: "", link: null });
    expect(t.startsWith("📌 *Casa 9* andou")).toBe(true);
  });

  it("estoura o teto: corta itens do fim e termina com '• …e mais N'", () => {
    const longo = "T".repeat(110);
    const avisos = Array.from({ length: 30 }, (_, i) => aviso({ titulo: `${i}-${longo}` }));
    const t = resumoDaRajada(avisos, { orgName: "RE/MAX Trio", link: "https://trio.imobpro.ia.br/deals/cmx1" });
    expect(t.length).toBeLessThanOrEqual(AVISO_TEXTO_TOTAL_MAX);
    const m = t.match(/• …e mais (\d+)/);
    expect(m).not.toBeNull();
    const exibidos = (t.match(/^• 📌 /gm) ?? []).length;
    expect(exibidos + Number(m![1])).toBe(30);
    // a ordem é preservada: o que fica é o começo da rajada
    expect(t).toContain("• 📌 0-");
    // o link e a assinatura sobrevivem ao corte
    expect(t).toContain("👉 Abrir negócio:");
    expect(t.endsWith("_RE/MAX Trio_")).toBe(true);
  });

  it("respeita um teto menor (corpo interativo de 1024)", () => {
    const longo = "T".repeat(110);
    const avisos = Array.from({ length: 30 }, () => aviso({ titulo: longo }));
    const t = resumoDaRajada(avisos, { orgName: "RE/MAX Trio", link: null, max: 1024 });
    expect(Array.from(t).length).toBeLessThanOrEqual(1024);
    expect(t).toMatch(/• …e mais \d+/);
  });

  it("cabe inteiro: não escreve 'e mais'", () => {
    const t = resumoDaRajada([aviso(), aviso()], { orgName: "", link: null });
    expect(t).not.toContain("e mais");
  });
});

describe("acaoDeLinkDoResumo", () => {
  it("prefere a linha cujo aviso tem 'abrir', mesmo que não seja a primeira", () => {
    const linhas = [
      { id: "r1", aviso: aviso({ acoes: [{ id: "ver_formulario" }] }) },
      { id: "r2", aviso: aviso({ acoes: [{ id: "abrir" }] }) },
    ];
    expect(acaoDeLinkDoResumo(linhas)).toEqual({ rowId: "r2", acao: "abrir" });
  });

  it("a primeira linha com 'abrir' ganha quando várias têm", () => {
    const linhas = [
      { id: "r1", aviso: aviso({ acoes: [{ id: "abrir" }] }) },
      { id: "r2", aviso: aviso({ acoes: [{ id: "abrir" }] }) },
    ];
    expect(acaoDeLinkDoResumo(linhas)).toEqual({ rowId: "r1", acao: "abrir" });
  });

  it("sem 'abrir' em nenhum: cai na primeira ação de link que existir", () => {
    const linhas = [
      { id: "r1", aviso: aviso({ acoes: [{ id: "lembrar_amanha" }] }) },
      { id: "r2", aviso: aviso({ acoes: [{ id: "lembrar_amanha" }, { id: "ver_proposta" }] }) },
    ];
    expect(acaoDeLinkDoResumo(linhas)).toEqual({ rowId: "r2", acao: "ver_proposta" });
  });

  it("nenhuma ação de link: null (o resumo sai só com o link no texto)", () => {
    const linhas = [{ id: "r1", aviso: aviso({ acoes: [{ id: "lembrar_amanha" }] }) }];
    expect(acaoDeLinkDoResumo(linhas)).toBeNull();
  });
});

describe("interativoDoResumo", () => {
  it("um botão 'Abrir negócio' com o id do roteador do M6", () => {
    expect(interativoDoResumo("corpo", { rowId: "r1", acao: "abrir" })).toEqual({
      tipo: "botoes",
      corpo: "corpo",
      opcoes: [{ id: "av:r1:abrir", titulo: "🔗 Abrir negócio" }],
    });
  });

  it("corpo acima de 1024 não vira interativo", () => {
    expect(interativoDoResumo("x".repeat(1025), { rowId: "r1", acao: "abrir" })).toBeNull();
  });
});
