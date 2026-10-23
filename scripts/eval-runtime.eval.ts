import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { buildGraph } from "../src/graph/graph";
import { currentExecution, withExecution } from "../src/lib/runtime/context";
import { CATALOG_VERSION, WORKFLOW_VERSION } from "../src/lib/runtime/contracts";
import { RuntimeEvalSchema } from "./eval-runtime-format";

const suite = RuntimeEvalSchema.parse(JSON.parse(readFileSync(process.env.MAX_EVAL_FIXTURE ?? "docs/contracts/max-runtime-eval.json", "utf8")));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("pins the evaluated workflow and catalog", () => {
  expect(suite.workflowVersion).toBe(WORKFLOW_VERSION);
  expect(suite.catalogVersion).toBe(CATALOG_VERSION);
});
for (const scenario of suite.scenarios) it(`replay ${scenario.id}`, async () => {
  // A bypass of the normal adapter guards is still caught before any connection.
  const network = vi.fn(() => { throw new Error("eval_network_forbidden"); });
  vi.stubGlobal("fetch", network);
  vi.stubEnv("AGENT_DEPLOY_PROFILE", suite.profile === "max" ? "" : suite.profile);
  vi.stubEnv("MAX_MARKETING", "false");
  vi.stubEnv("MAX_EXTENDED_QUERIES", "false");
  const taskId = randomUUID();
  await withExecution({ orgId: "fixture-org", subject: { kind: "user", userId: "fixture-user" }, conversationId: `playground:simulation:${taskId}`, taskId, mode: "simulation", workflowVersion: WORKFLOW_VERSION, controlVersion: 0, deadline: Date.now() + 10000, budgetUsd: 0, maxConcurrency: 3 }, async () => {
    let state = "succeeded";
    let reply = "";
    let nodes: string[] = [];
    try {
      const result = await buildGraph().compile().invoke({
        identity: { orgId: "fixture-org", orgName: "Organização sintética", kind: "user", userId: "fixture-user", userName: "Pessoa sintética" },
        inbound: { messageId: taskId, fromPhone: "+5511999990000", kind: "text", text: scenario.input, groupId: null, mediaUrl: null, mimeType: null, senderName: null, replyToMessageId: null, timestampMs: Date.now() },
      });
      reply = result.reply ?? "";
      nodes = result.timings.map(t => t.no);
    } catch { state = "unknown"; }
    const execution = currentExecution()!;
    const tools = [...new Set(execution.events.filter(e => e.kind === "tool.started").map(e => e.name))].sort();
    expect(state).toBe(scenario.expectedState);
    expect(tools).toEqual([...scenario.expectedTools].sort());
    for (const expected of scenario.expectedReplyIncludes) expect(reply).toContain(expected);
    for (const node of scenario.expectedNodes) expect(nodes).toContain(node);
    expect(execution.spentUsd).toBe(0);
    expect(network).not.toHaveBeenCalled();
  });
});
