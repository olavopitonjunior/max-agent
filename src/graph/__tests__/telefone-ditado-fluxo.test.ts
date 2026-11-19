import { describe, expect, it, vi } from "vitest";
import { conduzirFluxo, conferirDitado, iniciarFluxo, sanearDados, type ContextoDoTurno, type DadosDaProposta, type DepsDoFluxo, type Fluxo } from "../fluxos";
import { conduzirCaptacao, type FluxoCaptacao } from "../captacao";

/**
 * Rodada 3 (reteste de 17/11/2026): o telefone ditado ("11, 9000-0002") chegava cru ao card porque o
 * valor do EXTRATOR entrava no rascunho sem passar por `juntarTelefone`/`telefoneDuvidoso`. Os testes
 * conduzem o fluxo inteiro (mesma função que monta o card), com o extrator dublê devolvendo o valor como
 * o modelo o devolveu em produção: a sequência ditada, crua.
 */

const agora = 1_000_000;
const TUDO = ["proposal.create", "proposal.send", "form.create"] as const;

function deps(extraido: DadosDaProposta): DepsDoFluxo {
  return {
    acao: vi.fn().mockResolvedValue(null),
    extrairProposta: vi.fn().mockResolvedValue(extraido),
    extrairCampos: vi.fn().mockResolvedValue(null),
  };
}

const imovel = { endereco: "Rua Augusta, 500", numero: "500", cidade: "São Paulo", uf: "SP" };
// decisão 18/11: CPF obrigatório antes do SIM — o card só sai com o CPF do proponente.
const CPF = "39276943803";
const CPF_TEXTO = "CPF 392.769.438-03";
const completo = (telefone: string): DadosDaProposta => ({
  proponente: { nome: "TESTE Newton Ditado", telefone, cpf: CPF },
  imovel,
  valor: 600000,
  pagamento: { forma: "à vista" },
});

describe("A — primeira mensagem (iniciarFluxo)", () => {
  const pedido =
    `proposta de compra: comprador TESTE Newton Ditado, telefone 11, 9000-0002, imóvel Rua Augusta, 500, São Paulo/SP, valor R$ 600.000 à vista, ${CPF_TEXTO}`;

  it("telefone de 10 dígitos que não fecha celular: pergunta, não mostra card", async () => {
    const d = deps(completo("11, 9000-0002"));
    const p = await iniciarFluxo({ tipo: "proposta", pedido, policy: [...TUDO], agora }, d);
    expect(p.reply).not.toContain("11, 9000-0002 ·");
    expect(p.reply).not.toContain("Comprador:");
    expect(p.reply).toMatch(/telefone/i);
    expect(p.reply).toContain("(11) 90000-0000");
    expect(p.evento).toBe("telefone_duvidoso");
  });

  it("telefone ditado que fecha sai juntado e formatado no card", async () => {
    const d = deps(completo("11, 90000-0002"));
    const p = await iniciarFluxo({ tipo: "proposta", pedido: pedido.replace("9000-0002", "90000-0002"), policy: [...TUDO], agora }, d);
    expect(p.reply).toContain("Comprador: TESTE Newton Ditado · (11) 90000-0002");
  });
});

describe("B — correção com o card aberto (conduzirFluxo)", () => {
  const aberto = (): Fluxo => ({
    kind: "proposta", etapa: "revisao", natureza: "venda",
    dados: sanearDados(completo("(11) 90000-0003")), atualizadoEm: 1,
  });
  const ctx = (texto: string): ContextoDoTurno => ({ texto, messageId: "m-r3", agora: 2, policy: ["proposal.create"] });

  it("nome e telefone ditados: o telefone sai juntado e formatado", async () => {
    const r = await conduzirFluxo(
      aberto(),
      ctx("o nome é TESTE Comprador Corrigido e o telefone é 11, 90000-0004"),
      deps({ proponente: { nome: "TESTE Comprador Corrigido", telefone: "11, 90000-0004" } }),
    );
    expect(r.reply).toContain("Comprador: TESTE Comprador Corrigido · (11) 90000-0004");
    expect(r.reply).not.toContain("11, 90000-0004");
  });

  it("telefone de 10 dígitos: pergunta e não troca", async () => {
    const f = aberto();
    const r = await conduzirFluxo(
      f, ctx("o telefone é 11, 9000-0004"),
      deps({ proponente: { telefone: "11, 9000-0004" } }),
    );
    expect(r.evento).toBe("telefone_duvidoso");
    if (!r.fluxo || r.fluxo.kind !== "proposta") throw new Error("fluxo");
    expect(r.fluxo.dados.proponente?.telefone).toBe("(11) 90000-0003");
  });
});

