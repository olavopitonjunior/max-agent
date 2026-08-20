import { query } from "./db";
import { LLM_SHORT_TIMEOUT_MS } from "./http";
import { complete } from "./llm";
import { reportUsage } from "./cm";

/**
 * Memória do Max entre conversas.
 *
 * ── O que ela É, e o que já existia ───────────────────────────────────────
 *
 * O grafo já compacta o histórico: quando a conversa cresce, os turnos antigos
 * viram um resumo em prosa. Isso resolve CONTEXTO, não memória — o resumo é
 * lossy por construção, some ao ser recomprimido, e não dá pra consultar.
 *
 * Aqui é o outro tipo: fatos curtos, chaveados, que sobrevivem a qualquer
 * compactação. "Trabalha com locação", "prefere ser chamado de Neto",
 * "acompanha os imóveis da zona sul". O que faz o agente parar de perguntar a
 * mesma coisa toda semana.
 *
 * ── O que ela NÃO guarda, e isso é regra e não estilo ─────────────────────
 *
 * Nada de documento, CPF, dado bancário, valor de negócio ou informação de
 * terceiro. Esses vivem no ImobPro, atrás de auth e de escopo por org — copiar
 * pra cá criaria uma segunda cópia sem as mesmas defesas, num banco cuja razão
 * de existir é justamente NÃO ter os dados da aplicação.
 *
 * A cerca está no prompt de extração e nos limites deste arquivo; nenhuma das
 * duas confia na outra.
 *
 * ── Fora do caminho crítico ───────────────────────────────────────────────
 *
 * A extração roda DEPOIS de a resposta sair (ver `TurnResult.afterReply`) —
 * alternativa deliberada ao LangMem, cuja extração síncrona entraria na
 * latência do turn. Quem manda áudio no WhatsApp já espera; somar uma segunda
 * chamada de modelo antes da resposta seria pagar em espera pelo que só importa
 * na conversa seguinte.
 */

/** Teto por pessoa. Acima disso, os mais antigos saem. */
const MAX_FACTS_PER_PERSON = 20;
/** Um fato é uma frase curta, não um parágrafo. */
const MAX_VALUE_CHARS = 200;
const MAX_KEY_CHARS = 40;

export type Facts = Record<string, string>;

