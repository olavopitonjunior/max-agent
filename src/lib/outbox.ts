import { randomUUID } from "node:crypto";
import { query } from "./db";
import { nextDeliveryTime } from "./window";
import { sendText, sendTemplate, connectionStatus, provider, type ConnectionState } from "./transport";
import { janelaAberta } from "./janela24h";
import { seedNotification } from "@/graph/graph";
import { log } from "./log";
import { resolveIdentity } from "./identity";
import {
  inoperanciaDoErro,
  falhaDaMensagemMeta,
  MetaHttpError,
  type Inoperancia,
} from "./transport/erro";
import {
  KINDS_COM_ACEITE,
  botoesEmOrdem,
  templatesDoKind,
  templateUsavel,
  parametroObrigatorioFaltando,
  parametrosDoCorpo,
  type TemplateDef,
} from "./templates/catalog";
import type { BotaoEnviado } from "./transport";
import { templatesAprovados } from "./templates/aprovacao";

/**
 * Prefixos de `last_error` que significam "o CANAL estava fora, a mensagem não
 * tem defeito". Constantes porque quem carimba (aqui) e quem lê a tabela à mão
 * precisam concordar.
 */
export const MARCA_CANAL_DESEMPARELHADA = "instancia z-api desemparelhada";
export const MARCA_CANAL_INOPERANTE = "instancia z-api inoperante";
/** Meta: fora da janela de 24h, texto livre não sai — espera template. */
export const MARCA_REQUER_TEMPLATE = "requer_template: fora da janela de 24h da Meta";
/**
 * Janela fechada E o template deste `kind` ainda não está `APPROVED` em
 * `wa_template` (submissão pendente, rejeitada, ou nem submetida). Marcador
 * PRÓPRIO, distinto de `MARCA_REQUER_TEMPLATE`: aqui a mensagem tem template
 * definido no catálogo, só falta a Meta aprovar — o painel e o alerta podem
 * dar um conselho diferente ("aguarde a aprovação") de "escreva pra pessoa".
 */
/**
 * Janela fechada e o `kind` está FORA DA RÉGUA — não tem template (régua do
 * Olavo, 01/10/2026). Terminal: esperar não resolve, e represar para sempre
 * era o defeito do genérico. O aviso já foi por e-mail; pelo WhatsApp só
 * sairia como texto livre, e a pessoa não falou com o Max nas últimas 24h.
 */
export const MARCA_FORA_DA_REGUA =
  "fora_da_regua: tipo sem template e janela de 24h fechada — não enviado";

/**
 * Igual ao `fora_da_regua` acima — falha terminal, janela fechada, nenhum
 * template usável — mas a causa é outra: o `kind` TEM template(s), só que
 * nenhum candidato tem o parâmetro obrigatório desta linha (`paramsObrigatorios`
 * em `templates/catalog.ts`). Marca PRÓPRIA, com o nome do parâmetro, porque o
 * conselho é diferente: aqui falta o EMISSOR mandar o `params`, não aprovar
 * template nenhum. Hoje é o caso das notificações de proposta — o
 * contractmaker ainda não manda `proposta`/`quem` (PR separado).
 */
export function marcaParametroAusente(param: string): string {
  return `parametro_ausente: ${param} — falta o parâmetro obrigatório do template, não enviado`;
}

/**
 * Botões na ordem do template, preenchidos para ESTA linha. O id da linha é o
 * que o redirecionador `/r/<id>` resolve e o que volta no payload do toque.
 */
export function botoesDaLinha(def: TemplateDef, rowId: string): BotaoEnviado[] {
  return botoesEmOrdem(def.botao).map((b) => {
    if (b.tipo === "url") return { tipo: "url", param: rowId };
    if (b.tipo === "quick_reply") return { tipo: "quick_reply", payload: `${b.prefixo}:${rowId}` };
    // `quick_reply_acao`: o payload que o toque devolve no webhook
    // (`acao:<id>:<ação>`, interceptado em `lib/aceite.ts`).
    return { tipo: "quick_reply", payload: `acao:${rowId}:${b.acao}` };
  });
}

/** A Meta recusou o template na hora do envio (132xxx: parâmetro, pausa…). */
export const MARCA_TEMPLATE_INVALIDO = "template_invalido: a Meta recusou o template no envio";

export const MARCA_TEMPLATE_PENDENTE =
  "template_pendente: sem template aprovado para este tipo — aguardando aprovação da Meta";

/**
 * Represado há mais de `HORAS_PARA_EXPIRAR` sem template aprovado: vira
 * `dropped` e não sai mais (decisão do Olavo, 05/10/2026). Antes ficava
 * pendente sem prazo e, quando a Meta aprovava dias depois, saía tudo de uma
 * vez — inclusive aviso de algo que já tinha acontecido.
 */
