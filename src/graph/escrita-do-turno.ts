/**
 * "Houve escrita neste turno?", para o `travarPromessaSemEfeito`.
 *
 * Uma tool de escrita que FALHOU, foi recusada pela política ou foi descartada
 * não gravou nada: "ajusto o complemento" depois dela continua promessa vazia.
 * Os desfechos abaixo são os que a trilha (`toolLog`) marca quando a escrita
 * não aconteceu (despachante: recusas; confirmação: falhou/módulo desligado/
 * descartada; criação: fluxo em andamento / negócio já existente). Qualquer
 * outro desfecho de tool de escrita conta como escrita (proposta ou feita).
 */
export const DESFECHOS_SEM_ESCRITA: ReadonlySet<string> = new Set([
  "tool_desconhecida",
  "nao_oferecida",
  "capability_negada",
  "identidade_nao_escreve",
  "tipo_invalido",
  "descartada",
  "falhou",
  "modulo_desligado",
  "fluxo_em_andamento",
  "negocio_existente",
]);

export function houveEscritaNoTurno(
  toolLog: ReadonlyArray<{ name: string; outcome: string }>,
  ehEscrita: (nome: string) => boolean
): boolean {
  return toolLog.some((t) => ehEscrita(t.name) && !DESFECHOS_SEM_ESCRITA.has(t.outcome));
}
