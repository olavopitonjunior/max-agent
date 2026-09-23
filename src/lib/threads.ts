import { query } from "./db";
import { maskPhone, phoneTag } from "./phone";

/**
 * Conversas agrupadas por pessoa — o que o painel de conversas (Fase 4) lê.
 *
 * O `/admin/conversations` devolve turns soltos, em ordem de tempo, e serve
 * para investigar. O painel precisa de outra forma: **uma linha por pessoa**,
 * e ao abrir, a linha do tempo dela juntando o que ela disse, o que o Max
 * respondeu e os avisos que o sistema mandou.
 *
 * ── A thread é (org, telefone), nunca só telefone ─────────────────────────
 *
 * Um mesmo número pode conversar com o Max em duas orgs (corretor que atende
 * duas imobiliárias). Por isso TODA leitura de `conversation_turn` e `outbox`
 * filtra `org_id`, e não só a resolução da chave: se só a resolução filtrasse,
 * o admin da org A abriria a thread de um telefone que existe em A e veria os
 * turns que o mesmo número teve em B. O teste "mesmo telefone em duas orgs"
 * existe por isso.
 *
 * `inbound_queue` e `conversation_window` não têm `org_id`. A fila só entra por
 * `message_id` de turns JÁ filtrados. A janela 24h é do NÚMERO, e o nome do
 * campo diz isso (`janelaDoNumeroAberta`): se a pessoa falou com o Max pela
 * org B, a janela está aberta também para um aviso da org A. É assim que a
 * Meta conta, então é o dado certo, mas não é um fato da org.
 *
 * ── A chave pública é o `phoneTag`, nunca o telefone ──────────────────────
 *
 * A URL da thread atravessa navegador, log de proxy e histórico. O telefone
 * mascarado não serve de chave (colide), e o cru não pode sair. O `phoneTag` é
 * HMAC, estável e irreversível sem o segredo; a resolução é o caminho inverso
 * FEITO AQUI, calculando a tag sobre os telefones da org e comparando. Tag de
 * outra org e tag inexistente caem no mesmo "não achei", de propósito: um 403
 * diria "essa pessoa existe em outro lugar".
 */

/**
 * Teto de threads que a lista considera. Com `orgId`, é por org; no
 * `scope=all` do super-admin, é o teto da lista INTEIRA (as mais recentes de
 * todas as orgs), e uma org pouco ativa pode ficar de fora. O `truncado` da
 * resposta avisa; o super-admin que procura uma org específica filtra por ela.
 */
export const MAX_THREADS_NA_LISTA = 2000;

export interface ThreadResumo {
  key: string;
  orgId: string;
  phone: string;
  nome: string | null;
  /**
   * ISO UTC com microssegundos, largura fixa: compara como texto na ordem do
   * tempo, e não perde a fração que desempata o cursor.
   */
  ultimaEm: string;
  turns: number;
  avisos: number;
  temErro: boolean;
  ultimaPrevia: string | null;
  janelaDoNumeroAberta: boolean;
}

interface LinhaThread extends Record<string, unknown> {
  org_id: string;
  phone: string;
  ultima_em: string;
  turns: string;
  avisos: string;
  tem_erro: boolean;
  ultima_previa: string | null;
  nome_inbound: string | null;
  nome_aviso: string | null;
  janela_em: string | null;
}

/** O resumo mais os dígitos do telefone, só para o filtro `q`. Nunca sai. */
export type ThreadInterna = ThreadResumo & { digitos: string };

const JANELA_MS = 24 * 60 * 60 * 1000;

/**
 * Lista de threads de uma org (ou de todas, com `orgId = null`).
 *
 * Agrega no banco e pagina em memória. A paginação não pode ser no SQL porque o
 * cursor não pode carregar o telefone (é a chave pública, a tag), e a tag só
 * existe depois do HMAC, fora do banco. O volume cabe: uma org tem dezenas a
 * centenas de pessoas, e o teto `MAX_THREADS_NA_LISTA` impede que um dia vire
 * dump. Passou do teto, a resposta diz (`truncado`), e aí é hora de uma coluna
 * de tag no banco.
 */
