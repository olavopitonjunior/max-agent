import { describe, expect, it, vi } from "vitest";

const query = vi.fn();
const sendText = vi.fn();
// Keep the real privacy/delivery fences; only the SQL boundary is synthetic.
// The selected queue row exists at epoch zero, so the provider rejection is
// reached through the same marker + transaction path as production.
const rawQuery = async (sql: string, params: unknown[] = []) => {
  if (sql.startsWith("SELECT id FROM outbox") || sql.startsWith("SELECT id FROM inbound_queue")) {
    return { rows: [{ id: params[0] }] };
  }
  return { rows: await query(sql, params) };
};
vi.mock("../db", () => ({
  query,
  db: () => ({
    query: rawQuery,
    connect: async () => ({ query: rawQuery, release: vi.fn() }),
  }),
}));
vi.mock("../transport", () => ({
  sendText,
  sendTemplate: vi.fn(),
  connectionStatus: vi.fn().mockResolvedValue({ connected: true }),
  markReadTyping: vi.fn().mockResolvedValue(true),
  provider: () => "meta",
  capabilities: () => ({ templates: true, window24h: true, media: true, groups: false, status: true, typing: true, interactive: true }),
}));
vi.mock("../janela24h", () => ({ janelaAberta: vi.fn().mockResolvedValue(true), abrirJanela: vi.fn() }));
vi.mock("@/graph/graph", () => ({ seedNotification: vi.fn(), runTurn: vi.fn() }));
vi.mock("../connection", () => ({ observeConnection: vi.fn() }));
const remetenteConhecido = vi.fn().mockResolvedValue(true);
vi.mock("../identity", () => ({ remetenteConhecido, resolveIdentity: vi.fn() }));

const { MetaHttpError } = await import("../transport/erro");
const { dispatchDue } = await import("../outbox");
const { runQueued } = await import("../inbound");

const erro = (code: number) => new MetaHttpError("/messages", 400, JSON.stringify({ error: { code, message: "recusado" } }));