describe("R3.1 — o valor do extrator concilia com o texto ANTES da dúvida", () => {
  const aberto = (): Fluxo => ({
    kind: "proposta", etapa: "revisao", natureza: "venda",
    dados: sanearDados(completo("(11) 90000-0003")), atualizadoEm: 1,
  });
  const ctx = (texto: string): ContextoDoTurno => ({ texto, messageId: "m-r31", agora: 2, policy: ["proposal.create"] });

  it("modelo come um dígito, a pessoa escreveu certo: vale o escrito, sem pergunta", async () => {
    const r = await conduzirFluxo(aberto(), ctx("o telefone é 11 98888-7777"), deps({ proponente: { telefone: "119888-7777" } }));
    expect(r.evento).not.toBe("telefone_duvidoso");
    expect(r.reply).toContain("11 98888-7777");
  });

  it("primeira mensagem: o mesmo, sem pergunta", async () => {
    const pedido = `proposta de compra: comprador TESTE Newton Ditado, telefone 11 98888-7777, imóvel Rua Augusta, 500, São Paulo/SP, valor R$ 600.000 à vista, ${CPF_TEXTO}`;
    const p = await iniciarFluxo({ tipo: "proposta", pedido, policy: [...TUDO], agora }, deps(completo("119888-7777")));
    expect(p.evento).not.toBe("telefone_duvidoso");
    expect(p.reply).toContain("Comprador: TESTE Newton Ditado · 11 98888-7777");
  });

  it("telefone do modelo que não aparece no texto: descartado, sem pergunta", async () => {
    const r = await conduzirFluxo(aberto(), ctx("o sobrenome dele é Silva"),
      deps({ proponente: { nome: "TESTE Newton Ditado Silva", telefone: "11, 9000-0004" } }));
    expect(r.evento).not.toBe("telefone_duvidoso");
    if (!r.fluxo || r.fluxo.kind !== "proposta") throw new Error("fluxo");
    expect(r.fluxo.dados.proponente?.telefone).toBe("(11) 90000-0003");
  });
});

describe("R3.2 — caso A em duas mensagens: guarda o resto e espera só o telefone", () => {
  const pedido =
    `proposta de compra: comprador TESTE Newton Ditado, telefone 11, 9000-0002, imóvel Rua Augusta, 500, São Paulo/SP, valor R$ 600.000 à vista, ${CPF_TEXTO}`;

  it("1ª pergunta o telefone com os dados guardados; 2ª completa o card", async () => {
    const d = deps(completo("11, 9000-0002"));
    const p = await iniciarFluxo({ tipo: "proposta", pedido, policy: [...TUDO], agora }, d);
    expect(p.evento).toBe("telefone_duvidoso");
    expect(p.reply).not.toContain("Comprador:");
    if (!p.fluxo || p.fluxo.kind !== "proposta") throw new Error("fluxo");
    expect(p.fluxo.aguardaCampo).toEqual({ pessoa: "proponente", campo: "telefone" });
    expect(p.fluxo.dados.proponente?.nome).toBe("TESTE Newton Ditado");
    expect(p.fluxo.dados.proponente?.telefone).toBeUndefined();
    expect(p.fluxo.dados.valor).toBe(600000);
    expect(p.fluxo.dados.imovel?.endereco).toContain("Rua Augusta");

    const ctx2: ContextoDoTurno = { texto: "(11) 90000-0002", messageId: "m-2", agora: 3, policy: [...TUDO] };
    const r = await conduzirFluxo(p.fluxo, ctx2, d);
    expect(r.reply).toContain("Comprador: TESTE Newton Ditado · (11) 90000-0002");
    expect(r.reply).toContain("Rua Augusta");
    expect(r.reply).toContain("600.000");
  });
});

