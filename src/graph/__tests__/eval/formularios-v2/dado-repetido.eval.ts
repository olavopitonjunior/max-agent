import { afterEach, describe, expect, it } from "vitest";
import { CPF_SINTETICO, ModeloFalso, PESSOAS, Sessao, formatarCpf, roteirosDe, verificarTransversais } from "./harness";

/**
 * Dado repetido. O mesmo CPF dito de novo para a MESMA parte não cria parte nova. O mesmo CPF para outra
 * posição o agente não barra (achado F4, `achados.eval.ts`): quem barra é o servidor com 409, e o caso
 * afirma o que importa, que nada é afirmado como gravado e o rascunho não nasce.
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

  it("o mesmo CPF em duas partes: o servidor recusa (409), nada é dado como gravado e o sim repetido não cria", async () => {
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
    expect(t2.reply).toContain("Comprador 2 · Nome: " + PESSOAS.compradora2);

    const t3 = await s.fala("sim");
    expect(t3.escritas.map((w) => [w.verb, w.status])).toEqual([["proposal.create", 409]]);
    expect(t3.reply).toContain("Esse contato já está em outro assinante da proposta.");
    expect(t3.reply).not.toMatch(/anotei|salvei/i);
    expect(s.servidor.rascunho).toBeNull();

    // Insistir no sim repete a mesma tentativa e continua sem gravar.
    const t4 = await s.fala("sim");
    expect(t4.escritas.every((w) => w.status === 409)).toBe(true);
    expect(t4.reply).not.toMatch(/anotei|salvei/i);
    expect(s.servidor.rascunho).toBeNull();
  });
});
