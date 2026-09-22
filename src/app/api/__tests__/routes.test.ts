import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * As rotas testadas COMO rotas — auth, status codes e descartes.
 *
 * O HMAC já era testado como função (`hmac.test.ts`), mas nunca como rota: a
 * comparação de segredo do webhook, o Bearer dos crons e os 401/403/409 do
 * `/notify` nunca tinham sido exercitados de ponta a ponta. Os handlers do App
 * Router são funções puras (NextRequest → NextResponse), então o custo é baixo
 * e o que se ganha é a camada que estava a zero.
 *
 * Tudo abaixo da rota é mockado: aqui o assunto é o contrato HTTP, não a fila.
 */

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/inbound", () => ({
  enqueueInbound: vi.fn().mockResolvedValue({ status: "queued", id: "row-1" }),
  processInboundNow: vi.fn().mockResolvedValue(undefined),
  sweepInbound: vi.fn().mockResolvedValue({ claimed: 0, done: 0, failed: 0, retry: 0, blocked: 0 }),
}));
vi.mock("@/lib/outbox", () => ({
  enqueue: vi.fn().mockResolvedValue({ status: "queued", id: "out-1", deliverAfter: new Date() }),
  dispatchDue: vi.fn().mockResolvedValue({ claimed: 0, sent: 0, failed: 0, blocked: 0 }),
}));
vi.mock("@/lib/orgs", () => ({
  isOrgKnown: vi.fn().mockResolvedValue(true),
  encrypt: vi.fn((s: string) => `enc:${s}`),
  __resetOrgCache: vi.fn(),
}));
vi.mock("@/lib/identity", () => ({
  clearIdentityCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/db", () => ({
  query: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/delivery", () => ({
  applyStatusCallback: vi.fn().mockResolvedValue({ outbox: 1, replies: 0 }),
  reconcile: vi.fn().mockResolvedValue({ unconfirmed: 0, reported: 0, reportFailed: 0 }),
}));
vi.mock("@/lib/zapi", async (orig) => ({
  ...(await orig<typeof import("@/lib/zapi")>()),
  connectionStatus: vi.fn().mockResolvedValue({ connected: true, raw: {} }),
}));
vi.mock("@/lib/connection", () => ({
  observeConnection: vi.fn().mockResolvedValue({
    connected: true,
    seeded: false,
    transicao: false,
    aguardandoConfirmacao: false,
    alertou: null,
  }),
}));

const { POST: webhookPost } = await import("../zapi-webhook/[secret]/route");
const { POST: statusPost } = await import("../zapi-status/[secret]/route");
const { POST: connPost, GET: connGet } = await import(
  "../zapi-connection/[secret]/route"
);
const { POST: notifyPost } = await import("../notify/route");
const { GET: cronInbound } = await import("../cron/inbound/route");
const { GET: cronOutbox } = await import("../cron/outbox/route");
const { GET: adminStatus } = await import("../admin/status/route");
const { sign } = await import("@/lib/hmac");
const { observeConnection } = await import("@/lib/connection");
const { connectionStatus } = await import("@/lib/zapi");
const { enqueueInbound } = await import("@/lib/inbound");
const { applyStatusCallback } = await import("@/lib/delivery");
const { enqueue: enqueueOutbox, dispatchDue } = await import("@/lib/outbox");
const dispatchDueMock = dispatchDue as unknown as ReturnType<typeof vi.fn>;

const observa = observeConnection as unknown as ReturnType<typeof vi.fn>;
const checaConexao = connectionStatus as unknown as ReturnType<typeof vi.fn>;
const enfileira = enqueueInbound as unknown as ReturnType<typeof vi.fn>;
const aplicaStatus = applyStatusCallback as unknown as ReturnType<typeof vi.fn>;
const enfileiraOut = enqueueOutbox as unknown as ReturnType<typeof vi.fn>;

const SECRET = "hmac-secret-de-teste";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ZAPI_WEBHOOK_SECRET", "hook-secret");
  vi.stubEnv("ZAPI_INSTANCE_ID", "INST");
  vi.stubEnv("MAX_NOTIFY_SECRET", SECRET);
  vi.stubEnv("CRON_SECRET", "cron-secret");
});
afterEach(() => vi.unstubAllEnvs());

