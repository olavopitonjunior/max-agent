/**
 * Vetores do `deal.detail` enriquecido (PR-O4a), COPIADOS byte a byte de
 * `contractmaker/apps/web/src/lib/max/__tests__/query-vectors.ts`
 * (chaves `deal.detail.user` e `deal.detail.broker`, CM #3167).
 *
 * Literais de propósito: derivar dos tipos daqui acompanharia uma renomeação do
 * outro lado em silêncio, que é o defeito que o vetor existe para pegar. A ordem
 * das chaves é parte do contrato (o corpo HTTP a preserva).
 */
export const VETOR_DEAL_DETAIL_USER =
  '{"items":[{"id":"deal-1","etapa":"Documentação","pendencias":["Conferir documento"],"atualizadoEm":"2026-10-20T12:00:00.000Z","titulo":"Apto Centro","cliente":"Maria Silva","valor":850000,"tipo":"venda","partes":[{"papel":"vendedor","nome":"João Souza"},{"papel":"comprador","nome":"Maria Silva"}],"contrato":{"estado":"aprovado","versao":2,"atualizadoEm":"2026-10-19T12:00:00.000Z"},"proposta":{"id":"prop-1","codigo":"PROP-2026-0042","estado":"convertida"},"assinatura":{"estado":"running","enviadoEm":"2026-10-19T13:00:00.000Z","concluidoEm":null,"total":3,"assinadas":1,"recusadas":1,"pendentes":1},"link":"/deals/deal-1"}],"truncated":false}';

export const VETOR_DEAL_DETAIL_BROKER =
  '{"items":[{"id":"deal-1","etapa":"Documentação","pendencias":["atividade pendente"],"atualizadoEm":"2026-10-20T12:00:00.000Z","referencia":"Negócio #DEAL-1","partes":[{"papel":"vendedor"},{"papel":"comprador"}],"contrato":{"estado":"aprovado"},"assinatura":{"estado":"running","total":3,"assinadas":1,"recusadas":1,"pendentes":1}}],"truncated":false}';
