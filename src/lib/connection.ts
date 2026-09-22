import { query } from "./db";
import { contarVencidas } from "./outbox";
import { reportAlert } from "./cm";
import { provider } from "./transport";
import type { MotivoInoperante } from "./transport/erro";

/**
 * Por que a queda foi observada. Vai no e-mail, porque muda o CONSELHO:
 *
 *  · ausente — sessão do WhatsApp caiu: reparear por QR;
 *  · `assinatura` / `credencial` — a Z-API respondeu que não vai enviar
 *    (ver `MotivoInoperante`): cartão ou token, nunca QR;
 *  · `inacessivel` — o cron não CONSEGUE perguntar há N passadas seguidas
 *    (timeout, 5xx, formato desconhecido). Não sabemos se está caída; sabemos
 *    que estamos cegos, e ficar cego por um quarto de hora também é incidente.
 */
export type MotivoQueda = MotivoInoperante | "inacessivel";

/**
 * Transição de conexão da Z-API → alerta por e-mail (F7).
 *
 * ── O problema ────────────────────────────────────────────────────────────
 *
 * Em 2026-08-04 quatro mensagens reais se perderam porque a instância caiu e
 * ninguém soube. A causa técnica já está corrigida — o outbox e o inbound
 * checam a conexão antes de despachar, represam a fila e param de mentir
 * "enviado". O que faltava era o AVISO: a fila fica parada em silêncio até
 * alguém abrir o painel.
 *
 * ── Por que precisa de tabela ─────────────────────────────────────────────
 *
 * Cada execução de cron é amnésica. Sem estado gravado só dá para alertar por
 * ESTADO, e alertar por estado com o cron rodando a cada minuto são 1.440
 * e-mails por dia. `connection_state` (migration 013, linha única) é o que
 * torna "caiu agora" distinguível de "continua caído".
 *
 * ── Duas fontes, uma máquina ──────────────────────────────────────────────
 *
 *  · **push** — os callbacks `connected`/`disconnected` da Z-API, apontados
 *    para `/api/zapi-connection/<secret>`. Age na PRIMEIRA discordância: o
 *    callback é o evento, não uma amostra dele. Latência de segundos.
 *  · **cron** — o do outbox, a cada minuto. Não é a fonte do alerta; é o
 *    detector de callback PERDIDO, porque entrega pela rede falha e um alerta
 *    que depende só dela some justo no dia em que precisa. Exige DUAS passadas
 *    discordando, porque uma leitura solitária pode ser hiccup — e alerta
 *    falso ensina quem recebe a ignorar o verdadeiro.
 *
 * O `podeResponder()` do inbound NÃO alimenta esta máquina de propósito: ele
 * roda no mesmo minuto que o cron do outbox, e as duas escritas fariam o
 * `miss_streak` avançar duas vezes por minuto — furando a regra das duas
 * passadas sem que nada no código dissesse isso.
 *
 * ── O alerta é derivado do ESTADO, não do evento ──────────────────────────
 *
 * Parece um detalhe e é o que faz o retry existir. `alerted_down` significa
 * "já anunciei uma queda cuja volta ainda não anunciei", e só é carimbado
 * quando o e-mail SAI. Um POST que falha deixa o carimbo para trás e a passada
 * seguinte reenvia — sem fila nova, sem contador de tentativas, sem código de
 * retry. É também por isso que o receptor devolve 500 quando o e-mail não sai:
 * um 200 mentiroso carimbaria, e o alerta sumiria.
 */

/**
 * Debounce contra flapping: cai/volta/cai em dez minutos manda UM e-mail, não
 * três. Vem do PRD (§3.7).
 *
 * **O preço, que é real e está escolhido de olho aberto:** uma queda que
 * acontece logo depois de uma reconexão fica ATRASADA até uma hora — o estado
 * muda na hora, mas o e-mail espera o debounce expirar. Atrasada, nunca
 * perdida: o ramo derivado-do-estado reenvia sozinho na primeira passada
 * depois da janela.
 *
 * Aceito porque o cenário exige instabilidade (ou seja: o canal volta
 * sozinho), e quem recebe já foi avisado minutos antes. O que se evita em
 * troca é vinte e-mails numa hora — e alerta que se aprende a ignorar não
 * alerta ninguém. `connection.integration.test.ts` fixa os dois lados disso.
 */
