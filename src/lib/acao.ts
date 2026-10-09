import { orgById } from "./orgs";
import { normalizeBrPhone } from "./phone";
import { fetchWithTimeout, imobproBase, IMOBPRO_TIMEOUT_MS, IMOBPRO_PROPOSAL_SEND_TIMEOUT_MS } from "./http";
import type { ScopeSubject } from "@/graph/scope-contract";

/**
 * Cliente do `POST /api/agents/scope-action` — as ESCRITAS e consultas de fluxo
 * do Max (proposta e formulário de negócio).
 *
 * Mesmo desenho do `scope.ts`: o Max não decide escopo nem autorização. O
 * servidor refaz telefone→sujeito, aplica a política do Max e o papel da
 * pessoa, e devolve código FIXO em vez de mensagem crua (D4 do PR 1b2). Este
 * cliente só transporta e devolve `{ status, body }` — quem traduz o código em
 * frase é o template do fluxo (`fluxos.ts`), nunca o modelo.
 *
 * `null` = não houve resposta utilizável (org sem token, telefone impossível,
 * rede, timeout). Quem chama diz "não consegui agora" — e, numa escrita, NÃO
 * afirma que ela aconteceu.
 */

export const VERBOS_DE_ACAO = [
  "proposal.list",
  "proposal.status",
  "proposal.create",
  "proposal.update",
  "proposal.options",
  "proposal.preflight",
  "proposal.send",
  "proposal.cancel",
  "proposal.recreate",
  "proposal.convert",
  "proposal.complete",
  "proposal.delete",
  "proposal.duplicate",
  "form.options",
  "form.create",
] as const;
export type VerboDeAcao = (typeof VERBOS_DE_ACAO)[number];

export interface RespostaDeAcao {
  status: number;
  body: Record<string, unknown>;
}

export async function executarAcao(params: {
  orgId: string;
  rawPhone: string;
  subject: ScopeSubject;
  verb: VerboDeAcao;
  args: Record<string, unknown>;
  /** Obrigatória nas escritas: a `messageId` que confirmou. */
  idempotencyKey?: string;
}): Promise<RespostaDeAcao | null> {
  const org = await orgById(params.orgId);
  if (!org) return null;
  const e164 = normalizeBrPhone(params.rawPhone);
  if (!e164) return null;

  try {
    const res = await fetchWithTimeout(
      `${imobproBase()}/api/agents/scope-action`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${org.apiToken}`,
          "content-type": "application/json",
          ...(params.idempotencyKey ? { "x-idempotency-key": params.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          verb: params.verb,
          subject: params.subject,
          phone: e164,
          args: params.args,
        }),
      },
      params.verb === "proposal.send" ? IMOBPRO_PROPOSAL_SEND_TIMEOUT_MS : IMOBPRO_TIMEOUT_MS
    );
    const body = (await res.json().catch(() => ({}))) as unknown;
    if (res.status >= 500) {
      console.warn(`[acao] ${params.verb} ${res.status} na org ${params.orgId}`);
      return null;
    }
    if (!res.ok) {
      // 4xx é resposta de NEGÓCIO (pendências, sem permissão, duplicado) — o
      // fluxo traduz. Log em nível de aviso para correlacionar com a auditoria.
      console.warn(`[acao] ${params.verb} ${res.status} na org ${params.orgId}`);
    }
    return {
      status: res.status,
      body: body && typeof body === "object" ? (body as Record<string, unknown>) : {},
    };
  } catch (err) {
    console.warn(
      `[acao] ${params.verb} falhou na org ${params.orgId}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
