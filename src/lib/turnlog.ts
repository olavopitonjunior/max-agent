import { query } from "./db";
import { conversationKey } from "./phone";
import type { LlmUsage } from "./llm";

/**
 * Auditoria de conversa — uma linha por turn.
 *
 * ── Por que existe ────────────────────────────────────────────────────────
 *
 * No primeiro dia de conversa real em produção (21/08) apareceram quatro
 * defeitos nos dois primeiros turnos, e TODOS foram achados garimpando tabela
 * à mão, porque não havia lugar nenhum onde a conversa estivesse registrada.
 * É a mesma lição que o `outbox` já tinha ensinado: sem registro, "funcionando"
 * e "falhando em silêncio" têm a mesma aparência.
 *
 * ── Fora do caminho crítico, e sem poder derrubar nada ────────────────────
 *
 * Escrita no `afterReply`, junto da extração de memória — a resposta já saiu
 * quando isto roda. E `registrarTurn` NUNCA lança: auditoria que derruba o
 * turn é pior que auditoria nenhuma, porque troca uma conversa perdida por um
 * registro que ninguém vai ler.
 */

export interface ToolLogEntry {
  name: string;
  /** Argumentos como o modelo mandou — é isso que se quer ver ao investigar. */
  args: Record<string, unknown>;
  /** `proposta` | `criado` | `descartada` | `falhou` | `modulo_desligado` */
  outcome: string;
}

export interface TurnLog {
  orgId: string;
  phone: string;
  messageId?: string | null;
  kind?: string;
  /** O que virou texto do turn (transcrito, quando veio de mídia). */
  inboundText?: string | null;
  /** Original transcrito, quando houve mídia — para conferir a transcrição. */
  transcript?: string | null;
  replyText?: string | null;
  tools?: ToolLogEntry[];
  usage?: LlmUsage[];
  latencyMs?: number;
  error?: string | null;
}

export async function registrarTurn(log: TurnLog): Promise<void> {
  try {
    await query(
      `INSERT INTO conversation_turn
         (org_id, phone, message_id, kind, inbound_text, transcript,
          reply_text, tools_json, usage_json, latency_ms, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,
      [
        log.orgId,
        // Mesma chave do `thread_id` e da memória: investigar um turn e a
        // conversa dele não pode depender do formato de entrada do telefone.
        conversationKey(log.phone),
        log.messageId ?? null,
        log.kind ?? "text",
        log.inboundText ?? null,
        log.transcript ?? null,
        log.replyText ?? null,
        JSON.stringify(log.tools ?? []),
        JSON.stringify(log.usage ?? []),
        log.latencyMs ?? null,
        log.error ?? null,
      ]
    );
  } catch (err) {
    console.warn(
      "[turnlog] não registrou (o turn seguiu):",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * TTL do conteúdo. Apaga o que a pessoa DISSE; preserva o que a plataforma
 * precisa para entender custo.
 *
 * A linha continua existindo — some o texto, não o fato de ter havido um turn.
 * Deletar a linha inteira apagaria junto o histórico de consumo, que é
 * justamente o que não tem prazo para expirar.
 *
 * Mesmo tratamento de valor inválido que o `MEMORY_TTL_DAYS`: cai no default
 * com log de erro, nunca desliga em silêncio. `off` desliga de propósito.
 */
export async function pruneOldTurns(): Promise<number> {
  const raw = process.env.CONVERSATION_TTL_DAYS;
  if (raw?.trim().toLowerCase() === "off") return 0;

  let dias = 90;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      dias = n;
    } else {
      console.error(
        `[turnlog] CONVERSATION_TTL_DAYS inválida ("${raw}") — usando default 90. ` +
          `Para desligar a poda, use CONVERSATION_TTL_DAYS=off.`
      );
    }
  }

  try {
    const rows = await query<{ id: string }>(
      `UPDATE conversation_turn
          SET inbound_text = NULL, transcript = NULL, reply_text = NULL
        WHERE created_at < now() - ($1 || ' days')::interval
          AND (inbound_text IS NOT NULL OR reply_text IS NOT NULL
               OR transcript IS NOT NULL)
        RETURNING id`,
      [String(dias)]
    );
    return rows.length;
  } catch (err) {
    console.warn(
      "[turnlog] poda falhou:",
      err instanceof Error ? err.message : String(err)
    );
    return 0;
  }
}
