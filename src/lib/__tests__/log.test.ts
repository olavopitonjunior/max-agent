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
   * O furo que a code review encontrou, e o motivo de a regex ter mudado.
   *
   * A versão anterior era `\b\d{10,13}\b` — só dígito contíguo. Mas o texto que
   * o `scrub` existe para tratar é corpo bruto de erro de provedor, e validação
   * de telefone costuma FORMATAR o número na mensagem. Cada uma destas formas
   * passava inteira, sem nada, pelo caminho que promete não vazar dígito.
   */
  it.each([
    "Z-API /send-text 400: invalid phone +55 (11) 98765-4321",
    "Z-API /send-text 400: invalid phone 5511 98765-4321",
    "numero recusado: (11)98765-4321",
    "numero recusado: 11-98765-4321",
    "numero recusado: +55 11 98765 4321",
  ])("telefone com separador não escapa: %s", (detail) => {
    const spy = capturar("error");
    log.error("outbox.falhou", { detail });

    const linha = spy.mock.calls[0][0] as string;
    expect(linha).not.toContain("98765");
    expect(linha).not.toContain("4321");
    expect(linha).toContain(phoneTag("5511987654321"));
  });

  /**
   * O segundo furo da review. O contrato deste módulo diz "telefone em QUALQUER
   * campo, sem depender de disciplina no chamador" — e isso era falso para
   * qualquer coisa que não fosse string de primeiro nível. Hoje nenhum
   * call-site passa objeto, mas `LogFields` permite, e o dia em que alguém
   * logar o corpo de uma resposta de provedor é o dia em que vaza, sem ninguém
   * ter tocado neste arquivo.
   */
  it("desce em objeto e array aninhados", () => {
    const spy = capturar("error");
    log.error("zapi.recusou", {
      resposta: { erro: { texto: "invalid phone 5511987654321" } },
      tentativas: ["falhou para 5511987654321"],
    });

    const linha = spy.mock.calls[0][0] as string;
    expect(linha).not.toContain("5511987654321");
    expect(linha.match(/tel_[0-9a-f]{12}/g)).toHaveLength(2);
  });

  /**
   * Data ISO tem 8 dígitos e sequência longa de separadores — é o falso
   * positivo óbvio da regex nova. O corte é por contagem de dígitos justamente
   * para ela sobreviver: um log de auditoria sem timestamp legível não serve.
   */
  it("data ISO não vira rótulo", () => {
    const spy = capturar("log");
    log.info("turn.ok", { quando: "2026-08-21T22:07:00Z", venceEm: "2026-08-22" });

    const linha = spy.mock.calls[0][0] as string;
    expect(linha).toContain("2026-08-21T22:07:00Z");
    expect(linha).toContain("2026-08-22");
  });

  /**
   * Emitir nunca lança — é a promessa que permite estes logs viverem dentro de
   * blocos onde uma exceção reverteria trabalho já feito. Estrutura circular é
   * o caso que a recursão nova poderia ter quebrado.
   */
  it("estrutura circular não derruba o log", () => {
    const spy = capturar("warn");
    const circular: Record<string, unknown> = { nome: "a" };
    circular.eu = circular;

    expect(() => log.warn("qualquer", { circular })).not.toThrow();
    expect(spy).toHaveBeenCalled();
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
