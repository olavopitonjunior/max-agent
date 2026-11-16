import { describe, expect, it, vi } from "vitest";
import type { RespostaDoServidor } from "../../fluxos";
import { novoFluxoV2 } from "../estado";
import { documentoRepetido, unificarDocumentoRepetido, type CampoLido } from "../midia";
import { salvarParcial, textoDoParcial } from "../proposta-v2";

const CPF = "52998224725"; // sintético, DV válido
const CPF_FORMATADO = "529.982.247-25";
const OUTRO = "11144477735"; // sintético, DV válido
const lido = (path: string, valor: string): CampoLido => ({ path, valor, confianca: 1 });
const caminhos = (campos: CampoLido[]): string[] => campos.map((c) => c.path).sort();

/**
 * F4: o mesmo CPF/CNPJ em duas partes. Mesma pessoa dita duas vezes (mesmo lado, nomes que não se
 * contradizem) vira UMA parte antes do cartão e do SIM; lados diferentes ou nomes diferentes é
 * ambíguo e o agente pergunta, em vez de deixar o servidor responder 409 depois do "sim".
 */
describe("unificarDocumentoRepetido: uma pessoa só", () => {
  it("o mesmo CPF em duas posições do mesmo lado, sem nome contraditório, vira a posição menor", () => {
    const r = unificarDocumentoRepetido([
      lido("compradores[0].nome", "Ana Souza"),
      lido("compradores[0].cpf", CPF),
      lido("compradores[1].cpf", CPF_FORMATADO),
      lido("compradores[1].telefone", "11900000011"),
    ]);
    expect(caminhos(r)).toEqual(["compradores[0].cpf", "compradores[0].nome", "compradores[0].telefone"]);
    expect(r.find((c) => c.path === "compradores[0].telefone")!.valor).toBe("11900000011");
    expect(r.find((c) => c.path === "compradores[0].cpf")!.valor).toBe(CPF);
    expect(documentoRepetido(r)).toBeNull();
  });

  it("o mesmo nome (parcial) nas duas posições também é a mesma pessoa", () => {
    const r = unificarDocumentoRepetido([
      lido("compradores[0].nome", "Ana Souza"),
      lido("compradores[0].cpf", CPF),
      lido("compradores[1].nome", "Ana Souza Lima"),
      lido("compradores[1].cpf", CPF),
    ]);
    expect(caminhos(r)).toEqual(["compradores[0].cpf", "compradores[0].nome"]);
  });

  it("as posições seguintes sobem para fechar o buraco", () => {
    const r = unificarDocumentoRepetido([
      lido("compradores[0].cpf", CPF),
      lido("compradores[1].cpf", CPF),
      lido("compradores[2].nome", "Beto Lima"),
      lido("compradores[2].cpf", OUTRO),
    ]);
    expect(caminhos(r)).toEqual(["compradores[0].cpf", "compradores[1].cpf", "compradores[1].nome"]);
    expect(r.find((c) => c.path === "compradores[1].cpf")!.valor).toBe(OUTRO);
  });

  it("o cônjuge de quem foi unificado vai junto", () => {
    const r = unificarDocumentoRepetido([
      lido("compradores[0].cpf", CPF),
      lido("compradores[1].cpf", CPF),
      lido("compradores[1].conjuge.nome", "Carla Souza"),
    ]);
    expect(caminhos(r)).toEqual(["compradores[0].conjuge.nome", "compradores[0].cpf"]);
  });

  it("NEGADO: nomes diferentes com o mesmo CPF não são unificados (são duas pessoas, o corretor decide)", () => {
    const campos = [
      lido("compradores[0].nome", "Ana Souza"),
      lido("compradores[0].cpf", CPF),
      lido("compradores[1].nome", "Beto Lima"),
      lido("compradores[1].cpf", CPF),
    ];
    expect(unificarDocumentoRepetido(campos)).toEqual(campos);
    expect(documentoRepetido(campos)).toEqual({
      a: { grupo: "compradores", posicao: 0 },
      b: { grupo: "compradores", posicao: 1 },
    });
  });

  it("NEGADO: o mesmo CPF em lados diferentes (comprador e vendedor) não é unificado", () => {
    const campos = [lido("compradores[0].cpf", CPF), lido("vendedores[0].cpf", CPF_FORMATADO)];
    expect(unificarDocumentoRepetido(campos)).toEqual(campos);
    expect(documentoRepetido(campos)).toEqual({
      a: { grupo: "compradores", posicao: 0 },
      b: { grupo: "vendedores", posicao: 0 },
    });
  });

  it("NEGADO: CPFs diferentes, valor sem cara de documento e CPF do cônjuge não contam como repetição", () => {
    expect(documentoRepetido([lido("compradores[0].cpf", CPF), lido("compradores[1].cpf", OUTRO)])).toBeNull();
    expect(documentoRepetido([lido("compradores[0].cpf", "123"), lido("compradores[1].cpf", "123")])).toBeNull();
    expect(documentoRepetido([lido("compradores[0].cpf", CPF), lido("compradores[0].conjuge.cpf", CPF)])).toBeNull();
  });
});

describe("409 signatarios_duplicados: texto sempre neutro", () => {
  const f = { ...novoFluxoV2({ esteira: "venda", agora: 1, schemaType: "compra_venda_v1" }), proposalId: "prop-1" };
  const dep = (resposta: RespostaDoServidor) => ({ acao: vi.fn(async () => resposta) });

  async function textoDo409(body: Record<string, unknown>): Promise<string> {
    const r = await salvarParcial(dep({ status: 409, body }), f, { observacoes: "x" }, { confirmacao: { messageIdDoSim: "m1" } });
    if (r.ok) throw new Error("esperava recusa");
    return textoDoParcial(r, {});
  }

  it("sem dizer a causa: neutro, e nunca afirma telefone nem e-mail", async () => {
    const t = await textoDo409({ error: "signatarios_duplicados" });
    expect(t).toMatch(/assinantes repetidos/i);
    expect(t).not.toMatch(/telefone|e-mail|email/i);
    expect(t).not.toMatch(/anotei|salvei/i);
  });

  it("NEGADO: campos fora do contrato (max.md só define o código) não viram afirmação de causa", async () => {
    // O CM só declara `409 signatarios_duplicados`; `campo`/`campos`/`message` não existem no contrato.
    // Mesmo que um corpo traga isso, o texto continua neutro: nunca afirma CPF, e-mail nem telefone.
    for (const body of [
      { error: "signatarios_duplicados", campo: "cpf" },
      { error: "signatarios_duplicados", campos: ["compradores[1].cpf"] },
      { error: "signatarios_duplicados", message: "Há dois assinantes com o mesmo CPF." },
      { error: "signatarios_duplicados", campo: "email" },
    ]) {
      const t = await textoDo409(body);
      expect(t, JSON.stringify(body)).toMatch(/assinantes repetidos/i);
      expect(t, JSON.stringify(body)).not.toMatch(/CPF|CNPJ|telefone|e-mail|email/i);
      expect(t, JSON.stringify(body)).not.toMatch(/anotei|salvei/i);
    }
  });
});