function webhookReq(body: unknown, secret = "hook-secret") {
  return [
    new NextRequest(`http://max.test/api/zapi-webhook/${secret}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: { secret } },
  ] as const;
}

const MSG = {
  instanceId: "INST",
  messageId: "M1",
  phone: "5511987654321",
  text: { message: "oi" },
};

describe("POST /api/zapi-webhook/[secret]", () => {
  it("segredo errado é 404 — o endpoint não deve nem existir para quem sonda", async () => {
    const res = await webhookPost(...webhookReq(MSG, "errado"));
    expect(res.status).toBe(404);
  });

  it("sem ZAPI_WEBHOOK_SECRET é 500, nunca 200 silencioso", async () => {
    vi.stubEnv("ZAPI_WEBHOOK_SECRET", "");
    const res = await webhookPost(...webhookReq(MSG));
    expect(res.status).toBe(500);
    expect(enfileira).not.toHaveBeenCalled();
  });

  it("mensagem válida é aceita e enfileirada", async () => {
    const res = await webhookPost(...webhookReq(MSG));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(enfileira).toHaveBeenCalledOnce();
  });

  it("reação/sticker/status não viram linha na fila", async () => {
    for (const payload of [
      { ...MSG, reaction: { value: "👍" } },
      { ...MSG, sticker: { stickerUrl: "https://x/s.webp" } },
      { ...MSG, type: "MessageStatusCallback", status: "READ", ids: ["M1"] },
    ]) {
      const res = await webhookPost(...webhookReq(payload));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ignored: true });
    }
    expect(enfileira).not.toHaveBeenCalled();
  });

  it("instanceId de outra instância é ignorado", async () => {
    const res = await webhookPost(...webhookReq({ ...MSG, instanceId: "OUTRA" }));
    expect(res.status).toBe(200);
    expect(enfileira).not.toHaveBeenCalled();
  });
});

describe("POST /api/zapi-status/[secret]", () => {
  function statusCbReq(body: unknown, secret = "hook-secret") {
    return [
      new NextRequest(`http://max.test/api/zapi-status/${secret}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
      { params: { secret } },
    ] as const;
  }

  const CB = {
    instanceId: "INST",
    type: "MessageStatusCallback",
    status: "READ",
    ids: ["PROV-1"],
  };

  it("segredo errado é 404", async () => {
    expect((await statusPost(...statusCbReq(CB, "errado"))).status).toBe(404);
  });

  it("callback válido aplica o status", async () => {
    const res = await statusPost(...statusCbReq(CB));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: { outbox: 1 } });
    expect(aplicaStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "READ", messageIds: ["PROV-1"] })
    );
  });

  it("payload que não é status é ignorado sem tocar o banco", async () => {
    const res = await statusPost(
      ...statusCbReq({ instanceId: "INST", messageId: "M1", phone: "551199", text: { message: "oi" } })
    );
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(aplicaStatus).not.toHaveBeenCalled();
  });

  it("falha do banco ainda responde 200 — reentrega não resolveria", async () => {
    aplicaStatus.mockRejectedValueOnce(new Error("db fora"));
    const res = await statusPost(...statusCbReq(CB));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ error: true });
  });
});

function notifyReq(body: string, headers: Record<string, string>) {
  return new NextRequest("http://max.test/api/notify", {
    method: "POST",
    body,
    headers,
  });
}

const NOTIFY_BODY = JSON.stringify({
  orgId: "org1",
  audience: "platform_user",
  phone: "+5511987654321",
  dedupeKey: "n:1",
});

