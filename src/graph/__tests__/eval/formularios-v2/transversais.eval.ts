import { describe, expect, it } from "vitest";
import { CPF_SINTETICO, ModeloFalso, Sessao, formatarCpf, verificarTransversais } from "./harness";

/**
 * Prova negativa das verificações transversais: cada uma TEM de reprovar o defeito que ela existe para
 * pegar. Sem isso, "todos os casos passaram" poderia significar "a verificação não enxerga nada".
 */
describe("eval fv2: as transversais reprovam o que devem", () => {
  async function sessao(): Promise<Sessao> {
    const s = new Sessao({ modelo: new ModeloFalso(), cpfs: [CPF_SINTETICO], nomes: ["Fulano Ficticio"] });
    await s.preparar();
    return s;
  }
  const turno = (s: Sessao, extra: Partial<Sessao["turnos"][number]>) =>
    s.turnos.push({ indice: s.turnos.length, messageId: "m1", kind: "text", entrada: "x", reply: null, sensivel: false, escritas: [], reacoes: [], ...extra });

  it("T1: 'anotei' sem escrita 2xx no turno", async () => {
    const s = await sessao();
    turno(s, { reply: "Anotei e salvei no rascunho." });
    await expect(verificarTransversais(s)).rejects.toThrow(/T1/);
  });

  it("T1: a ficha agendada que diz 'anotei'", async () => {
    const s = await sessao();
    s.fichasAgendadas.push("Anotei tudo.");
    await expect(verificarTransversais(s)).rejects.toThrow(/T1/);
  });

  it("T2: escrita sem um 'sim' explícito por trás da chave", async () => {
    const s = await sessao();
    await s.servidor.atender({ verb: "proposal.create", args: {}, idempotencyKey: "wamid.QUALQUER" });
    await expect(verificarTransversais(s)).rejects.toThrow(/T2/);
  });

  it("T2: escrita sem chave de idempotência", async () => {
    const s = await sessao();
    await s.servidor.atender({ verb: "proposal.create", args: {} });
    await expect(verificarTransversais(s)).rejects.toThrow(/T2/);
  });

  it("T3: CPF em claro no que vai ao modelo", async () => {
    const s = await sessao();
    s.modelo.chamadas.push({ system: "s", conteudo: `o CPF é ${formatarCpf(CPF_SINTETICO)}`, ferramenta: null });
    await expect(verificarTransversais(s)).rejects.toThrow(/T3/);
  });

  it("T3: nome de parte fora das cercas na extração", async () => {
    const s = await sessao();
    s.modelo.chamadas.push({ system: "s", conteudo: "Fulano Ficticio mandou", ferramenta: "preencher_proposta_v2" });
    await expect(verificarTransversais(s)).rejects.toThrow(/T3/);
  });

  it("T4: chamada ao modelo sem reportUsage", async () => {
    const s = await sessao();
    s.modelo.chamadas.push({ system: "s", conteudo: "sem pii", ferramenta: null });
    await expect(verificarTransversais(s)).rejects.toThrow(/T4/);
  });

  it("e passa quando está tudo certo (nenhum turno, nenhuma chamada)", async () => {
    const s = await sessao();
    await expect(verificarTransversais(s)).resolves.toBeUndefined();
  });
});
