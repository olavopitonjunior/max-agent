import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Segunda trava do "Newton só fala com usuário interno": mesmo que algo além
 * do `/api/notify` enfileire aviso a parte do negócio, o `enqueue` recusa no
 * perfil newton antes de tocar no banco.
 */
vi.mock("../db", () => ({ query: vi.fn(), db: vi.fn() }));

const { enqueue } = await import("../outbox");
const { query } = await import("../db");

afterEach(() => vi.unstubAllEnvs());

describe("enqueue × perfil", () => {
  it("newton: deal_party lança audience_nao_permitida_no_perfil sem tocar no banco", async () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    await expect(
      enqueue({
        orgId: "org1",
        dedupeKey: "k",
        audience: "deal_party",
        phone: "5511900000001",
        recipientName: "",
        title: "",
        body: "oi",
        linkUrl: null,
        dealId: null,
        orgName: "",
      })
    ).rejects.toThrow("audience_nao_permitida_no_perfil");
    expect(query).not.toHaveBeenCalled();
  });
});
