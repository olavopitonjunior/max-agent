import { query } from "./db";
import { nextDeliveryTime } from "./window";

/**
 * Reprocesso de notificações que FALHARAM POR CULPA DO CANAL.
 *
 * ── Por que existe ────────────────────────────────────────────────────────
 *
 * Em 10/09 a assinatura da Z-API foi cancelada por cobrança recusada. O
 * `/status` passou a responder 400 "must subscribe", que na época era
 * exceção → fail-open → o outbox tentou enviar, o `send-text` recusou com o
 * mesmo 400, três tentativas queimaram em segundos e 16 linhas viraram
 * `failed` — que é TERMINAL: nada as revisita quando o canal volta.
 *
 * O `dispatchDue` de hoje represa em vez de tentar (e devolve a tentativa
 * quando o envio é recusado), então o caso novo não acontece mais. Este
 * módulo é para o que JÁ está `failed` por esse motivo: devolve as linhas a
 * `pending` para o cron despachar pelo caminho normal — janela 7h–22h, claim,
 * marcador de envio, tudo.
 *
 * ── Módulo próprio, e não função no `outbox.ts` ──────────────────────────
 *
 * O `outbox.ts` importa o grafo (para semear thread), e o grafo importa o
 * checkpointer e o cliente de LLM. O script de linha de comando que chama
 * isto não precisa de nada disso — e carregar tudo para um UPDATE é onde um
 * import com efeito colateral vira surpresa.
 *
 * ── Cortes, todos deliberados ─────────────────────────────────────────────
 *
 *  · **por causa**: só `failed` cujo `last_error` é reconhecidamente do canal
 *    — e o corte é no SQL, antes do `LIMIT`, senão cem falhas de número
 *    inválido esgotariam o teto e esconderiam as linhas certas (achado do
 *    code review);
 *  · **por idade**: `desde` é obrigatório. Reprocessar sem corte ressuscita
 *    "formulário concluído" de semanas atrás no WhatsApp de cliente real;
 *  · **por exclusão**: `exceto` tira linhas de teste ("TESTE —") ou de uma org;
 *  · **por teto**: `limite` de linhas por execução;
 *  · **dry-run por padrão**: `apply: false` só lista. Este módulo roda contra
 *    PRODUÇÃO (o `.env.local` do max-agent aponta para lá).
 */

/**
 * O que o `send-text` devolve quando a assinatura caiu (o texto exato das 16
 * linhas de 10/09) e quando a credencial está errada. Reconhecidos pelo ERRO
 * DE ENVIO: as linhas que este módulo existe para salvar nunca passaram por
 * carimbo nenhum — o `dispatchDue` de hoje não deixa mais uma linha chegar a
 * `failed` por esse caminho. Regex do Postgres (`~*`), não de JS.
 */
const PADROES_DE_CANAL_SQL: string[] = [
  "Z-API /send-text 400: .*subscri",
  "Z-API /send-text 40[13]:",
];

export interface ReprocessoParams {
  /** `false` só lista. */
  apply: boolean;
  /** Só linhas criadas a partir daqui. Obrigatório, sem default — ver acima. */
  desde: Date;
  /** Substring que, presente em `title`, `body` ou `org_name`, EXCLUI a linha. */
  exceto?: string;
  /** Teto de linhas candidatas (já filtradas por causa e idade). */
  limite?: number;
}

export interface LinhaCandidata {
  id: string;
  org_name: string;
  title: string;
  created_at: Date;
  last_error: string | null;
  /** Bateu no `exceto`: listada, mas não reprocessada. */
  excluida: boolean;
}

export interface ReprocessoResult {
  candidatas: LinhaCandidata[];
  /** Ids efetivamente devolvidos a `pending` (vazio no dry-run). */
  reprocessadas: string[];
  /** Quando as linhas voltam a vencer — respeita a janela 7h–22h. */
  deliverAfter: Date;
  /** O `LIMIT` cortou: há mais candidatas além das listadas. */
  truncado: boolean;
}

export async function reprocessarFalhasDeCanal(
  p: ReprocessoParams
): Promise<ReprocessoResult> {
  const limite = p.limite ?? 100;
  const deliverAfter = nextDeliveryTime();

  // `limite + 1` só para saber se cortou — a última é descartada.
  const rows = await query<{
    id: string;
    org_name: string;
    title: string;
    body: string;
    created_at: Date;
    last_error: string | null;
  }>(
    `SELECT id, coalesce(org_name, '') AS org_name, coalesce(title, '') AS title,
            coalesce(body, '') AS body, created_at, last_error
       FROM outbox
      WHERE status = 'failed'
        AND created_at >= $1
        AND last_error ~* ANY($3::text[])
      ORDER BY created_at
      LIMIT $2`,
    [p.desde, limite + 1, PADROES_DE_CANAL_SQL]
  );
  const truncado = rows.length > limite;
  if (truncado) rows.pop();

  const exceto = p.exceto?.trim();
  const candidatas: LinhaCandidata[] = rows.map((r) => ({
    id: r.id,
    org_name: r.org_name,
    title: r.title,
    created_at: r.created_at,
    last_error: r.last_error,
    excluida: Boolean(
      exceto &&
        (r.title.includes(exceto) || r.body.includes(exceto) || r.org_name.includes(exceto))
    ),
  }));

  const alvo = candidatas.filter((c) => !c.excluida).map((c) => c.id);
  if (!p.apply || alvo.length === 0) {
    return { candidatas, reprocessadas: [], deliverAfter, truncado };
  }

  /**
   * `AND status = 'failed'` de novo no UPDATE: entre o SELECT e aqui o cron
   * não toca em `failed`, mas alguém pode ter rodado este mesmo script em
   * paralelo. `attempts = 0` porque as três tentativas anteriores não
   * disseram nada sobre a mensagem; `send_started_at = NULL` já é o estado de
   * uma falha registrada, reafirmado para a retomada de órfã não a liquidar
   * como enviada.
   *
   * `reported_at`/`report_attempts` zerados: a reconciliação (`delivery.ts`)
   * já REPORTOU esta linha ao ImobPro como `failed` e carimbou `reported_at`
   * — sem zerar, o `sent` que vem depois nunca seria reportado de novo e o
   * ImobPro mostraria "falhou" para uma mensagem que chegou (achado do code
   * review).
   *
   * O `last_error` guarda o motivo original — é a trilha de por que esta
   * linha voltou. O carimbo de represamento do `dispatchDue` não passa por
   * cima dela, de propósito.
   */
  const feitas = await query<{ id: string }>(
    `UPDATE outbox
        SET status = 'pending',
            attempts = 0,
            send_started_at = NULL,
            reported_at = NULL,
            report_attempts = 0,
            deliver_after = $2,
            last_error = 'reprocessada em ' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                         || ' após queda de canal; erro original: ' || left(coalesce(last_error, ''), 200)
      WHERE id = ANY($1::text[]) AND status = 'failed'
  RETURNING id`,
    [alvo, deliverAfter]
  );

  return { candidatas, reprocessadas: feitas.map((f) => f.id), deliverAfter, truncado };
}
