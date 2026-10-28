import type { Candidate } from "@/lib/identity";
import type { ContextoDoTurno } from "@/graph/fluxos";
import { podeEscrever } from "@/graph/tools";
import type { InboundMessage } from "@/lib/transport";
import type { executarAcao } from "@/lib/acao";
import type { enqueue } from "@/lib/outbox";
import type { sendReaction } from "@/lib/transport";
import type { RespostaDoBotao, LeitorDeAtividade, rotearBotaoDeAtividade } from "@/lib/atividade-botao";
import { query } from "@/lib/db";
import { conversationKey } from "@/lib/phone";
import { subjectDe } from "@/lib/scope";
import { amanhaAs } from "@/lib/window";
import { PREFIXO_AVISO } from "@/lib/aviso/interativo";
import { ACOES_AVISO, type AcaoAviso, type Aviso } from "@/lib/aviso/schema";

/**
 * Toque num botão (ou linha de lista) de AVISO: payload `av:<rowId>:<acao>` ou
 * `av:<rowId>:item:<alvoId>` (ids montados em `aviso/interativo.ts`, M5).
 *
 * Roteamento SEM modelo, como o `atv:` (`atividade-botao.ts`): mora no nó
 * `conduzir` do grafo porque precisa de identidade e política, e o
 * `interceptar` do `aceite.ts` só deixa o payload passar.
 *
 * ── Quem pode tocar ─────────────────────────────────────────────────────────
 *
 * O payload é só uma referência: a autoridade é a linha da `outbox`. O toque só
 * vale se a linha existe, foi ENVIADA, é da org da identidade e do telefone que
 * tocou. Qualquer falha dessas dá a MESMA frase (`TEXTO_AVISO_INDISPONIVEL`):
 * quem não existe e quem não é seu não se distinguem. Passadas 72h do envio o
 * aviso expira (`TEXTO_AVISO_EXPIRADO`), porque o estado do negócio já mudou.
 *
 * ── Idempotência ────────────────────────────────────────────────────────────
 *
 * As ações com efeito próprio (`reenviar_link`, `adiar_1d`, `lembrar_amanha`)
 * reivindicam `(rowId, ação)` na tabela `aviso_toque` (migration 028). O
 * segundo toque, de outra mensagem, responde `TEXTO_AVISO_JA_FEITO` sem repetir
 * o efeito; a mesma `messageId` de novo (reentrega do webhook) passa. Quem
 * garante que não duplica é a `x-idempotency-key`, FIXA por aviso e ação
 * (`av:<rowId>:<ação>`, e não a `messageId` do toque) ou a `dedupeKey` do
 * lembrete. Erro libera a reivindicação, para o toque seguinte poder tentar de
 * novo; se o erro foi incerto (`null`, 5xx, rede) a tentativa pode ter chegado
 * ao servidor, e a mesma chave faz a plataforma deduplicar o reenvio. A trava
 * não guarda "incerto" (a 028 só tem a linha), então a chave fixa é o que impede
 * o efeito duplo.
 *
 * Exceção: o 409 `concluido` do `form.remind` (o formulário já foi preenchido) é
 * definitivo e MANTÉM a trava: repetir o toque só repetiria a mesma resposta.
 *
 * As ações de link (`abrir`, `ver_*`) não escrevem nada e não reivindicam;
 * `concluir` segue o fluxo de atividades de hoje (resumo, SIM, chave do SIM) e a
 * trava dela é o próprio fluxo. `criar_atividade` ("próximo passo") NÃO escreve:
 * devolve o link do negócio (criar atividade exige campos que o botão não tem).
 *
 * ── Sucesso e erro ──────────────────────────────────────────────────────────
 *
 * Sucesso direto responde a frase da ação e reage ✅ ao toque (cortesia: a
 * reação falhar não muda nada). Erro (`null`, 4xx, 5xx) responde a frase fixa
 * `TEXTO_AVISO_ERRO`, sem reação e sem afirmar que algo aconteceu.
 */

