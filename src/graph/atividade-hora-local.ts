const FUSO = "America/Sao_Paulo";

function local(valor: unknown, comHora: boolean): unknown {
  if (typeof valor !== "string") return valor;
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return valor;
  return data
    .toLocaleString("pt-BR", {
      timeZone: FUSO,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      ...(comHora ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
    })
    .replace(",", "");
}

/**
 * A plataforma devolve as datas da atividade em ISO UTC e o modelo lê a hora crua: 09:00 em
 * São Paulo saía como 12:00 (medido no playground). O modelo só recebe a hora local já pronta.
 */
export function atividadeEmHoraLocal(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const a = item as Record<string, unknown>;
  const saida: Record<string, unknown> = { ...a };
  if ("vencimento" in a) saida.vencimento = local(a.vencimento, a.temHorario !== false);
  if ("concluidaEm" in a) saida.concluidaEm = local(a.concluidaEm, true);
  if ("canceladaEm" in a) saida.canceladaEm = local(a.canceladaEm, true);
  if (Array.isArray(a.comentarios)) {
    saida.comentarios = a.comentarios.map((c) =>
      c && typeof c === "object" ? { ...(c as Record<string, unknown>), em: local((c as Record<string, unknown>).em, true) } : c,
    );
  }
  return saida;
}
