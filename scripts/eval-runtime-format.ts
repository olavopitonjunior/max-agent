import { z } from "zod";

/** Exported history is a template; only explicitly reviewed synthetic cases can run. */
export const RuntimeEvalSchema = z.object({
  schemaVersion: z.literal(1),
  effectMode: z.literal("mock-only"),
  workflowVersion: z.string().min(1),
  catalogVersion: z.string().min(1),
  reviewRequired: z.literal(false),
  /** Perfil de deploy sob o qual o replay roda (AGENT_DEPLOY_PROFILE). Ausente = max. */
  profile: z.enum(["max", "newton"]).default("max"),
  scenarios: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    input: z.string().min(1).max(2000),
    expectedTools: z.array(z.string().regex(/^[a-z][a-z._]{1,70}$/)),
    expectedState: z.enum(["succeeded", "unknown"]),
    expectedReplyIncludes: z.array(z.string().min(1)).default([]),
    expectedNodes: z.array(z.string().min(1)).default([]),
  }).strict()).min(1).max(100),
}).strict().superRefine((suite, ctx) => {
  if (new Set(suite.scenarios.map(s => s.id)).size !== suite.scenarios.length) {
    ctx.addIssue({ code: "custom", message: "Scenario identifiers must be unique" });
  }
  if (suite.scenarios.some(s => s.input.startsWith("Preencha com uma mensagem sintética"))) {
    ctx.addIssue({ code: "custom", message: "Replace exported placeholders with reviewed synthetic messages" });
  }
});
