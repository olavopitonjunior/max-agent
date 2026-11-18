import { afterEach, describe, expect, it } from "vitest";
import { CPF_SINTETICO, ModeloFalso, PESSOAS, Sessao, verificarTransversais } from "./harness";

/**
 * Áudio: a transcrição é feita no servidor (`transcribeMedia`) e entra no mesmo caminho do texto. O modelo
 * recebe o texto transcrito com tokens; sem áudio inteligível o agente pede por escrito e não escreve nada.
 */
describe("eval fv2: áudio", () => {
  let s: Sessao;
  afterEach(async () => {
    await verificarTransversais(s);
  });

  it("áudio com nome, CPF e valor vira ficha mascarada e só o sim grava", async () => {
    const modelo = new ModeloFalso().roteiro(({ tokens }) => ({
      compradores: [{ nome: PESSOAS.comprador, cpf: tokens.CPF[0] }],
      negociacao: { valor: 500000 },
    }));
    s = new Sessao({ modelo, nomes: [PESSOAS.comprador], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();

    const t1 = await s.audio(`comprador ${PESSOAS.comprador} cpf 529.982.247-25 valor R$ 500.000`);
    expect(t1.reply).toContain(PESSOAS.comprador);
    expect(t1.reply).toContain("***.982.247-**");
    expect(t1.reply).not.toContain("529.982.247-25");
    expect(t1.reply).toMatch(/responda SIM/i);
    expect(s.servidor.escritas()).toHaveLength(0);
    // O modelo recebeu a transcrição já tokenizada.
    expect(s.modelo.chamadas[0]!.conteudo).toContain("⟨CPF_1⟩");

    const t2 = await s.fala("sim");
    expect(t2.escritas.map((w) => [w.verb, w.status])).toEqual([["proposal.create", 201]]);
    expect(s.servidor.rascunho?.compradores[0]).toMatchObject({ nome: PESSOAS.comprador, cpf: CPF_SINTETICO });
  });

  it("áudio que não dá para ouvir: pede por escrito, sem modelo e sem escrita", async () => {
    s = new Sessao({ modelo: new ModeloFalso(), nomes: [PESSOAS.comprador], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();

    const t = await s.audio(null);
    expect(t.reply).toBe("Não consegui ouvir esse áudio. Pode me mandar por escrito?");
    expect(s.modelo.extracoesFeitas).toBe(0);
    expect(s.servidor.escritas()).toHaveLength(0);
  });
});
