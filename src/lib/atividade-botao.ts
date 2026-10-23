import type { Candidate } from "@/lib/identity";
import type { ResultadoDeLeitura } from "@/lib/scope";
import type { ContextoDoTurno, Fluxo } from "@/graph/fluxos";
import {
  atividadePermitida,
  iniciarAtividade,
  TEXTO_ATIVIDADE_INDISPONIVEL,
  TEXTO_ATIVIDADE_NAO_LIBERADA,
  TEXTO_ATIVIDADE_SEM_VERIFICAR,
  type OperacaoDeAtividade,
} from "@/graph/atividades";
import { podeEscrever } from "@/graph/tools";

/**
 * Roteamento do toque num botão de atividade: payload `atv:<id>:concluir|comentar|recusar`
 * (Atividades v2 / M1). Módulo irmão de `aceite.ts`, que cuida dos payloads
 * `ok:`/`duvida:`/`acao:`.
 *
 * ── Por que NÃO mora em `interceptar` ──────────────────────────────────────
 *
 * `interceptar` roda ANTES da identidade: não sabe quem é a pessoa nem qual a
 * política dela. Este roteamento precisa dos dois (só usuário interno, só com
 * `activity.write`), então é chamado pelo nó `conduzir` do grafo, depois do
 * `gate`. `interceptar` só deixa o payload passar (`ehPayloadDeAtividade`),
 * para o texto do botão não virar "dúvida" em outro caminho.
 *
 * ── O que o toque faz ─────────────────────────────────────────────────────
 *
 * O toque NUNCA escreve. `concluir` abre a proposta de conclusão (que ainda
 * pede SIM); `comentar` e `recusar` pedem o texto/motivo e então propõem. A
 * escrita é a do fluxo de `atividades.ts`: resumo → SIM → verbo com a
 * `messageId` do SIM como `x-idempotency-key`.
 *
 * ── Resposta neutra ───────────────────────────────────────────────────────
 *
 * Payload malformado, id inexistente e id de outra org dão a MESMA frase
 * (`TEXTO_ATIVIDADE_INDISPONIVEL`): o servidor responde "vazio" para os três
 * (`activity.get`), e aqui nada distingue quem não existe de quem não é seu.
 */

const PAYLOAD = /^atv:([A-Za-z0-9_-]{1,64}):(concluir|comentar|recusar)$/;

export interface PayloadDeAtividade {
  atividadeId: string;
  acao: Exclude<OperacaoDeAtividade, "criar">;
}

/** O payload é DESTE roteamento? (Mesmo malformado: quem decide é `parsePayloadDeAtividade`.) */
export function ehPayloadDeAtividade(payload: string | null | undefined): boolean {
  return typeof payload === "string" && payload.startsWith("atv:");
}

/** `null` = malformado ou ação fora do enum. */
export function parsePayloadDeAtividade(payload: string | null | undefined): PayloadDeAtividade | null {
  if (typeof payload !== "string") return null;
  const m = PAYLOAD.exec(payload);
  return m ? { atividadeId: m[1]!, acao: m[2] as PayloadDeAtividade["acao"] } : null;
}

export interface RespostaDoBotao {
  reply: string;
  /** `null` = nenhum fluxo aberto por este toque. */
  fluxo: Fluxo | null;
  evento: string;
}

export const TEXTO_BOTAO_SEM_LEITURA =
  "Não consegui abrir essa atividade agora. Nada foi alterado; toque no botão de novo em instantes.";

/** `activity.get` do servidor para ESTE usuário (injetado: o grafo passa `consultarEscopo`). */
export type LeitorDeAtividade = (atividadeId: string) => Promise<ResultadoDeLeitura | null>;

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function rotearBotaoDeAtividade(params: {
  payload: string;
  ctx: ContextoDoTurno;
  identity: Candidate;
  ler: LeitorDeAtividade;
}): Promise<RespostaDoBotao> {
  const parsed = parsePayloadDeAtividade(params.payload);
  if (!parsed) return { reply: TEXTO_ATIVIDADE_INDISPONIVEL, fluxo: null, evento: "atividade_botao_invalido" };

  // Identidade e política ANTES de qualquer leitura: quem não pode escrever não consulta nada por aqui.
  if (!podeEscrever(params.identity)) {
    return { reply: TEXTO_ATIVIDADE_NAO_LIBERADA, fluxo: null, evento: "atividade_botao_sem_login" };
  }
  if (params.ctx.politicaIndisponivel) {
    return { reply: TEXTO_ATIVIDADE_SEM_VERIFICAR, fluxo: null, evento: "atividade_politica_indisponivel" };
  }
  if (!atividadePermitida(params.ctx) || !params.ctx.policy.includes("activity.list")) {
    return { reply: TEXTO_ATIVIDADE_NAO_LIBERADA, fluxo: null, evento: "atividade_sem_politica" };
  }

  const lida = await params.ler(parsed.atividadeId);
  if (!lida) return { reply: TEXTO_BOTAO_SEM_LEITURA, fluxo: null, evento: "atividade_botao_sem_leitura" };

  // O servidor devolve vazio para inexistente, de outra org e fora da visibilidade: mesma resposta aos três.
  const item = lida.items.find(
    (it): it is Record<string, unknown> =>
      !!it && typeof it === "object" && (it as { id?: unknown }).id === parsed.atividadeId
  );
  if (!item) return { reply: TEXTO_ATIVIDADE_INDISPONIVEL, fluxo: null, evento: "atividade_botao_indisponivel" };

  const rotulo = (texto(item.titulo) ?? "Atividade").slice(0, 80);
  if (parsed.acao !== "comentar" && (texto(item.concluidaEm) || texto(item.canceladaEm))) {
    const estado = texto(item.concluidaEm) ? "já está concluída" : "foi cancelada";
    return { reply: `A atividade "${rotulo}" ${estado}. Nada foi alterado.`, fluxo: null, evento: "atividade_botao_encerrada" };
  }

  const passo = iniciarAtividade({ operacao: parsed.acao, alvo: { id: parsed.atividadeId, rotulo } }, params.ctx);
  return { reply: passo.reply, fluxo: passo.fluxo, evento: `atividade_botao_${passo.evento}` };
}