export const TEXTO_AVISO_INDISPONIVEL = "Não encontrei esse aviso. Nada foi alterado.";
export const TEXTO_AVISO_EXPIRADO = "Esse aviso expirou. Abra o negócio pelo sistema.";
export const TEXTO_AVISO_JA_FEITO = "Isso já foi feito. 👍";
export const TEXTO_AVISO_ERRO = "Não consegui agora. Nada foi alterado; tente de novo em instantes.";
export const TEXTO_AVISO_SEM_PERMISSAO = "Você não tem essa permissão por aqui. Nada foi alterado.";
const TEXTO_LEMBRETE = "Combinado! Te lembro amanhã às 9h. ⏰";
const TEXTO_REENVIO = "Pronto! Reenviei o link para quem ainda falta preencher. 👍";
const TEXTO_ADIAMENTO = "Pronto! Adiei para amanhã. 📅";
export const TEXTO_FORMULARIO_CONCLUIDO = "Esse formulário já foi preenchido. Nada foi alterado.";
const TEXTO_PROXIMO_PASSO = "Para criar o próximo passo, abra o negócio no sistema.";

/** Depois disso o aviso expira (o negócio já pode ter mudado). */
export const AVISO_VALIDADE_MS = 72 * 60 * 60 * 1000;
const HORA_DO_LEMBRETE = 9;

const ACOES = ACOES_AVISO.join("|");
const PAYLOAD = new RegExp(`^av:([A-Za-z0-9_-]{1,64}):(?:item:([^:\\s]{1,128})|(${ACOES}))$`);

export interface PayloadDeAviso {
  rowId: string;
  /** Botão: a ação. Lista: `null` (a ação sai do `alvoId`). */
  acao: AcaoAviso | null;
  /** Só na lista: o `alvoId` da ação tocada. */
  alvoId: string | null;
}

export function ehPayloadDeAviso(payload: string | null | undefined): boolean {
  return typeof payload === "string" && payload.startsWith(PREFIXO_AVISO);
}

/** `null` = malformado ou ação fora do enum. */
export function parsePayloadDeAviso(payload: string | null | undefined): PayloadDeAviso | null {
  if (typeof payload !== "string") return null;
  const m = PAYLOAD.exec(payload);
  if (!m) return null;
  return { rowId: m[1]!, acao: (m[3] as AcaoAviso | undefined) ?? null, alvoId: m[2] ?? null };
}

/** O que o roteador precisa da linha da outbox. */
export interface LinhaDoAviso {
  id: string;
  org_id: string;
  phone: string;
  audience: string;
  status: string;
  deal_id: string | null;
  sent_at: Date | string | null;
  aviso: Aviso | null;
  // Para copiar a linha no lembrete.
  recipient_name: string;
  title: string;
  body: string;
  link_url: string | null;
  org_name: string;
  kind: string | null;
  params: Record<string, string> | null;
}

/** Acesso ao banco, injetável para o teste unitário. */
export interface DadosDoAviso {
  carregar(rowId: string): Promise<LinhaDoAviso | null>;
  /** `true` = este toque pode agir; `false` = já foi feito por outra mensagem. */
  reivindicar(rowId: string, acao: AcaoAviso, messageId: string): Promise<boolean>;
  liberar(rowId: string, acao: AcaoAviso, messageId: string): Promise<void>;
}

export const dadosDoAviso: DadosDoAviso = {
  async carregar(rowId) {
    const rows = await query<LinhaDoAviso & Record<string, unknown>>(
      `SELECT id, org_id, phone, audience, status, deal_id, sent_at, aviso,
              recipient_name, title, body, link_url, org_name, kind, params
         FROM outbox WHERE id = $1`,
      [rowId]
    );
    return rows[0] ?? null;
  },
  async reivindicar(rowId, acao, messageId) {
    // Mesma mensagem de novo (reentrega do webhook) também passa: o efeito é idempotente pela chave.
    const rows = await query<{ message_id: string }>(
      `INSERT INTO aviso_toque (row_id, acao, message_id) VALUES ($1, $2, $3)
       ON CONFLICT (row_id, acao) DO UPDATE SET message_id = aviso_toque.message_id
         WHERE aviso_toque.message_id = EXCLUDED.message_id
       RETURNING message_id`,
      [rowId, acao, messageId]
    );
    return rows.length > 0;
  },
  async liberar(rowId, acao, messageId) {
    await query(`DELETE FROM aviso_toque WHERE row_id = $1 AND acao = $2 AND message_id = $3`, [rowId, acao, messageId]);
  },
};

