import { describe, expect, it } from "vitest";
import { CPF_SINTETICO, ModeloFalso, PESSOAS, Sessao, formatarCpf } from "./harness";
import { lerIntencaoDeFormulario } from "../../../formularios/intencao";

/**
 * ACHADOS dos evals (Tarefa 18). Cada caso afirma o comportamento DESEJADO; enquanto o código tem o defeito,
 * ele falha de verdade e o `it.fails` o deixa verde, com a razão ao lado. Quando o código for corrigido o
 * `it.fails` passa a falhar ("espera falhar e passou"): é o sinal para trocar por `it`. Nada daqui foi
 * corrigido no código de produção (fora do escopo da T18).
 */
describe("eval fv2: achados", () => {
  async function comTudoNumaMensagem(): Promise<Sessao> {
    const modelo = new ModeloFalso().roteiro(({ tokens }) => ({
      compradores: [{ nome: PESSOAS.comprador, cpf: tokens.CPF[0] }],
      negociacao: { valor: 500000 },
    }));
    const s = new Sessao({ modelo, nomes: [PESSOAS.comprador], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();
    await s.fala(`comprador ${PESSOAS.comprador} CPF ${formatarCpf(CPF_SINTETICO)} valor R$ 500.000, ficha`);
    return s;
  }

  // F1 (PII, regra 6 do brief): a fala do corretor (com CPF/telefone) não fica em claro no histórico do
  // checkpoint. Como `credito`/`captacao`, `messages` guarda só "(resposta da ficha de proposta)"; a fala
  // vai CIFRADA para o fluxo (`cofreFalas`) e a janela de extração a lê de lá.
  it("F1: o CPF dito pelo corretor não fica em claro no histórico do checkpoint", async () => {
    const s = await comTudoNumaMensagem();
    const historico = await s.historicoDoCheckpoint();
    expect(historico.replace(/\D/g, "").includes(CPF_SINTETICO)).toBe(false);
    expect(historico.includes(formatarCpf(CPF_SINTETICO))).toBe(false);
    expect(historico).toContain("(resposta da ficha de proposta)");
  });

  // F3 (UX): `rotuloDoPath` (src/graph/formularios/midia.ts) não tem rótulo para `negociacao.*`,
  // `corretor.*` e `observacoes`; o valor da proposta lido pelo modelo aparece na ficha como
  // "Outros · negociacao.valor: 500000".
  it("F3: a ficha rotula o valor como 'Valor da negociação', não pelo caminho técnico", async () => {
    const s = await comTudoNumaMensagem();
    expect(s.ultimaResposta).not.toContain("negociacao.valor");
    expect(s.ultimaResposta).toContain("Valor da negociação");
  });

  // F5: a função pura tolera erro de digitação na palavra-chave sozinha ("propsta", "capitação").
  it("F5a: 'propsta' sozinho é entendido como pedido de proposta", () => {
    expect(lerIntencaoDeFormulario("propsta")).toMatchObject({ tipo: "criar", alvo: "proposta" });
    expect(lerIntencaoDeFormulario("porposta")).toMatchObject({ tipo: "criar", alvo: "proposta" });
    expect(lerIntencaoDeFormulario("proposa")).toMatchObject({ tipo: "criar", alvo: "proposta" });
  });
  it("F5b: 'capitação' é entendido como captação", () => {
    expect(lerIntencaoDeFormulario("capitação")).toMatchObject({ tipo: "criar", alvo: "captacao" });
    expect(lerIntencaoDeFormulario("captaçao")).toMatchObject({ tipo: "criar", alvo: "captacao" });
    expect(lerIntencaoDeFormulario("captacão")).toMatchObject({ tipo: "criar", alvo: "captacao" });
  });
  it("F5c: palavras reais parecidas não viram pedido", () => {
    for (const t of ["resposta", "aposta", "capacitação", "proposito"]) {
      expect(lerIntencaoDeFormulario(t), t).toBeNull();
    }
  });

  // F4 e F4b: mais casos em `dado-repetido.eval.ts` (mesma pessoa vira uma parte só; nomes ou lados diferentes
  // são perguntados antes do sim) e em `documento-repetido.test.ts` (texto do 409 sem inventar a causa).
  it("F4: o mesmo CPF em duas pessoas é perguntado antes do sim, nunca gravado", async () => {
    const modelo = new ModeloFalso().roteiro(({ tokens }) => ({
      compradores: [{ nome: PESSOAS.comprador, cpf: tokens.CPF[0] }],
      vendedores: [{ nome: PESSOAS.vendedor, cpf: tokens.CPF[0] }],
      negociacao: { valor: 500000 },
    }));
    const s = new Sessao({ modelo, nomes: [PESSOAS.comprador, PESSOAS.vendedor], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();
    const t = await s.fala(
      `comprador ${PESSOAS.comprador} CPF ${formatarCpf(CPF_SINTETICO)}, vendedor ${PESSOAS.vendedor} CPF ${formatarCpf(CPF_SINTETICO)}, valor R$ 500.000, ficha`
    );
    expect(t.reply).toContain("O mesmo CPF/CNPJ apareceu para duas pessoas");
    expect((await s.fala("sim")).escritas).toEqual([]);
  });
  it("F4b: o 409 signatarios_duplicados (só o código, como no contrato) tem texto neutro, sem afirmar a causa", async () => {
    const modelo = new ModeloFalso().roteiro(({ tokens }) => ({
      compradores: [{ nome: PESSOAS.comprador, cpf: tokens.CPF[0] }],
      negociacao: { valor: 500000 },
    }));
    const s = new Sessao({ modelo, nomes: [PESSOAS.comprador], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();
    s.servidor.programar("proposal.create", { status: 409, body: { error: "signatarios_duplicados" } });
    await s.fala(`comprador ${PESSOAS.comprador} CPF ${formatarCpf(CPF_SINTETICO)} valor R$ 500.000, ficha`);
    const t = await s.fala("sim");
    expect(t.reply).toMatch(/assinantes repetidos/i);
    expect(t.reply).not.toMatch(/CPF|CNPJ|telefone|e-mail|email/i);
  });

  // F2: a conferência de uma foto sem legenda mostra o CPF lido em claro (a resposta é `sensivel`), enquanto
  // a ficha o mascara. Decisão de produto: manter assim ou mascarar também a conferência.
  it.todo("F2: a conferência da foto sem legenda mascara o CPF como a ficha");

  // F6: `lerDocumento` e `transcribeMedia` são cobrados pelo servidor, sem `reportUsage` do lado do agente.
  // O transversal T4 só conta as chamadas ao modelo (`complete`).
  it.todo("F6: o custo de lerDocumento/transcribeMedia aparece em AIUsage do lado do servidor (verificar no ImobPro)");
});