const DEBOUNCE_MS = 60 * 60_000;

/** Passadas do cron discordando antes de acreditar. O push não usa isto. */
const CRON_CONFIRMACOES = 2;

/**
 * Passadas seguidas SEM CONSEGUIR PERGUNTAR antes de tratar como queda.
 *
 * Muito mais que as duas de cima, de propósito: uma leitura definitiva
 * (`connected:false` num 200, ou um 400 de assinatura) é a Z-API AFIRMANDO
 * algo; um timeout ou um 5xx é ela não dizendo nada — e um blip do endpoint
 * de status não pode virar e-mail de queda. Quinze minutos cego, sim: é
 * tempo bastante para não ser blip, e curto bastante para alguém agir antes
 * de a fila envelhecer.
 *
 * Contador PRÓPRIO (`blind_streak`, migration 014), e não o `miss_streak`:
 * uma leitura cega não afirma nada, então não pode avançar nem zerar a
 * confirmação de uma leitura definitiva. Com um contador só, um timeout no
 * meio de uma reconexão em curso reiniciaria a contagem para sempre, e
 * catorze timeouts seguidos de um único `connected:false` decretariam a queda
 * com uma leitura só — os dois furos foram achados em code review antes de
 * chegar a produção.
 */
const CRON_CONFIRMACOES_INACESSIVEL = 15;

/**
 *  · `push` — callback `connected`/`disconnected` da Z-API. É o evento.
 *  · `cron` — amostra de minuto em minuto; exige confirmação.
 *  · `envio` — o `send-text` RECUSOU com 400 de assinatura ou 401/403. Também
 *    é evento, não amostra: a Z-API acabou de dizer que não envia. Age na
 *    primeira discordância, como o push. Existe para o caso em que o
 *    `/status` está defasado (cobrança caiu entre a checagem e o envio) — sem
 *    isto o outbox releria "conectada" a cada minuto e nunca transitaria.
 */
export type FonteDeObservacao = "push" | "cron" | "envio";

export interface ObserveResult {
  /** Estado gravado ao fim da observação. */
  connected: boolean;
  /** A linha não existia e foi semeada agora — nenhum alerta nesta passada. */
  seeded: boolean;
  /** Houve transição commitada nesta passada. */
  transicao: boolean;
  /** Passadas do cron discordando, ainda abaixo do limiar. */
  aguardandoConfirmacao: boolean;
  /** Qual alerta foi ENVIADO com sucesso, se algum. */
  alertou: "queda" | "volta" | null;
}

/** `query<T>` exige um shape indexável; daí o type em vez de interface. */
type Estado = {
  connected: boolean;
  down_since: Date | null;
  alerted_down: boolean;
  queda_pendente: boolean;
  notified_at: Date | null;
  miss_streak: number;
  blind_streak: number;
  /** Causa da queda ATUAL; NULL na queda de sessão comum e quando conectada. */
  motivo: MotivoQueda | null;
};

const COLUNAS = `connected, down_since, alerted_down, queda_pendente, notified_at,
  miss_streak, blind_streak, motivo`;

/**
 * Observa o estado da instância e, se for o caso, alerta.
 *
 * `connected` tem que ser um boolean CONHECIDO. `connectionStatus()` LANÇA
 * quando o `/status` responde não-2xx ou num formato que não entendemos, e
 * exceção ali significa "não consegui PERGUNTAR" — nunca "está desconectado".
 * Confundir os dois custou uma tarde em 21/08: um 401 de credencial foi
 * carimbado na fila como "instância desemparelhada" e mandou alguém repárear a
 * instância mais de uma vez. Quem chama esta função trata a exceção ANTES,
 * simplesmente não observando nada.
 *
 * Nunca lança: é chamada de dentro do cron e da rota de callback, e alerta
 * quebrado não pode quebrar o que ele alertava.
 */
