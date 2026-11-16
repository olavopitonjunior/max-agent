import { afterEach, describe, expect, it } from "vitest";
import { CPF_SINTETICO, ModeloFalso, PESSOAS, Sessao, formatarCpf, roteirosDe, verificarTransversais } from "./harness";

/**
 * Dado repetido. O mesmo CPF dito de novo para a MESMA parte não cria parte nova, e para outra
 * posição (mesmo lado) é a mesma pessoa e vira uma só; em lados ou nomes diferentes o agente PERGUNTA antes
 * do cartão e do sim (F4). Se mesmo assim o servidor devolver 409, nada é dado como gravado e a causa
 * dita é só a que o corpo do 409 diz (F4b).
 */
describe("eval fv2: dado repetido", () => {
  let s: Sessao;
  afterEach(async () => {
    await verificarTransversais(s);
  });

  it("o mesmo CPF duas vezes na mesma parte dá uma parte só", async () => {
    const modelo = new ModeloFalso().roteiro(
      ...roteirosDe([
        { compradores: [{ nome: PESSOAS.comprador, cpf: "{{CPF:1}}" }], negociacao: { valor: 500000 } },
        { compradores: [{ cpf: "{{CPF:1}}" }] },
      ])
    );
    s = new Sessao({ modelo, nomes: [PESSOAS.comprador], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();

    const t1 = await s.fala(`comprador ${PESSOAS.comprador} CPF ${formatarCpf(CPF_SINTETICO)} valor R$ 500.000, ficha`);
    const t2 = await s.fala(`o CPF dele é ${formatarCpf(CPF_SINTETICO)}, ficha`);
    expect(t2.reply).toBe(t1.reply);
    expect(t2.reply).not.toContain("Comprador 2");

    const t3 = await s.fala("sim");
    expect(t3.escritas.map((w) => [w.verb, w.status])).toEqual([["proposal.create", 201]]);
    expect(s.servidor.escritasDoVerbo("proposal.create")).toHaveLength(1);
    expect(s.servidor.rascunho?.compradores).toHaveLength(1);
  });

  it("o mesmo CPF dito para duas posições do mesmo lado (mesma pessoa) vira uma parte só, antes do cartão e do SIM", async () => {
    const modelo = new ModeloFalso().roteiro(
      ...roteirosDe([
        { compradores: [{ nome: PESSOAS.comprador, cpf: "{{CPF:1}}" }], negociacao: { valor: 500000 } },
        { compradores: [{}, { cpf: "{{CPF:1}}" }] },
      ])
    );
    s = new Sessao({ modelo, nomes: [PESSOAS.comprador], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();

    await s.fala(`comprador ${PESSOAS.comprador} CPF ${formatarCpf(CPF_SINTETICO)} valor R$ 500.000, ficha`);
    const t2 = await s.fala(`o segundo comprador tem CPF ${formatarCpf(CPF_SINTETICO)}, ficha`);
    expect(t2.reply).not.toContain("Comprador 2");

    const t3 = await s.fala("sim");
    expect(t3.escritas.map((w) => [w.verb, w.status])).toEqual([["proposal.create", 201]]);
    expect(s.servidor.rascunho?.compradores).toHaveLength(1);
  });

  it("o mesmo CPF em duas pessoas de nome diferente: o agente pergunta antes do sim e não escreve nada (F4)", async () => {
    const modelo = new ModeloFalso().roteiro(
      ...roteirosDe([
        { compradores: [{ nome: PESSOAS.comprador, cpf: "{{CPF:1}}" }], negociacao: { valor: 500000 } },
        { compradores: [{}, { nome: PESSOAS.compradora2, cpf: "{{CPF:1}}" }] },
      ])
    );
    s = new Sessao({ modelo, nomes: [PESSOAS.comprador, PESSOAS.compradora2], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();

    await s.fala(`comprador ${PESSOAS.comprador} CPF ${formatarCpf(CPF_SINTETICO)} valor R$ 500.000, ficha`);
    const t2 = await s.fala(`a ${PESSOAS.compradora2} é a segunda compradora, CPF ${formatarCpf(CPF_SINTETICO)}, ficha`);
    expect(t2.reply).toContain("O mesmo CPF/CNPJ apareceu para duas pessoas");
    expect(t2.reply).toContain(PESSOAS.comprador);
    expect(t2.reply).toContain(PESSOAS.compradora2);
    expect(t2.reply).not.toContain("Comprador 2 · Nome");

    // O sim não grava: o cartão com o mesmo CPF em duas pessoas nunca foi mostrado.
    const t3 = await s.fala("sim");
    expect(t3.escritas).toEqual([]);
    expect(t3.reply).toContain("O mesmo CPF/CNPJ apareceu para duas pessoas");
    // A pergunta diz que NADA foi anotado; não pode afirmar que gravou.
    expect(t3.reply).toContain("não anotei nada");
    expect(t3.reply).not.toMatch(/proposta (criada|salva)|salvei/i);
    expect(s.servidor.escritas()).toHaveLength(0);
    expect(s.servidor.rascunho).toBeNull();
  });

  it("o mesmo CPF como comprador e como vendedor: pergunta em vez de escrever (F4)", async () => {
    const modelo = new ModeloFalso().roteiro(
      ...roteirosDe([
        {
          compradores: [{ nome: PESSOAS.comprador, cpf: "{{CPF:1}}" }],
          vendedores: [{ nome: PESSOAS.vendedor, cpf: "{{CPF:1}}" }],
          negociacao: { valor: 500000 },
        },
      ])
    );
    s = new Sessao({ modelo, nomes: [PESSOAS.comprador, PESSOAS.vendedor], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();

    const t1 = await s.fala(
      `comprador ${PESSOAS.comprador} CPF ${formatarCpf(CPF_SINTETICO)}, vendedor ${PESSOAS.vendedor} CPF ${formatarCpf(CPF_SINTETICO)}, valor R$ 500.000, ficha`
    );
    expect(t1.reply).toContain("O mesmo CPF/CNPJ apareceu para duas pessoas");
    const t2 = await s.fala("sim");
    expect(t2.escritas).toEqual([]);
    expect(s.servidor.rascunho).toBeNull();
  });

  it("o servidor ainda recusa com 409 (causa não dita): nada é dado como gravado e o texto não inventa a causa (F4b)", async () => {
    const modelo = new ModeloFalso().roteiro(
      ...roteirosDe([{ compradores: [{ nome: PESSOAS.comprador, cpf: "{{CPF:1}}" }], negociacao: { valor: 500000 } }])
    );
    s = new Sessao({ modelo, nomes: [PESSOAS.comprador], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();
    s.servidor.programar("proposal.create", { status: 409, body: { error: "signatarios_duplicados" } });

    await s.fala(`comprador ${PESSOAS.comprador} CPF ${formatarCpf(CPF_SINTETICO)} valor R$ 500.000, ficha`);
    const t = await s.fala("sim");
    expect(t.escritas.map((w) => [w.verb, w.status])).toEqual([["proposal.create", 409]]);
    expect(t.reply).toMatch(/assinantes repetidos/i);
    expect(t.reply).not.toMatch(/telefone|e-mail|email/i);
    expect(t.reply).not.toMatch(/anotei|salvei/i);
    expect(s.servidor.rascunho).toBeNull();
  });
});