export async function loadFacts(orgId: string, phone: string): Promise<Facts> {
  try {
    const rows = await query<{ key: string; value: string }>(
      `SELECT key, value FROM memory_facts
        WHERE org_id = $1 AND phone = $2
        ORDER BY updated_at DESC
        LIMIT $3`,
      [orgId, phone, MAX_FACTS_PER_PERSON]
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch (err) {
    // Memória é enriquecimento: sem ela o Max responde igual, só menos
    // pessoal. Derrubar o turn por causa disso seria trocar uma conversa por
    // nenhuma.
    console.warn(
      "[memory] leitura falhou (segue sem memória):",
      err instanceof Error ? err.message : String(err)
    );
    return {};
  }
}

/** Normaliza e recusa o que não deve virar fato. `null` = descartar. */
function limpar(key: unknown, value: unknown): [string, string] | null {
  if (typeof key !== "string" || typeof value !== "string") return null;
  const k = key.trim().toLowerCase().slice(0, MAX_KEY_CHARS);
  const v = value.trim().slice(0, MAX_VALUE_CHARS);
  if (!k || !v) return null;

  /**
   * Segunda cerca, independente do prompt.
   *
   * O prompt pede pra não extrair documento nem dado bancário, mas prompt é
   * pedido, não garantia — e o custo de um CPF vazar pra este banco é alto
   * demais pra depender de o modelo ter obedecido. Chave OU valor com cara de
   * documento é descartado aqui, sem discussão.
   */
  const suspeito = /\b(cpf|cnpj|rg\b|documento|conta|agencia|agência|pix|cart[ãa]o|senha|iban)\b/i;
  if (suspeito.test(k) || suspeito.test(v)) return null;
  // Sequência longa de dígitos é documento, telefone ou valor — nada disso é
  // "fato operacional" e todos têm dono melhor no ImobPro.
  if (/\d[\d.\-/\s]{8,}/.test(v)) return null;

  return [k, v];
}

/**
 * Grava os fatos novos. Upsert por chave — fato que muda (mudou de função,
 * mudou de foco) sobrescreve em vez de acumular contradição.
 */
export async function saveFacts(
  orgId: string,
  phone: string,
  facts: Facts
): Promise<number> {
  const limpos = Object.entries(facts)
    .map(([k, v]) => limpar(k, v))
    .filter((x): x is [string, string] => x !== null)
    .slice(0, MAX_FACTS_PER_PERSON);

  if (limpos.length === 0) return 0;

  try {
    for (const [key, value] of limpos) {
      await query(
        `INSERT INTO memory_facts (org_id, phone, key, value, updated_at)
         VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (org_id, phone, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [orgId, phone, key, value]
      );
    }

    // Poda pelo teto. Sem isto a memória cresce sem limite e passa a ocupar o
    // prompt inteiro — o oposto do ganho.
    await query(
      `DELETE FROM memory_facts
        WHERE org_id = $1 AND phone = $2
          AND key NOT IN (
            SELECT key FROM memory_facts
             WHERE org_id = $1 AND phone = $2
             ORDER BY updated_at DESC
             LIMIT $3
          )`,
      [orgId, phone, MAX_FACTS_PER_PERSON]
    );

    return limpos.length;
  } catch (err) {
    console.warn(
      "[memory] gravação falhou:",
      err instanceof Error ? err.message : String(err)
    );
    return 0;
  }
}

const EXTRACT_SYSTEM = `Você extrai FATOS DURÁVEIS sobre uma pessoa, a partir de uma conversa de WhatsApp com um assistente imobiliário.

Devolva um objeto JSON plano, com no máximo 5 pares "chave": "valor".

O que extrair — só o que continuará verdade daqui a semanas:
- como a pessoa prefere ser chamada
- função ou área em que atua (locação, vendas, administrativo)
- preferências de trabalho recorrentes
- assunto que ela acompanha de forma continuada

O que NUNCA extrair:
- CPF, CNPJ, RG, documento, dado bancário, PIX, cartão, senha
- valores de negócio, endereços de imóvel, nomes de clientes dela
- qualquer coisa sobre TERCEIROS
- o assunto pontual desta conversa ("perguntou do contrato X") — isso é contexto, não fato

Se não houver nada durável, devolva {}. Prefira {} a inventar.
Responda SOMENTE o JSON, sem cercas de código e sem comentários.`;

/**
 * Lê o turn e devolve o que vale lembrar. Nunca lança.
 *
 * Chamada de modelo separada, e não um pedaço a mais no prompt de resposta:
 * misturar as duas faria a resposta ao usuário carregar instruções de extração,
 * e um modelo nano confunde as duas tarefas com facilidade — já responderia
 * "anotei que você trabalha com locação" no meio de uma resposta sobre
 * contrato.
 */
export async function extractFacts(params: {
  orgId: string;
  phone: string;
  userText: string;
  replyText: string;
  known: Facts;
}): Promise<Facts> {
  const conhecidos = Object.keys(params.known);

  try {
    const result = await complete({
      system: EXTRACT_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            (conhecidos.length
              ? `Já sabemos (não repita estes, a menos que tenham MUDADO): ${conhecidos.join(", ")}\n\n`
              : "") +
            `Pessoa: ${params.userText.slice(0, 2000)}\n` +
            `Assistente: ${params.replyText.slice(0, 2000)}`,
        },
      ],
      maxTokens: 300,
      timeoutMs: LLM_SHORT_TIMEOUT_MS,
    });

    void reportUsage(params.orgId, result.usage);

    const bruto = result.text.trim().replace(/^```(?:json)?|```$/g, "").trim();
    const parsed: unknown = JSON.parse(bruto);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Facts;
  } catch (err) {
    // Inclui JSON malformado. Memória é opcional; um turn sem extração custa
    // uma conversa menos pessoal, não uma conversa quebrada.
    console.warn(
      "[memory] extração falhou:",
      err instanceof Error ? err.message : String(err)
    );
    return {};
  }
}

/** Bloco pro prompt. String vazia quando não há nada — sem cabeçalho órfão. */
export function renderFacts(facts: Facts): string {
  const entries = Object.entries(facts);
  if (entries.length === 0) return "";
  return (
    "\n\nO que você já sabe sobre esta pessoa (de conversas anteriores):\n" +
    entries.map(([k, v]) => `- ${k}: ${v}`).join("\n")
  );
}

/**
 * TTL da memória: fato que ninguém atualiza há MEMORY_TTL_DAYS sai.
 *
 * Sem isto, um "trabalha com locação" de dois anos atrás continuava no prompt
 * para sempre — e a tabela, indexada por telefone, acumulava dado pessoal sem
 * prazo (a poda por teto de 20 só age em quem CONVERSA; quem sumiu ficava
 * congelado). Varredura global barata, chamada pelo cron da fila de entrada;
 * quem quiser prazo diferente ajusta a env sem deploy.
 */
export async function pruneOldFacts(): Promise<number> {
  const days = Number(process.env.MEMORY_TTL_DAYS ?? "180");
  if (!Number.isFinite(days) || days <= 0) return 0;
  const rows = await query<{ count: string }>(
    `WITH apagados AS (
       DELETE FROM memory_facts
        WHERE updated_at < now() - ($1 || ' days')::interval
        RETURNING 1
     ) SELECT count(*)::text AS count FROM apagados`,
    [String(days)]
  );
  return Number(rows[0]?.count ?? 0);
}
