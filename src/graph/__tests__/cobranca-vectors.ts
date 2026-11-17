/**
 * Vetor do `charge.status` (PR-O4d-MA), COPIADO byte a byte de
 * `contractmaker/apps/web/src/lib/max/__tests__/query-vectors.ts`
 * (chave `charge.status.user`, CM `feat/max-o4d-charge-status`, PR #3176, commit b89fdb6fd).
 *
 * Só existe a forma do usuário: o corretor comissionado nunca recebe este verbo
 * (o servidor responde `{"items":[]}` mesmo com a política concedendo), então não há
 * vetor `.broker`.
 *
 * Literal de propósito: derivar dos tipos daqui acompanharia uma renomeação do outro
 * lado em silêncio, que é o defeito que o vetor existe para pegar. A ordem das chaves
 * é parte do contrato (o corpo HTTP a preserva).
 */
export const VETOR_CHARGE_STATUS_USER =
  '{"items":[{"id":"ch-2","negocioId":"deal-1","tipo":"comissao","estado":"paga","valor":1200050,"vencimento":"2026-11-25T00:00:00.000Z","pagoEm":"2026-11-24T13:20:00.000Z","canceladoEm":null,"estornadoEm":null,"provedor":"asaas"},{"id":"ch-1","negocioId":"deal-1","tipo":"avulsa","estado":"aguardando","valor":35000,"vencimento":"2026-11-18T00:00:00.000Z","pagoEm":null,"canceladoEm":null,"estornadoEm":null,"provedor":"rinne"}],"truncated":false}';