export const HORAS_PARA_EXPIRAR = 72;
export const MARCA_EXPIRADO =
  `expirado: ${HORAS_PARA_EXPIRAR}h sem template aprovado fora da janela de 24h — não enviado`;

/**
 * Timeout no envio de TEMPLATE: a Meta pode ter aceitado e só a resposta
 * demorou. Reenviar arriscava a pessoa receber o aviso duas vezes, pago em
 * dobro; a decisão do Olavo (05/10/2026) é não duplicar.
 *
 * Liquida como a órfã com envio iniciado: `sent`, sem `wamid`, com esta marca
 * à vista. `failed` seria pior nas duas pontas — o OK de uma mensagem que
 * chegou não acharia o texto (o aceite só entrega `sent`), e o ImobPro
 * mostraria "falhou" e convidaria a reenviar. Sem o `wamid` o webhook de
 * entrega não acha a linha; a reconciliação a marca `unconfirmed`, que é a
 * verdade.
 */
export const MARCA_ENVIO_INCERTO =
  "envio_incerto: timeout no envio do template — não reenviado para não duplicar";

/**
 * Fila de saída das notificações proativas.
 *
 * Existe porque o ImobPro passou a entregar a qualquer hora: os call-sites de
 * lá só checam a janela 7h–22h no caminho do Newton, que não tem fila. Aqui, a
 * mensagem fora da janela é AGENDADA, não descartada — antes disso, tudo que
 * nascia de madrugada no motor de deal-events era perdido em silêncio.
 */

export interface EnqueueParams {
  orgId: string;
  dedupeKey: string;
  audience: string;
  phone: string;
  recipientName: string;
  title: string;
  body: string;
  linkUrl: string | null;
  dealId: string | null;
  orgName: string;
  /** Tipo da notificação (ver migration 016). Sem template no catálogo = fora da régua. */
  kind?: string | null;
  /** Variáveis do template, já limpas pelo /notify. */
  params?: Record<string, string> | null;
}

export type EnqueueResult =
  | { status: "queued"; id: string; deliverAfter: Date }
  | { status: "duplicate"; id: string };

