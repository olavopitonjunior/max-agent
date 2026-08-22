import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * A máquina de transição da conexão — o motor do alerta de queda (F7).
 *
 * Integração de verdade contra o Postgres porque o que está sob teste É SQL:
 * o upsert de semeadura, o `UPDATE ... WHERE NOT alerted_down` que serve de
 * claim (e impede push e cron concorrentes de mandarem dois e-mails) e o CTE
 * que devolve o `notified_at` anterior para poder desfazer o claim. Nenhum dos
 * três se prova com mock — mock devolve o que eu mandar ele devolver.
 *
 * Pula sem `DATABASE_URL`, para `npm test` seguir verde no CI.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

vi.mock("../cm", () => ({ reportAlert: vi.fn() }));

const { observeConnection } = await import("../connection");
const { query, db } = await import("../db");
const { reportAlert } = await import("../cm");

const alerta = reportAlert as unknown as ReturnType<typeof vi.fn>;

/** Só o que este arquivo escreve: a linha única de `connection_state`. */
async function limpar() {
  await query(`DELETE FROM connection_state`);
  await query(`DELETE FROM outbox WHERE org_id = 'org-conn-test'`);
}

async function estado() {
  const [r] = await query<{
    connected: boolean;
    down_since: Date | null;
    alerted_down: boolean;
    queda_pendente: boolean;
    notified_at: Date | null;
    miss_streak: number;
  }>(`SELECT connected, down_since, alerted_down, queda_pendente,
             notified_at, miss_streak
        FROM connection_state WHERE id`);
  return r;
}

/** Uma notificação vencida, para o alerta ter o que contar como represada. */
async function enfileirarVencida(n: number) {
  for (let i = 0; i < n; i++) {
    await query(
      `INSERT INTO outbox (id, org_id, dedupe_key, audience, phone, status, deliver_after)
            VALUES ($1, 'org-conn-test', $1, 'platform_user', '5511987654321',
                    'pending', now() - interval '1 minute')`,
      [`conn-${i}-${Math.random().toString(36).slice(2)}`]
    );
  }
}

/** Envelhece o último e-mail, para o debounce de 1h não bloquear o cenário. */
async function envelhecerNotificacao() {
  await query(
    `UPDATE connection_state SET notified_at = now() - interval '2 hours' WHERE id`
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  alerta.mockResolvedValue(true);
  if (hasDb) await limpar();
});

afterAll(async () => {
  if (hasDb) {
    await limpar();
    await db().end();
  }
});

