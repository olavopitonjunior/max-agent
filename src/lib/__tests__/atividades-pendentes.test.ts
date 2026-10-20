import { describe, expect, it } from "vitest";
import { HORAS_REARME_AVISO_NEUTRO, jaAvisadoNestaJanela } from "../atividades-pendentes";

const AGORA = new Date("2026-10-14T15:00:00.000Z");
const h = (horasAtras: number) => new Date(AGORA.getTime() - horasAtras * 3_600_000);

describe("jaAvisadoNestaJanela (aviso neutro de atividades, um por janela)", () => {
  it("o rearme é de 24h, a mesma duração da janela da Meta", () => {
    expect(HORAS_REARME_AVISO_NEUTRO).toBe(24);
  });

  it("nunca avisou: pode avisar", () => {
    expect(jaAvisadoNestaJanela({ ultimoAvisoEm: null, ultimaEntradaEm: null, agora: AGORA })).toBe(false);
    expect(jaAvisadoNestaJanela({ ultimoAvisoEm: null, ultimaEntradaEm: h(30), agora: AGORA })).toBe(false);
  });

  it("avisou há 1h e a pessoa não escreveu: já avisada (a linha seguinte é omitida)", () => {
    expect(jaAvisadoNestaJanela({ ultimoAvisoEm: h(1), ultimaEntradaEm: null, agora: AGORA })).toBe(true);
    expect(jaAvisadoNestaJanela({ ultimoAvisoEm: h(1), ultimaEntradaEm: h(40), agora: AGORA })).toBe(true);
  });

  it("rearma 24h depois do último aviso: exatamente 24h já pode avisar de novo", () => {
    expect(jaAvisadoNestaJanela({ ultimoAvisoEm: h(23.99), ultimaEntradaEm: null, agora: AGORA })).toBe(true);
    expect(jaAvisadoNestaJanela({ ultimoAvisoEm: h(24), ultimaEntradaEm: null, agora: AGORA })).toBe(false);
    expect(jaAvisadoNestaJanela({ ultimoAvisoEm: h(25), ultimaEntradaEm: null, agora: AGORA })).toBe(false);
  });

  it("a pessoa escreveu DEPOIS do aviso: a janela anterior acabou, pode avisar", () => {
    expect(jaAvisadoNestaJanela({ ultimoAvisoEm: h(10), ultimaEntradaEm: h(5), agora: AGORA })).toBe(false);
  });

  it("a pessoa escreveu ANTES do aviso: o aviso conta", () => {
    expect(jaAvisadoNestaJanela({ ultimoAvisoEm: h(5), ultimaEntradaEm: h(10), agora: AGORA })).toBe(true);
  });
});
