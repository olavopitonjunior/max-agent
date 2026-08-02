/**
 * Janela de cortesia 7h–22h `America/Sao_Paulo`.
 *
 * A regra é a mesma que o ImobPro sempre aplicou, mas o DONO mudou: os
 * call-sites de notificação de lá deixaram de segurar a mensagem quando o
 * agente é o Max, justamente porque aqui existe fila. Se este arquivo
 * simplesmente descartasse fora da janela, a notificação sumiria — o motor de
 * `deal-events` do ImobPro não tem cron de reconciliação.
 *
 * Então a regra aqui é: **adiar, nunca descartar**.
 */

const TZ = "America/Sao_Paulo";
export const WINDOW_OPEN_HOUR = 7;
export const WINDOW_CLOSE_HOUR = 22;

function partsInSaoPaulo(date: Date): { year: number; month: number; day: number; hour: number } {
  // `en-CA` dá ISO (YYYY-MM-DD) no `formatToParts`, o que evita ambiguidade de
  // ordem entre dia e mês.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value])
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
  };
}

export function isWithinWindow(date: Date = new Date()): boolean {
  const { hour } = partsInSaoPaulo(date);
  return hour >= WINDOW_OPEN_HOUR && hour < WINDOW_CLOSE_HOUR;
}

/**
 * Quando esta mensagem pode sair: agora, se a janela está aberta; senão, a
 * próxima abertura às 7h de São Paulo.
 *
 * O cálculo é feito por tentativa e verificação em vez de aritmética de fuso:
 * São Paulo não tem mais horário de verão, mas já teve, e ancorar a conta num
 * offset fixo é o tipo de coisa que volta a quebrar quando a lei muda. Aqui,
 * quem decide o offset é sempre o `Intl`.
 */
export function nextDeliveryTime(from: Date = new Date()): Date {
  if (isWithinWindow(from)) return from;

  const { hour } = partsInSaoPaulo(from);

  // Antes das 7h: a abertura é hoje. Depois das 22h: é amanhã.
  const daysAhead = hour < WINDOW_OPEN_HOUR ? 0 : 1;
  const candidate = new Date(from.getTime() + daysAhead * 24 * 60 * 60_000);

  // Varre a partir do início do dia-alvo em SP até achar a primeira hora dentro
  // da janela. No máximo 24 iterações, e imune a mudança de offset.
  const target = partsInSaoPaulo(candidate);
  for (let i = 0; i < 48; i++) {
    const probe = new Date(
      Date.UTC(target.year, target.month - 1, target.day, i, 0, 0)
    );
    const p = partsInSaoPaulo(probe);
    if (
      p.year === target.year &&
      p.month === target.month &&
      p.day === target.day &&
      p.hour === WINDOW_OPEN_HOUR
    ) {
      return probe;
    }
  }

  // Inalcançável na prática; devolver `from` faz a mensagem sair já, que é
  // melhor que travar numa fila para sempre.
  return from;
}