describe("R3.3 — telefone com código de país aparece no texto: fica, sem pergunta", () => {
  const pedido = (tel: string) =>
    `proposta de compra: comprador TESTE Estrangeiro, telefone ${tel}, imóvel Rua Augusta, 500, São Paulo/SP, valor R$ 600.000 à vista, ${CPF_TEXTO}`;
  const dadosCom = (tel: string): DadosDaProposta => ({ ...completo(tel), proponente: { nome: "TESTE Estrangeiro", telefone: tel, cpf: CPF } });
  const aberto = (): Fluxo => ({
    kind: "proposta", etapa: "revisao", natureza: "venda",
    dados: sanearDados(completo("(11) 90000-0003")), atualizadoEm: 1,
  });

  it.each(["+351 912 345 678", "+55 11 90000-0003"])("1ª mensagem: %s", async (tel) => {
    const p = await iniciarFluxo({ tipo: "proposta", pedido: pedido(tel), policy: [...TUDO], agora }, deps(dadosCom(tel)));
    expect(p.evento).not.toBe("telefone_duvidoso");
    expect(p.reply).toContain(`Comprador: TESTE Estrangeiro · ${tel}`);
  });

  it.each(["+351 912 345 678", "+55 11 90000-0004"])("correção com o card aberto: %s", async (tel) => {
    const r = await conduzirFluxo(aberto(), { texto: `o telefone é ${tel}`, messageId: "m-int", agora: 2, policy: ["proposal.create"] },
      deps({ proponente: { telefone: tel } }));
    expect(r.evento).not.toBe("telefone_duvidoso");
    expect(r.reply).toContain(tel);
  });

  it("telefone do modelo cujos dígitos NÃO estão no texto continua descartado", async () => {
    const p = await iniciarFluxo({ tipo: "proposta", pedido: pedido("+351 912 345 678"), policy: [...TUDO], agora }, deps(dadosCom("+351 999 999 999")));
    expect(p.reply).not.toContain("999 999 999");
  });
});

describe("R3.5 — estrangeiro só com regra mínima (sem libphonenumber no max-agent)", () => {
  const pedido = (tel: string) =>
    `proposta de compra: comprador TESTE Estrangeiro, telefone ${tel}, imóvel Rua Augusta, 500, São Paulo/SP, valor R$ 600.000 à vista, ${CPF_TEXTO}`;
  const dadosCom = (tel: string): DadosDaProposta => ({ ...completo(tel), proponente: { nome: "TESTE Estrangeiro", telefone: tel, cpf: CPF } });
  const aberto = (): Fluxo => ({
    kind: "proposta", etapa: "revisao", natureza: "venda",
    dados: sanearDados(completo("(11) 90000-0003")), atualizadoEm: 1,
  });

  it.each(["+5 1234 5678", "+351 123 4567", "+351 912 345 6789", "+44 7911 123456"])("1ª mensagem pergunta: %s", async (tel) => {
    const p = await iniciarFluxo({ tipo: "proposta", pedido: pedido(tel), policy: [...TUDO], agora }, deps(dadosCom(tel)));
    expect(p.evento).toBe("telefone_duvidoso");
    expect(p.reply).not.toContain("Comprador:");
  });

  it.each(["+5 1234 5678", "+351 123 4567"])("correção com o card aberto pergunta e não troca: %s", async (tel) => {
    const r = await conduzirFluxo(aberto(), { texto: `o telefone é ${tel}`, messageId: "m-r35", agora: 2, policy: ["proposal.create"] },
      deps({ proponente: { telefone: tel } }));
    expect(r.evento).toBe("telefone_duvidoso");
  });

  it("+1 com 10 dígitos e +351 com 9 passam", async () => {
    for (const tel of ["+1 415 555 2671", "+351 912 345 678"]) {
      const p = await iniciarFluxo({ tipo: "proposta", pedido: pedido(tel), policy: [...TUDO], agora }, deps(dadosCom(tel)));
      expect(p.reply).toContain(`Comprador: TESTE Estrangeiro · ${tel}`);
    }
  });

  it("'+5511 90000' não é estrangeiro (é +55 truncado): pergunta", async () => {
    const p = await iniciarFluxo({ tipo: "proposta", pedido: pedido("+5511 90000"), policy: [...TUDO], agora }, deps(dadosCom("+5511 90000")));
    expect(p.evento).toBe("telefone_duvidoso");
  });

  it("candidatos sem duplicata: +55 colado e o valor do modelo formatado", () => {
    const d = conferirDitado({ proponente: { nome: "A B", telefone: "(11) 99999-9999" } }, "telefone +5511999999999");
    expect(d.proponente?.telefone).toBe("(11) 99999-9999");
  });

  it("valor monetário com + não vira telefone candidato", () => {
    const d = conferirDitado({ proponente: { nome: "A B", telefone: "+50 000 000" } }, "valor R$ 600.000, sinal de +50 000 000");
    expect(d.proponente?.telefone).toBeUndefined();
  });
});