export async function listarThreads(orgId: string | null): Promise<{
  threads: ThreadInterna[];
  truncado: boolean;
}> {
  const linhas = await query<LinhaThread>(
    `WITH ev AS (
       SELECT t.org_id, t.phone, t.created_at, t.id::text AS id,
              1 AS eh_turn,
              (t.error IS NOT NULL) AS erro,
              COALESCE(t.reply_text, t.inbound_text) AS previa,
              iq.sender_name AS nome_inbound,
              NULL::text AS nome_aviso
         FROM conversation_turn t
         LEFT JOIN inbound_queue iq ON iq.message_id = t.message_id
        WHERE ($1::text IS NULL OR t.org_id = $1)
       UNION ALL
       SELECT o.org_id, o.phone, o.created_at, o.id,
              0,
              (o.status IN ('failed', 'dropped') OR o.delivery_status = 'failed'),
              NULLIF(o.title, ''),
              NULL,
              NULLIF(o.recipient_name, '')
         FROM outbox o
        WHERE ($1::text IS NULL OR o.org_id = $1)
     )
     SELECT ev.org_id, ev.phone,
            to_char(max(ev.created_at) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ultima_em,
            sum(ev.eh_turn)::text AS turns,
            sum(1 - ev.eh_turn)::text AS avisos,
            bool_or(ev.erro) AS tem_erro,
            (array_agg(ev.previa ORDER BY ev.created_at DESC, ev.id DESC)
               FILTER (WHERE ev.previa IS NOT NULL))[1] AS ultima_previa,
            (array_agg(ev.nome_inbound ORDER BY ev.created_at DESC, ev.id DESC)
               FILTER (WHERE ev.nome_inbound IS NOT NULL))[1] AS nome_inbound,
            (array_agg(ev.nome_aviso ORDER BY ev.created_at DESC, ev.id DESC)
               FILTER (WHERE ev.nome_aviso IS NOT NULL))[1] AS nome_aviso,
            cw.last_inbound_at::text AS janela_em
       FROM ev
       LEFT JOIN conversation_window cw ON cw.phone = ev.phone
      GROUP BY ev.org_id, ev.phone, cw.last_inbound_at
      ORDER BY max(ev.created_at) DESC
      LIMIT $2`,
    [orgId, MAX_THREADS_NA_LISTA + 1]
  );

  const truncado = linhas.length > MAX_THREADS_NA_LISTA;
  const agora = Date.now();
  const threads = linhas.slice(0, MAX_THREADS_NA_LISTA).map((l): ThreadInterna => ({
    key: phoneTag(l.phone),
    orgId: l.org_id,
    phone: maskPhone(l.phone),
    // O aviso tem o nome do cadastro no ImobPro; o inbound, o do perfil do
    // WhatsApp. O do cadastro ganha: é o que o admin reconhece.
    nome: l.nome_aviso ?? l.nome_inbound,
    ultimaEm: l.ultima_em,
    turns: Number(l.turns),
    avisos: Number(l.avisos),
    temErro: l.tem_erro,
    ultimaPrevia: previa(l.ultima_previa),
    janelaDoNumeroAberta:
      l.janela_em !== null && agora - Date.parse(l.janela_em) < JANELA_MS,
    digitos: l.phone.replace(/\D/g, ""),
  }));

  return { threads, truncado };
}

/** Prévia curta: a lista não é lugar de ler a conversa inteira. */
function previa(texto: string | null): string | null {
  if (!texto) return null;
  const limpo = texto.replace(/\s+/g, " ").trim();
  return limpo.length > 120 ? `${limpo.slice(0, 119)}…` : limpo;
}

