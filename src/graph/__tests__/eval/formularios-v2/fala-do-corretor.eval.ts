import { afterEach, describe, expect, it } from "vitest";
import { CPF_SINTETICO, ModeloFalso, PESSOAS, Sessao, formatarCpf, roteirosDe, telefoneFicticio, verificarTransversais } from "./harness";

/**
 * I1/I2: a fala do corretor numa proposta v2 nunca vai em claro para o `messages` do checkpoint, em QUALQUER
 * caminho do grafo (abertura pelo `propor_criacao`, interceptações como consulta/gestão), e a janela da
 * extração continua enxergando a fala de abertura (vem do cofre cifrado, não do histórico).
 */
describe("eval fv2: a fala do corretor não vaza para o histórico do checkpoint", () => {
  let s: Sessao;
  afterEach(async () => {
    await verificarTransversais(s);
  });

  const tel = telefoneFicticio(31);

  it("I1: a mensagem que ABRE a proposta (com CPF e telefone) vira marcador no histórico", async () => {
    const modelo = new ModeloFalso()
      .conversa({ toolCalls: [{ id: "c1", name: "propor_criacao", args: { tipo: "proposta", natureza: "venda" } }] })
      .roteiro(...roteirosDe([{ compradores: [{ nome: PESSOAS.comprador, cpf: "{{CPF:1}}", telefone: "{{TEL:1}}" }] }]));
    s = new Sessao({ modelo, nomes: [PESSOAS.comprador], cpfs: [CPF_SINTETICO] });
    await s.preparar();

    const t = await s.fala(`quero criar uma propsta de venda, comprador ${PESSOAS.comprador} CPF ${formatarCpf(CPF_SINTETICO)} telefone ${tel}`);
    // O corretor continua recebendo a ficha real; só o state guarda o marcador.
    expect(t.reply).toContain(PESSOAS.comprador);
    expect(((await s.fluxo()) as { kind?: string } | undefined)?.kind).toBe("proposta_v2");

    const historico = await s.historicoDoCheckpoint();
    expect(historico.replace(/\D/g, "").includes(CPF_SINTETICO), "CPF em claro no histórico").toBe(false);
    expect(historico.includes(formatarCpf(CPF_SINTETICO))).toBe(false);
    expect(historico.includes(tel)).toBe(false);
    expect(historico).toContain("(resposta da ficha de proposta)");  });

  it("I2: o que foi dito na abertura chega à janela da extração do turno seguinte (cofre, não histórico)", async () => {
    const modelo = new ModeloFalso()
      .conversa({ toolCalls: [{ id: "c1", name: "propor_criacao", args: { tipo: "proposta", natureza: "venda" } }] })
      .roteiro(...roteirosDe([{ compradores: [{ nome: PESSOAS.comprador }] }, { compradores: [{ cpf: "{{CPF:1}}" }] }]));
    s = new Sessao({ modelo, nomes: [PESSOAS.comprador], cpfs: [CPF_SINTETICO] });
    await s.preparar();

    await s.fala(`quero criar uma propsta de venda, comprador ${PESSOAS.comprador}`);
    await s.fala(`o CPF dele é ${formatarCpf(CPF_SINTETICO)}`);

    const extracoes = s.modelo.chamadas.filter((c) => c.ferramenta === "preencher_proposta_v2");
    expect(extracoes.length).toBeGreaterThanOrEqual(2);
    const segunda = extracoes[extracoes.length - 1]!;
    expect(segunda.conteudo, "a abertura tem de estar na janela").toContain('<mensagem n="1">');
    expect(segunda.conteudo).toContain(PESSOAS.comprador);
    expect(segunda.conteudo).toContain('<mensagem n="2" atual="true">');
  });

  it("I1: pergunta fora da ficha (consulta) com CPF no meio da proposta v2 não deixa o CPF no histórico", async () => {
    const modelo = new ModeloFalso().roteiro(...roteirosDe([{ compradores: [{ nome: PESSOAS.comprador }] }]));
    s = new Sessao({ modelo, nomes: [PESSOAS.comprador], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();

    await s.fala(`comprador ${PESSOAS.comprador}`);
    expect(((await s.fluxo()) as { kind?: string } | undefined)?.kind).toBe("proposta_v2");
    const tq = await s.fala(`quais são as minhas propostas em andamento? o CPF do cliente é ${formatarCpf(CPF_SINTETICO)}`);
    expect(tq.reply, "o turno foi interceptado pela consulta").toContain("permissão para consultar propostas");

    const historico = await s.historicoDoCheckpoint();
    expect(historico.replace(/\D/g, "").includes(CPF_SINTETICO), "CPF em claro no histórico").toBe(false);
    expect(historico.includes(formatarCpf(CPF_SINTETICO))).toBe(false);
  });
});