describe("recusa Meta 131048/131049", () => {
  it.each([131048, 131049])("outbox liquida %i como falha terminal, com código, sem reagendar", async (code) => {
    query.mockReset();
    sendText.mockReset().mockRejectedValue(erro(code));
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT count(*)::int AS due")) return [{ due: 1 }];
      if (sql.includes("RETURNING id, org_id")) return [{
        id: "out-1", org_id: "org-1", audience: "platform_user", phone: "5511999990000",
        title: "Aviso", body: "Corpo", link_url: null, org_name: "Org", recipient_name: "Pessoa",
        attempts: 1, send_started_at: null, kind: "manual_message", params: null,
        last_error: null, created_at: new Date(),
      }];
      return [];
    });

    const totals = await dispatchDue(1, { connected: true });
    expect(totals.failed).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    const updates = query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE outbox"));
    expect(updates.some(([sql, params]) => String(sql).includes("status = 'failed'") && params.includes(code))).toBe(true);
    expect(updates.some(([sql]) => String(sql).includes("deliver_after = CASE"))).toBe(false);
  });

  it.each([131048, 131049])("outbox repete somente a gravação se o banco falhar após a recusa %i", async (code) => {
    query.mockReset();
    sendText.mockReset().mockRejectedValue(erro(code));
    let gravacoes = 0;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT count(*)::int AS due")) return [{ due: 1 }];
      if (sql.includes("RETURNING id, org_id")) return [{
        id: "out-2", org_id: "org-1", audience: "platform_user", phone: "5511999990000",
        title: "Aviso", body: "Corpo", link_url: null, org_name: "Org", recipient_name: "Pessoa",
        attempts: 1, send_started_at: null, kind: "manual_message", params: null,
        last_error: null, created_at: new Date(),
      }];
      if (sql.includes("SET status = 'failed', error_code")) {
        gravacoes += 1;
        if (gravacoes === 1) throw new Error("Neon temporariamente indisponível");
      }
      return [];
    });

    expect((await dispatchDue(1, { connected: true })).failed).toBe(1);
    expect(gravacoes).toBe(2);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("deliver_after = CASE"))).toBe(false);
  });

  it.each([131048, 131049])("inbound encerra a resposta recusada %i sem tentar novamente", async (code) => {
    query.mockReset().mockResolvedValue([]);
    sendText.mockReset().mockRejectedValue(erro(code));
    const row = {
      id: "in-1", message_id: "wamid.in-1", from_phone: "5511999990000", group_id: null,
      kind: "text", text: "oi", media_url: null, mime_type: null, sender_name: null,
      reply_to_message_id: null, timestamp_ms: null, button_payload: null,
      attempts: 1, reply_text: "Resposta pronta", last_send_started_at: null,
    };

    expect(await runQueued(row)).toBe("failed");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("last_send_started_at = NULL"))).toBe(true);
    expect(query.mock.calls.some(([sql, params]) => String(sql).includes("SET status = 'failed'") && String(params[1]).includes(`#${code}`))).toBe(true);
  });

  /**
   * "Lida + digitando…" liga no início do turno (antes do modelo), uma vez por
   * mensagem: a retentativa não repete e o reenvio de resposta pronta não passa
   * por aqui. Fire-and-forget: a falha do indicador não derruba o turno.
   */
  it("inbound liga o digitando uma vez, na primeira tentativa, antes do modelo", async () => {
    const { markReadTyping } = await import("../transport");
    const { runTurn } = await import("@/graph/graph");
    const typing = vi.mocked(markReadTyping);
    const ordem: string[] = [];
    typing.mockReset().mockImplementation(async () => { ordem.push("typing"); return true; });
    vi.mocked(runTurn).mockReset().mockImplementation((async () => { ordem.push("modelo"); return { reply: null }; }) as never);
    query.mockReset().mockResolvedValue([]);
    const base = {
      id: "in-9", message_id: "wamid.in-9", from_phone: "5511999990000", group_id: null,
      kind: "text", text: "oi", media_url: null, mime_type: null, sender_name: null,
      reply_to_message_id: null, timestamp_ms: null, button_payload: null,
      reply_text: null, last_send_started_at: null,
    };

    expect(await runQueued({ ...base, attempts: 1 })).toBe("done");
    expect(typing).toHaveBeenCalledTimes(1);
    expect(typing).toHaveBeenCalledWith("wamid.in-9");
    expect(ordem).toEqual(["typing", "modelo"]);

    typing.mockClear();
    expect(await runQueued({ ...base, attempts: 2 })).toBe("done");
    expect(typing).not.toHaveBeenCalled();

    // Indicador que rejeita não derruba o turno.
    typing.mockRejectedValue(new Error("boom"));
    expect(await runQueued({ ...base, attempts: 1 })).toBe("done");
  });

  it("remetente desconhecido não vê 'lida + digitando' (o grafo pode não responder)", async () => {
    const { markReadTyping } = await import("../transport");
    const { runTurn } = await import("@/graph/graph");
    const typing = vi.mocked(markReadTyping);
    typing.mockReset().mockResolvedValue(true);
    vi.mocked(runTurn).mockReset().mockResolvedValue({ reply: null } as never);
    query.mockReset().mockResolvedValue([]);
    remetenteConhecido.mockReset().mockResolvedValue(false);
    const row = {
      id: "in-10", message_id: "wamid.in-10", from_phone: "5511988880000", group_id: null,
      kind: "text", text: "oi", media_url: null, mime_type: null, sender_name: null,
      reply_to_message_id: null, timestamp_ms: null, button_payload: null,
      reply_text: null, last_send_started_at: null, attempts: 1,
    };
    expect(await runQueued(row)).toBe("done");
    expect(remetenteConhecido).toHaveBeenCalledWith("5511988880000");
    expect(typing).not.toHaveBeenCalled();
    expect(runTurn).toHaveBeenCalledTimes(1);
    remetenteConhecido.mockResolvedValue(true);
  });
});

