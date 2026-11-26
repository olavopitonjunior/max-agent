/**
 * Recusa de dado de assinante pela ClickSign (CM 422 `dados_recusados_clicksign`, hotfix #220).
 * Módulo-folha: o `fluxos` (envio da proposta) e a `assinatura` (enviar ao proprietário) usam o MESMO texto,
 * e um importando o outro formaria ciclo.
 */

/** `dados_recusados_clicksign.campo` → o que a pessoa corrige (contrato em docs/max.md do CM). */
export const TEXTO_DO_CAMPO_RECUSADO: Record<string, string> = {
  nome: "A ClickSign recusou o nome de um assinante: use nome e sobrenome, sem números nem símbolos.",
  cpf: "A ClickSign recusou o CPF de um assinante: confira os números.",
  email: "A ClickSign recusou o e-mail de um assinante: confira o endereço.",
  celular: "A ClickSign recusou o celular de um assinante: use DDD + número.",
  nascimento: "A ClickSign recusou a data de nascimento de um assinante: confira a data.",
  outro: "A ClickSign recusou o envio desta proposta.",
};

/** O corpo é a recusa de dado da ClickSign? (422 + código fixo) */
export function ehRecusaDeDadosClicksign(status: number, body: Record<string, unknown>): boolean {
  return status === 422 && body.error === "dados_recusados_clicksign";
}

/** O campo recusado, só se for um dos conhecidos: valor desconhecido (ou texto do servidor) vira "outro". */
export function campoRecusadoDe(body: Record<string, unknown>): string {
  return typeof body.campo === "string" && Object.hasOwn(TEXTO_DO_CAMPO_RECUSADO, body.campo) ? body.campo : "outro";
}