describe("POST /api/notify", () => {
  it("sem assinatura é 401", async () => {
    expect((await notifyPost(notifyReq(NOTIFY_BODY, {}))).status).toBe(401);
  });

  it("assinatura expirada é 401 indistinguível de inválida", async () => {
    const velho = String(Date.now() - 10 * 60_000);
    const res = await notifyPost(
      notifyReq(NOTIFY_BODY, {
        "x-max-timestamp": velho,
        "x-max-signature": sign(velho, NOTIFY_BODY, SECRET),
      })
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("assinatura válida enfileira e responde 202", async () => {
    const ts = String(Date.now());
    const res = await notifyPost(
      notifyReq(NOTIFY_BODY, {
        "x-max-timestamp": ts,
        "x-max-signature": sign(ts, NOTIFY_BODY, SECRET),
      })
    );
    expect(res.status).toBe(202);
    // O VALOR entregue à fila, não só a chamada: telefone cru no gateway já
    // custou perda silenciosa em produção (#189 e o ramo de corretor do
    // Newton em 2026-08). A Z-API quer E.164 SEM "+".
    // Valor E arity: sem a segunda, um /notify que enfileirasse duas vezes
    // (retry mal fechado) passaria neste teste e no de baixo.
    expect(enfileiraOut).toHaveBeenCalledOnce();
    expect(enfileiraOut).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "5511987654321" })
    );
  });

  it("telefone formatado chega à fila no formato da Z-API", async () => {
    // O caso que distingue o helper do replace inline: com "+5511..." os dois
    // coincidem; com telefone sujo, só a normalização acerta.
    const body = JSON.stringify({
      orgId: "org1",
      audience: "platform_user",
      phone: "(11) 98765-4321",
      dedupeKey: "n:2",
    });
    const ts = String(Date.now());
    const res = await notifyPost(
      notifyReq(body, {
        "x-max-timestamp": ts,
        "x-max-signature": sign(ts, body, SECRET),
      })
    );
    expect(res.status).toBe(202);
    expect(enfileiraOut).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "5511987654321" })
    );
  });

  /**
   * O corpo LITERAL que o contractmaker de produção manda desde cm#887/#888
   * (`notify-trigger.ts`): mesmas chaves, mesma ordem, `kind` e `params` por
   * último. Escrito à mão a partir de lá — não derivado do schema daqui —
   * para que um desalinhamento entre os dois repos quebre este teste.
   */
  const CORPO_DO_CM = JSON.stringify({
    orgId: "org1",
    audience: "deal_broker",
    phone: "+5511987654321",
    recipientName: "Ana Corretora",
    title: "Status do negócio atualizado",
    body: 'O negócio "Venda Apto 302" avançou para o status "Assinatura".',
    linkUrl: "https://trio.imobpro.ia.br/deals/cmx1",
    dealId: "cmx1",
    orgName: "RE/MAX Trio",
    dedupeKey: "log-abc",
    kind: "stage_change",
    params: { negocio: "Venda Apto 302", etapa: "Assinatura" },
  });

  async function postar(body: string) {
    const ts = String(Date.now());
    return notifyPost(
      notifyReq(body, { "x-max-timestamp": ts, "x-max-signature": sign(ts, body, SECRET) })
    );
  }

  it("kind e params do contractmaker chegam à fila", async () => {
    const res = await postar(CORPO_DO_CM);
    expect(res.status).toBe(202);
    expect(enfileiraOut).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "stage_change",
        params: { negocio: "Venda Apto 302", etapa: "Assinatura" },
        linkUrl: "https://trio.imobpro.ia.br/deals/cmx1",
      })
    );
  });

  it("emissor antigo (sem kind/params) segue 202, com os dois nulos", async () => {
    const res = await postar(NOTIFY_BODY);
    expect(res.status).toBe(202);
    expect(enfileiraOut).toHaveBeenCalledWith(expect.objectContaining({ kind: null, params: null }));
  });

  /**
   * Um enfeite ruim não pode custar a notificação: 400 aqui faria o
   * contractmaker marcar `failed` e o aviso nunca sairia.
   */
  it("kind/params fora do formato viram ausentes — nunca 400", async () => {
    const base = JSON.parse(CORPO_DO_CM);
    for (const ruim of [
      { kind: "Tipo Com Espaço", params: "texto" },
      { kind: 42, params: ["a"] },
      { kind: "", params: { "Chave Ruim": "x", ok: 7, vazio: "  " } },
    ]) {
      enfileiraOut.mockClear();
      const res = await postar(JSON.stringify({ ...base, ...ruim }));
      expect(res.status).toBe(202);
      expect(enfileiraOut).toHaveBeenCalledWith(expect.objectContaining({ kind: null, params: null }));
    }
  });

  it("params: quebra de linha vira espaço e só as chaves válidas ficam", async () => {
    const base = JSON.parse(CORPO_DO_CM);
    await postar(JSON.stringify({ ...base, params: { negocio: "Casa\nna praia", "X-Y": "fora", prazo: "30/09" } }));
    expect(enfileiraOut).toHaveBeenCalledWith(
      expect.objectContaining({ params: { negocio: "Casa na praia", prazo: "30/09" } })
    );
  });

  it("chave desconhecida no corpo é descartada, não recusada (nada de .strict())", async () => {
    const base = JSON.parse(CORPO_DO_CM);
    const res = await postar(JSON.stringify({ ...base, campoDoFuturo: { x: 1 } }));
    expect(res.status).toBe(202);
  });

  it("duplicata é 409 — o contrato que o ImobPro lê como 'já assumido'", async () => {
    enfileiraOut.mockResolvedValueOnce({ status: "duplicate", id: "out-1" });
    const ts = String(Date.now());
    const res = await notifyPost(
      notifyReq(NOTIFY_BODY, {
        "x-max-timestamp": ts,
        "x-max-signature": sign(ts, NOTIFY_BODY, SECRET),
      })
    );
    expect(res.status).toBe(409);
  });
});

