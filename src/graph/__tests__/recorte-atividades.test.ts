import { describe, expect, it } from "vitest";
import { semRecorteNaoPedido } from "../tools";

const chamada = (filtro: string) => ({ name: "listar_atividades", args: { estado: "atrasadas", filtro } });

describe("semRecorteNaoPedido", () => {
  it.each([
    ["e as atrasadas?", "minhas"],
    ["mostra as atividades", "hoje"],
    ["lista as tarefas da equipe", "atrasadas"],
  ])("tira o recorte que a pessoa não disse: %s (%s)", (texto, filtro) => {
    expect(semRecorteNaoPedido(chamada(filtro), texto).args).toEqual({ estado: "atrasadas" });
  });

  it.each([
    ["quais são as minhas atividades?", "minhas"],
    ["o que eu tenho pra hoje?", "hoje"],
    ["o que eu tenho pra hoje?", "minhas"],
    ["tem alguma vencida?", "atrasadas"],
    ["E as ATRASADAS?", "atrasadas"],
  ])("mantém o recorte pedido: %s (%s)", (texto, filtro) => {
    expect(semRecorteNaoPedido(chamada(filtro), texto).args.filtro).toBe(filtro);
  });

  it("não mexe em outra tool nem em chamada sem filtro", () => {
    const negocios = { name: "listar_negocios", args: { filtro: "minhas" } };
    expect(semRecorteNaoPedido(negocios, "e as atrasadas?")).toBe(negocios);
    const sem = { name: "listar_atividades", args: { estado: "abertas" } };
    expect(semRecorteNaoPedido(sem, "e as atrasadas?")).toBe(sem);
  });
});