describe("R3.4 — de quem é o telefone que não fecha (só o texto o trouxe)", () => {
  const base = (tail: string) => `proposta de compra: comprador TESTE Novo, valor R$ 600.000 à vista, imóvel Rua Augusta, 500, São Paulo/SP, ${tail}`;
  const semTel = (): DadosDaProposta => ({ proponente: { nome: "TESTE Novo" }, imovel, valor: 600000, pagamento: { forma: "à vista" } });

  it("rótulo do vendedor: aguarda o telefone do vendedor, nunca do comprador", async () => {
    const p = await iniciarFluxo({ tipo: "proposta", pedido: base("telefone do vendedor 11, 9000-0002"), policy: [...TUDO], agora }, deps(semTel()));
    expect(p.evento).toBe("telefone_duvidoso");
    if (!p.fluxo || p.fluxo.kind !== "proposta") throw new Error("fluxo");
    expect(p.fluxo.aguardaCampo).toEqual({ pessoa: "vendedor", campo: "telefone" });
  });

  it("papel dito DEPOIS do número ou longe do rótulo não vira vendedor: mantém a atribuição do modelo (nenhuma)", async () => {
    const pedido = "proposta de compra: imóvel Rua Augusta, 500, São Paulo/SP, valor R$ 600.000, vendedor Maria (proprietária), telefone 11, 9000-0002 do comprador";
    const p = await iniciarFluxo({ tipo: "proposta", pedido, policy: [...TUDO], agora }, deps(semTel()));
    expect(p.evento).toBe("telefone_duvidoso");
    if (!p.fluxo || p.fluxo.kind !== "proposta") throw new Error("fluxo");
    expect(p.fluxo.aguardaCampo?.pessoa).not.toBe("vendedor");
  });

  it("sem rótulo identificável: não assume o comprador (sem aguardaCampo)", async () => {
    const p = await iniciarFluxo({ tipo: "proposta", pedido: base("o número 11, 9000-0002"), policy: [...TUDO], agora }, deps(semTel()));
    expect(p.evento).toBe("telefone_duvidoso");
    if (!p.fluxo || p.fluxo.kind !== "proposta") throw new Error("fluxo");
    expect(p.fluxo.aguardaCampo).toBeUndefined();
    expect(p.reply).toMatch(/de quem/i);
  });
});