export async function enqueue(p: EnqueueParams): Promise<EnqueueResult> {
  const id = randomUUID();
  const deliverAfter = nextDeliveryTime();

  // `ON CONFLICT DO NOTHING` + RETURNING: a linha só volta quando FOI inserida
  // agora. Conflito devolve zero linhas, e aí a chave já existia — que é
  // exatamente a definição de duplicata que o ImobPro espera ver como 409.
  const rows = await query<{ id: string }>(
    `INSERT INTO outbox
       (id, org_id, dedupe_key, audience, phone, recipient_name,
        title, body, link_url, deal_id, org_name, deliver_after, kind, params)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      id,
      p.orgId,
      p.dedupeKey,
      p.audience,
      p.phone,
      p.recipientName,
      p.title,
      p.body,
      p.linkUrl,
      p.dealId,
      p.orgName,
      deliverAfter,
      p.kind ?? null,
      p.params ? JSON.stringify(p.params) : null,
    ]
  );

  if (rows.length === 0) {
    const existing = await query<{ id: string }>(
      `SELECT id FROM outbox WHERE dedupe_key = $1`,
      [p.dedupeKey]
    );
    return { status: "duplicate", id: existing[0]?.id ?? "" };
  }

  return { status: "queued", id, deliverAfter };
}

/**
 * Texto que vai pro WhatsApp.
 *
 * O ImobPro manda título, corpo e link SEPARADOS justamente para que a forma
 * final seja decidida aqui, onde se sabe qual é o transporte. Com Z-API não há
 * template nem limite de variáveis, então dá pra montar algo legível: negrito
 * no título (markdown do WhatsApp), assinatura da imobiliária, link inteiro.
 */
export function renderMessage(row: {
  title: string;
  body: string;
  link_url: string | null;
  org_name: string;
  recipient_name: string;
}): string {
  const first = row.recipient_name.trim().split(/\s+/)[0] ?? "";
  const hello = first ? `Oi, ${first}! ` : "";
  const parts = [`${hello}*${row.title}*`, row.body];
  if (row.link_url) parts.push(row.link_url);
  if (row.org_name) parts.push(`— ${row.org_name}`);
  return parts.filter(Boolean).join("\n\n");
}

export interface DispatchTotals {
  claimed: number;
  sent: number;
  failed: number;
  /**
   * Havia fila mas a instância estava desemparelhada — nada foi tentado.
   *
   * Campo próprio e não `failed`: a diferença é entre "a mensagem tem problema"
   * e "o CANAL está fora". Somar os dois faria uma queda de instância parecer
   * um lote de mensagens ruins, e é a queda que precisa acordar alguém.
   */
  blocked: number;
  /**
   * O `send-text` RECUSOU por assinatura/credencial no meio do despacho —
   * o `/status` tinha dito "conectada" e estava defasado. As linhas voltaram
   * a `pending` sem contar tentativa; quem chama informa a máquina de estado
   * (fonte `envio`).
   */
  inoperante?: Inoperancia;
  /**
   * Linhas que esperam template: provedor Meta, janela de 24h fechada. Não é
   * falha nem queda de canal — a mensagem está boa, só não pode sair como
   * texto livre agora.
   */
  held: number;
  /** Represados que passaram de `HORAS_PARA_EXPIRAR` e viraram `dropped`. */
  expired: number;
}

interface OutboxRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  audience: string;
  phone: string;
  title: string;
  body: string;
  link_url: string | null;
  org_name: string;
  recipient_name: string;
  attempts: number;
  /** O envio COMEÇOU numa tentativa anterior (ver migration 007). */
  send_started_at: string | Date | null;
  /** Tipo da notificação (migration 016). Sem template no catálogo = fora da régua. */
  kind: string | null;
  /** Variáveis do fato, já limpas pelo /notify — jsonb, o driver devolve objeto. */
  params: Record<string, string> | null;
  /** Desfecho da tentativa anterior — diz qual template a Meta acabou de recusar. */
  last_error: string | null;
  /** Quando o aviso nasceu — conta o prazo do represado (`HORAS_PARA_EXPIRAR`). */
  created_at: string | Date;
}

/**
 * Máximo de tentativas antes de desistir. Erro de Z-API costuma ser de rede ou
 * rate limit (transitório) ou número inválido (permanente) — três tentativas
 * separam um do outro sem encher a fila de zumbi.
 */
const MAX_ATTEMPTS = 3;

/**
 * Quanto tempo uma linha pode ficar em `sending` antes de ser considerada
 * órfã. Folga larga sobre o `maxDuration` do cron (60s), pra nunca disputar
 * com uma execução ainda viva.
 */
const SENDING_ORPHAN_MINUTES = 10;

/**
 * Quantas mensagens estão ESPERANDO agora — vencidas e não despachadas.
 *
 * Uma função só, em vez de duas cópias da mesma query: este número aparece em
 * dois lugares que precisam concordar sempre — o `blocked` do despacho e o
 * `represadas` do e-mail de alerta (`lib/connection.ts`). Duas cópias
 * divergiriam no primeiro ajuste de predicado, e o e-mail passaria a dizer um
 * número que o log não confirma.
 *
 * Inclui o órfão em `sending` (execução que morreu entre o claim e o envio)
 * porque ele também está parado esperando, não sendo entregue.
 */
export async function contarVencidas(): Promise<number> {
  const [{ due }] = await query<{ due: number }>(
    `SELECT count(*)::int AS due FROM outbox
      WHERE (status = 'pending' AND deliver_after <= now())
         OR (status = 'sending'
             AND last_attempt_at < now() - ($1 || ' minutes')::interval)`,
    [String(SENDING_ORPHAN_MINUTES)]
  );
  return due;
}

/**
 * Despacha o que está vencido. Chamado pelo cron.
 *
 * **O claim MUDA O ESTADO para `sending`, e é isso que impede o envio duplo.**
 * `FOR UPDATE SKIP LOCKED` sozinho não basta: ele segura o lock só enquanto o
 * statement roda, e como claim e envio são statements separados, entre um e
 * outro a linha voltaria a ficar `pending` e vencida — elegível de novo pra
 * segunda execução do cron. Medido: duas passadas concorrentes despachavam a
 * mesma linha (`attempts` chegava a 2).
 *
 * `sending` é transitório. Quem morrer entre o claim e o envio deixa a linha
 * presa nele — daí a recuperação por `last_attempt_at`, que devolve o órfão ao
 * conjunto reivindicável depois de `SENDING_ORPHAN_MINUTES`.
 *
 * `statusConhecido`: o chamador JÁ perguntou o estado da instância e passa a
 * resposta adiante, para não perguntar duas vezes no mesmo minuto. É o caso do
 * cron, que desde a F7 pergunta SEMPRE (antes só perguntava com fila vencida,
 * e por isso uma queda com a fila vazia era invisível para ele).
 *
 *  - objeto  → usa esta resposta, não chama a Z-API.
 *  - `null`  → o chamador perguntou e a chamada FALHOU. Segue (fail-open),
 *              sem perguntar de novo: repetir a pergunta que acabou de falhar
 *              só gasta o orçamento da function.
 *  - ausente → comportamento antigo, pergunta por conta própria.
 */
/** O que o despacho precisa saber da instância — o `raw` é só para o log. */
type StatusDaInstancia = Pick<ConnectionState, "connected" | "inoperante"> & {
  raw?: unknown;
};

export async function dispatchDue(
  limit = 50,
  statusConhecido?: StatusDaInstancia | null,
  /** `Date.now()` do início da requisição — âncora do prazo de seed. */
  iniciadoEm?: number
): Promise<DispatchTotals> {
  const totals: DispatchTotals = { claimed: 0, sent: 0, failed: 0, blocked: 0, held: 0, expired: 0 };

  /**
   * ── A checagem que faltava ─────────────────────────────────────────────
   *
   * `send-text` numa instância DESEMPARELHADA responde 200 com um `messageId`
   * que nunca chega a lugar nenhum. Sem conferir o estado, a linha virava
   * `sent`, com id de provedor e sem erro — e o log dizia "4 enviadas, 0
   * falhas" enquanto ninguém recebia nada. Aconteceu em 2026-08-04, com quatro
   * mensagens reais.
   *
   * `connectionStatus()` já existia neste arquivo, com um comentário dizendo
   * que era "o ÚNICO jeito de saber se as mensagens estão mesmo saindo", e
   * nunca era chamado.
   *
   * ANTES do claim, de propósito: reivindicar incrementa `attempts`, e uma
   * instância fora do ar por vinte minutos queimaria as três tentativas de toda
   * a fila e marcaria como `failed` mensagens que não têm defeito nenhum.
   *
   * Quando o chamador passa `statusConhecido`, esta pergunta já foi feita lá
   * fora e não se repete — ver o doc do parâmetro.
   */
  const due = await contarVencidas();

  if (due > 0) {
    const status: StatusDaInstancia =
      statusConhecido !== undefined
        ? // `null` = o chamador perguntou e falhou. Fail-open, igual ao catch
          // abaixo: não conseguir PERGUNTAR não é estar desconectado.
          (statusConhecido ?? { connected: true, raw: null })
        : await connectionStatus().catch((err) => {
            // Não conseguir PERGUNTAR não é o mesmo que estar desconectado.
            // Seguir é o comportamento antigo, que ao menos entrega quando
            // está tudo bem.
            console.warn(
              "[outbox] não deu pra checar a instância:",
              err instanceof Error ? err.message : String(err)
            );
            return { connected: true, raw: null };
          });

    if (!status.connected) {
      totals.blocked = due;
      /**
       * Duas causas, dois textos — porque o conselho é diferente:
       *
       *  · desemparelhada: sessão do WhatsApp caiu, repareie por QR;
       *  · INOPERANTE (assinatura/credencial): a Z-API respondeu que NÃO vai
       *    enviar. Até 12/09 isso era exceção e caía no fail-open abaixo — o
       *    `send-text` recusava, três tentativas queimavam e a linha virava
       *    `failed` para sempre, sem alerta. Represar é o comportamento certo
       *    pelo mesmo motivo do desemparelhamento: o problema é do CANAL, e o
       *    canal volta.
       *
       * Ruidoso de propósito: é a única linha que distingue "ninguém tinha o
       * que receber" de "o canal caiu e a fila está represada".
       */
      const inop = status.inoperante;
      console.error(
        (inop
          ? `[outbox] INSTÂNCIA INOPERANTE (${inop.motivo}) — `
          : `[outbox] INSTÂNCIA DESEMPARELHADA — `) +
          `${due} mensagem(ns) represada(s), nada enviado. ` +
          `A fila não é perdida: volta a sair quando a instância voltar. ` +
          `Estado: ${inop ? inop.detalhe : JSON.stringify(status.raw)}`
      );
      /**
       * Carimba o motivo nas linhas vencidas SEM tocar em status nem attempts:
       * quem for olhar a tabela precisa achar a explicação ali, não só no log.
       *
       * `IS DISTINCT FROM`: durante uma queda isto roda a cada minuto, e
       * reescrever o mesmo texto é uma tupla nova por linha por passada. E
       * NUNCA por cima da trilha do reprocesso (`reprocessada em …`): ela é o
       * único rastro de que a linha voltou de `failed`, e o envio bem-sucedido
       * já vai zerar `last_error` depois.
       */
      await query(
        `UPDATE outbox SET last_error = $1
          WHERE status = 'pending' AND deliver_after <= now()
            AND last_error IS DISTINCT FROM $1
            AND (last_error IS NULL OR last_error NOT LIKE 'reprocessada em %')`,
        [
          inop
            ? `${MARCA_CANAL_INOPERANTE} (${inop.motivo}) — nada foi enviado`
            : `${MARCA_CANAL_DESEMPARELHADA} — nada foi enviado`,
        ]
      );
      return totals;
    }
  }

  const rows = await query<OutboxRow>(
    `UPDATE outbox
        SET status = 'sending', attempts = attempts + 1, last_attempt_at = now()
      WHERE id IN (
        SELECT id FROM outbox
         WHERE (status = 'pending' AND deliver_after <= now())
            OR (status = 'sending'
                AND last_attempt_at < now() - ($2 || ' minutes')::interval)
         ORDER BY deliver_after
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, org_id, audience, phone, title, body, link_url, org_name,
                recipient_name, attempts, send_started_at, kind, params, last_error,
                created_at`,
    [limit, String(SENDING_ORPHAN_MINUTES)]
  );
  totals.claimed = rows.length;

  /**
   * Prazo do trabalho OPCIONAL do loop (a semeadura de thread): os envios em
   * si seguem até o fim, mas seed depois do orçamento é pulado — o contexto
   * perdido custa menos que a function morta com linhas presas em `sending`.
   *
   * **Medido do início da REQUISIÇÃO, não daqui**, quando o chamador informa
   * `iniciadoEm`. Desde a F7 o cron gasta tempo antes de chamar esta função —
   * `connectionStatus()` (até 10s) e, na passada da reconexão, um alerta com
   * teto de 25s. Ancorar o prazo no início do despacho ignorava esses 35s e
   * podia somar 75s num `maxDuration` de 60: a function morre no meio do laço
   * e deixa linhas presas em `sending` por 10 minutos, com uma tentativa já
   * queimada — justamente na passada com a maior fila represada.
   */
  const seedDeadline = (iniciadoEm ?? Date.now()) + 40_000;

  for (const [indice, row] of rows.entries()) {
    /**
     * O que saiu no WhatsApp vira turno do assistente no thread — para que
     * "o que é isso?" tenha contexto. DEPOIS do envio, com catch próprio, e
     * SÓ quando o thread certo existe (achados do code review):
     *
     *  - `deal_party` nunca conversa com o Max (identidade `unknown` não abre
     *    thread) — semear criaria checkpoint com PII que nenhum caminho lê,
     *    compacta ou expira.
     *  - Corretor em DUAS orgs com escolha salva na org A: notificação da org
     *    B semeada em `B:fone` nunca seria lida (a conversa dele vive em
     *    `A:fone`) — e semear em `A:fone` misturaria dado da org B no thread
     *    da A, furando o isolamento por construção do thread_id. Só semeia
     *    quando a identidade RESOLVIDA aponta para a MESMA org da notificação.
     *  - Turn em voo no mesmo telefone: o `updateState` é read-copy-write sem
     *    lock — concorrer com um `invoke` pode perder o turno de alguém. O
     *    check de `processing` estreita a janela de ~15s para milissegundos;
     *    o residual é aceito e está documentado aqui.
     */
    const semear = async () => {
      try {
        if (Date.now() > seedDeadline) return;
        if (row.audience === "deal_party") return;
        // Repasse de dúvida: o corpo é a dúvida de OUTRA pessoa — no thread
        // do time viraria contexto que o esquecimento dela não alcança.
        if (row.kind === "support_handoff") return;
        // Saiu como "tem uma mensagem — responda OK": a pessoa ainda não viu
        // o texto, e semeá-lo faria o Max "lembrar" do que não foi entregue.
        if (envioTemplate && row.kind && KINDS_COM_ACEITE.includes(row.kind)) return;

        const identity = await resolveIdentity(row.phone);
        if (identity.kind !== "resolved") return;
        if (identity.candidate.orgId !== row.org_id) return;

        const emVoo = await query<{ um: number }>(
          `SELECT 1 AS um FROM inbound_queue
            WHERE from_phone = $1 AND status = 'processing' LIMIT 1`,
          [row.phone]
        );
        if (emVoo.length > 0) return;

        await seedNotification(row.org_id, row.phone, renderMessage(row));
      } catch (err) {
        console.warn(
          `[outbox] thread não semeado (${row.id}) — o envio ficou de pé:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    };

    /**
     * Órfã COM envio iniciado: a execução anterior morreu entre o `send-text`
     * e o UPDATE final (falha de envio limpa o marcador). Reenviar duplicaria
     * a notificação — liquida como `sent` com a ressalva na linha; a
     * reconciliação de entrega (Fase 4) confirma o desfecho.
     */
    if (row.send_started_at != null) {
      await query(
        `UPDATE outbox
            SET status = 'sent', sent_at = now(),
                last_error = 'envio anterior provavelmente concluído — não reenviado'
          WHERE id = $1`,
        [row.id]
      );
      // SEM semear aqui, de propósito: o caminho normal pode ter semeado antes
      // de a liquidação falhar (seria o segundo turno idêntico no thread), e no
      // caso "falha não registrada" a mensagem nem chegou — semear afirmaria
      // contexto de uma mensagem que não existe. (achado do code review)
      totals.sent += 1;
      continue;
    }

    /**
     * ── Janela de 24h da Meta ──────────────────────────────────────────────
     *
     * Na Cloud API, texto livre fora da janela é aceito com 200 e recusado
     * DEPOIS, no webhook (131047) — a linha viraria `sent` e só então
     * `failed`, queimando uma notificação que um template entregaria. Então
     * pergunta antes: janela fechada, olha se o template do `kind` desta
     * linha já está `APPROVED` (catálogo em `templates/catalog.ts`,
     * aprovação em `templates/aprovacao.ts`) — se estiver, sai por ELE; senão
     * represa com a tentativa devolvida e o motivo à vista no painel. Quem
     * libera é a pessoa escrevendo de novo, a Meta aprovando o template, ou
     * (se nenhum dos dois) o alerta chegando à mão do Olavo. Só vale para a
     * Meta: a Z-API não tem janela.
     */
    let envioTemplate: TemplateDef | null = null;
    if (provider() === "meta" && !(await janelaAberta(row.phone))) {
      const candidatosDoKind = templatesDoKind(row.kind);
      if (candidatosDoKind.length === 0) {
        await query(
          `UPDATE outbox
              SET status = 'failed', last_error = $2, send_started_at = NULL,
                  reported_at = NULL
            WHERE id = $1 AND status = 'sending'`,
          [row.id, MARCA_FORA_DA_REGUA]
        );
        log.info("outbox.fora_da_regua", { rowId: row.id, orgId: row.org_id, kind: row.kind });
        totals.failed += 1;
        continue;
      }
      // Candidatos cujo `paramsObrigatorios` está satisfeito por ESTA linha
      // (`templateUsavel`) — sem isso o template nem entra na disputa por "o
      // aprovado", e NUNCA sai com um fallback genérico (ver `catalog.ts`).
      const candidatos = candidatosDoKind.filter((c) => templateUsavel(c, row));
      if (candidatos.length === 0) {
        const faltando = parametroObrigatorioFaltando(candidatosDoKind[0], row) ?? "?";
        const marca = marcaParametroAusente(faltando);
        await query(
          `UPDATE outbox
              SET status = 'failed', last_error = $2, send_started_at = NULL,
                  reported_at = NULL
            WHERE id = $1 AND status = 'sending'`,
          [row.id, marca]
        );
        log.info("outbox.parametro_ausente", {
          rowId: row.id,
          orgId: row.org_id,
          kind: row.kind,
          param: faltando,
        });
        totals.failed += 1;
        continue;
      }
      // Entre as versões do kind ([v4, v3, v2, v1]), o APROVADO — de preferência o que a Meta não
      // classificou como MARKETING (limite de frequência por pessoa, 131049).
      // O template que a Meta acabou de recusar NESTA linha (marca
      // `template_invalido` com o nome) fica de fora enquanto houver outro:
      // sem isso o v2 pausado se repetia de 5 em 5 minutos com o v1 aprovado
      // ao lado. Fail-closed: erro de leitura = nenhum aprovado.
      let leituraFalhou = false;
      const aprovados = await templatesAprovados(candidatos.map((c) => c.name)).catch((err) => {
        leituraFalhou = true;
        console.warn(
          `[outbox] não deu pra checar aprovação dos templates de ${row.kind}:`,
          err instanceof Error ? err.message : String(err)
        );
        return new Map<string, string>();
      });
      const recusadoAgora = (c: TemplateDef) =>
        !!row.last_error?.startsWith(MARCA_TEMPLATE_INVALIDO) && row.last_error.includes(`, ${c.name})`);
      const usaveis = candidatos.filter((c) => aprovados.has(c.name));
      const semRecusa = usaveis.filter((c) => !recusadoAgora(c));
      const pool = semRecusa.length > 0 ? semRecusa : usaveis;
      const def: TemplateDef | null = pool.find((c) => aprovados.get(c.name) !== "MARKETING") ?? pool[0] ?? null;
      if (!def) {
        const idadeMs = Date.now() - new Date(row.created_at).getTime();
        // Só expira com a leitura de aprovação BEM-SUCEDIDA (falha transitória
        // não é "nenhum aprovado") e nunca a linha que o operador acabou de
        // reprocessar — ela nasce velha de propósito.
        const reprocessada = !!row.last_error?.startsWith("reprocessada em ");
        if (!leituraFalhou && !reprocessada && idadeMs > HORAS_PARA_EXPIRAR * 3_600_000) {
          await query(
            `UPDATE outbox
                SET status = 'dropped', last_error = $2, send_started_at = NULL
              WHERE id = $1 AND status = 'sending'`,
            [row.id, MARCA_EXPIRADO]
          );
          log.info("outbox.expirado", { rowId: row.id, orgId: row.org_id, kind: row.kind });
          totals.expired += 1;
          continue;
        }
        await query(
          `UPDATE outbox
              SET status = 'pending',
                  attempts = GREATEST(attempts - 1, 0),
                  deliver_after = now() + interval '1 hour',
                  last_error = $2
            WHERE id = $1 AND status = 'sending'`,
          [row.id, MARCA_TEMPLATE_PENDENTE]
        );
        log.info("outbox.aguarda_aprovacao_template", {
          rowId: row.id,
          orgId: row.org_id,
          templates: candidatos.map((c) => c.name).join(","),
        });
        totals.held += 1;
        continue;
      }
      envioTemplate = def;
    }

    try {
      // Marcador ANTES do send — é ele que a retomada de órfã consulta acima.
      // O template vai junto: a órfã liquidada como `sent` precisa dizer que
      // saiu por template, senão o OK de uma mensagem da imobiliária não a
      // acha (`lib/aceite.ts` só entrega o que saiu por template). Tentativa
      // que falha deixa o nome da última tentativa; a próxima o sobrescreve.
      await query(
        `UPDATE outbox SET send_started_at = now(), template_name = $2 WHERE id = $1`,
        [row.id, envioTemplate?.name ?? null]
      );
      const res = envioTemplate
        ? await sendTemplate({
            to: row.phone,
            name: envioTemplate.name,
            lang: envioTemplate.lang,
            bodyParams: parametrosDoCorpo(envioTemplate, row),
            botoes: botoesDaLinha(envioTemplate, row.id),
          })
        : await sendText({ to: row.phone, body: renderMessage(row) });
      log.info(envioTemplate ? "outbox.enviado_template" : "outbox.enviado", {
        rowId: row.id,
        orgId: row.org_id,
        phone: row.phone,
        sentMessageId: res.messageId,
        audience: row.audience,
        ...(envioTemplate ? { template: envioTemplate.name } : {}),
      });
      /**
       * O UPDATE final ganha um retry local: falhar AQUI (blip do Neon) com a
       * mensagem já entregue deixaria a linha órfã — e era o reenvio duplicado.
       * Duas tentativas curtas resolvem o blip; se ambas falharem, o marcador
       * acima garante que a retomada não reenvia.
       *
       * `template_name` grava o template com que a linha SAIU (NULL = texto
       * livre) — é o que o painel e a auditoria de custo (Meta cobra
       * template) precisam distinguir.
       */
      const settle = () =>
        query(
          `UPDATE outbox
              SET status = 'sent', sent_at = now(), provider_message_id = $2,
                  template_name = $3, last_error = NULL
            WHERE id = $1`,
          [row.id, res.messageId, envioTemplate?.name ?? null]
        );
      await settle().catch(async () => {
        await new Promise((r) => setTimeout(r, 500));
        // Segunda falha NÃO sobe: subir cairia no catch de envio, que limpa o
        // marcador — e o reenvio duplicado voltaria. A linha fica `sending`
        // com o marcador, e a retomada de órfã a liquida sem reenviar.
        await settle().catch((e) =>
          console.warn(
            `[outbox] enviado mas não liquidado (${row.id}) — a retomada fecha:`,
            e instanceof Error ? e.message : String(e)
          )
        );
      });
      await semear();
      totals.sent += 1;
    } catch (err) {
      /**
       * ── Corrida rara: a Meta recusou por 131047, ou o TEMPLATE mudou de
       * estado entre a checagem e o `send` ────────────────────────────────
       *
       * `envioTemplate` só é `null` aqui quando a checagem ACIMA achou a
       * janela aberta — e ela fechou entre a checagem e o `send`. Com
       * `envioTemplate` preenchido, é o próprio template que deixou de ser
       * usável nesse intervalo (pausado, desativado, parâmetro — ver
       * `transport/erro.ts`). Nenhum dos dois é falha da MENSAGEM: representa
       * igual ao caminho normal, sem contar tentativa nem derrubar o canal —
       * retentar o mesmo template imediatamente só repetiria o erro.
       */
      const falhaMsg = falhaDaMensagemMeta(err);
      if (falhaMsg === "requer_template" || falhaMsg === "template_invalido") {
        // Template recusado no envio leva marca PRÓPRIA com o código da Meta:
        // misturado ao "aguardando aprovação", um template quebrado em loop
        // passava por pendente — e a métrica de falha de template (G1) zerava.
        const codigo = err instanceof MetaHttpError ? err.code : null;
        const marca =
          falhaMsg === "template_invalido" && envioTemplate
            ? `${MARCA_TEMPLATE_INVALIDO} (#${codigo ?? "?"}, ${envioTemplate.name})`
            : envioTemplate
              ? MARCA_TEMPLATE_PENDENTE
              : MARCA_REQUER_TEMPLATE;
        const devolverTemplate = () =>
          query(
            `UPDATE outbox
                SET status = 'pending',
                    attempts = GREATEST(attempts - 1, 0),
                    send_started_at = NULL,
                    deliver_after = now() + interval '5 minutes',
                    last_error = $2,
                    -- O código da Meta fica: \`last_error\` é sobrescrito pelo
                    -- próximo desfecho, e a métrica de falha de template (G1)
                    -- precisa do histórico.
                    error_code = COALESCE($3, error_code)
              WHERE id = $1 AND status = 'sending'`,
            [row.id, marca, falhaMsg === "template_invalido" ? codigo : null]
          );
        await devolverTemplate().catch((e) =>
          console.error(
            `[outbox] linha ${row.id} presa em 'sending' após ${falhaMsg} na corrida — a retomada de órfã a pega:`,
            e instanceof Error ? e.message : String(e)
          )
        );
        totals.held += 1;
        continue;
      }
      /**
       * ── O canal recusou, não a mensagem ─────────────────────────────────
       *
       * 400 de assinatura ou 401/403 no `send-text` é a Z-API dizendo que não
       * envia NADA — e o `/status` de um minuto atrás disse "conectada" porque
       * estava defasado (a cobrança caiu entre a checagem e o envio, ou o
       * provedor demora a refletir). Contar tentativa aqui é o que fez as 16
       * linhas de 10/09 virarem `failed`: três passadas e acabou.
       *
       * Então: esta linha e TODAS as que ainda não foram tentadas voltam a
       * `pending` com a tentativa devolvida, o laço para (as seguintes
       * tomariam o mesmo 400), e o chamador informa a máquina de estado
       * (fonte `envio`) — é isso que faz o e-mail sair mesmo com o `/status`
       * mentindo "conectada" a cada minuto.
       */
      const inop = inoperanciaDoErro(err);
      if (inop) {
        const restantes = rows.slice(indice).map((r) => r.id);
        const devolver = () =>
          query(
            `UPDATE outbox
                SET status = 'pending',
                    attempts = GREATEST(attempts - 1, 0),
                    send_started_at = NULL,
                    last_error = $2
              WHERE id = ANY($1::text[]) AND status = 'sending'`,
            [restantes, `${MARCA_CANAL_INOPERANTE} (${inop.motivo}) — envio recusado, tentativa não contada`]
          );
        await devolver().catch(async () => {
          await new Promise((r) => setTimeout(r, 500));
          await devolver().catch((e) =>
            console.error(
              `[outbox] ${restantes.length} linha(s) presas em 'sending' com tentativa ` +
                `contada após recusa do canal — a retomada de órfã as pega em 10 min. Motivo: ` +
                (e instanceof Error ? e.message : String(e))
            )
          );
        });
        totals.blocked += restantes.length;
        totals.inoperante = inop;
        console.error(
          `[outbox] INSTÂNCIA INOPERANTE (${inop.motivo}) no ENVIO — ` +
            `${restantes.length} linha(s) devolvida(s) a pending sem contar tentativa. ${inop.detalhe}`
        );
        break;
      }

      const message = err instanceof Error ? err.message : String(err);
      // Template + timeout: pode ter saído. Não reenvia (ver MARCA_ENVIO_INCERTO).
      if (envioTemplate && /^timeout de \d+ms em /.test(message)) {
        const incerto = () =>
          query(
            `UPDATE outbox
                SET status = 'sent', sent_at = now(), provider_message_id = NULL,
                    last_error = $2, send_started_at = NULL
              WHERE id = $1`,
            [row.id, MARCA_ENVIO_INCERTO]
          );
        await incerto().catch(async () => {
          await new Promise((r) => setTimeout(r, 500));
          await incerto().catch((e) =>
            console.error(
              `[outbox] envio incerto NÃO registrado (${row.id}) — a retomada de órfã ` +
                `liquida como 'sent' sem reenviar:`,
              e instanceof Error ? e.message : String(e)
            )
          );
        });
        log.warn("outbox.envio_incerto", { rowId: row.id, orgId: row.org_id, template: envioTemplate.name });
        totals.sent += 1;
        continue;
      }
      // Esgotou as tentativas → `failed` (terminal, visível no painel). Ainda
      // tem crédito → volta pra `pending` com backoff, e o próximo cron pega.
      const exhausted = row.attempts >= MAX_ATTEMPTS;
      const settleFailure = () =>
        query(
          `UPDATE outbox
              SET status = $2,
                  last_error = $3,
                  -- Envio FALHOU: limpa o marcador, a retentativa deve reenviar.
                  send_started_at = NULL,
                  deliver_after = CASE WHEN $2 = 'pending'
                                       THEN now() + ($4 || ' minutes')::interval
                                       ELSE deliver_after END
            WHERE id = $1`,
          [row.id, exhausted ? "failed" : "pending", message.slice(0, 500), String(row.attempts * 5)]
        );
      /**
       * Guardado com retry próprio: se este UPDATE subisse, derrubaria o
       * `dispatchDue` inteiro (as linhas seguintes ficariam `sending` até a
       * janela de órfã) E deixaria o marcador na linha — que a retomada
       * liquidaria como `sent` sem ter enviado (achado do code review).
       */
      await settleFailure().catch(async () => {
        await new Promise((r) => setTimeout(r, 500));
        await settleFailure().catch((e) =>
          console.error(
            `[outbox] FALHA NÃO REGISTRADA (${row.id}) — linha segue 'sending' com ` +
              `marcador; a retomada vai marcá-la 'sent' SEM envio. Intervenção: ` +
              `SET send_started_at = NULL, status = 'pending'. Motivo: ` +
              (e instanceof Error ? e.message : String(e))
          )
        );
      });
      totals.failed += 1;
    }
  }

  return totals;
}
