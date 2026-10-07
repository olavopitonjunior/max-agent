import { describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../db", () => ({ query }));
vi.mock("../cm", () => ({ reportDeliveryOutcome: vi.fn() }));

const { applyFalhaDeEnvio, applyStatusCallback } = await import("../delivery");

describe("falha assíncrona da Meta", () => {
  it("failed não regride para sent atrasado, mas read posterior confirma entrega", async () => {
    query.mockReset();
    let replyStatus = "failed";
    query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (!sql.includes("UPDATE inbound_queue")) return [];
      const rankDoAtual = Number(new RegExp(`WHEN '${replyStatus}' THEN (\\d+)`).exec(sql)?.[1] ?? 0);
      const rankNovo = params[2] as number;
      if (rankDoAtual >= rankNovo) return [];
      replyStatus = params[1] as string;
      return [{ id: "inbound-1" }];
    });

    const sent = await applyStatusCallback({ status: "sent", messageIds: ["wamid.reply-1"], phone: null, momment: null });
    expect(sent.replies).toBe(0);
    expect(replyStatus).toBe("failed");

    const read = await applyStatusCallback({ status: "read", messageIds: ["wamid.reply-1"], phone: null, momment: null });
    expect(read.replies).toBe(1);
    expect(replyStatus).toBe("read");
  });

  it("grava a falha da resposta pelo wamid mesmo sem linha de outbox", async () => {
    query.mockReset();
    query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("UPDATE inbound_queue")) {
        expect(params[0]).toBe("wamid.reply-1");
        expect(sql).toContain("reply_message_id = $1");
        expect(sql).toContain("reply_delivery_status = 'failed'");
        expect(sql).toMatch(/reply_delivery_status IS NULL OR reply_delivery_status IN \('sent', 'unconfirmed'\)/);
        return [{ id: "inbound-1" }];
      }
      return [];
    });

    expect(await applyFalhaDeEnvio({ messageId: "wamid.reply-1", code: 131049, title: "Meta chose not to deliver" })).toBe(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE inbound_queue"))).toBe(true);
  });

  it("131047 também registra a falha da resposta sem reenviar texto livre", async () => {
    query.mockReset();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    query.mockImplementation(async (sql: string) =>
      sql.includes("UPDATE inbound_queue") ? [{ id: "inbound-2" }] : []
    );

    expect(await applyFalhaDeEnvio({ messageId: "wamid.reply-2", code: 131047, title: "Re-engagement message" })).toBe(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE inbound_queue"))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
