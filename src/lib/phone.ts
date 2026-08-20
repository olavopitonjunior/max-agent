/**
 * Normalização de telefone BR para E.164.
 *
 * Cópia deliberada de `apps/web/src/lib/validators/phone-br.ts` do ImobPro. Os
 * dois lados normalizam: lá para que o motivo da recusa fique no log do
 * negócio (onde alguém procura quando "o corretor não recebeu"), aqui porque
 * este serviço também recebe telefone de fora do `/notify` — o webhook da
 * Z-API, por exemplo.
 *
 * Não é sobre desconfiar do chamador: é que mandar telefone cru pro gateway já
 * causou perda SILENCIOSA de mensagem em produção (#189, e de novo no ramo de
 * corretor do Newton em 2026-08).
 */
function onlyDigits(input: string): string {
  return (input ?? "").replace(/\D/g, "");
}

export function normalizeBrPhone(raw: string): string | null {
  if (!raw) return null;
  let d = onlyDigits(raw);
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    d = d.slice(2);
  }
  if (d.length !== 10 && d.length !== 11) return null;
  return `+55${d}`;
}

/** Formato que a Z-API espera: E.164 sem "+". */
export function toZapiPhone(raw: string): string | null {
  const e164 = normalizeBrPhone(raw);
  return e164 ? e164.replace(/^\+/, "") : null;
}

/**
 * Telefone para LOG: DDI+DDD e os 4 finais, o meio mascarado.
 *
 * Log da Vercel é retido e pesquisável fora do nosso controle de acesso —
 * telefone completo ali é PII vazando para onde ninguém audita. Os 4 finais
 * bastam para correlacionar uma investigação com a linha da fila (lá o número
 * está inteiro, atrás de credencial de banco).
 */
export function maskPhone(raw: string): string {
  const d = onlyDigits(raw ?? "");
  if (d.length <= 6) return "***";
  return `${d.slice(0, 4)}***${d.slice(-4)}`;
}
