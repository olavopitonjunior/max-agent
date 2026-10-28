import { describe, expect, it } from "vitest";
import { interativoDoAviso, ROTULOS_BOTAO } from "../interativo";
import type { Aviso } from "../schema";

const BASE: Aviso = {
  v: 1,
  evento: "form_reminder",
  nivel: "B",
  emoji: "⏳",
  titulo: "Formulário aguardando",
  negocio: "Venda Apto 302",
  frase: "O formulário de *Venda Apto 302* ainda não foi preenchido.",
  itens: [],
  itensExtras: 0,
  link: { rotulo: "Abrir negócio", url: "https://trio.imobpro.ia.br/deals/cmx1" },
  acoes: [{ id: "reenviar_link", alvoId: "f1" }, { id: "lembrar_amanha" }, { id: "ver_formulario" }],
  forma: "botoes",
};

const ROW = "11111111-2222-3333-4444-555555555555";

describe("interativoDoAviso", () => {
  it("B form_reminder: 3 botões com ids av:<rowId>:<acao> e rótulos do contrato", () => {
    const out = interativoDoAviso(BASE, ROW, "corpo");
    expect(out).toEqual({
      tipo: "botoes",
      corpo: "corpo",
      opcoes: [
        { id: `av:${ROW}:reenviar_link`, titulo: "📨 Reenviar link" },
        { id: `av:${ROW}:lembrar_amanha`, titulo: "⏰ Me lembra amanhã" },
        { id: `av:${ROW}:ver_formulario`, titulo: "🔗 Ver formulário" },
      ],
    });
  });

  it("rótulos fixos do contrato, todos ≤20 caracteres (limite da Meta)", () => {
    expect(ROTULOS_BOTAO).toEqual({
      abrir: "🔗 Abrir negócio",
      ver_formulario: "🔗 Ver formulário",
      ver_proposta: "🔗 Ver proposta",
      reenviar_link: "📨 Reenviar link",
      lembrar_amanha: "⏰ Me lembra amanhã",
      concluir: "✅ Concluir",
      adiar_1d: "📅 Adiar 1 dia",
      criar_atividade: "➕ Próximo passo",
    });
    for (const r of Object.values(ROTULOS_BOTAO)) expect(Array.from(r).length).toBeLessThanOrEqual(20);
  });

  it("nível A: null (só texto)", () => {
    expect(
      interativoDoAviso({ ...BASE, nivel: "A", acoes: [{ id: "abrir" }], forma: "botoes" }, ROW, "c")
    ).toBeNull();
  });

  it("sem ações (parte do negócio: regravado sem ações): null", () => {
    expect(interativoDoAviso({ ...BASE, acoes: [], forma: null }, ROW, "c")).toBeNull();
  });

  it("corpo acima de 1024 (limite da Meta): null, o texto segue", () => {
    expect(interativoDoAviso(BASE, ROW, "x".repeat(1025))).toBeNull();
    expect(interativoDoAviso(BASE, ROW, "x".repeat(1024))).not.toBeNull();
  });

  it("nível C com imagemUrl: botões com cabeçalho de imagem", () => {
    const c: Aviso = {
      ...BASE,
      evento: "contract_signed",
      nivel: "C",
      emoji: "✅",
      acoes: [{ id: "abrir" }, { id: "criar_atividade", alvoId: "n1" }],
      imagemUrl: "https://app.test/og/marco?t=abc",
    };
    const out = interativoDoAviso(c, ROW, "corpo");
    expect(out).toMatchObject({ tipo: "botoes", imagemUrl: "https://app.test/og/marco?t=abc" });
    expect(out!.opcoes.map((o) => o.id)).toEqual([`av:${ROW}:abrir`, `av:${ROW}:criar_atividade`]);
  });

  it("nível C sem imagemUrl: botões sem cabeçalho", () => {
    const c: Aviso = { ...BASE, nivel: "C", acoes: [{ id: "abrir" }], forma: "botoes" };
    const out = interativoDoAviso(c, ROW, "corpo");
    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty("imagemUrl");
  });

  it("forma null em B/C é tratada como botões; mais de 3 ações cortam em 3", () => {
    const out = interativoDoAviso(
      { ...BASE, forma: null, acoes: [{ id: "abrir" }, { id: "concluir" }, { id: "adiar_1d" }, { id: "lembrar_amanha" }] },
      ROW,
      "c"
    );
    expect(out!.tipo).toBe("botoes");
    expect(out!.opcoes).toHaveLength(3);
  });

  it("lista: botão 'Ver itens' e ids av:<rowId>:item:<alvoId>, título ≤24 e descrição com o resto", () => {
    const lista: Aviso = {
      ...BASE,
      evento: "daily_report",
      forma: "lista",
      itens: ["Ligar para o Carlos sobre a proposta do Apto 302"],
      acoes: [
        { id: "abrir", alvoId: "a1" },
        { id: "abrir", alvoId: "a2" },
      ],
    };
    const out = interativoDoAviso(lista, ROW, "c");
    expect(out).toMatchObject({ tipo: "lista", botao: "Ver itens", corpo: "c" });
    expect(out!.opcoes[0]).toEqual({
      id: `av:${ROW}:item:a1`,
      titulo: "Ligar para o Carlos sob…",
      descricao: "Ligar para o Carlos sobre a proposta do Apto 302",
    });
    expect(Array.from(out!.opcoes[0].titulo).length).toBeLessThanOrEqual(24);
    // Sem item textual para a 2ª linha: título genérico, ainda tocável.
    expect(out!.opcoes[1].id).toBe(`av:${ROW}:item:a2`);
    expect(out!.opcoes[1].titulo.length).toBeGreaterThan(0);
  });

  it("lista: ação sem alvoId não vira linha; sem nenhuma linha, null", () => {
    const lista: Aviso = { ...BASE, forma: "lista", acoes: [{ id: "abrir" }] };
    expect(interativoDoAviso(lista, ROW, "c")).toBeNull();
  });
});