export async function observeConnection(params: {
  connected: boolean;
  fonte: FonteDeObservacao;
  /**
   * Só faz sentido com `connected: false`. É PERSISTIDO na transição para
   * baixo (`connection_state.motivo`) e é de lá que o e-mail lê a causa —
   * inclusive a retentativa de um envio que falhou, que pode acontecer numa
   * passada cujo motivo é outro (um timeout no minuto do reenvio não
   * transforma uma assinatura cancelada em "inacessível").
   */
  motivo?: MotivoQueda;
}): Promise<ObserveResult> {
  const { connected, fonte } = params;
  const motivo = connected ? undefined : params.motivo;
  /** Passada CEGA: o cron não conseguiu perguntar. Não é uma leitura. */
  const cega = !connected && motivo === "inacessivel";
  /**
   * Resultado montado só no fim, e nunca por mutação de um objeto
   * compartilhado com o `catch`: um erro no meio devolveria `transicao: true`
   * para uma transição que talvez não tenha sido commitada. Forma que mente é
   * pior que forma pobre.
   */
  const nada = (over: Partial<ObserveResult> = {}): ObserveResult => ({
    // O estado OBSERVADO, que nos caminhos de erro pode não ser o gravado.
    connected,
    seeded: false,
    transicao: false,
    aguardandoConfirmacao: false,
    alertou: null,
    ...over,
  });

  try {
    /**
     * Semeadura preguiçosa. A migration NÃO insere linha: gravar
     * `connected = true` lá afirmaria um estado que ninguém observou.
     *
     * `RETURNING` com linha = acabamos de inserir → primeira observação da
     * vida, e ela não alerta. Não temos crença anterior com que comparar, e a
     * passada seguinte decide com o caminho normal — se estiver mesmo caído,
     * o alerta sai um minuto depois pelo ramo derivado-do-estado.
     */
    if (cega) {
      /**
       * Uma passada cega NÃO semeia. Semear "desconectada" a partir de um
       * timeout afirmaria uma queda que ninguém observou — e, pior, sem
       * crença anterior o limiar de quinze não existe: a segunda passada cega
       * já mandaria e-mail (achado do code review). Sem linha, não há o que
       * observar; a primeira leitura definitiva semeia.
       */
      const [existe] = await query<{ ok: boolean }>(
        `SELECT true AS ok FROM connection_state WHERE id`
      );
      if (!existe) {
        console.warn(
          "[connection] sem estado gravado e sem conseguir consultar a Z-API — nada semeado"
        );
        return nada();
      }
    }
    const semeada = cega
      ? []
      : await query<{ ok: boolean }>(
          `INSERT INTO connection_state (id, connected, changed_at, down_since, motivo, updated_at)
                VALUES (true, $1, now(), CASE WHEN $1 THEN NULL ELSE now() END, $2, now())
           ON CONFLICT (id) DO NOTHING
             RETURNING true AS ok`,
          [connected, motivo ?? null]
        );
    if (semeada.length > 0) {
      console.log(
        `[connection] estado semeado (${fonte}): ${descrever(connected, motivo)}`
      );
      return nada({ seeded: true });
    }

    const [antes] = await query<Estado>(
      `SELECT ${COLUNAS} FROM connection_state WHERE id`
    );
    // Impossível depois do upsert; não vale derrubar o cron por isso.
    if (!antes) return nada();

    let estado = antes;
    let transicao = false;
    let aguardando = false;

    /** Transição commitada: grava o estado novo e zera a escrituração. */
    const transitar = async (): Promise<void> => {
      const [depois] = await query<Estado>(
        `UPDATE connection_state
            SET connected = $1,
                changed_at = now(),
                -- Preserva down_since na volta: é dele que sai o "ficou fora
                -- por 2h13m", e changed_at já terá virado a hora da VOLTA.
                down_since = CASE WHEN $1 THEN down_since ELSE now() END,
                -- QUEDA NOVA ZERA A ESCRITURAÇÃO DO INCIDENTE ANTERIOR.
                -- Sem isto, um alerta de volta que falha para sempre trava
                -- alerted_down = true, e a cerca do alertarQueda passa a
                -- suprimir TODA queda futura — o operador receberia só um
                -- "reconectada" de uma queda que nunca lhe foi anunciada,
                -- que é o inverso exato do invariante.
                alerted_down   = CASE WHEN $1 THEN alerted_down   ELSE false END,
                queda_pendente = CASE WHEN $1 THEN queda_pendente ELSE false END,
                -- O motivo é do estado de QUEDA: nasce aqui e morre na volta.
                motivo = CASE WHEN $1 THEN NULL ELSE $2 END,
                miss_streak = 0,
                blind_streak = 0,
                updated_at = now()
          WHERE id
      RETURNING ${COLUNAS}`,
        [connected, motivo ?? null]
      );
      estado = depois;
      transicao = true;
      console.warn(
        `[connection] TRANSIÇÃO (${fonte}): instância ` +
          (connected ? "RECONECTADA" : descrever(false, motivo))
      );
    };

    if (cega) {
      /**
       * Passada cega: só o contador PRÓPRIO avança. `miss_streak` fica como
       * está — uma leitura que não afirma nada não pode avançar nem zerar a
       * confirmação de uma leitura definitiva. Transita só quando o estado
       * gravado é "conectada": cega com a instância já caída é só cega, e o
       * bloco de alerta abaixo continua reenviando o que faltou com o motivo
       * GRAVADO, não com "inacessível".
       */
      const [{ blind_streak }] = await query<{ blind_streak: number }>(
        `UPDATE connection_state
            SET blind_streak = blind_streak + 1, updated_at = now()
          WHERE id
      RETURNING blind_streak`
      );
      if (antes.connected) {
        if (blind_streak < CRON_CONFIRMACOES_INACESSIVEL) {
          console.warn(
            `[connection] sem conseguir consultar a Z-API ` +
              `(${blind_streak}/${CRON_CONFIRMACOES_INACESSIVEL})`
          );
          aguardando = true;
        } else {
          await transitar();
        }
      }
    } else if (connected !== antes.connected) {
      if (fonte === "cron") {
        const [{ miss_streak }] = await query<{ miss_streak: number }>(
          `UPDATE connection_state
              SET miss_streak = miss_streak + 1, blind_streak = 0, updated_at = now()
            WHERE id
        RETURNING miss_streak`
        );
        if (miss_streak < CRON_CONFIRMACOES) {
          /**
           * Ainda não acreditamos: o estado gravado NÃO muda, e nenhuma
           * transição é commitada.
           *
           * Mas seguimos para o bloco de alerta em vez de retornar aqui. O
           * retry deste desenho é o ramo derivado-do-estado, e retornar cedo
           * faria um hiccup isolado do `/status` adiar em uma passada inteira
           * o reenvio de um alerta que falhou antes — atrasando justamente o
           * mecanismo que substitui a fila de retry.
           */
          console.warn(
            `[connection] cron discorda do gravado (${miss_streak}/${CRON_CONFIRMACOES}) — ` +
              `observado ${descrever(connected, motivo)}`
          );
          aguardando = true;
        }
      }

      // `push` e `envio` agem na primeira discordância: são eventos.
      if (!aguardando) await transitar();
    } else {
      /**
       * Leitura definitiva CONCORDANDO com o gravado. Zera os dois contadores
       * (a discordância anterior era ruído; a cegueira acabou).
       *
       * E, se a instância continua caída por uma causa DIFERENTE da gravada
       * quando a gravada era "inacessível", atualiza o motivo e REARMA o
       * alerta: é o caso "cego por 15 min" → "a Z-API voltou a responder, e
       * respondeu 400 de assinatura". A causa acionável chegou DEPOIS do
       * e-mail, e o operador precisa dela — sai um segundo 🔴, sujeito ao
       * debounce de 1h como qualquer queda. Só nesse sentido: de uma causa
       * definitiva para outra não se rearma (é a mesma queda, com o mesmo
       * conselho útil), e de definitiva para cega nem chega aqui.
       */
      const causaNova =
        !connected && antes.motivo === "inacessivel" && (motivo ?? null) !== antes.motivo;
      if (antes.miss_streak !== 0 || antes.blind_streak !== 0 || causaNova) {
        const [depois] = await query<Estado>(
          `UPDATE connection_state
              SET miss_streak = 0,
                  blind_streak = 0,
                  motivo       = CASE WHEN $1 THEN $2    ELSE motivo       END,
                  alerted_down = CASE WHEN $1 THEN false ELSE alerted_down END,
                  updated_at = now()
            WHERE id RETURNING ${COLUNAS}`,
          [causaNova, motivo ?? null]
        );
        estado = depois;
        if (causaNova) {
          console.warn(
            `[connection] causa da queda passou de inacessível para ` +
              `${descrever(false, motivo)} — alerta rearmado`
          );
        }
      }
    }

    /**
     * As duas funções decidem no SQL, relendo a linha — não a partir do
     * `estado` em memória. É o que torna a decisão atômica: push e cron podem
     * rodar no mesmo instante, e quem perde o `UPDATE` condicional não envia.
     * `estado` aqui só escolhe QUAL das duas perguntar.
     */
    const alertou = estado.connected ? await alertarVolta() : await alertarQueda();

    return nada({
      connected: estado.connected,
      transicao,
      aguardandoConfirmacao: aguardando,
      alertou,
    });
  } catch (err) {
    console.error(
      "[connection] observação falhou:",
      err instanceof Error ? err.message : String(err)
    );
    return nada();
  }
}

