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

  // F1 (PII, regra 6 do brief): para `proposta_v2` o texto do corretor entra no histórico do checkpoint
  // (`messages`, graph.ts ~1555-1595) com o CPF em claro. Só `credito` e `captacao` o trocam por
  // "(resposta da ficha de ...)". O estado do fluxo, o outbox e o prompt estão limpos (cobertos nos
  // transversais); o histórico não.
  it.fails("F1: o CPF dito pelo corretor não fica em claro no histórico do checkpoint", async () => {
    const s = await comTudoNumaMensagem();
    const historico = await s.historicoDoCheckpoint();
    expect(historico.replace(/\D/g, "").includes(CPF_SINTETICO)).toBe(false);
    expect(historico.includes(formatarCpf(CPF_SINTETICO))).toBe(false);
  });

  // F3 (UX): `rotuloDoPath` (src/graph/formularios/midia.ts) não tem rótulo para `negociacao.*`,
  // `corretor.*` e `observacoes`; o valor da proposta lido pelo modelo aparece na ficha como
  // "Outros · negociacao.valor: 500000".
  it.fails("F3: a ficha rotula o valor como 'Valor da proposta', não pelo caminho técnico", async () => {
    const s = await comTudoNumaMensagem();
    expect(s.ultimaResposta).not.toContain("negociacao.valor");
  });

  // F5: a função pura não pega "propsta" sozinho nem "capitação" (com a criação permitida, quem decide é o
  // modelo; sem a permissão, o typo cai no chat em vez da recusa clara).
  it.fails("F5a: 'propsta' sozinho é entendido como pedido de proposta", () => {
    expect(lerIntencaoDeFormulario("propsta")).toMatchObject({ tipo: "criar", alvo: "proposta" });
  });
  it.fails("F5b: 'capitação' é entendido como captação", () => {
    expect(lerIntencaoDeFormulario("capitação")).toMatchObject({ tipo: "criar", alvo: "captacao" });
  });

  // F4: o mesmo CPF em duas posições só é barrado pelo servidor (409 `signatarios_duplicados`), depois do
  // "sim". A ficha deveria avisar antes. O 409 ainda diz "telefone ou e-mail diferente" quando a causa foi o CPF.
  it.todo("F4: a ficha avisa quando o mesmo CPF aparece em duas partes, antes do sim");
  it.todo("F4b: o 409 signatarios_duplicados por CPF fala de CPF, não de 'telefone ou e-mail'");

  // F2: a conferência de uma foto sem legenda mostra o CPF lido em claro (a resposta é `sensivel`), enquanto
  // a ficha o mascara. Decisão de produto: manter assim ou mascarar também a conferência.
  it.todo("F2: a conferência da foto sem legenda mascara o CPF como a ficha");

  // F6: `lerDocumento` e `transcribeMedia` são cobrados pelo servidor, sem `reportUsage` do lado do agente.
  // O transversal T4 só conta as chamadas ao modelo (`complete`).
  it.todo("F6: o custo de lerDocumento/transcribeMedia aparece em AIUsage do lado do servidor (verificar no ImobPro)");
});
