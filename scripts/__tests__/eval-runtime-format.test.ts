import { describe, expect, it } from "vitest";
import { RuntimeEvalSchema } from "../eval-runtime-format";

const fixture = { schemaVersion: 1, effectMode: "mock-only", workflowVersion: "max-v1", catalogVersion: "2026-10-20.1", reviewRequired: false, scenarios: [{ id: "greeting", input: "Olá", expectedTools: [], expectedState: "succeeded" }] };
describe("reviewed runtime evaluation fixtures", () => {
  it("rejects unreviewed exports and production effect modes", () => {
    expect(RuntimeEvalSchema.safeParse({ ...fixture, reviewRequired: true }).success).toBe(false);
    expect(RuntimeEvalSchema.safeParse({ ...fixture, effectMode: "live" }).success).toBe(false);
    expect(RuntimeEvalSchema.safeParse({ ...fixture, scenarios: [{ ...fixture.scenarios[0], input: "Preencha com uma mensagem sintética e revise o resultado esperado." }] }).success).toBe(false);
  });
  it("defaults the profile to max and only accepts max or newton", () => {
    const ok = RuntimeEvalSchema.safeParse(fixture);
    expect(ok.success && ok.data.profile).toBe("max");
    const newton = RuntimeEvalSchema.safeParse({ ...fixture, profile: "newton" });
    expect(newton.success && newton.data.profile).toBe("newton");
    expect(RuntimeEvalSchema.safeParse({ ...fixture, profile: "outro" }).success).toBe(false);
  });
  it("accepts bounded synthetic suites and rejects duplicate identities", () => {
    expect(RuntimeEvalSchema.safeParse(fixture).success).toBe(true);
    expect(RuntimeEvalSchema.safeParse({ ...fixture, scenarios: [...fixture.scenarios, ...fixture.scenarios] }).success).toBe(false);
  });
});
