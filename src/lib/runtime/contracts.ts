import { z } from 'zod';
import { createHash } from 'node:crypto';
export const WORKFLOW_VERSION = 'max-v1';
export const CATALOG_VERSION = '2026-10-20.1';
export const SubjectSchema = z.discriminatedUnion('kind', [z.object({kind:z.literal('user'),userId:z.string().min(1)}).strict(),z.object({kind:z.literal('broker'),splitRecipientId:z.string().min(1)}).strict()]);
export const ExecutionContextSchema = z.object({orgId:z.string().min(1),subject:SubjectSchema,conversationId:z.string().min(1),taskId:z.string().uuid(),mode:z.enum(['live','simulation','staging']),workflowVersion:z.string().min(1),controlVersion:z.number().int().nonnegative(),personDigest:z.string().optional(),privacyEpoch:z.number().int().nonnegative().optional(),deadline:z.number().int().positive(),budgetUsd:z.number().nonnegative().finite(),maxConcurrency:z.number().int().min(1).max(3)}).strict();
export type ExecutionContext = z.infer<typeof ExecutionContextSchema>;
export const STATES = ['queued','running','waiting_input','waiting_approval','succeeded','failed','cancelled','unknown'] as const;
export const TaskSchema = z.object({id:z.string().uuid(),context:ExecutionContextSchema,state:z.enum(STATES),createdAt:z.number(),updatedAt:z.number()});
export const ExecutionIntentSchema = z.object({id:z.string().uuid(),orgId:z.string(),taskId:z.string().uuid(),key:z.string().min(1),verb:z.string().min(1),contentDigest:z.string().min(1),state:z.enum(STATES)});
export const ApprovalSchema = z.object({id:z.string().min(1),orgId:z.string().min(1),subject:SubjectSchema,taskId:z.string().uuid(),contentDigest:z.string().min(1),expiresAt:z.number(),approvedAt:z.number()}).strict();
export type Approval = z.infer<typeof ApprovalSchema>;
export const ConversationControlSchema = z.object({state:z.enum(['bot','waiting_human','human']),ownerId:z.string().nullable(),controlVersion:z.number().int().nonnegative()});
export const HandoffCaseSchema = z.object({orgId:z.string(),conversationId:z.string(),control:ConversationControlSchema});
export const RunEventSchema = z.object({id:z.string().uuid(),taskId:z.string().uuid(),orgId:z.string(),kind:z.string(),name:z.string(),at:z.number(),data:z.record(z.unknown()).optional()});
export type RunEvent = z.infer<typeof RunEventSchema>;
export const ResponseEnvelopeSchema = z.object({taskId:z.string().uuid(),workflowVersion:z.string(),state:z.enum(STATES),reply:z.string().nullable(),events:z.array(RunEventSchema)});
export const ReleaseManifestSchema = z.object({workflowVersion:z.string(),catalogVersion:z.string(),newCapabilitiesDefault:z.literal(false),frameworkUpgrade:z.literal(false)});
export function contentDigest(value: unknown): string {
  const canonical = (v:unknown):unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v==='object' ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function approvalMatches(approval: Approval, context: ExecutionContext, digest:string, now=Date.now()):boolean {
  return approval.orgId===context.orgId && approval.taskId===context.taskId && contentDigest(approval.subject)===contentDigest(context.subject) && approval.contentDigest===digest && approval.approvedAt<=now && approval.expiresAt>now;
}
