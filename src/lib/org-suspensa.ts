/**
 * Organização SUSPENSA no ImobPro.
 *
 * O ImobPro responde 403 `{ error: "ORG_SUSPENSA", reason }` em toda rota
 * autenticada de uma org suspensa (`lib/auth/org-suspensa.ts` lá; docs/max.md
 * §17.1). Não é falta de permissão da pessoa nem defeito de integração: é um
 * FATO da org, e retentar não resolve — quem resolve é a plataforma.
 *
 * Por isso o Max o reconhece e responde com frase fixa (regra 7: fato
 * estruturado, sem modelo reescrevendo), em vez de tratar como 403 genérico.
 *
 * Módulo sem `fetch`, pelo mesmo motivo de `transport/erro.ts`: testes que
 * mockam `cm.ts` não precisam reexportar funções puras.
 */

export const ORG_SUSPENSA = "ORG_SUSPENSA";

export const TEXTO_ORG_SUSPENSA =
  "O acesso da sua imobiliária ao ImobPro está suspenso no momento. " +
  "Fale com o administrador da imobiliária.";

/** O erro de um cliente HTTP que recebeu o 403 acima. Não se retenta. */
export class OrgSuspensaError extends Error {
  constructor(rota: string) {
    super(`organização suspensa (${rota})`);
    this.name = "OrgSuspensaError";
  }
}

/** 403 cujo corpo traz `error: "ORG_SUSPENSA"`. Corpo ilegível = não é. */
export function ehOrgSuspensa(status: number, corpo: string): boolean {
  if (status !== 403) return false;
  try {
    return (JSON.parse(corpo) as { error?: unknown }).error === ORG_SUSPENSA;
  } catch {
    return false;
  }
}
