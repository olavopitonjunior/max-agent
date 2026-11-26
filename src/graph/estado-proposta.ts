/**
 * "Em aberto" não é um status do servidor: é o GRUPO das propostas ainda vivas (tudo menos as encerradas).
 * O código decide o que entra, nunca o modelo (prod 26/11: "minhas propostas em aberto" listou Cancelada e
 * Virou negócio). Módulo folha, usado pelo despachante (caminho do modelo) e pela consulta direta.
 */

/** Status (cru, do servidor) que encerram a proposta: não estão em aberto. */
export const STATUS_ENCERRADOS = ["convertida", "recusada_proponente", "recusada_vendedor", "expirada", "cancelada", "arquivada"];
/** O rótulo que o servidor mostra ao lado (sem acento, minúsculo), quando o corpo não traz o status cru. */
export const ROTULOS_ENCERRADOS = ["virou negocio", "recusada", "expirada", "cancelada", "arquivada"];

const semAcento = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9]+/g, " ").trim();

/** "em aberto", "abertas", "pendentes", "em andamento": o pedido é pelas que ainda estão vivas. */
export function pedeEmAberto(estado: unknown): boolean {
  if (typeof estado !== "string") return false;
  return /^(em )?(aberto|aberta|abertos|abertas|andamento|pendente|pendentes)$/.test(semAcento(estado));
}

/** A proposta saiu do jogo (cancelada, recusada, virou negócio, expirada, arquivada)? */
export function propostaEncerrada(p: { status?: unknown; estado?: unknown }): boolean {
  const status = typeof p.status === "string" ? semAcento(p.status).replace(/ /g, "_") : "";
  const rotulo = typeof p.estado === "string" ? semAcento(p.estado) : "";
  return STATUS_ENCERRADOS.includes(status) || ROTULOS_ENCERRADOS.includes(rotulo);
}
