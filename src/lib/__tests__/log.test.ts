import { describe, it, expect, vi, afterEach } from "vitest";
import { log } from "../log";

/**
 * O que este arquivo defende é a promessa que justifica o helper existir: a
 * máscara mora DENTRO dele. Se alguém mexer no `emit` e o telefone inteiro
 * passar a sair, o log da Vercel — retido e pesquisável fora do nosso
 * controle de acesso — vira o vazamento que o docblock do `phone.ts`
 * descreve. Um call-site disciplinado não protege disso; um teste, sim.
 */

function capturar(nivel: "log" | "warn" | "error") {
  return vi.spyOn(console, nivel).mockImplementation(() => undefined);
}

afterEach(() => vi.restoreAllMocks());

describe("log estruturado", () => {
  it("mascara o telefone mesmo recebendo cru", () => {
    const spy = capturar("log");
    log.info("inbound.aceito", { phone: "5511987654321", messageId: "M1" });

    const linha = spy.mock.calls[0][0] as string;
    expect(linha).not.toContain("5511987654321");
    expect(JSON.parse(linha).phone).toBe("5511***4321");
  });

  it("emite UMA linha de JSON válido, com o event como primeiro campo", () => {
    const spy = capturar("log");
    log.info("outbox.enviado", { rowId: "r1", sentMessageId: "S1" });

    const linha = spy.mock.calls[0][0] as string;
    expect(linha).not.toContain("\n");
    const obj = JSON.parse(linha);
    expect(Object.keys(obj)[0]).toBe("event");
    expect(obj).toMatchObject({ event: "outbox.enviado", rowId: "r1", sentMessageId: "S1" });
  });

  it("sem telefone não inventa o campo", () => {
    const spy = capturar("log");
    log.info("evento.qualquer", { rowId: "r1" });

    expect(JSON.parse(spy.mock.calls[0][0] as string)).not.toHaveProperty("phone");
  });

  it("warn e error saem pelos canais certos — nível é o que o alerta lê", () => {
    const w = capturar("warn");
    const e = capturar("error");
    log.warn("inbound.dreno_estourou", { phone: "5511987654321" });
    log.error("inbound.turn_falhou", { messageId: "M2" });

    expect(JSON.parse(w.mock.calls[0][0] as string).phone).toBe("5511***4321");
    expect(JSON.parse(e.mock.calls[0][0] as string).event).toBe("inbound.turn_falhou");
  });
});