/**
 * Alerta de QUEDA — derivado do estado, com claim antes do envio.
 *
 * O claim (`alerted_down = true` numa condição que já testa `NOT alerted_down`)
 * é o mesmo padrão do `status = 'sending'` do outbox, e resolve o mesmo
 * problema: push e cron podem rodar no mesmo instante, e sem ele os dois
 * mandariam o e-mail. Quem perde o `UPDATE` condicional recebe zero linhas e
 * simplesmente não envia.
 *
 * Se o envio falha, o claim é DESFEITO — inclusive o `notified_at`, que volta
 * ao valor anterior. Duplicar um e-mail de alerta é barato; perder um é o
 * defeito que este arquivo existe para matar.
 */
/** Texto de log para um estado observado. */
/**
 * `{ canal: "meta" }` quando o Max fala pela Cloud API; nada na Z-API. Lido na
 * hora do ENVIO do alerta: numa troca de provedor no meio de um incidente, o
 * conselho segue o canal que está valendo agora, que é onde se age.
 *
 * Sem lançar: um `WHATSAPP_PROVIDER` inválido já derruba o despacho por outro
 * caminho, e o alerta é justamente o que tem que sair nessa hora.
 */
function canalDoAlerta(): { canal?: "meta" } {
  try {
    return provider() === "meta" ? { canal: "meta" } : {};
  } catch {
    return {};
  }
}

