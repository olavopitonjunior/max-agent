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
  provider: () => "meta",
  capabilities: () => ({ templates: true, window24h: true, media: true, groups: false, status: true }),
}));
vi.mock("../janela24h", () => ({ janelaAberta: vi.fn().mockResolvedValue(true), abrirJanela: vi.fn() }));
vi.mock("@/graph/graph", () => ({ seedNotification: vi.fn(), runTurn: vi.fn() }));
vi.mock("../connection", () => ({ observeConnection: vi.fn() }));

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
});