export interface DepsDoAviso {
  executar: typeof executarAcao;
  enfileirar: typeof enqueue;
  reagir: typeof sendReaction;
  rotearAtividade: typeof rotearBotaoDeAtividade;
  /** Padrão: o banco. */
  dados?: DadosDoAviso;
}

const COM_LINK: ReadonlySet<AcaoAviso> = new Set(["abrir", "ver_formulario", "ver_proposta"]);
const COM_TRAVA: ReadonlySet<AcaoAviso> = new Set(["reenviar_link", "adiar_1d", "lembrar_amanha"]);

function resposta(reply: string, evento: string): RespostaDoBotao {
  return { reply, fluxo: null, evento: `aviso_botao_${evento}` };
}

function instante(v: Date | string | null): number | null {
  if (v === null) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export async function rotearBotaoDeAviso(params: {
  payload: string;
  inbound: InboundMessage;
  identity: Candidate;
  ctx: ContextoDoTurno;
  deps: DepsDoAviso;
  /** `activity.get` do servidor, repassado ao roteador de atividade (`concluir`/`criar_atividade`). */
  ler: LeitorDeAtividade;
  /**
   * Resposta de "termine o pedido em andamento", quando há escrita aberta. Vale só para as ações
   * que abrem fluxo (`concluir`/`criar_atividade`); as diretas não mexem no fluxo aberto.
   */
  ocupado?: string;
}): Promise<RespostaDoBotao> {
  const { payload, inbound, identity, ctx, deps } = params;
  const dados = deps.dados ?? dadosDoAviso;

  const parsed = parsePayloadDeAviso(payload);
  if (!parsed) return resposta(TEXTO_AVISO_INDISPONIVEL, "invalido");

  const row = await dados.carregar(parsed.rowId);
  const aviso = row?.aviso ?? null;
  if (
    !row ||
    !aviso ||
    row.audience === "deal_party" ||
    row.status !== "sent" ||
    row.org_id !== identity.orgId ||
    conversationKey(row.phone) !== conversationKey(inbound.fromPhone)
  ) {
    return resposta(TEXTO_AVISO_INDISPONIVEL, "indisponivel");
  }

  const enviadoEm = instante(row.sent_at);
  if (enviadoEm === null) return resposta(TEXTO_AVISO_INDISPONIVEL, "indisponivel");
  if (ctx.agora - enviadoEm > AVISO_VALIDADE_MS) return resposta(TEXTO_AVISO_EXPIRADO, "expirado");

  // Botão: a ação tem de estar no aviso. Lista: a linha tocada é a ação com aquele `alvoId`.
  const item = parsed.acao
    ? aviso.acoes.find((a) => a.id === parsed.acao)
    : aviso.acoes.find((a) => a.alvoId === parsed.alvoId);
  if (!item) return resposta(TEXTO_AVISO_INDISPONIVEL, "acao_fora_do_aviso");
  const acao = item.id;
  const alvoId = item.alvoId ?? null;

  // Links: só devolve o que o próprio aviso já mostrou. Sem escrita, sem trava, sem reação.
  if (COM_LINK.has(acao)) {
    const url = aviso.link?.url ?? row.link_url;
    if (!url) return resposta(TEXTO_AVISO_INDISPONIVEL, "sem_link");
    return resposta(`👉 ${aviso.link?.rotulo ?? "Abrir"}: ${url}`, "link");
  }

  // Próximo passo: nunca escreve (nem política, nem reação). Só leva ao negócio.
  if (acao === "criar_atividade") {
    const url = aviso.link?.url ?? row.link_url;
    if (!url) return resposta(TEXTO_AVISO_INDISPONIVEL, "sem_link");
    return resposta(`${TEXTO_PROXIMO_PASSO}\n👉 Abrir negócio: ${url}`, "proximo_passo");
  }

  // Concluir: o fluxo de atividades de hoje (resumo, SIM, chave do SIM).
  if (acao === "concluir") {
    if (!alvoId) return resposta(TEXTO_AVISO_INDISPONIVEL, "sem_alvo");
    if (params.ocupado) return resposta(params.ocupado, "ocupado");
    return deps.rotearAtividade({
      payload: `atv:${alvoId}:concluir`,
      ctx,
      identity,
      ler: params.ler,
    });
  }

  // Daqui em diante: ações com efeito. `lembrar_amanha` só escreve na própria outbox;
  // as demais mexem no negócio e exigem usuário com a permissão.
  if (acao !== "lembrar_amanha") {
    if (!podeEscrever(identity)) return resposta(TEXTO_AVISO_INDISPONIVEL, "sem_login");
    if (ctx.politicaIndisponivel) return resposta(TEXTO_AVISO_ERRO, "politica_indisponivel");
    const capacidade = acao === "reenviar_link" ? "form.create" : "activity.write";
    if (!ctx.policy.includes(capacidade)) return resposta(TEXTO_AVISO_SEM_PERMISSAO, "sem_politica");
    if (!alvoId || (acao === "reenviar_link" && !row.deal_id)) {
      return resposta(TEXTO_AVISO_INDISPONIVEL, "sem_alvo");
    }
  }

  const travada = COM_TRAVA.has(acao);
  if (travada && !(await dados.reivindicar(row.id, acao, inbound.messageId))) {
    return resposta(TEXTO_AVISO_JA_FEITO, "ja_feito");
  }

  let reply: string;
  let ok = false;
  try {
    if (acao === "lembrar_amanha") {
      await deps.enfileirar({
        orgId: row.org_id,
        dedupeKey: `lembrete:${row.id}`,
        audience: row.audience,
        phone: row.phone,
        recipientName: row.recipient_name,
        title: row.title,
        body: row.body,
        linkUrl: row.link_url,
        dealId: row.deal_id,
        orgName: row.org_name,
        kind: row.kind,
        params: row.params,
        aviso,
        deliverAfter: amanhaAs(HORA_DO_LEMBRETE, new Date(ctx.agora)),
      });
      ok = true;
      reply = TEXTO_LEMBRETE;
    } else {
      const direta =
        acao === "reenviar_link"
          ? { verb: "form.remind" as const, args: { deal_id: row.deal_id, form_id: alvoId }, texto: TEXTO_REENVIO }
          : { verb: "activity.postpone" as const, args: { atividade_id: alvoId, dias: 1 }, texto: TEXTO_ADIAMENTO };
      const res = await deps.executar({
        orgId: identity.orgId,
        rawPhone: inbound.fromPhone,
        subject: subjectDe(identity),
        verb: direta.verb,
        args: direta.args,
        // Fixa por aviso e ação: o toque repetido depois de um erro incerto não duplica o efeito.
        idempotencyKey: `${PREFIXO_AVISO}${row.id}:${acao}`,
      });
      if (acao === "reenviar_link" && res?.status === 409 && (res.body as { reason?: unknown } | null)?.reason === "concluido") {
        // Definitivo: mantém a trava e não reage.
        return resposta(TEXTO_FORMULARIO_CONCLUIDO, "reenviar_link_concluido");
      }
      ok = !!res && res.status >= 200 && res.status < 300;
      reply = ok ? direta.texto : TEXTO_AVISO_ERRO;
    }
  } catch {
    ok = false;
    reply = TEXTO_AVISO_ERRO;
  }

  if (!ok) {
    // Libera para o toque seguinte tentar de novo; falhar em liberar não pode esconder o erro.
    if (travada) await dados.liberar(row.id, acao, inbound.messageId).catch(() => undefined);
    return resposta(TEXTO_AVISO_ERRO, `${acao}_erro`);
  }

  // Cortesia: o ✅ no toque. Nunca lança (o transporte devolve false) e nunca atrasa a resposta de texto.
  await deps.reagir({ to: inbound.fromPhone, messageId: inbound.messageId, emoji: "✅" }).catch(() => false);
  return resposta(reply, acao);
}
