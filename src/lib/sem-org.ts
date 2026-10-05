/**
 * O `org_id` gravado quando o Max conversa com um número que não pertence a
 * nenhuma imobiliária (o desconhecido que recebe "fale com seu corretor").
 *
 * Tem parêntese e espaço, e por isso viaja na URL assinada com grafias
 * diferentes (`%28sem+org%29`, `(sem+org)`): o HMAC aceita a query canônica
 * para isso (`queryCanonica` em `lib/auth.ts`).
 */
export const SEM_ORG = "(sem org)";
