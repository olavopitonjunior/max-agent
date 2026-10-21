import { describe, expect, it } from 'vitest';
import { ExecutionContextSchema, ApprovalSchema, approvalMatches } from '../contracts';
import { withExecution, currentExecution, assertExternalAllowed, namespaceFor, runEvent } from '../context';
import { executableTool, catalog } from '../catalog';

const context = { orgId: 'org-a', subject: { kind: 'user' as const, userId: 'u-a' }, conversationId: 'conversation-a', taskId: '11111111-1111-4111-8111-111111111111', mode: 'simulation' as const, workflowVersion: 'max-v1', controlVersion: 0, deadline: Date.now() + 10000, budgetUsd: 1, maxConcurrency: 3 };
describe('execution boundary', () => {
  it('rejects missing tenant and unbounded concurrency', () => {
    expect(ExecutionContextSchema.safeParse({ ...context, orgId: '' }).success).toBe(false);
    expect(ExecutionContextSchema.safeParse({ ...context, maxConcurrency: 4 }).success).toBe(false);
  });
  it('keeps concurrent execution identity isolated and blocks all external simulation effects', async () => {
    await Promise.all(['org-a', 'org-b'].map(orgId => withExecution({ ...context, orgId }, async () => {
      await Promise.resolve();
      expect(currentExecution()?.context.orgId).toBe(orgId);
      expect(() => assertExternalAllowed()).toThrow('simulation_external_denied');
      runEvent('tool.started', 'proposal.list');
      expect(currentExecution()?.events[0].orgId).toBe(orgId);
    })));
    expect(currentExecution()).toBeUndefined();
  });
  it('binds playground namespaces to mode, tenant, phone and session', () => {
    const a = namespaceFor('simulation', 'a', '+5511999990000', 'session');
    expect(a).not.toBe(namespaceFor('simulation', 'b', '+5511999990000', 'session'));
    expect(a).not.toBe(namespaceFor('simulation', 'a', '+5511999990001', 'session'));
    expect(a).not.toBe(namespaceFor('staging', 'a', '+5511999990000', 'session'));
    expect(a).not.toBe('a:5511999990000');
  });
  it('rejects altered or expired approval and approval from another task', () => {
    const approval = ApprovalSchema.parse({ id:'approval', orgId:'org-a', subject:context.subject, taskId:context.taskId, contentDigest:'abc', expiresAt: Date.now()+10000, approvedAt:Date.now() });
    expect(approvalMatches(approval, context, 'abc')).toBe(true);
    expect(approvalMatches(approval, context, 'changed')).toBe(false);
    expect(approvalMatches(approval, { ...context, taskId:'22222222-2222-4222-8222-222222222222' }, 'abc')).toBe(false);
    expect(approvalMatches({ ...approval, expiresAt:Date.now()-1 }, context, 'abc')).toBe(false);
  });
  it('does not advertise future features as executable or enable new capabilities by default', () => {
    expect(executableTool('deep-research')).toBeUndefined();
    expect(catalog().tools.find(t=>t.id==='deep-research')?.status).toBe('planned');
    expect(executableTool('marketing.generate')).toBeUndefined();
    expect(executableTool('proposal.list')?.executor).toBe('scope-action');
  });
});
