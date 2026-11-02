import { describe, expect, it } from "vitest";
import { atividadeEmHoraLocal } from "../atividade-hora-local";

describe("atividadeEmHoraLocal", () => {
  it("vencimento com horário sai na hora de São Paulo, nunca em UTC", () => {
    expect(atividadeEmHoraLocal({ titulo: "A", vencimento: "2026-11-05T12:00:00.000Z", temHorario: true })).toEqual({
      titulo: "A",
      vencimento: "05/11/2026 09:00",
      temHorario: true,
    });
  });

  it("dia inteiro não ganha hora e a virada do dia em UTC não muda a data local", () => {
    expect(atividadeEmHoraLocal({ vencimento: "2026-11-06T02:00:00.000Z", temHorario: false })).toMatchObject({ vencimento: "05/11/2026" });
  });

  it("conclusão, cancelamento e comentários também; nulo e texto inválido ficam como vieram", () => {
    expect(
      atividadeEmHoraLocal({
        vencimento: null,
        concluidaEm: "2026-11-05T15:30:00.000Z",
        canceladaEm: "nao-e-data",
        comentarios: [{ autor: "X", texto: "oi", em: "2026-11-05T03:00:00.000Z" }],
      }),
    ).toEqual({
      vencimento: null,
      concluidaEm: "05/11/2026 12:30",
      canceladaEm: "nao-e-data",
      comentarios: [{ autor: "X", texto: "oi", em: "05/11/2026 00:00" }],
    });
  });
});
