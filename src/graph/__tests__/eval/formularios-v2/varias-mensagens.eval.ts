import { afterEach, describe, expect, it } from "vitest";
import { ModeloFalso, PESSOAS, Sessao, formatarCpf, roteirosDe, verificarTransversais, CPF_SINTETICO } from "./harness";

/**
 * Vários mensagens curtas: nome, depois CPF, depois valor. Os dois primeiros turnos ficam em silêncio (só a
 * reação) e a ficha sai agendada pelo outbox; o terceiro completa o rascunho e mostra a ficha na hora. A
 * janela da extração cresce a cada mensagem, para o modelo ter o contexto das anteriores.
 */
describe("eval fv2: várias mensagens (nome, depois CPF, depois valor)", () => {
  let s: Sessao;
  afterEach(async () => {
    await verificarTransversais(s);
  });

  const roteiros = () =>
    roteirosDe([
      { compradores: [{ nome: PESSOAS.comprador }] },
      { compradores: [{ cpf: "{{CPF:1}}" }] },
      { negociacao: { valor: 500000 } },
    ]);

  it.each(["max", "newton"] as const)("%s: silêncio nas parciais, ficha ao completar, grava só no sim", async (bot) => {
    s = new Sessao({ bot, modelo: new ModeloFalso().roteiro(...roteiros()), nomes: [PESSOAS.comprador], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();

    const t1 = await s.fala(`comprador ${PESSOAS.comprador}`);
    expect(t1.reply, "turno 1 em silêncio").toBeNull();
    expect(s.fichasAgendadas).toHaveLength(1);
    expect(s.fichasAgendadas[0]).toContain(PESSOAS.comprador);
    expect(s.fichasAgendadas[0]).toContain("Valor da proposta");

    const t2 = await s.fala(`cpf ${formatarCpf(CPF_SINTETICO)}`);
    expect(t2.reply, "turno 2 em silêncio").toBeNull();
    expect(s.fichasAgendadas).toHaveLength(2);
    expect(s.fichasAgendadas[1]).toContain("***.982.247-**");
    expect(s.fichasAgendadas[1]).not.toContain(formatarCpf(CPF_SINTETICO));

    const t3 = await s.fala("valor R$ 500.000");
    expect(t3.reply).toContain(PESSOAS.comprador);
    expect(t3.reply).toMatch(/responda SIM/i);
    expect(s.servidor.escritas(), "nada gravado antes do sim").toHaveLength(0);

    const t4 = await s.fala("sim");
    expect(t4.escritas.map((w) => [w.verb, w.status])).toEqual([["proposal.create", 201]]);
    expect(s.servidor.rascunho?.compradores[0]).toMatchObject({ nome: PESSOAS.comprador, cpf: CPF_SINTETICO });
    expect(s.servidor.rascunho?.negociacao.valor).toBe(500000);
  });

  it("a janela da extração cresce, com as mensagens anteriores em cercas e o CPF tokenizado", async () => {
    s = new Sessao({ modelo: new ModeloFalso().roteiro(...roteiros()), nomes: [PESSOAS.comprador], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();
    await s.fala(`comprador ${PESSOAS.comprador}`);
    await s.fala(`cpf ${formatarCpf(CPF_SINTETICO)}`);
    await s.fala("valor R$ 500.000");

    const extracoes = s.modelo.chamadas.filter((c) => c.ferramenta === "preencher_proposta_v2");
    expect(extracoes).toHaveLength(3);
    expect(extracoes[0]!.conteudo).toContain('<mensagem n="1" atual="true">');
    expect(extracoes[2]!.conteudo).toContain('<mensagem n="1">');
    expect(extracoes[2]!.conteudo).toContain('<mensagem n="2">');
    expect(extracoes[2]!.conteudo).toContain('<mensagem n="3" atual="true">');
    expect(extracoes[2]!.conteudo).toMatch(/⟨CPF_1⟩/);
    expect(extracoes[2]!.conteudo).toMatch(/⟨VALOR_1⟩/);
  });

  it("o 'sim' antes de o corretor ter visto a ficha mostra a ficha e não grava", async () => {
    s = new Sessao({ modelo: new ModeloFalso().roteiro(...roteiros()), nomes: [PESSOAS.comprador], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();
    await s.fala(`comprador ${PESSOAS.comprador}`);
    const t = await s.fala("sim");
    expect(t.escritas).toHaveLength(0);
    expect(t.reply).toContain("📋 Rascunho da proposta");
    expect(s.servidor.rascunho).toBeNull();
  });
});
