/**
 * A pergunta fixa do aviso `proposal_awaiting_decision` (14/11/2026): o proponente
 * assinou e o corretor decide entre mandar ao proprietário e encerrar.
 *
 * Texto montado AQUI, sem modelo: a plataforma manda só os FATOS (`codigo`,
 * `decisao`) e o texto é o mesmo dentro da janela de 24h e no que é semeado no
 * thread quando o aviso sai por template (que não muda: o texto aprovado pela Meta
 * `max_proposta_assinada_proponente` não tem a pergunta). O que o Max semeia é o que
 * ele "lembra" ao receber o "enviar"/"encerrar" (`graph/proprietario.ts::sugestaoPendente`).
 *
 * Fail-closed: sem `decisao: "enviar_proprietario_ou_encerrar"` (CM antigo, ou liberação
 * de outra etapa: testemunha, imobiliária, comprador) ou sem um código de proposta
 * válido, não há pergunta e o aviso sai como antes.
 */

export const KIND_DECISAO_PROPOSTA = "proposal_awaiting_decision";
export const DECISAO_ENVIAR_OU_ENCERRAR = "enviar_proprietario_ou_encerrar";

/** O código humano da proposta ("PROP-2026-0042"); o mesmo formato que `proprietario.ts` reconhece. */
export const CODIGO_DA_PROPOSTA = /^PROP-\d{4}-\d+$/i;

/** A frase fixa. `proprietario.ts` a reconhece por `RESPONDA ENVIAR … ENCERRAR`. */
export const PERGUNTA_ENVIAR_OU_ENCERRAR = "Responda ENVIAR para mandar ao proprietário ou ENCERRAR para concluir.";

/** O código dos fatos: `codigo`, ou o primeiro termo de `proposta` ("PROP-2026-0042 Rua X"). */
export function codigoDaProposta(params: Record<string, string> | null | undefined): string | null {
  const candidatos = [params?.codigo, params?.proposta?.trim().split(/\s+/)[0]];
  for (const c of candidatos) {
    const limpo = c?.trim();
    if (limpo && CODIGO_DA_PROPOSTA.test(limpo)) return limpo.toUpperCase();
  }
  return null;
}

/**
 * "Proposta PROP-2026-0042: Responda ENVIAR … ou ENCERRAR …", ou `null` quando este
 * aviso não oferece a escolha.
 */
export function perguntaDaDecisao(
  kind: string | null | undefined,
  params: Record<string, string> | null | undefined
): string | null {
  if (kind !== KIND_DECISAO_PROPOSTA) return null;
  if (params?.decisao?.trim() !== DECISAO_ENVIAR_OU_ENCERRAR) return null;
  const codigo = codigoDaProposta(params);
  return codigo ? `Proposta ${codigo}: ${PERGUNTA_ENVIAR_OU_ENCERRAR}` : null;
}