function descrever(connected: boolean, motivo: MotivoQueda | undefined): string {
  if (connected) return "conectada";
  return motivo ? `DESCONECTADA (${motivo})` : "DESCONECTADA";
}

async function alertarQueda(): Promise<"queda" | null> {
  const claim = await query<{
    anterior: Date | null;
    down_since: Date | null;
    motivo: MotivoQueda | null;
  }>(
    `WITH antes AS (SELECT notified_at, down_since, motivo FROM connection_state WHERE id)
     UPDATE connection_state cs
        SET alerted_down = true, notified_at = now(), updated_at = now()
       FROM antes
      WHERE cs.id
        AND NOT cs.connected
        AND NOT cs.alerted_down
        -- Debounce contra flapping. Não atrapalha o retry de um envio que
        -- falhou: ali alerted_down voltou a false E notified_at voltou ao
        -- valor anterior, então a condição de tempo é a mesma de antes.
        AND (cs.notified_at IS NULL
             OR cs.notified_at < now() - ($1 || ' milliseconds')::interval)
  RETURNING antes.notified_at AS anterior, antes.down_since AS down_since,
            antes.motivo AS motivo`,
    [String(DEBOUNCE_MS)]
  );
  if (claim.length === 0) {
    /**
     * Não reivindicamos. Duas razões possíveis, e uma delas precisa deixar
     * marca: **a queda foi segurada pelo debounce e ninguém soube dela**.
     *
     * O `WHERE` abaixo só casa esse caso — `NOT alerted_down` exclui a queda
     * que JÁ virou e-mail, e `NOT connected` exclui a chamada em estado
     * conectado. Sem esta marca existia um buraco de silêncio total: queda →
     * volta → queda de novo dentro da hora (segurada) → volta de novo, e como
     * `alerted_down` nunca chegou a ser marcado, nem o alerta de reconexão
     * saía. Uma queda inteira, com fila represada e inbound morto, não era
     * anunciada a ninguém — o oposto do que este arquivo existe para garantir.
     */
    await query(
      `UPDATE connection_state SET queda_pendente = true, updated_at = now()
        WHERE id AND NOT connected AND NOT alerted_down AND NOT queda_pendente`
    );
    return null;
  }

  // Lido do ESTADO, não da passada: ver o doc do parâmetro `motivo`.
  const motivo = claim[0].motivo ?? undefined;

  /**
   * Cego não é represado. Quando o cron não consegue consultar o `/status`,
   * o despacho segue em fail-open e ENTREGA a fila — dizer "7 represadas"
   * num e-mail que sai no mesmo minuto em que as 7 saem seria mentira. O
   * número só vale quando a fila está de fato parada (sessão caída ou
   * inoperante), que é quando `dispatchDue` também a conta como `blocked`.
   */
  const represadas =
    motivo === "inacessivel"
      ? 0
      : await contarVencidas().catch((err) => {
          // O e-mail sai mesmo sem o número: dizer "não sei quantas" é
          // infinitamente melhor que não avisar que o canal caiu.
          console.error(
            "[connection] não deu pra contar represadas:",
            err instanceof Error ? err.message : String(err)
          );
          return 0;
        });

  /**
   * `at` é quando a instância CAIU, não quando este e-mail está sendo montado.
   * Duas coisas dependem disso:
   *
   *  · o e-mail diz "detectado em X" e X passa a ser verdade — com o instante
   *    do envio, uma retentativa 40 minutos depois dataria o incidente errado;
   *  · a retentativa carrega o MESMO `at`, então o receptor consegue tratar as
   *    tentativas de um incidente como um incidente só (é a chave de dedupe
   *    dele, `max:zapi:<evento>:<at>`). Com o instante do envio, cada
   *    retentativa viraria um incidente novo na contagem.
   */
  /**
   * `motivo` só entra no corpo quando existe. Sem ele o JSON é byte a byte o
   * de antes — é o que o vetor fixo de paridade (`hmac-parity.test.ts`) trava,
   * e é o que o receptor antigo do ImobPro continua aceitando (chave extra é
   * descartada lá, não rejeitada; o receptor que a exibe é PR próprio no
   * contractmaker).
   */
  const ok = await reportAlert({
    evento: "zapi_desconectada",
    at: (claim[0].down_since ?? new Date()).toISOString(),
    represadas,
    ...(motivo ? { motivo } : {}),
    ...canalDoAlerta(),
  });

  if (!ok) {
    /**
     * O rollback é CONDICIONADO ao estado que foi reivindicado. Incondicional,
     * ele vira lost update na seguinte sequência real: reivindicamos a queda,
     * o POST fica em voo, a instância reconecta, o push commita a volta e o
     * e-mail de reconexão SAI — e então o POST da queda falha e o rollback
     * rebobina `alerted_down`/`notified_at` por cima de um e-mail que já
     * saiu. O operador receberia só um "reconectada, ficou fora por X" sem
     * nunca ter sido avisado da queda: exatamente o que o invariante de
     * `alerted_down` existe para impedir. Com a cerca, vira no-op.
     */
    await query(
      `UPDATE connection_state
          SET alerted_down = false, notified_at = $1, updated_at = now()
        WHERE id AND NOT connected AND alerted_down`,
      [claim[0].anterior]
    );
    console.error("[connection] alerta de queda NÃO entregue — reenvia na próxima passada");
    return null;
  }

  console.error(
    `[connection] ALERTA DE QUEDA enviado${motivo ? ` (${motivo})` : ""} — ` +
      `${represadas} mensagem(ns) represada(s)`
  );
  return "queda";
}

