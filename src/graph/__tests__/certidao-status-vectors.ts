/**
 * Vetor do `certidao.status` (PR-O4b-MA), COPIADO byte a byte de
 * `contractmaker/apps/web/src/lib/max/__tests__/query-vectors.ts`
 * (chave `certidao.status.user`, CM `feat/max-o4b-certidao-status`, commit 453c8594d).
 *
 * Só existe a forma do usuário: o corretor comissionado nunca recebe este verbo
 * (o servidor responde `{"items":[]}` mesmo com a política concedendo), então não há
 * vetor `.broker`.
 *
 * Literal de propósito: derivar dos tipos daqui acompanharia uma renomeação do outro
 * lado em silêncio, que é o defeito que o vetor existe para pegar. A ordem das chaves
 * é parte do contrato (o corpo HTTP a preserva).
 */
export const VETOR_CERTIDAO_STATUS_USER =
  '{"items":[{"id":"cj-1","certidao":"CND Federal + Divida Ativa","modelo":null,"alvo":{"papel":"vendedor","indice":1},"situacao":"saiu","rotulo":"Saiu","faltaDado":false,"previsao":null,"validade":{"ate":"2026-12-01","vencida":false},"atualizadoEm":"2026-10-19T10:05:00.000Z"},{"id":"cj-2","certidao":"CNDT (Trabalhista)","modelo":null,"alvo":{"papel":"comprador","indice":2},"situacao":"em_andamento","rotulo":"Em andamento","faltaDado":false,"previsao":"2026-10-25T12:00:00.000Z","validade":null,"atualizadoEm":"2026-10-19T10:05:00.000Z"},{"id":"cj-3","certidao":"CEAT TRT2 (SP - fisico)","modelo":null,"alvo":{"papel":"vendedor","indice":1},"situacao":"precisa_de_voce","rotulo":"Precisa de você","faltaDado":true,"previsao":null,"validade":null,"atualizadoEm":"2026-10-19T08:00:00.000Z"},{"id":"cj-4","certidao":"TJSP Certidão de Distribuição","modelo":"Falências","alvo":{"papel":"vendedor","indice":1},"situacao":"em_andamento","rotulo":"Em andamento","faltaDado":false,"previsao":"2026-10-25T12:00:00.000Z","validade":null,"atualizadoEm":"2026-10-19T10:05:00.000Z"}],"truncated":false}';
