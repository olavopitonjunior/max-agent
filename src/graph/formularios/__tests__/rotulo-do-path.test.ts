import { describe, expect, it } from "vitest";
import { rotuloDoPath } from "../midia";

/**
 * F3: a ficha nunca mostra o caminho técnico do servidor ("negociacao.valor") ao corretor.
 */
describe("rotuloDoPath: rótulos em português, nunca o caminho cru", () => {
  it.each([
    ["negociacao.valor", "Negociação", "Valor da negociação"],
    ["negociacao.sinal", "Negociação", "Sinal"],
    ["negociacao.prazo_meses", "Negociação", "Prazo (meses)"],
    ["negociacao.data_entrada", "Negociação", "Data de entrada"],
    ["negociacao.modalidade", "Negociação", "Modalidade"],
    ["corretor.creci", "Corretor", "CRECI"],
    ["observacoes", "Outros", "Observações"],
  ])("%s", (path, grupo, campo) => {
    expect(rotuloDoPath(path)).toEqual({ grupo, campo });
  });

  it("as partes e o imóvel seguem como antes", () => {
    expect(rotuloDoPath("compradores[1].cpf")).toEqual({ grupo: "Comprador 2", campo: "CPF" });
    expect(rotuloDoPath("compradores[0].conjuge.nome")).toEqual({ grupo: "Cônjuge (Comprador 1)", campo: "Nome" });
    expect(rotuloDoPath("imovel.matricula")).toEqual({ grupo: "Imóvel", campo: "Matrícula" });
  });

  it("NEGADO: caminho desconhecido cai num rótulo genérico, sem ponto, colchete nem sublinhado", () => {
    for (const path of ["negociacao.taxa_de_juros", "corretor.telefone_comercial", "seguro.apolice_numero", "xyz", "a.b.c_d"]) {
      const { grupo, campo } = rotuloDoPath(path);
      expect(`${grupo} ${campo}`, path).not.toMatch(/[._\[\]]/);
      expect(grupo.length).toBeGreaterThan(0);
      expect(campo.length).toBeGreaterThan(0);
    }
    expect(rotuloDoPath("negociacao.taxa_de_juros")).toEqual({ grupo: "Negociação", campo: "Taxa de juros" });
    expect(rotuloDoPath("seguro.apolice_numero")).toEqual({ grupo: "Outros", campo: "Apolice numero" });
  });
});
