import { randomUUID } from "node:crypto";
import { query } from "./db";
import { executarAcao } from "./acao";
import { enqueue } from "./outbox";
import { orgById } from "./orgs";
import { lerItemDaCaptacao, textoDeEnvioConcluido } from "@/graph/captacao";
import type { ScopeSubject } from "@/graph/scope-contract";

/**
 * Conferência proativa do envio da captação (defeito 4, prod 19/11/2026).
 *
 * `captacao.send` pode passar de 20 s e voltar 202 ("Enviando…"). O fluxo agenda UM job
 * (`agendarConferenciaDeEnvio`) e o cron do outbox o processa (`processarFollowups`): consulta o
 * `captacao.list`, e quando o estado deixa de ser "Enviando…" enfileira UMA mensagem no outbox.
 * Se o corretor perguntou "como está" antes e viu o estado final, o fluxo encerra o job sem
 * mensagem (`concluirConferenciaDeEnvio`). Migration 031.
 *
 * Guardrails: o telefone do job é o do corretor do turno que enviou (o Max só fala com
 * corretores); o Max só afirma o que o Contractmaker devolveu no `captacao.list`; o texto leva só
 * o nome (ou código) da captação, o estado e o link.
 */

export const KIND_CAPTACAO_ENVIO = "captacao_envio";
/** Prazo total da conferência: depois disso, e ainda "Enviando…", desiste sem mensagem. */
export const PRAZO_DA_CONFERENCIA_MS = 5 * 60_000;
/** Primeira conferência: 30 s depois do 202. */
export const PRIMEIRA_CONFERENCIA_S = 30;
/** Backoff entre conferências que ainda veem "Enviando…" (a última se repete). */
export const BACKOFF_S = [30, 60, 120] as const;
/** Quanto o claim "aluga" o job: quem morre no meio devolve a linha ao cron nesse prazo. */
const ALUGUEL_S = 120;
const LOTE = 5;

export const dedupeDaConferencia = (captacaoId: string, messageId: string): string =>
  `captacao-envio:${captacaoId}:${messageId}`;

export interface AgendamentoDeConferencia {
  orgId: string;
  /** Telefone do corretor do turno (quem receberá o aviso). */
  phone: string;
  subject: ScopeSubject;
}

/**
 * Grava o job (idempotente pela `dedupe_key`: o mesmo envio não agenda duas conferências).
 * Lança em falha de banco — quem chama trata (best-effort).
 */
