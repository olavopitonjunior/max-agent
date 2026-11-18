import { afterEach, describe, expect, it } from "vitest";
import { ModeloFalso, PESSOAS, ServidorFalso, Sessao, verificarTransversais } from "./harness";
import { lerIntencaoDeFormulario } from "../../../formularios/intencao";

/**
 * Erros de digitação ("propsta", "captaçao", "porposta"). Duas camadas, cada uma com o que realmente faz:
 *  - a função pura `lerIntencaoDeFormulario` reconhece o que está na lista de variações;
 *  - com a criação permitida, quem abre o fluxo é o MODELO (`propor_criacao`): o eval simula o modelo
 *    acertando a intenção e confere o resto do caminho. A tolerância do modelo real a typos NÃO é medida
 *    aqui (precisa do eval com modelo real, `vitest.eval.config.ts`).
 * Os typos que a função pura não pega estão em `achados.eval.ts`.
 */
describe("eval fv2: erro de digitação", () => {
  let s: Sessao | undefined;
  afterEach(async () => {
    if (s) await verificarTransversais(s);
    s = undefined;
  });

  it.each([
    ["quero fazer uma porposta de compra", "proposta", "venda"],
    ["nova proposa", "proposta", undefined],
    ["captaçao nova", "captacao", undefined],
    ["criar captacao", "captacao", undefined],
  ] as const)("a função pura entende %j", (texto, alvo, esteira) => {
    const i = lerIntencaoDeFormulario(texto);
    expect(i).toMatchObject({ tipo: "criar", alvo });
    if (esteira) expect(i).toMatchObject({ esteira });
  });

  it("'propsta' com a criação permitida: o modelo abre o fluxo e a conversa segue normal", async () => {
    const modelo = new ModeloFalso()
      .conversa({ toolCalls: [{ id: "c1", name: "propor_criacao", args: { tipo: "proposta", natureza: "venda" } }] })
      .roteiro(() => ({}), () => ({ compradores: [{ nome: PESSOAS.comprador }], negociacao: { valor: 500000 } }));
    s = new Sessao({ modelo, nomes: [PESSOAS.comprador] });
    await s.preparar();

    const t1 = await s.fala("quero criar uma propsta de venda");
    expect(t1.reply).toContain("vamos montar a proposta de compra e venda");
    expect(s.servidor.escritas()).toHaveLength(0);
    const t2 = await s.fala(`comprador ${PESSOAS.comprador}, valor R$ 500.000, pode montar a ficha`);
    expect(t2.reply).toContain(PESSOAS.comprador);
    expect(s.servidor.escritas(), "a ficha não grava").toHaveLength(0);
  });

  it("sem a capability de criar, o typo recebe recusa clara e nenhum modelo é chamado", async () => {
    s = new Sessao({ politica: ["proposal.send"], servidor: new ServidorFalso({ fluxoV2: true }), modelo: new ModeloFalso() });
    await s.preparar();

    const t = await s.fala("quero criar uma propsta de venda");
    expect(t.reply).toContain("Criar formulário ou proposta pelo Max não está disponível para você agora.");
    expect(t.reply).toContain("Nada foi criado");
    expect(s.modelo.chamadas).toHaveLength(0);
    expect(s.servidor.escritas()).toHaveLength(0);
  });

  it("'captaçao' não abre o fluxo v2 de proposta: segue para o chat, sem escrita", async () => {
    s = new Sessao({ modelo: new ModeloFalso() });
    await s.preparar();

    const t = await s.fala("quero cadastrar uma captaçao");
    expect(t.reply).toBe("Como posso ajudar?");
    expect(await s.fluxo()).toBeUndefined();
    expect(s.servidor.escritas()).toHaveLength(0);
  });
});
