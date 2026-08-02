import { describe, it, expect } from "vitest";
import { isWithinWindow, nextDeliveryTime } from "../window";

/**
 * A janela de cortesia é a regra que o ImobPro DELEGOU a este serviço: os
 * call-sites de lá pararam de segurar a mensagem quando o agente é o Max
 * justamente porque aqui ela é adiada em vez de descartada. Um erro aqui não
 * atrasa uma notificação — some com ela.
 *
 * São Paulo é UTC-3 (sem horário de verão desde 2019), então 10h UTC = 7h SP.
 */
const at = (iso: string) => new Date(iso);

describe("isWithinWindow", () => {
  it("07h SP (10h UTC) já está dentro — é a abertura", () => {
    expect(isWithinWindow(at("2026-08-02T10:00:00Z"))).toBe(true);
  });

  it("meio-dia SP está dentro", () => {
    expect(isWithinWindow(at("2026-08-02T15:00:00Z"))).toBe(true);
  });

  it("21h59 SP ainda está dentro", () => {
    expect(isWithinWindow(at("2026-08-03T00:59:00Z"))).toBe(true);
  });

  it("22h SP está FORA — o fechamento é exclusivo", () => {
    expect(isWithinWindow(at("2026-08-03T01:00:00Z"))).toBe(false);
  });

  it("03h SP está fora", () => {
    expect(isWithinWindow(at("2026-08-02T06:00:00Z"))).toBe(false);
  });

  it("06h59 SP ainda está fora", () => {
    expect(isWithinWindow(at("2026-08-02T09:59:00Z"))).toBe(false);
  });
});

describe("nextDeliveryTime", () => {
  it("dentro da janela entrega agora", () => {
    const now = at("2026-08-02T15:00:00Z");
    expect(nextDeliveryTime(now).toISOString()).toBe(now.toISOString());
  });

  /** Madrugada: a abertura é no MESMO dia, poucas horas depois. */
  it("03h SP agenda pras 07h SP do mesmo dia", () => {
    const out = nextDeliveryTime(at("2026-08-02T06:00:00Z"));
    expect(out.toISOString()).toBe("2026-08-02T10:00:00.000Z");
  });

  /** Depois das 22h a abertura já é no dia seguinte. */
  it("23h SP agenda pras 07h SP do dia seguinte", () => {
    const out = nextDeliveryTime(at("2026-08-02T02:00:00Z")); // 23h de 01/08 SP
    expect(out.toISOString()).toBe("2026-08-02T10:00:00.000Z");
  });

  it("o horário agendado está sempre dentro da janela", () => {
    for (const iso of [
      "2026-08-02T02:00:00Z",
      "2026-08-02T06:00:00Z",
      "2026-08-02T09:59:00Z",
      "2026-08-03T01:30:00Z",
      "2026-12-31T04:00:00Z", // vira o ano
    ]) {
      expect(isWithinWindow(nextDeliveryTime(at(iso)))).toBe(true);
    }
  });

  it("nunca agenda pro passado", () => {
    for (const iso of ["2026-08-02T02:00:00Z", "2026-08-02T09:59:00Z"]) {
      const from = at(iso);
      expect(nextDeliveryTime(from).getTime()).toBeGreaterThanOrEqual(
        from.getTime()
      );
    }
  });
});