d("observeConnection", () => {
  /**
   * A migration não semeia de propósito: gravar `connected = true` lá
   * afirmaria um estado que ninguém observou. A primeira observação insere e
   * NÃO alerta — sem crença anterior não existe transição.
   */
  it("a primeira observação semeia e não alerta", async () => {
    const r = await observeConnection({ connected: false, fonte: "cron" });
    expect(r.seeded).toBe(true);
    expect(r.alertou).toBeNull();
    expect(alerta).not.toHaveBeenCalled();

    const e = await estado();
    expect(e.connected).toBe(false);
    expect(e.down_since).not.toBeNull();
  });

  it("caiu → alerta, com o número de represadas no payload", async () => {
    await observeConnection({ connected: true, fonte: "cron" }); // semeia
    await enfileirarVencida(4);

    // Cron exige duas passadas discordando.
    await observeConnection({ connected: false, fonte: "cron" });
    const r = await observeConnection({ connected: false, fonte: "cron" });

    expect(r.alertou).toBe("queda");
    expect(alerta).toHaveBeenCalledTimes(1);
    expect(alerta.mock.calls[0][0]).toMatchObject({
      evento: "zapi_desconectada",
      represadas: 4,
    });
    expect((await estado()).alerted_down).toBe(true);
  });

  /**
   * O ponto do trabalho inteiro: alertar por ESTADO seriam 1.440 e-mails por
   * dia, porque o cron roda a cada minuto.
   */
  it("continua caído → nenhum segundo alerta, por mais que se insista", async () => {
    await observeConnection({ connected: true, fonte: "cron" });
    await observeConnection({ connected: false, fonte: "push" });
    expect(alerta).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 10; i++) {
      const r = await observeConnection({ connected: false, fonte: "cron" });
      expect(r.alertou).toBeNull();
    }
    expect(alerta).toHaveBeenCalledTimes(1);
  });

  /**
   * O teste acima roda em milissegundos, então quem segura as dez repetições é
   * o DEBOUNCE — não o `alerted_down`. Este isola o `alerted_down`: passada a
   * janela de uma hora, o debounce deixa de proteger e só o invariante impede
   * o reenvio.
   *
   * A distinção não é acadêmica: é a diferença entre **um e-mail por queda** e
   * **um e-mail por hora de queda**. Uma instância fora por três dias mandaria
   * setenta e dois. Descoberto por teste de mutação — o caso anterior passava
   * mesmo com a condição removida.
   */
  it("continua caído DEPOIS da janela do debounce — ainda um e-mail só", async () => {
    await observeConnection({ connected: true, fonte: "cron" });
    await observeConnection({ connected: false, fonte: "push" });
    expect(alerta).toHaveBeenCalledTimes(1);

    await envelhecerNotificacao(); // a hora passou; o debounce não protege mais
    const r = await observeConnection({ connected: false, fonte: "cron" });

    expect(r.alertou).toBeNull();
    expect(alerta).toHaveBeenCalledTimes(1);
    expect((await estado()).alerted_down).toBe(true);
  });

  it("voltou → alerta de reconexão com o tempo fora", async () => {
    await observeConnection({ connected: true, fonte: "cron" });
    await observeConnection({ connected: false, fonte: "push" });
    await query(
      `UPDATE connection_state SET down_since = now() - interval '2 hours' WHERE id`
    );

    const r = await observeConnection({ connected: true, fonte: "push" });
    expect(r.alertou).toBe("volta");
    expect(alerta).toHaveBeenCalledTimes(2);

    const payload = alerta.mock.calls[1][0];
    expect(payload.evento).toBe("zapi_reconectada");
    // ~2h, com folga para o tempo de execução do teste.
    expect(payload.foraPorMs).toBeGreaterThan(115 * 60_000);
    expect(payload.foraPorMs).toBeLessThan(125 * 60_000);
    expect((await estado()).alerted_down).toBe(false);
  });

  /**
   * O outro lado do invariante de `alerted_down`: celebrar o fim de um
   * problema que ninguém soube que existiu confunde mais do que informa.
   */
  it("volta sem queda anunciada não manda e-mail nenhum", async () => {
    await observeConnection({ connected: false, fonte: "cron" }); // semeia caído
    const r = await observeConnection({ connected: true, fonte: "push" });
    expect(r.transicao).toBe(true);
    expect(r.alertou).toBeNull();
    expect(alerta).not.toHaveBeenCalled();
  });

  it("uma passada só do cron não alerta — precisa de duas", async () => {
    await observeConnection({ connected: true, fonte: "cron" });

    const r = await observeConnection({ connected: false, fonte: "cron" });
    expect(r.aguardandoConfirmacao).toBe(true);
    expect(r.connected).toBe(true); // o gravado ainda diz conectada
    expect(alerta).not.toHaveBeenCalled();
    expect((await estado()).miss_streak).toBe(1);
  });

  /** Discordância isolada é ruído: o contador zera quando volta a concordar. */
  it("o contador do cron zera quando a leitura volta a concordar", async () => {
    await observeConnection({ connected: true, fonte: "cron" });
    await observeConnection({ connected: false, fonte: "cron" });
    expect((await estado()).miss_streak).toBe(1);

    await observeConnection({ connected: true, fonte: "cron" });
    expect((await estado()).miss_streak).toBe(0);
    expect(alerta).not.toHaveBeenCalled();
  });

  /** É a diferença que justifica a rota de callback existir. */
  it("o push age na PRIMEIRA discordância", async () => {
    await observeConnection({ connected: true, fonte: "cron" });
    const r = await observeConnection({ connected: false, fonte: "push" });
    expect(r.transicao).toBe(true);
    expect(r.alertou).toBe("queda");
  });

  /**
   * O TESTE QUE SUSTENTA O RETRY. O carimbo só acontece quando o e-mail SAI;
   * um POST que falha volta o estado ao que era e a passada seguinte reenvia.
   * Sem isto, o 500 do receptor não teria efeito nenhum.
   */
  it("envio que falha não carimba, e a passada seguinte reenvia", async () => {
    await observeConnection({ connected: true, fonte: "cron" });
    await envelhecerNotificacao();

    alerta.mockResolvedValueOnce(false);
    const r1 = await observeConnection({ connected: false, fonte: "push" });
    expect(r1.alertou).toBeNull();
    const e1 = await estado();
    expect(e1.alerted_down).toBe(false);
    // `notified_at` volta ao valor ANTERIOR — senão o debounce de 1h bloquearia
    // o próprio retry que este desenho existe para permitir.
    expect(e1.notified_at!.getTime()).toBeLessThan(Date.now() - 60 * 60_000);

    const r2 = await observeConnection({ connected: false, fonte: "cron" });
    expect(r2.alertou).toBe("queda");
    expect((await estado()).alerted_down).toBe(true);
  });

  it("reconexão que falha também reenvia depois", async () => {
    await observeConnection({ connected: true, fonte: "cron" });
    await observeConnection({ connected: false, fonte: "push" });

    alerta.mockResolvedValueOnce(false);
    const r1 = await observeConnection({ connected: true, fonte: "push" });
    expect(r1.alertou).toBeNull();
    expect((await estado()).alerted_down).toBe(true); // claim desfeito

    const r2 = await observeConnection({ connected: true, fonte: "cron" });
    expect(r2.alertou).toBe("volta");
  });

  /**
   * Flapping: cai, volta e cai de novo em minutos. Sem o debounce seriam três
   * e-mails para um problema só — e alerta que se aprende a ignorar é pior
   * que nenhum.
   */
  it("debounce de 1h segura a segunda queda em sequência", async () => {
    await observeConnection({ connected: true, fonte: "cron" });
    await observeConnection({ connected: false, fonte: "push" }); // e-mail 1
    await observeConnection({ connected: true, fonte: "push" }); // e-mail 2
    expect(alerta).toHaveBeenCalledTimes(2);

    const r = await observeConnection({ connected: false, fonte: "push" });
    expect(r.transicao).toBe(true); // o ESTADO muda...
    expect(r.alertou).toBeNull(); // ...mas o e-mail não sai
    expect(alerta).toHaveBeenCalledTimes(2);
  });

  /**
   * `represadas: 0` é notícia legítima e não silencia nada: a queda derruba o
   * inbound também, e quem escrever para o Max fica sem resposta.
   */
  it("fila vazia não impede o alerta", async () => {
    await observeConnection({ connected: true, fonte: "cron" });
    const r = await observeConnection({ connected: false, fonte: "push" });
    expect(r.alertou).toBe("queda");
    expect(alerta.mock.calls[0][0].represadas).toBe(0);
  });

  /**
   * A PROPRIEDADE CENTRAL DO ARQUIVO, que até aqui só existia em prosa: o
   * claim é o que impede push e cron simultâneos de mandarem dois e-mails.
   * Sob READ COMMITTED o segundo UPDATE bloqueia no lock da linha e reavalia
   * `NOT alerted_down` contra a versão nova, devolvendo zero linhas — mas
   * "deve funcionar" e "funciona" são coisas diferentes.
   */
  it("duas observações CONCORRENTES mandam UM e-mail só", async () => {
    await observeConnection({ connected: true, fonte: "cron" });

    const rs = await Promise.all([
      observeConnection({ connected: false, fonte: "push" }),
      observeConnection({ connected: false, fonte: "push" }),
    ]);

    expect(alerta).toHaveBeenCalledTimes(1);
    expect(rs.filter((r) => r.alertou === "queda")).toHaveLength(1);
    expect((await estado()).alerted_down).toBe(true);
  });

  /**
   * B1 do gate: o rollback de um envio que falhou NÃO pode passar por cima de
   * um e-mail que já saiu. Sequência: reivindica a queda → a instância volta e
   * o e-mail de reconexão sai → só então o POST da queda falha. Sem a cerca no
   * WHERE, o rollback rebobinaria `alerted_down`/`notified_at` e o operador
   * ficaria com um "reconectada" sem nunca ter sido avisado da queda.
   */
  it("rollback não desfaz um alerta que já saiu depois dele", async () => {
    await observeConnection({ connected: true, fonte: "cron" });
    await observeConnection({ connected: false, fonte: "push" }); // e-mail 1
    const notifiedDepoisDaQueda = (await estado()).notified_at!;

    // Simula o estado em que a volta já foi anunciada...
    await observeConnection({ connected: true, fonte: "push" }); // e-mail 2
    const depoisDaVolta = await estado();
    expect(depoisDaVolta.alerted_down).toBe(false);

    // ...e agora chega o rollback atrasado de uma queda que falhou.
    await query(
      `UPDATE connection_state
          SET alerted_down = false, notified_at = $1, updated_at = now()
        WHERE id AND NOT connected AND alerted_down`,
      [notifiedDepoisDaQueda]
    );

    const final = await estado();
    expect(final.alerted_down).toBe(false);
    // O carimbo do e-mail de volta sobreviveu — o rollback foi no-op.
    expect(final.notified_at!.getTime()).toBe(depoisDaVolta.notified_at!.getTime());
  });

  /**
   * O preço do debounce, fixado como DECISÃO e não como acaso: a segunda queda
   * fica atrasada, nunca perdida. Assim que a janela expira, o ramo
   * derivado-do-estado reenvia sozinho, sem transição nova.
   */
  it("a queda segurada pelo debounce sai sozinha quando a janela expira", async () => {
    await observeConnection({ connected: true, fonte: "cron" });
    await observeConnection({ connected: false, fonte: "push" });
    await observeConnection({ connected: true, fonte: "push" });
    await observeConnection({ connected: false, fonte: "push" }); // segurada
    expect(alerta).toHaveBeenCalledTimes(2);

    await envelhecerNotificacao(); // a janela de 1h passou
    const r = await observeConnection({ connected: false, fonte: "cron" });
    expect(r.transicao).toBe(false); // sem transição nova: o estado já era esse
    expect(r.alertou).toBe("queda");
    expect(alerta).toHaveBeenCalledTimes(3);
  });

  /**
   * O BURACO DE SILÊNCIO TOTAL, achado no code review.
   *
   * Queda → volta → queda de novo dentro da hora (segurada pelo debounce) →
   * volta de novo. Como `alerted_down` nunca chegou a ser marcado na segunda
   * queda, o alerta de reconexão também não saía: uma queda inteira, com a
   * fila represada e o inbound morto, não era anunciada a NINGUÉM. É o oposto
   * do que este arquivo existe para garantir, e contradizia a promessa
   * "atrasada, nunca perdida".
   *
   * Com `queda_pendente`, a reconexão conta a história inteira — uma mensagem
   * em vez de duas (que era o ponto do debounce), nunca zero.
   */
  it("queda segurada e recuperada dentro da janela AINDA é anunciada", async () => {
    await observeConnection({ connected: true, fonte: "cron" });
    await observeConnection({ connected: false, fonte: "push" }); // e-mail 1
    await observeConnection({ connected: true, fonte: "push" }); // e-mail 2

    // Segunda queda, dentro da janela de 1h: o debounce segura o e-mail.
    const caiu = await observeConnection({ connected: false, fonte: "push" });
    expect(caiu.alertou).toBeNull();
    expect((await estado()).queda_pendente).toBe(true);

    // E a instância volta ANTES de a janela expirar.
    await query(
      `UPDATE connection_state SET down_since = now() - interval '35 minutes' WHERE id`
    );
    const voltou = await observeConnection({ connected: true, fonte: "push" });

    expect(voltou.alertou).toBe("volta");
    expect(alerta).toHaveBeenCalledTimes(3);
    const payload = alerta.mock.calls[2][0];
    expect(payload.evento).toBe("zapi_reconectada");
    expect(payload.foraPorMs).toBeGreaterThan(34 * 60_000);

    const fim = await estado();
    expect(fim.queda_pendente).toBe(false);
    expect(fim.alerted_down).toBe(false);
  });

  /**
   * O LATCH, também do code review. Um alerta de volta que falha para sempre
   * deixava `alerted_down = true` travado, e a cerca do `alertarQueda` passava
   * a suprimir TODA queda futura — o operador só receberia "reconectada" de
   * uma queda que nunca lhe foi anunciada. Queda nova zera a escrituração do
   * incidente anterior.
   */
  it("volta que nunca entrega não trava as quedas seguintes", async () => {
    await observeConnection({ connected: true, fonte: "cron" });
    await observeConnection({ connected: false, fonte: "push" }); // e-mail 1
    await envelhecerNotificacao();

    alerta.mockResolvedValue(false); // a volta nunca entrega
    await observeConnection({ connected: true, fonte: "push" });
    expect((await estado()).alerted_down).toBe(true); // latch armado

    // Nova queda: tem que ser anunciada, não engolida pelo latch.
    alerta.mockResolvedValue(true);
    const r = await observeConnection({ connected: false, fonte: "push" });

    expect(r.alertou).toBe("queda");
    expect(alerta.mock.calls.at(-1)![0].evento).toBe("zapi_desconectada");
  });

  /**
   * Achado 4: com o cron ainda juntando confirmações, o retry derivado do
   * estado tem que rodar assim mesmo — ele é o substituto da fila de retry, e
   * pular uma passada por causa de um hiccup do `/status` atrasaria justamente
   * o mecanismo que garante a entrega.
   */
  it("aguardando confirmação do cron NÃO adia o reenvio pendente", async () => {
    await observeConnection({ connected: true, fonte: "cron" });
    await envelhecerNotificacao();

    alerta.mockResolvedValueOnce(false);
    await observeConnection({ connected: false, fonte: "push" }); // falhou
    expect((await estado()).alerted_down).toBe(false);

    // Agora o `/status` dá um hiccup e diz "conectada" (discorda do gravado).
    const r = await observeConnection({ connected: true, fonte: "cron" });

    expect(r.aguardandoConfirmacao).toBe(true);
    expect(r.transicao).toBe(false); // nada commitado
    expect(r.alertou).toBe("queda"); // mas o reenvio saiu
  });

  /** A tabela é de linha única, e isso é estrutural — não convenção. */
  it("a segunda linha é impossível", async () => {
    await observeConnection({ connected: true, fonte: "cron" });
    await expect(
      query(`INSERT INTO connection_state (id, connected) VALUES (false, false)`)
    ).rejects.toThrow();
  });
});