describe("crons", () => {
  const semAuth = new NextRequest("http://max.test/api/cron/x");
  const comAuth = new NextRequest("http://max.test/api/cron/x", {
    headers: { authorization: "Bearer cron-secret" },
  });

  it("sem Bearer é 401 nos dois", async () => {
    expect((await cronInbound(semAuth)).status).toBe(401);
    expect((await cronOutbox(semAuth)).status).toBe(401);
  });

  it("com Bearer responde os totais", async () => {
    expect((await cronInbound(comAuth)).status).toBe(200);
    expect((await cronOutbox(comAuth)).status).toBe(200);
  });

  /**
   * Antes da F7 o estado da instância só era checado com fila vencida — e com
   * a fila vazia uma queda era invisível para o cron. Agora pergunta sempre,
   * uma vez, e repassa a resposta ao despacho.
   */
  it("o cron do outbox observa a conexão em TODA passada", async () => {
    await cronOutbox(comAuth);
    expect(observa).toHaveBeenCalledWith({ connected: true, fonte: "cron" });
    expect(checaConexao).toHaveBeenCalledTimes(1);
    // O 3º argumento é a âncora do orçamento da passada (`iniciadoEm`).
    expect(dispatchDueMock).toHaveBeenCalledWith(
      50,
      { connected: true, raw: {} },
      expect.any(Number)
    );
  });

  /**
   * Não conseguir PERGUNTAR não é estar desconectado — é a lição do 401 de
   * credencial que virou "instância desemparelhada" em 21/08. O despacho
   * segue (fail-open, `null`).
   *
   * Mas a máquina de estado É informada, como `inacessivel` (2026-09-12): ela
   * exige quinze passadas assim antes de alertar. Até então nada era
   * observado — e foi por isso que a assinatura cancelada de 10/09, que na
   * época caía aqui, passou dois dias sem e-mail.
   */
  it("falha ao checar a instância observa `inacessivel`, segue em fail-open e não derruba o cron", async () => {
    checaConexao.mockRejectedValueOnce(new Error("503 — upstream"));
    expect((await cronOutbox(comAuth)).status).toBe(200);
    expect(observa).toHaveBeenCalledWith({
      connected: false,
      fonte: "cron",
      motivo: "inacessivel",
    });
    expect(dispatchDueMock).toHaveBeenCalledWith(50, null, expect.any(Number));
  });

  /**
   * Inoperante (assinatura cancelada, credencial trocada) é leitura
   * DEFINITIVA: `connected:false` com motivo. Vai para a máquina de estado
   * com o motivo e para o despacho como estado conhecido — que represa.
   */
  it("instância inoperante: observa com o motivo e repassa ao despacho", async () => {
    const inoperante = {
      connected: false,
      raw: { status: 400 },
      inoperante: { motivo: "assinatura", detalhe: "Z-API /status 400: must subscribe" },
    };
    checaConexao.mockResolvedValueOnce(inoperante);
    expect((await cronOutbox(comAuth)).status).toBe(200);
    expect(observa).toHaveBeenCalledWith({
      connected: false,
      fonte: "cron",
      motivo: "assinatura",
    });
    expect(dispatchDueMock).toHaveBeenCalledWith(50, inoperante, expect.any(Number));
  });

  /**
   * O `/status` disse "conectada" e o `send-text` recusou: leitura defasada.
   * A recusa é evento (fonte `envio`) — sem isto o cron releria "conectada"
   * a cada minuto e a queda nunca seria anunciada.
   */
  it("envio recusado por inoperância informa a máquina de estado por `envio`", async () => {
    dispatchDueMock.mockResolvedValueOnce({
      claimed: 2,
      sent: 0,
      failed: 0,
      blocked: 2,
      inoperante: { motivo: "assinatura", detalhe: "Z-API /send-text 400" },
    });
    expect((await cronOutbox(comAuth)).status).toBe(200);
    expect(observa).toHaveBeenCalledWith({ connected: true, fonte: "cron" });
    expect(observa).toHaveBeenLastCalledWith({
      connected: false,
      fonte: "envio",
      motivo: "assinatura",
    });
  });
});

