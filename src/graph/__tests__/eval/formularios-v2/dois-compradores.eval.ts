import { afterEach, describe, expect, it } from "vitest";
import { ModeloFalso, PESSOAS, Sessao, cpfFicticio, formatarCpf, roteirosDe, verificarTransversais } from "./harness";

/**
 * Dois compradores: cada um com o seu CPF, na mesma mensagem ou em mensagens separadas. A ficha mostra
 * Comprador 1 e Comprador 2; o "sim" grava UMA proposta com os dois, cada CPF no seu dono.
 */
describe("eval fv2: dois compradores", () => {
  let s: Sessao;
  const cpf1 = cpfFicticio(11);
  const cpf2 = cpfFicticio(23);
  afterEach(async () => {
    await verificarTransversais(s);
  });

  it("na mesma mensagem", async () => {
    const modelo = new ModeloFalso().roteiro(
      ...roteirosDe([
        {
          compradores: [
            { nome: PESSOAS.comprador, cpf: "{{CPF:1}}" },
            { nome: PESSOAS.compradora2, cpf: "{{CPF:2}}" },
          ],
          negociacao: { valor: 900000 },
        },
      ])
    );
    s = new Sessao({ modelo, nomes: [PESSOAS.comprador, PESSOAS.compradora2], cpfs: [cpf1, cpf2] });
    await s.preparar();
    await s.semear();

    const t1 = await s.fala(
      `compradores ${PESSOAS.comprador} CPF ${formatarCpf(cpf1)} e ${PESSOAS.compradora2} CPF ${formatarCpf(cpf2)}, valor R$ 900.000, pode montar a ficha`
    );
    expect(t1.reply).toContain("Comprador 1 · Nome: " + PESSOAS.comprador);
    expect(t1.reply).toContain("Comprador 2 · Nome: " + PESSOAS.compradora2);
    expect(t1.reply).not.toContain(formatarCpf(cpf1));
    expect(t1.reply).not.toContain(formatarCpf(cpf2));
    expect(s.servidor.escritas()).toHaveLength(0);

    const t2 = await s.fala("sim");
    expect(t2.escritas.map((w) => [w.verb, w.status])).toEqual([["proposal.create", 201]]);
    expect(s.servidor.escritasDoVerbo("proposal.create")).toHaveLength(1);
    expect(s.servidor.rascunho?.compradores).toEqual([
      expect.objectContaining({ nome: PESSOAS.comprador, cpf: cpf1 }),
      expect.objectContaining({ nome: PESSOAS.compradora2, cpf: cpf2 }),
    ]);
  });

  it("o segundo comprador chega depois, com a ficha do primeiro já vista", async () => {
    const modelo = new ModeloFalso().roteiro(
      ...roteirosDe([
        { compradores: [{ nome: PESSOAS.comprador, cpf: "{{CPF:1}}" }], negociacao: { valor: 900000 } },
        // A janela traz os dois CPFs, na ordem de aparição: o segundo é o do novo comprador.
        { compradores: [{}, { nome: PESSOAS.compradora2, cpf: "{{CPF:2}}" }] },
      ])
    );
    s = new Sessao({ modelo, nomes: [PESSOAS.comprador, PESSOAS.compradora2], cpfs: [cpf1, cpf2] });
    await s.preparar();
    await s.semear();

    await s.fala(`comprador ${PESSOAS.comprador} CPF ${formatarCpf(cpf1)} valor R$ 900.000, ficha`);
    const t2 = await s.fala(`tem um segundo comprador, ${PESSOAS.compradora2} CPF ${formatarCpf(cpf2)}, ficha`);
    expect(t2.reply).toContain("Comprador 1 · Nome: " + PESSOAS.comprador);
    expect(t2.reply).toContain("Comprador 2 · Nome: " + PESSOAS.compradora2);

    const t3 = await s.fala("sim");
    expect(t3.escritas.map((w) => [w.verb, w.status])).toEqual([["proposal.create", 201]]);
    expect(s.servidor.rascunho?.compradores).toEqual([
      expect.objectContaining({ nome: PESSOAS.comprador, cpf: cpf1 }),
      expect.objectContaining({ nome: PESSOAS.compradora2, cpf: cpf2 }),
    ]);
  });
});