describe("resposta do turno com botões", () => {
  const row = (id: string) => ({
    id, message_id: `wamid.${id}`, from_phone: "5511999990000", group_id: null,
    kind: "text", text: "conclui a atividade", media_url: null, mime_type: null, sender_name: null,
    reply_to_message_id: null, timestamp_ms: null, button_payload: null,
    reply_text: null, last_send_started_at: null, attempts: 1,
  });

  it("'Responda SIM … NÃO' vai com os botões; o texto numerado segue junto como fallback", async () => {
    const { runTurn } = await import("@/graph/graph");
    const reply = "Posso concluir?\n\nResponda SIM para confirmar ou NÃO para parar.";
    vi.mocked(runTurn).mockReset().mockResolvedValue({ reply } as never);
    query.mockReset().mockResolvedValue([]);
    sendText.mockReset().mockResolvedValue({ messageId: "wamid.R" });
    expect(await runQueued(row("in-11"))).toBe("done");
    expect(sendText).toHaveBeenCalledTimes(1);
    const [params] = sendText.mock.calls[0];
    expect(params.body).toBe(reply);
    expect(params.quoteMessageId).toBe("wamid.in-11");
    expect(params.interativo?.opcoes.map((o: { id: string }) => o.id)).toEqual(["op:SIM", "op:NÃO"]);
  });

  const toque = (id: string, contexto: string | null) => ({ ...row(id), text: "SIM", button_payload: "op:SIM", reply_to_message_id: contexto });

  it("toque no botão da ÚLTIMA resposta vale como SIM digitado", async () => {
    const { runTurn } = await import("@/graph/graph");
    vi.mocked(runTurn).mockReset().mockResolvedValue({ reply: "Feito." } as never);
    query.mockReset().mockImplementation(async (sql: string) =>
      sql.includes("SELECT reply_message_id") ? [{ reply_message_id: "wamid.ULTIMA" }] : []);
    sendText.mockReset().mockResolvedValue({ messageId: "wamid.R3" });
    expect(await runQueued(toque("in-13", "wamid.ULTIMA"))).toBe("done");
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runTurn).mock.calls[0][0]).toMatchObject({ text: "SIM", buttonPayload: "op:SIM" });
  });

  it.each([["wamid.ANTIGA"], [null]])("toque em mensagem antiga (contexto %s) não chega ao grafo", async (contexto) => {
    const { runTurn } = await import("@/graph/graph");
    const { TEXTO_BOTAO_ANTIGO } = await import("../inbound");
    vi.mocked(runTurn).mockReset();
    query.mockReset().mockImplementation(async (sql: string) =>
      sql.includes("SELECT reply_message_id") ? [{ reply_message_id: "wamid.ULTIMA" }] : []);
    sendText.mockReset().mockResolvedValue({ messageId: "wamid.R4" });
    expect(await runQueued(toque("in-14", contexto))).toBe("done");
    expect(runTurn).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith({ to: "5511999990000", body: TEXTO_BOTAO_ANTIGO, quoteMessageId: "wamid.in-14" });
  });

  it("resposta comum sai exatamente como antes, sem a chave interativo", async () => {
    const { runTurn } = await import("@/graph/graph");
    vi.mocked(runTurn).mockReset().mockResolvedValue({ reply: "Você tem 2 negócios." } as never);
    query.mockReset().mockResolvedValue([]);
    sendText.mockReset().mockResolvedValue({ messageId: "wamid.R2" });
    expect(await runQueued(row("in-12"))).toBe("done");
    expect(sendText).toHaveBeenCalledWith({ to: "5511999990000", body: "Você tem 2 negócios.", quoteMessageId: "wamid.in-12" });
  });
});