/**
 * Alerta de VOLTA. Sai quando há uma queda a encerrar — anunciada
 * (`alerted_down`) **ou** segurada pelo debounce sem nunca ter sido anunciada
 * (`queda_pendente`).
 *
 * A segunda condição não estava aqui e o buraco era sério: queda → volta →
 * queda dentro da hora (segurada) → volta, e o operador não recebia nada sobre
 * a segunda queda. Este e-mail já carrega `foraPorMs`, então ele sozinho conta
 * a história inteira — "ficou fora por 35 min" é infinitamente melhor que
 * silêncio, e é uma mensagem em vez de duas, que era o ponto do debounce.
 *
 * O que continua valendo: sem queda nenhuma pendente, nada sai. Celebrar o fim
 * de um problema que nunca existiu confunde mais do que informa.
 */
async function alertarVolta(): Promise<"volta" | null> {
  const claim = await query<{
    anterior: Date | null;
    down_since: Date | null;
    voltou_em: Date;
    era_anunciada: boolean;
  }>(
    `WITH antes AS (SELECT notified_at, down_since, changed_at, alerted_down
                      FROM connection_state WHERE id)
     UPDATE connection_state cs
        SET alerted_down = false, queda_pendente = false,
            notified_at = now(), updated_at = now()
       FROM antes
      WHERE cs.id AND cs.connected AND (cs.alerted_down OR cs.queda_pendente)
  RETURNING antes.notified_at AS anterior,
            antes.alerted_down AS era_anunciada,
            antes.down_since AS down_since,
            antes.changed_at AS voltou_em`
  );
  if (claim.length === 0) return null;

  const { anterior, down_since, voltou_em, era_anunciada } = claim[0];
  if (!down_since) {
    // Não deveria acontecer (a transição de queda sempre carimba), mas um NULL
    // aqui não pode virar NaN no corpo do e-mail.
    console.warn("[connection] reconexão sem down_since — tempo fora vai como 0");
  }
  /**
   * Medido entre a queda e a VOLTA, não até agora: numa retentativa, "agora"
   * já andou e o e-mail anunciaria um tempo fora maior do que o real —
   * crescendo a cada tentativa. Mesmo motivo do `at` no alerta de queda.
   */
  const foraPorMs = down_since
    ? Math.max(0, voltou_em.getTime() - down_since.getTime())
    : 0;

  const ok = await reportAlert({
    evento: "zapi_reconectada",
    at: voltou_em.toISOString(),
    foraPorMs,
    ...canalDoAlerta(),
  });

  if (!ok) {
    // Mesma cerca do rollback da queda, pela mesma razão: só desfaz se o
    // estado ainda for aquele que este envio reivindicou. Devolve a marca ao
    // campo de onde ela veio — trocar `queda_pendente` por `alerted_down`
    // faria o reenvio afirmar que a queda tinha sido anunciada.
    await query(
      `UPDATE connection_state
          SET alerted_down   = $2,
              queda_pendente = NOT $2,
              notified_at = $1,
              updated_at = now()
        WHERE id AND connected AND NOT alerted_down AND NOT queda_pendente`,
      [anterior, era_anunciada]
    );
    console.error("[connection] alerta de volta NÃO entregue — reenvia na próxima passada");
    return null;
  }

  console.log(
    `[connection] alerta de reconexão enviado (fora por ${foraPorMs} ms` +
      `${era_anunciada ? "" : "; a queda tinha sido segurada pelo debounce"})`
  );
  return "volta";
}
