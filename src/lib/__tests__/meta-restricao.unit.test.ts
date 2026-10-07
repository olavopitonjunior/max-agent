import { describe, expect, it, vi } from "vitest";

const query = vi.fn();
const sendText = vi.fn();
vi.mock("../db", () => ({ query }));
vi.mock("../transport", () => ({
  sendText,
  sendTemplate: vi.fn(),
  connectionStatus: vi.fn().mockResolvedValue({ connected: true }),
  provider: () => "meta",
}));
vi.mock("../janela24h", () => ({ janelaAberta: vi.fn().mockResolvedValue(true), abrirJanela: vi.fn() }));
vi.mock("@/graph/graph", () => ({ seedNotification: vi.fn(), runTurn: vi.fn() }));
vi.mock("../connection", () => ({ observeConnection: vi.fn() }));

const { MetaHttpError } = await import("../transport/erro");
const { dispatchDue } = await import("../outbox");
const { runQueued } = await import("../inbound");

const erro = (code: number) => new MetaHttpError("/messages", 400, JSON.stringify({ error: { code, message: "recusado" } }));

describe("recusa Meta 131048/131049", () => {
  it("outbox liquida a mensagem como falha terminal, com código, sem reagendar", async () => {
    query.mockReset();
    sendText.mockReset().mockRejectedValue(erro(131049));
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
    const updates = query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE outbox"));
    expect(updates.some(([sql, params]) => String(sql).includes("status = 'failed'") && params.includes(131049))).toBe(true);
    expect(updates.some(([sql]) => String(sql).includes("deliver_after = CASE"))).toBe(false);
  });

  it("outbox repete a gravação se o banco falhar após a recusa da Meta", async () => {
    query.mockReset();
    sendText.mockReset().mockRejectedValue(erro(131048));
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
  });

  it("inbound encerra a resposta recusada sem tentar novamente", async () => {
    query.mockReset().mockResolvedValue([]);
    sendText.mockReset().mockRejectedValue(erro(131048));
    const row = {
      id: "in-1", message_id: "wamid.in-1", from_phone: "5511999990000", group_id: null,
      kind: "text", text: "oi", media_url: null, mime_type: null, sender_name: null,
      reply_to_message_id: null, timestamp_ms: null, button_payload: null,
      attempts: 1, reply_text: "Resposta pronta", last_send_started_at: null,
    };

    expect(await runQueued(row)).toBe("failed");
    expect(query.mock.calls.some(([sql, params]) => String(sql).includes("SET status = 'failed'") && String(params[1]).includes("#131048"))).toBe(true);
  });
});
