import { currentExecution, runEvent } from "./runtime/context";
import { executeIntent } from "./runtime/store";
import { executableTool, isWriteVerb } from "./runtime/catalog";
import { contentDigest } from "./runtime/contracts";
import { assertBotWrite } from "./runtime/handoff";
import { orgById } from "./orgs";
import { normalizeBrPhone } from "./phone";
import {
  fetchWithTimeout, imobproBase, IMOBPRO_TIMEOUT_MS, IMOBPRO_PROPOSAL_SEND_TIMEOUT_MS, IMOBPRO_CREDIT_REQUEST_TIMEOUT_MS,
  captacaoSendTimeoutMs,
} from "./http";
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
  // Crédito Upestate (M2): leitura (`credit.read`) e a ficha (`credit.request`).
  "credit.preflight",
  "credit.status",
  "lead.upsert",
  // M3: envio síncrono da análise (até 20 s no servidor).
  "credit.request",
  // Captação (P9): `captacao.create` (capability do mesmo nome) cobre options/create/preflight;
  // `send` e `list` têm a sua. Escritas (create, send) levam `x-idempotency-key`.
  "captacao.options",
  "captacao.create",
  "captacao.preflight",
  "captacao.send",
  "captacao.list",
  // Autorização de reaproveitamento (v2/PR7, par do contractmaker#1863): `pedir` e
  // `decidir` levam `x-idempotency-key` (a `messageId` do "sim"); `listar` não.
  "captacao.autorizacao.pedir",
  "captacao.autorizacao.listar",
  "captacao.autorizacao.decidir",
  "marketing.options",
  "marketing.library",
  "marketing.prepare",
  "marketing.generate",
  "marketing.status",
] as const;
export type VerboDeAcao = (typeof VERBOS_DE_ACAO)[number];

/** Envio de proposta, de análise de crédito e de captação esperam mais; o resto, o teto comum. */
export function timeoutDoVerbo(verb: VerboDeAcao): number {
  if (verb === "proposal.send") return IMOBPRO_PROPOSAL_SEND_TIMEOUT_MS;
  if (verb === "captacao.send") return captacaoSendTimeoutMs();
  if (verb === "credit.request") return IMOBPRO_CREDIT_REQUEST_TIMEOUT_MS;
  return IMOBPRO_TIMEOUT_MS;
}

export interface RespostaDeAcao {
  status: number;
  body: Record<string, unknown>;
}

async function executarAcaoDireta(params: {
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
      timeoutDoVerbo(params.verb)
    );
    const body = (await res.json().catch(() => ({}))) as unknown;
    // 503 `notConfigured` do crédito (M3) é resposta de NEGÓCIO ("indisponível"), não falha de rede.
    const naoConfigurado = res.status === 503 && !!body && typeof body === "object" && (body as Record<string, unknown>).notConfigured === true;
    // `captacao.send` 502 `falha_envio` é desfecho CANÔNICO (o envio falhou e a captação ficou
    // em "falha no envio"), não queda de rede: o fluxo o traduz e nunca reenvia sozinho.
    const falhaDeEnvio = params.verb === "captacao.send" && res.status === 502 && !!body && typeof body === "object" &&
      (body as Record<string, unknown>).error === "falha_envio";
    if (res.status >= 500 && !naoConfigurado && !falhaDeEnvio) {
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

/** Shared gateway used by deterministic flows, marketing and future adapters. */
export async function executarAcao(params: Parameters<typeof executarAcaoDireta>[0]): Promise<RespostaDeAcao | null> {
  if (!executableTool(params.verb)) return { status: 403, body: { error: "capability_disabled" } };
  const e = currentExecution();
  if (e && (e.context.orgId !== params.orgId || contentDigest(e.context.subject) !== contentDigest(params.subject))) throw new Error("execution_tenant_mismatch");
  runEvent("tool.started", params.verb);
  if (e?.context.mode === "simulation") { runEvent("tool.simulated", params.verb); return { status: 409, body: { error: "simulation_effect_denied", simulated: true } }; }
  if (!isWriteVerb(params.verb)) return executarAcaoDireta(params);
  if (process.env.MAX_WRITES_KILL === "true" || ((params.verb === "marketing.generate" || params.verb === "credit.request") && process.env.MAX_PAID_KILL === "true")) return { status: 503, body: { error: "writes_disabled" } };
  if (e) {
    await assertBotWrite(e.context, params.rawPhone);
    if (!params.idempotencyKey) return { status: 400, body: { error: "idempotency_required" } };
    return executeIntent({ verb: params.verb, key: params.idempotencyKey, args: params.args }, () => executarAcaoDireta(params));
  }
  return executarAcaoDireta(params);
}