describe("R3.6 — estrangeiro fora da regra mínima tem saída: a repetição vale como veio", () => {
  const pedido = (tel: string) =>
    `proposta de compra: comprador TESTE Estrangeiro, telefone ${tel}, imóvel Rua Augusta, 500, São Paulo/SP, valor R$ 600.000 à vista, ${CPF_TEXTO}`;
  const dadosCom = (tel: string): DadosDaProposta => ({ ...completo(tel), proponente: { nome: "TESTE Estrangeiro", telefone: tel, cpf: CPF } });
  const ctx = (texto: string): ContextoDoTurno => ({ texto, messageId: "m-r36", agora: 3, policy: [...TUDO] });

  it("1ª mensagem com +34: pergunta, citando o formato com +código do país", async () => {
    const p = await iniciarFluxo({ tipo: "proposta", pedido: pedido("+34 612 345 678"), policy: [...TUDO], agora }, deps(dadosCom("+34 612 345 678")));
    expect(p.evento).toBe("telefone_duvidoso");
    expect(p.reply).toContain("+código do país");
    expect(p.reply).not.toContain("Comprador:");
  });

  it.each(["+34 612 345 678", "+44 7911 123456", "+54 9 11 2345 6789", "+598 99 123 456", "+351 21 234 5678"])(
    "resposta repetindo %s: o card sai com o número como veio, sem nova pergunta", async (tel) => {
      const d = deps(dadosCom(tel));
      const p = await iniciarFluxo({ tipo: "proposta", pedido: pedido(tel), policy: [...TUDO], agora }, d);
      expect(p.evento).toBe("telefone_duvidoso");
      if (!p.fluxo) throw new Error("fluxo");
      const r = await conduzirFluxo(p.fluxo, ctx(tel), d);
      expect(r.evento).not.toBe("telefone_duvidoso");
      expect(r.reply).toContain(`Comprador: TESTE Estrangeiro · ${tel}`);
    });

  it("card aberto: a repetição do estrangeiro depois da pergunta vale", async () => {
    const aberto: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "venda", dados: sanearDados(completo("(11) 90000-0003")), atualizadoEm: 1 };
    const d = deps({ proponente: { telefone: "+44 7911 123456" } });
    const r1 = await conduzirFluxo(aberto, { texto: "o telefone é +44 7911 123456", messageId: "m-a", agora: 2, policy: ["proposal.create"] }, d);
    expect(r1.evento).toBe("telefone_duvidoso");
    if (!r1.fluxo) throw new Error("fluxo");
    const r2 = await conduzirFluxo(r1.fluxo, { texto: "o telefone é +44 7911 123456", messageId: "m-b", agora: 3, policy: ["proposal.create"] }, d);
    expect(r2.evento).not.toBe("telefone_duvidoso");
    expect(r2.reply).toContain("+44 7911 123456");
  });

  it("resposta brasileira que não fecha ('11, 9000-0002') à pergunta: pergunta de novo", async () => {
    const d = deps(dadosCom("+34 612 345 678"));
    const p = await iniciarFluxo({ tipo: "proposta", pedido: pedido("+34 612 345 678"), policy: [...TUDO], agora }, d);
    if (!p.fluxo) throw new Error("fluxo");
    const r = await conduzirFluxo(p.fluxo, ctx("11, 9000-0002"), d);
    expect(r.evento).toBe("telefone_duvidoso");
    expect(r.reply).not.toContain("Comprador:");
  });

  it("repetição do brasileiro duvidoso (caso do áudio) continua perguntando", async () => {
    const d = deps(completo("11, 9000-0002"));
    const p = await iniciarFluxo({ tipo: "proposta", pedido: pedido("11, 9000-0002"), policy: [...TUDO], agora }, d);
    if (!p.fluxo) throw new Error("fluxo");
    const r = await conduzirFluxo(p.fluxo, ctx("11, 9000-0002"), d);
    expect(r.evento).toBe("telefone_duvidoso");
    const r2 = await conduzirFluxo(r.fluxo as Fluxo, ctx("telefone 11, 9000-0002"), d);
    expect(r2.evento).toBe("telefone_duvidoso");
  });

  it("'telefone do vendedor é 11, 9000-0002': aguarda o telefone do vendedor", async () => {
    const pedidoV = "proposta de compra: comprador TESTE Novo, valor R$ 600.000 à vista, imóvel Rua Augusta, 500, São Paulo/SP, telefone do vendedor é 11, 9000-0002";
    const p = await iniciarFluxo({ tipo: "proposta", pedido: pedidoV, policy: [...TUDO], agora },
      deps({ proponente: { nome: "TESTE Novo" }, imovel, valor: 600000, pagamento: { forma: "à vista" } }));
    expect(p.evento).toBe("telefone_duvidoso");
    if (!p.fluxo || p.fluxo.kind !== "proposta") throw new Error("fluxo");
    expect(p.fluxo.aguardaCampo).toEqual({ pessoa: "vendedor", campo: "telefone" });
  });

  it("'é' só vale colado ao papel: 'telefone do vendedor é o mesmo, 11, …' não atribui", async () => {
    const pedidoV = "proposta de compra: comprador TESTE Novo, valor R$ 600.000 à vista, imóvel Rua Augusta, 500, São Paulo/SP, telefone do vendedor é o mesmo do anúncio 11, 9000-0002";
    const p = await iniciarFluxo({ tipo: "proposta", pedido: pedidoV, policy: [...TUDO], agora },
      deps({ proponente: { nome: "TESTE Novo" }, imovel, valor: 600000, pagamento: { forma: "à vista" } }));
    if (!p.fluxo || p.fluxo.kind !== "proposta") throw new Error("fluxo");
    expect(p.fluxo.aguardaCampo?.pessoa).not.toBe("vendedor");
  });
});

