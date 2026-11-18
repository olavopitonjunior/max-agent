import { describe, expect, it } from "vitest";
import { CPF_SINTETICO, ModeloFalso, Sessao, emailFicticio, formatarCpf, telefoneFicticio, verificarTransversais } from "./harness";

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

  // I3: as palavras reais do incidente do Newton (06/11) e dos templates do v2, não só "anotei"/"salvei".
  it.each(["Anotado.", "Anotada a proposta.", "Gravei o canal.", "Gravei as testemunhas.", "Registrei o valor.", "Tudo salvo no rascunho.", "ANOTADO!", "Já registrado."])(
    "T1: %j sem escrita 2xx no turno",
    async (reply) => {
      const s = await sessao();
      turno(s, { reply });
      await expect(verificarTransversais(s)).rejects.toThrow(/T1/);
    }
  );

  it("T1: a escrita recusada (409) também não autoriza 'gravei'", async () => {
    const s = await sessao();
    turno(s, {
      reply: "Gravei o canal.",
      escritas: [{ verb: "proposal.update", args: {}, status: 409, escrita: true, turno: 0 }],
    });
    await expect(verificarTransversais(s)).rejects.toThrow(/T1/);
  });

  it("T1: 'Gravei' COM escrita 2xx no turno é legítimo", async () => {
    const s = await sessao();
    turno(s, {
      entrada: "sim",
      reply: "Gravei o canal.",
      escritas: [{ verb: "proposal.update", args: {}, status: 200, escrita: true, turno: 0, idempotencyKey: "m1" }],
    });
    await s.servidor.atender({ verb: "proposal.update", args: {}, idempotencyKey: "m1" });
    await expect(verificarTransversais(s)).resolves.toBeUndefined();
  });

  it.each([
    "Não gravei nada.",
    "Nada foi anotado.",
    "O que veio de documento ainda não foi anotado: responda SIM se estiver certo.",
    "Cada pessoa tem o seu, então não anotei nada.",
    "Não registrei, não salvei e nada foi gravado.",
    "Nada foi anotado nem salvo.",
    "Não gravei: há assinantes repetidos na proposta.",
  ])("T1: a recusa honesta %j não é afirmação", async (reply) => {
    const s = await sessao();
    turno(s, { reply });
    await expect(verificarTransversais(s)).resolves.toBeUndefined();
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

  // M3: o helper do CHECKPOINT inteiro tem de reprovar o vazamento (CPF, telefone, e-mail), senão "passou"
  // não prova nada sobre o `messages`.
  it("T3: CPF (formatado) em claro no histórico do checkpoint", async () => {
    const s = await sessao();
    await s.injetarNoHistorico(`o CPF dele é ${formatarCpf(CPF_SINTETICO)}`);
    await expect(verificarTransversais(s)).rejects.toThrow(/T3.*CPF/);
  });

  it("T3: CPF só com dígitos no histórico do checkpoint", async () => {
    const s = await sessao();
    await s.injetarNoHistorico(`cpf ${CPF_SINTETICO}`);
    await expect(verificarTransversais(s)).rejects.toThrow(/T3.*CPF/);
  });

  it("T3: telefone fictício em claro no histórico do checkpoint", async () => {
    const s = await sessao();
    await s.injetarNoHistorico(`ligue para ${telefoneFicticio(42)}`);
    await expect(verificarTransversais(s)).rejects.toThrow(/T3.*telefone/);
  });

  it("T3: e-mail fictício em claro no histórico do checkpoint", async () => {
    const s = await sessao();
    await s.injetarNoHistorico(`mande para ${emailFicticio("Fulano")}`);
    await expect(verificarTransversais(s)).rejects.toThrow(/T3.*e-mail/);
  });

  it("T3: o histórico sem PII (o marcador) passa", async () => {
    const s = await sessao();
    await s.injetarNoHistorico("(resposta da ficha de proposta)");
    await expect(verificarTransversais(s)).resolves.toBeUndefined();
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
