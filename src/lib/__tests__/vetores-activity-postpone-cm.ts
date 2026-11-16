import { iniciarAtividade, argsDoVerbo } from "@/graph/atividades";

/**
 * Vetor fixo do verbo `activity.postpone` com `ate`/`hora`, copiado LITERALMENTE do teste do contractmaker
 * (`apps/web/src/app/api/agents/scope-action/__tests__/activity-postpone.test.ts`, bloco "activity.postpone com
 * ate/hora", PR-O3-CM #3162): mesmo id (`act1`), mesmas datas e horas, mesma lista de recusados e o mesmo "agora"
 * (2026-11-15 12:00 em São Paulo). Regra 1 do Max: o MESMO vetor dos dois lados.
 *
 * Aqui não há espelho de schema: o que se afirma é a SAÍDA do código de produção deste lado
 * (`iniciarAtividade` valida e `argsDoVerbo` monta o que vai no `x-idempotency-key`-ado POST do verbo).
 */
export const AGORA_DO_CM = Date.parse("2026-11-15T15:00:00.000Z");

/** `ATE` do teste do CM. */
export const ATE = { atividade_id: "act1", ate: "2026-11-20" };

/** O CM aceita (200) e o que este lado precisa montar, exatamente, para cada um. */
export const ACEITOS_PELO_CM: ReadonlyArray<{ entrada: Record<string, unknown>; saida: Record<string, unknown> }> = [
  { entrada: ATE, saida: { atividade_id: "act1", ate: "2026-11-20" } },
  { entrada: { ...ATE, hora: "09:30" }, saida: { atividade_id: "act1", ate: "2026-11-20", hora: "09:30" } },
  { entrada: { ...ATE, hora: "22:30" }, saida: { atividade_id: "act1", ate: "2026-11-20", hora: "22:30" } },
  // "ate igual a hoje (SP) é permitido"
  { entrada: { atividade_id: "act1", ate: "2026-11-15", hora: "18:00" }, saida: { atividade_id: "act1", ate: "2026-11-15", hora: "18:00" } },
];

/**
 * O CM recusa com 400 `invalid_args` (lista literal do teste do CM) ou `DATE_IN_PAST` (a última). Estes são os que
 * este lado também recusa ANTES de enviar (formato, dia que não existe, hora sem `ate`, dia passado): nenhuma chamada.
 */
export const RECUSADOS_ANTES_DE_ENVIAR: ReadonlyArray<Record<string, unknown>> = [
  { atividade_id: "act1", ate: "20/11/2026" },
  { atividade_id: "act1", ate: "2026-1-5" },
  { atividade_id: "act1", ate: "2026-11-20T10:00:00Z" },
  { atividade_id: "act1", ate: "2026-02-31" },
  { atividade_id: "act1", ate: "2026-13-01" },
  { atividade_id: "act1", hora: "09:30" },
  { atividade_id: "act1", dias: 1, hora: "09:30" },
  { ...ATE, hora: "9:30" },
  { ...ATE, hora: "25:00" },
  { ...ATE, hora: "09:60" },
  { atividade_id: "act1", ate: "2026-11-14" },
];

/**
 * O CM recusa porque o corpo traz campo a mais (`dias` junto de `ate`, `orgId`). Este lado não tem como enviá-los:
 * o pedido do modelo só carrega `ate`/`hora`, então a saída é o vetor limpo, sem o extra.
 */
export const RECUSADOS_POR_CAMPO_EXTRA: ReadonlyArray<{ entrada: Record<string, unknown>; extra: string }> = [
  { entrada: { ...ATE, dias: 1 }, extra: "dias" },
  { entrada: { ...ATE, orgId: "org-2" }, extra: "orgId" },
];

/**
 * O pedido, como o modelo o entrega ao grafo (só `ate`/`hora`; o id vem do mapa de referências): passa por
 * `iniciarAtividade` e por `argsDoVerbo`. `null` = este lado não monta chamada nenhuma (nada é enviado).
 * `dias`, `orgId` e qualquer outro campo do vetor são ignorados de propósito: o pedido não tem onde carregá-los.
 */
export function argsMontadosPorEsteLado(vetor: Record<string, unknown>, agora = AGORA_DO_CM): Record<string, unknown> | null {
  const passo = iniciarAtividade(
    { operacao: "reagendar", alvo: { id: String(vetor.atividade_id), rotulo: "Ligar para o João" }, ate: vetor.ate, hora: vetor.hora },
    { texto: "reagenda", messageId: "m1", policy: ["activity.write"], agora, orgName: "Imob" },
  );
  return "fluxo" in passo && passo.fluxo && passo.fluxo.kind === "atividade" ? argsDoVerbo(passo.fluxo) : null;
}