export async function agendarConferenciaDeEnvio(
  who: AgendamentoDeConferencia,
  job: { captacaoId: string; messageId: string }
): Promise<void> {
  await query(
    `INSERT INTO followup_job
       (id, org_id, phone, kind, ref_id, dedupe_key, subject, next_at, deadline_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(secs => $8), now() + make_interval(secs => $9))
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      randomUUID(),
      who.orgId,
      who.phone,
      KIND_CAPTACAO_ENVIO,
      job.captacaoId,
      dedupeDaConferencia(job.captacaoId, job.messageId),
      JSON.stringify(who.subject),
      PRIMEIRA_CONFERENCIA_S,
      PRAZO_DA_CONFERENCIA_MS / 1000,
    ]
  );
}

/** O corretor já viu o estado final: encerra a conferência pendente (sem mensagem). */
export async function concluirConferenciaDeEnvio(orgId: string, captacaoId: string): Promise<void> {
  await query(
    `UPDATE followup_job
        SET status = 'done', updated_at = now()
      WHERE kind = $1 AND org_id = $2 AND ref_id = $3 AND status = 'pending'`,
    [KIND_CAPTACAO_ENVIO, orgId, captacaoId]
  );
}

interface JobRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  phone: string;
  ref_id: string;
  dedupe_key: string;
  subject: unknown;
  attempt: number;
  deadline_at: Date | string;
}

export interface TotaisDeFollowup {
  claimed: number;
  avisados: number;
  reagendados: number;
  desistidos: number;
}

const ehSujeito = (v: unknown): v is ScopeSubject => {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (o.kind === "user" && typeof o.userId === "string") || (o.kind === "broker" && typeof o.splitRecipientId === "string");
};

/**
 * Processa os jobs vencidos. Claim com `FOR UPDATE SKIP LOCKED` DENTRO de um UPDATE que empurra
 * `next_at` (aluguel): o lock do SKIP LOCKED só dura o statement (ver migration 002), então sem
 * mudar a linha duas passadas concorrentes pegariam o mesmo job. Nunca lança.
 */
export async function processarFollowups(): Promise<TotaisDeFollowup> {
  const totais: TotaisDeFollowup = { claimed: 0, avisados: 0, reagendados: 0, desistidos: 0 };
  let jobs: JobRow[];
  try {
    jobs = await query<JobRow>(
      `UPDATE followup_job
          SET next_at = now() + make_interval(secs => $2), updated_at = now()
        WHERE id IN (
          SELECT id FROM followup_job
           WHERE status = 'pending' AND next_at <= now()
           ORDER BY next_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, org_id, phone, ref_id, dedupe_key, subject, attempt, deadline_at`,
      [LOTE, ALUGUEL_S]
    );
  } catch (err) {
    console.error("[followup] claim falhou:", err instanceof Error ? err.message : String(err));
    return totais;
  }
  totais.claimed = jobs.length;
  await Promise.all(
    jobs.map(async (job) => {
      const r = await processarUm(job).catch((err): "reagendado" | "desistido" => {
        console.error(`[followup] job ${job.id} falhou:`, err instanceof Error ? err.message : String(err));
        return "reagendado";
      });
      if (r === "avisado") totais.avisados += 1;
      else if (r === "desistido") totais.desistidos += 1;
      else totais.reagendados += 1;
    })
  );
  return totais;
}

async function processarUm(job: JobRow): Promise<"avisado" | "reagendado" | "desistido"> {
  const deadline = new Date(job.deadline_at).getTime();
  const subject = typeof job.subject === "string" ? safeJson(job.subject) : job.subject;

  if (ehSujeito(subject)) {
    const r = await executarAcao({
      orgId: job.org_id,
      rawPhone: job.phone,
      subject,
      verb: "captacao.list",
      args: { captacaoId: job.ref_id },
    }).catch(() => null);
    const item = r?.status === 200 && Array.isArray(r.body.items)
      ? r.body.items.map(lerItemDaCaptacao).find((x) => x?.id === job.ref_id)
      : null;
    // Só um estado que o CM devolveu e que não é "Enviando…" encerra. Qualquer outra coisa (sem
    // resposta, 4xx, captação fora da lista) é "não sei ainda": nunca afirma envio.
    if (item?.estado && !/enviando/i.test(item.estado)) {
      try {
        const org = await orgById(job.org_id);
        await enqueue({
          orgId: job.org_id,
          dedupeKey: job.dedupe_key,
          audience: "platform_user",
          phone: job.phone,
          recipientName: "",
          title: "Captação",
          body: textoDeEnvioConcluido(item, item.estado),
          linkUrl: null,
          dealId: null,
          orgName: org?.orgName ?? "",
          kind: null,
        });
        // `duplicate` também encerra: a mesma chave já está no outbox.
        await query(`UPDATE followup_job SET status = 'done', updated_at = now() WHERE id = $1 AND status = 'pending'`, [job.id]);
        return "avisado";
      } catch (err) {
        // Não enfileirou: cai no backoff abaixo (e desiste no prazo), em vez de repetir para sempre.
        console.error(`[followup] job ${job.id}: enqueue falhou:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Ainda "Enviando…" (ou não deu para saber, ou sujeito ilegível): backoff, ou desiste sem mensagem.
  if (!ehSujeito(subject) || Date.now() >= deadline) {
    await query(`UPDATE followup_job SET status = 'gave_up', updated_at = now() WHERE id = $1 AND status = 'pending'`, [job.id]);
    return "desistido";
  }
  const espera = BACKOFF_S[Math.min(job.attempt, BACKOFF_S.length - 1)]!;
  await query(
    `UPDATE followup_job
        SET attempt = attempt + 1, next_at = now() + make_interval(secs => $2), updated_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [job.id, espera]
  );
  return "reagendado";
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