function semAcento(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Busca: 4 dígitos ou mais casam com o FINAL do telefone; texto casa com o nome.
 *
 * Final, e não "contém": os 4 finais são o que a tela mostra, então é o que o
 * admin tem na mão. "Contém" com 4 dígitos casaria meio mundo pelo DDD.
 * Menos de 4 dígitos é recusado (400 na rota): com 1-3 dígitos, a busca vira um
 * jeito de enumerar os números por tentativa.
 */
export type Busca =
  | { tipo: "digitos"; valor: string }
  | { tipo: "nome"; valor: string };

export function interpretarBusca(q: string): Busca | "invalida" | null {
  const t = q.trim();
  if (!t) return null;
  if (/^[\d\s()+-]+$/.test(t)) {
    const d = t.replace(/\D/g, "");
    return d.length >= 4 ? { tipo: "digitos", valor: d } : "invalida";
  }
  return t.length >= 2 ? { tipo: "nome", valor: semAcento(t) } : "invalida";
}

export function filtrarThreads(threads: ThreadInterna[], busca: Busca | null): ThreadInterna[] {
  if (!busca) return threads;
  return threads.filter((t) => {
    if (busca.tipo === "digitos") return t.digitos.endsWith(busca.valor);
    return t.nome !== null && semAcento(t.nome).includes(busca.valor);
  });
}

/** Tira o campo interno antes de responder. */
export function paraResposta({ digitos: _omitido, ...resto }: ThreadInterna): ThreadResumo {
  return resto;
}

/**
 * Tag → telefone, DENTRO da org. `null` = não existe nesta org (e o chamador
 * não pode distinguir de "não existe em lugar nenhum").
 */
export async function resolverTelefone(orgId: string, key: string): Promise<string | null> {
  if (!/^tel_[0-9a-f]{12}$/.test(key)) return null;
  const linhas = await query<{ phone: string }>(
    `SELECT phone FROM conversation_turn WHERE org_id = $1
     UNION
     SELECT phone FROM outbox WHERE org_id = $1`,
    [orgId]
  );
  return linhas.find((l) => phoneTag(l.phone) === key)?.phone ?? null;
}

/**
 * `em` é o `created_at` em ISO UTC com microssegundos. O cursor sai dele: o
 * ISO do JavaScript corta em milissegundos, e um cursor truncado pula as
 * linhas que caem entre o corte e o valor real.
 */
export interface EventoLinhaDoTempo extends Record<string, unknown> {
  id: string;
  origem: "turn" | "aviso";
  em: string;
}

/**
 * Linha do tempo de uma thread: turns e avisos da org, do mais recente para
 * trás, paginada por `(created_at, id)` como o `/admin/conversations` (o `id`
 * desempata instante repetido; ver lá o porquê).
 *
 * `id` é comparado como texto porque as duas tabelas têm tipos diferentes
 * (uuid × text). A ordem só precisa ser total e estável, não "natural".
 */
export async function linhaDoTempo(
  orgId: string,
  phone: string,
  cursor: { ts: string; id: string } | null,
  limite: number
): Promise<EventoLinhaDoTempo[]> {
  return query<EventoLinhaDoTempo>(
    `SELECT * FROM (
     SELECT ev0.*,
            to_char(ev0.created_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS em
       FROM (
       SELECT t.id::text AS id, 'turn' AS origem, t.created_at,
              t.message_id, t.kind, t.inbound_text, t.transcript, t.reply_text,
              t.tools_json, t.usage_json, t.latency_ms, t.error,
              iq.reply_delivery_status, iq.reply_delivered_at::text AS reply_delivered_at,
              iq.reply_read_at::text AS reply_read_at,
              NULL::text AS titulo, NULL::text AS corpo, NULL::text AS link_url,
              NULL::text AS aviso_kind, NULL::text AS template_name,
              NULL::text AS status, NULL::text AS delivery_status,
              NULL::int AS error_code, NULL::text AS last_error,
              NULL::text AS sent_at, NULL::text AS delivered_at, NULL::text AS read_at,
              NULL::text AS clicked_at, NULL::text AS deal_id
         FROM conversation_turn t
         LEFT JOIN inbound_queue iq ON iq.message_id = t.message_id
        WHERE t.org_id = $1 AND t.phone = $2
       UNION ALL
       SELECT o.id, 'aviso', o.created_at,
              NULL, NULL, NULL, NULL, NULL,
              NULL, NULL, NULL, NULL,
              NULL, NULL, NULL,
              o.title, o.body, o.link_url,
              o.kind, o.template_name,
              o.status, o.delivery_status,
              o.error_code, o.last_error,
              o.sent_at::text, o.delivered_at::text, o.read_at::text,
              o.clicked_at::text, o.deal_id
         FROM outbox o
        WHERE o.org_id = $1 AND o.phone = $2
     ) ev0
     ) ev
     WHERE ($3::timestamptz IS NULL OR (ev.created_at, ev.id) < ($3::timestamptz, $4::text))
     ORDER BY ev.created_at DESC, ev.id DESC
     LIMIT $5`,
    [orgId, phone, cursor?.ts ?? null, cursor?.id ?? null, limite]
  );
}
