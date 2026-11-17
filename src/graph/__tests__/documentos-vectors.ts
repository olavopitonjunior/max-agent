/**
 * Vetor do `document.list` (PR-O4c-MA), COPIADO byte a byte de
 * `contractmaker/apps/web/src/lib/max/__tests__/query-vectors.ts`
 * (chave `document.list.user`, CM `feat/max-o4c-document-list`, PR #3171, commit 1fdfc1b02).
 *
 * Só existe a forma do usuário: o corretor comissionado nunca recebe este verbo
 * (o servidor responde `{"items":[]}` mesmo com a política concedendo), então não há
 * vetor `.broker`.
 *
 * Literal de propósito: derivar dos tipos daqui acompanharia uma renomeação do outro
 * lado em silêncio, que é o defeito que o vetor existe para pegar. A ordem das chaves
 * é parte do contrato (o corpo HTTP a preserva).
 */
export const VETOR_DOCUMENT_LIST_USER =
  '{"items":[{"id":"ct-1","origem":"contrato","nome":"Contrato de Compra e Venda","categoria":"contrato","versao":2,"criadoEm":"2026-10-19T10:00:00.000Z","link":"/deals/deal-1?tab=contratos"},{"id":"env-1","origem":"contrato_assinado","nome":"Contrato de Compra e Venda","categoria":"contrato_assinado","versao":null,"criadoEm":"2026-10-18T15:30:00.000Z","link":"/deals/deal-1?tab=contratos"},{"id":"att-1","origem":"anexo","nome":"RG do vendedor.pdf","categoria":"rg","versao":null,"criadoEm":"2026-10-17T09:00:00.000Z","link":"/deals/deal-1?tab=anexos"}],"truncated":false}';
