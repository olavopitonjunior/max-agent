import { describe, it, expect } from "vitest";
import { avisoSchema, avisoParaAudiencia, groupKeyDoAviso, type Aviso } from "../schema";

const VALIDO = {
  v: 1,
  evento: "form_reminder",
  nivel: "B",
  emoji: "⏳",
  titulo: "Formulário aguardando",
  negocio: "Venda Apto 302",
  frase: "O formulário do negócio *Venda Apto 302* ainda não foi preenchido.",
  itens: ["Ana Souza", "Beto Lima"],
  itensExtras: 0,
  link: { rotulo: "Abrir negócio", url: "https://trio.imobpro.ia.br/deals/cmx1" },
  acoes: [
    { id: "reenviar_link" },
    { id: "lembrar_amanha" },
    { id: "ver_formulario" },
  ],
  forma: "botoes",
};

describe("avisoSchema", () => {
  it("aceita o exemplo do contrato", () => {
    const r = avisoSchema.safeParse(VALIDO);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(VALIDO);
  });

  it("recusa 4 ações com forma botoes", () => {
    const r = avisoSchema.safeParse({
      ...VALIDO,
      acoes: [{ id: "abrir" }, { id: "concluir" }, { id: "adiar_1d" }, { id: "ver_proposta" }],
    });
    expect(r.success).toBe(false);
  });

  it("aceita até 10 ações com forma lista e recusa 11", () => {
    const acoes = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: "concluir", alvoId: `a${i}` }));
    expect(avisoSchema.safeParse({ ...VALIDO, nivel: "B", forma: "lista", acoes: acoes(10) }).success).toBe(true);
    expect(avisoSchema.safeParse({ ...VALIDO, forma: "lista", acoes: acoes(11) }).success).toBe(false);
  });

  it("recusa titulo com 121 chars e aceita 120", () => {
    expect(avisoSchema.safeParse({ ...VALIDO, titulo: "a".repeat(121) }).success).toBe(false);
    expect(avisoSchema.safeParse({ ...VALIDO, titulo: "a".repeat(120) }).success).toBe(true);
  });

  it("recusa item de 121 chars, item com quebra de linha e mais de 4 itens", () => {
    expect(avisoSchema.safeParse({ ...VALIDO, itens: ["a".repeat(121)] }).success).toBe(false);
    expect(avisoSchema.safeParse({ ...VALIDO, itens: ["linha1\nlinha2"] }).success).toBe(false);
    expect(avisoSchema.safeParse({ ...VALIDO, itens: ["1", "2", "3", "4", "5"] }).success).toBe(false);
  });

  it("recusa frase com mais de 300 chars", () => {
    expect(avisoSchema.safeParse({ ...VALIDO, frase: "a".repeat(301) }).success).toBe(false);
  });

  it("recusa versão, nível e ação desconhecidos", () => {
    expect(avisoSchema.safeParse({ ...VALIDO, v: 2 }).success).toBe(false);
    expect(avisoSchema.safeParse({ ...VALIDO, nivel: "D" }).success).toBe(false);
    expect(avisoSchema.safeParse({ ...VALIDO, acoes: [{ id: "apagar" }], forma: "botoes" }).success).toBe(false);
  });

  it("imagemUrl só no nível C", () => {
    const img = "https://x.test/a.png?sig=1";
    expect(avisoSchema.safeParse({ ...VALIDO, imagemUrl: img }).success).toBe(false);
    expect(avisoSchema.safeParse({ ...VALIDO, nivel: "C", imagemUrl: img }).success).toBe(true);
  });

  it("esteira, responsável, equipe e departamento são opcionais", () => {
    const r = avisoSchema.safeParse({
      ...VALIDO,
      responsavel: "Ana",
      equipe: "Equipe Sul",
      departamento: "Vendas",
      esteira: { etapas: ["Proposta", "Assinatura"], atual: 1 },
    });
    expect(r.success).toBe(true);
  });
});

describe("groupKeyDoAviso", () => {
  const aviso = (nivel: "A" | "B" | "C") => ({ ...VALIDO, nivel }) as Aviso;
  it("dealId + nível A/B = dealId", () => {
    expect(groupKeyDoAviso("d1", aviso("A"))).toBe("d1");
    expect(groupKeyDoAviso("d1", aviso("B"))).toBe("d1");
  });
  it("nível C, sem dealId ou sem aviso = null", () => {
    expect(groupKeyDoAviso("d1", aviso("C"))).toBeNull();
    expect(groupKeyDoAviso(null, aviso("B"))).toBeNull();
    expect(groupKeyDoAviso("", aviso("B"))).toBeNull();
    expect(groupKeyDoAviso("d1", null)).toBeNull();
    expect(groupKeyDoAviso("d1", undefined)).toBeNull();
  });
});

describe("avisoParaAudiencia", () => {
  it("deal_party perde ações, forma e imagem", () => {
    const base = { ...VALIDO, nivel: "C", imagemUrl: "https://x.test/a.png" } as Aviso;
    const r = avisoParaAudiencia("deal_party", base)!;
    expect(r.acoes).toEqual([]);
    expect(r.forma).toBeNull();
    expect("imagemUrl" in r).toBe(false);
    expect(r.titulo).toBe(base.titulo);
    // não muta a entrada
    expect(base.acoes.length).toBe(3);
    expect(base.imagemUrl).toBeDefined();
  });
  it("outras audiências passam intactas; sem aviso devolve null", () => {
    const a = VALIDO as Aviso;
    expect(avisoParaAudiencia("deal_broker", a)).toBe(a);
    expect(avisoParaAudiencia("platform_user", a)).toBe(a);
    expect(avisoParaAudiencia("deal_party", undefined)).toBeNull();
    expect(avisoParaAudiencia("deal_broker", null)).toBeNull();
  });
});