describe("POST /api/zapi-connection/[secret]", () => {
  function req(secret: string) {
    return [
      new NextRequest(`http://max.test/api/zapi-connection/${secret}`, {
        method: "POST",
        body: JSON.stringify({ instanceId: "INST", connected: false }),
        headers: { "content-type": "application/json" },
      }),
      { params: { secret } },
    ] as const;
  }

  it("segredo errado é 404 — para quem sonda, a rota não existe", async () => {
    const res = await connPost(...req("errado"));
    expect(res.status).toBe(404);
    expect(observa).not.toHaveBeenCalled();
  });

  /**
   * A rota NÃO confia no corpo: o POST é gatilho, e o estado vem de
   * `connectionStatus()`. O payload acima diz `connected: false` e o que vale
   * é o `true` da checagem — é o que a torna imune ao formato do callback, a
   * reentrega e a callback fora de ordem.
   */
  it("ignora o corpo e observa o que a checagem disser", async () => {
    const res = await connPost(...req("hook-secret"));
    expect(res.status).toBe(200);
    expect(checaConexao).toHaveBeenCalledTimes(1);
    expect(observa).toHaveBeenCalledWith({ connected: true, fonte: "push" });
  });

  it("checagem falhando responde 200 sem observar — o cron cobre depois", async () => {
    checaConexao.mockRejectedValueOnce(new Error("timeout"));
    const res = await connPost(...req("hook-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, checked: false });
    expect(observa).not.toHaveBeenCalled();
  });

  /** Inoperante também é `connected:false` — e o motivo vai para o e-mail. */
  it("checagem dizendo inoperante observa a queda com o motivo", async () => {
    checaConexao.mockResolvedValueOnce({
      connected: false,
      raw: {},
      inoperante: { motivo: "credencial", detalhe: "Z-API /status 401" },
    });
    const res = await connPost(...req("hook-secret"));
    expect(res.status).toBe(200);
    expect(observa).toHaveBeenCalledWith({
      connected: false,
      fonte: "push",
      motivo: "credencial",
    });
  });

  it("o GET confere a URL do painel sem mandar evento", async () => {
    const res = await connGet(...req("hook-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handler: "connection" });
    expect(observa).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/status — a query entra na assinatura", () => {
  function statusReq(query: string, signedPayload: string | null) {
    const ts = String(Date.now());
    const headers: Record<string, string> = {};
    if (signedPayload !== null) {
      headers["x-max-timestamp"] = ts;
      headers["x-max-signature"] = sign(ts, signedPayload, SECRET);
    }
    return new NextRequest(`http://max.test/api/admin/status${query}`, { headers });
  }

  it("formato novo: método + path + query assinados", async () => {
    const res = await adminStatus(
      statusReq("?orgId=org1", "GET./api/admin/status?orgId=org1")
    );
    expect(res.status).toBe(200);
  });

  it("assinatura de UMA query não vale para outra org", async () => {
    // Captura da assinatura de ?orgId=org1 reusada com ?orgId=org2 — era o
    // replay cross-tenant que o corpo-vazio permitia.
    const ts = String(Date.now());
    const res = await adminStatus(
      new NextRequest("http://max.test/api/admin/status?orgId=org2", {
        headers: {
          "x-max-timestamp": ts,
          "x-max-signature": sign(ts, "GET./api/admin/status?orgId=org1", SECRET),
        },
      })
    );
    expect(res.status).toBe(401);
  });

  it("formato antigo (corpo vazio) é RECUSADO — max#21", async () => {
    // A tolerância caiu em 2026-08-28. Este caso inverteu de propósito: era o
    // teste que travava a aceitação, e agora é o que trava a recusa. Enquanto
    // ela existia, uma assinatura de corpo vazio capturada valia 5 minutos para
    // QUALQUER org, porque o `?orgId=` ficava fora do que era assinado.
    expect((await adminStatus(statusReq("", ""))).status).toBe(401);
  });

  it("sem assinatura é 401", async () => {
    expect((await adminStatus(statusReq("", null))).status).toBe(401);
  });
});
