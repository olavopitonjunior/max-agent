import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { log } from "../log";
import { phoneTag } from "../phone";

/**
 * O que este arquivo defende é a promessa que justifica o helper existir: a
 * despersonalização mora DENTRO dele. Se alguém mexer no `emit` e o telefone
 * inteiro passar a sair, o log da Vercel — retido e pesquisável fora do nosso
 * controle de acesso — vira o vazamento que o docblock do `phone.ts`
 * descreve. Um call-site disciplinado não protege disso; um teste, sim.
 *
 * As asserções são contra `phoneTag(...)` e não contra um literal de propósito:
 * o valor do rótulo depende do segredo, e fixá-lo aqui só testaria o HMAC (que
 * `phone.test.ts` já testa). O que importa neste arquivo é **por onde o
 * telefone passa**.
 */

function capturar(nivel: "log" | "warn" | "error") {
  return vi.spyOn(console, nivel).mockImplementation(() => undefined);
}

beforeEach(() => vi.stubEnv("MAX_NOTIFY_SECRET", "s-log"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("log estruturado", () => {
  it("despersonaliza o telefone mesmo recebendo cru", () => {
    const spy = capturar("log");
    log.info("inbound.aceito", { phone: "5511987654321", messageId: "M1" });

    const linha = spy.mock.calls[0][0] as string;
    expect(linha).not.toContain("5511987654321");
    // Nem os 4 finais, que era o que a máscara antiga deixava passar.
    expect(linha).not.toContain("4321");
    expect(JSON.parse(linha).phone).toBe(phoneTag("5511987654321"));
  });

  /**
   * O caso que motivou o `scrub`: a Z-API ecoa o número do destinatário no
   * corpo do erro. Sem isto, o telefone sai inteiro por um campo que ninguém
   * lembrou de tratar — e é justamente no erro que alguém vai olhar.
   */
  it("também no meio de texto livre de erro do provedor", () => {
    const spy = capturar("error");
    log.error("outbox.falhou", {
      rowId: "r1",
      detail: "Z-API /send-text 400: invalid phone 5511987654321",
    });

    const linha = spy.mock.calls[0][0] as string;
    expect(linha).not.toContain("5511987654321");
    expect(linha).toContain(phoneTag("5511987654321"));
  });

  /**
   * A costura só funciona se o rótulo for o mesmo entre eventos — é assim que
   * uma busca devolve a conversa inteira. Como as portas de entrada entregam
   * formatos diferentes (a Z-API sem "+", quem normaliza antes com "+"), o
   * risco real é o mesmo turn aparecer sob dois rótulos.
   */
  it("o mesmo aparelho tem um rótulo só, venha o telefone como vier", () => {
    const spy = capturar("log");
    log.info("inbound.aceito", { phone: "5511987654321" });
    log.info("outbox.enviado", { phone: "+55 11 98765-4321" });

    const [a, b] = spy.mock.calls.map((c) => JSON.parse(c[0] as string).phone);
    expect(a).toBe(b);
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

    expect(JSON.parse(w.mock.calls[0][0] as string).phone).toBe(phoneTag("5511987654321"));
    expect(JSON.parse(e.mock.calls[0][0] as string).event).toBe("inbound.turn_falhou");
  });
});