describe("telefones válidos continuam como vieram", () => {
  it.each(["(11) 90000-0003", "11 90000-0003", "+55 11 90000-0003", "+351 912 345 678"])("%s", (t) => {
    expect(sanearDados({ proponente: { nome: "A B", telefone: t } }).proponente?.telefone).toBe(t);
  });
  it("sequência ditada que fecha vira (DD) NNNNN-NNNN", () => {
    expect(sanearDados({ proponente: { nome: "A B", telefone: "11, 90000-0004" } }).proponente?.telefone).toBe("(11) 90000-0004");
    expect(sanearDados({ proponente: { nome: "A B", telefone: "11 9 0000 0004" } }).proponente?.telefone).toBe("(11) 90000-0004");
  });
});

describe("C — captação, etapa de proprietários: frases de parada", () => {
  const fluxo = (): FluxoCaptacao => ({ kind: "captacao", etapa: "proprietarios", tentativas: 0, atualizadoEm: 1 });
  const d: DepsDoFluxo = { acao: vi.fn().mockResolvedValue(null), extrairProposta: async () => null, extrairCampos: async () => null };
  const ctx = (texto: string): ContextoDoTurno => ({ texto, messageId: "m-c", agora: 2, policy: ["captacao.create"] });

  it.each(["para por aqui, não envia nada", "pare", "não envia nada", "deixa pra lá", "para por aqui"])(
    "encerra: %s", async (texto) => {
      const r = await conduzirCaptacao(fluxo(), ctx(texto), d, true);
      expect(r.fluxo).toBeNull();
      expect(r.evento).toBe("captacao_cancelado");
    });

  it.each(["pare.", "Para por aqui!", "deixa para lá", "Deixa pra lá.", "não envia nada!"])("pontuação final e variantes: %s", async (texto) => {
    const r = await conduzirCaptacao(fluxo(), ctx(texto), d, true);
    expect(r.evento).toBe("captacao_cancelado");
  });

  it.each(["venda para João da Silva", "Rua Deixa Pra Lá, 10", "Maria Para Silva"])("'para'/'deixa' dentro de outra frase não cancela: %s", async (texto) => {
    const r = await conduzirCaptacao(fluxo(), ctx(texto), d, true);
    expect(r.evento).not.toBe("captacao_cancelado");
  });
});
