import { query } from "./db";
import { contarVencidas } from "./outbox";
import { reportAlert } from "./cm";

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

export type FonteDeObservacao = "push" | "cron";

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
  notified_at: Date | null;
  miss_streak: number;
};

const COLUNAS = `connected, down_since, alerted_down, notified_at, miss_streak`;

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
}): Promise<ObserveResult> {
  const { connected, fonte } = params;
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
    const semeada = await query<{ ok: boolean }>(
      `INSERT INTO connection_state (id, connected, changed_at, down_since, updated_at)
            VALUES (true, $1, now(), CASE WHEN $1 THEN NULL ELSE now() END, now())
       ON CONFLICT (id) DO NOTHING
         RETURNING true AS ok`,
      [connected]
    );
    if (semeada.length > 0) {
      console.log(
        `[connection] estado semeado (${fonte}): ${connected ? "conectada" : "DESCONECTADA"}`
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

    if (connected !== antes.connected) {
      if (fonte === "cron") {
        const [{ miss_streak }] = await query<{ miss_streak: number }>(
          `UPDATE connection_state
              SET miss_streak = miss_streak + 1, updated_at = now()
            WHERE id
        RETURNING miss_streak`
        );
        if (miss_streak < CRON_CONFIRMACOES) {
          // Ainda não acreditamos. Nada a alertar: o estado gravado não mudou.
          console.warn(
            `[connection] cron discorda do gravado (${miss_streak}/${CRON_CONFIRMACOES}) — ` +
              `observado ${connected ? "conectada" : "DESCONECTADA"}`
          );
          return nada({ connected: antes.connected, aguardandoConfirmacao: true });
        }
      }

      const [depois] = await query<Estado>(
        `UPDATE connection_state
            SET connected = $1,
                changed_at = now(),
                -- Preserva down_since na volta: é dele que sai o "ficou fora
                -- por 2h13m", e changed_at já terá virado a hora da VOLTA.
                down_since = CASE WHEN $1 THEN down_since ELSE now() END,
                miss_streak = 0,
                updated_at = now()
          WHERE id
      RETURNING ${COLUNAS}`,
        [connected]
      );
      estado = depois;
      transicao = true;
      console.warn(
        `[connection] TRANSIÇÃO (${fonte}): instância ${connected ? "RECONECTADA" : "DESCONECTADA"}`
      );
    } else if (antes.miss_streak !== 0) {
      // Voltou a concordar: a discordância anterior era ruído.
      const [depois] = await query<Estado>(
        `UPDATE connection_state SET miss_streak = 0, updated_at = now()
          WHERE id RETURNING ${COLUNAS}`
      );
      estado = depois;
    }

    /**
     * As duas funções decidem no SQL, relendo a linha — não a partir do
     * `estado` em memória. É o que torna a decisão atômica: push e cron podem
     * rodar no mesmo instante, e quem perde o `UPDATE` condicional não envia.
     * `estado` aqui só escolhe QUAL das duas perguntar.
     */
    const alertou = estado.connected
      ? await alertarVolta()
      : await alertarQueda();

    return nada({ connected: estado.connected, transicao, alertou });
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
async function alertarQueda(): Promise<"queda" | null> {
  const claim = await query<{ anterior: Date | null; down_since: Date | null }>(
    `WITH antes AS (SELECT notified_at, down_since FROM connection_state WHERE id)
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
  RETURNING antes.notified_at AS anterior, antes.down_since AS down_since`,
    [String(DEBOUNCE_MS)]
  );
  if (claim.length === 0) return null;

  const represadas = await contarVencidas().catch((err) => {
    // O e-mail sai mesmo sem o número: dizer "não sei quantas" é infinitamente
    // melhor que não avisar que o canal caiu.
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
  const ok = await reportAlert({
    evento: "zapi_desconectada",
    at: (claim[0].down_since ?? new Date()).toISOString(),
    represadas,
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
    `[connection] ALERTA DE QUEDA enviado — ${represadas} mensagem(ns) represada(s)`
  );
  return "queda";
}

/**
 * Alerta de VOLTA. Só sai se a queda correspondente FOI anunciada — senão o
 * e-mail celebraria o fim de um problema que ninguém soube que existiu, o que
 * confunde mais do que informa. É o outro lado do invariante de
 * `alerted_down`.
 */
async function alertarVolta(): Promise<"volta" | null> {
  const claim = await query<{
    anterior: Date | null;
    down_since: Date | null;
    voltou_em: Date;
  }>(
    `WITH antes AS (SELECT notified_at, down_since, changed_at FROM connection_state WHERE id)
     UPDATE connection_state cs
        SET alerted_down = false, notified_at = now(), updated_at = now()
       FROM antes
      WHERE cs.id AND cs.connected AND cs.alerted_down
  RETURNING antes.notified_at AS anterior,
            antes.down_since AS down_since,
            antes.changed_at AS voltou_em`
  );
  if (claim.length === 0) return null;

  const { anterior, down_since, voltou_em } = claim[0];
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
  });

  if (!ok) {
    // Mesma cerca do rollback da queda, pela mesma razão: só desfaz se o
    // estado ainda for aquele que este envio reivindicou.
    await query(
      `UPDATE connection_state
          SET alerted_down = true, notified_at = $1, updated_at = now()
        WHERE id AND connected AND NOT alerted_down`,
      [anterior]
    );
    console.error("[connection] alerta de volta NÃO entregue — reenvia na próxima passada");
    return null;
  }

  console.log(`[connection] alerta de reconexão enviado (fora por ${foraPorMs} ms)`);
  return "volta";
}
