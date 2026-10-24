import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../catalog';
import { ferramentasDoTurno } from '@/graph/tools';
import { marketingStep } from '@/graph/marketing';
import { executarAcao } from '../../acao';
import { consultarEscopo } from '../../scope';

const network = vi.hoisted(() => ({ requests: [] as string[] }));
vi.mock('../../orgs', () => ({ orgById: async (orgId: string) => ({ orgId, apiToken: 'fixture' }) }));
vi.mock('../../http', () => ({
  fetchWithTimeout: async (url: string) => { network.requests.push(url); return Response.json({ items: [{ id: 'fixture' }], truncated: false }); },
  imobproBase: () => 'https://fixture.test', IMOBPRO_TIMEOUT_MS: 8000,
  IMOBPRO_PROPOSAL_SEND_TIMEOUT_MS: 30000, IMOBPRO_CREDIT_REQUEST_TIMEOUT_MS: 30000,
  captacaoSendTimeoutMs: () => 30000,
}));
const enabled = JSON.stringify({ 'pilot-org': ['runtime', 'queries', 'marketing', 'handoff'] });
const identity = (orgId: string) => ({ kind: 'user' as const, orgId, orgName: 'Synthetic', userId: 'user', userName: 'Synthetic' });
beforeEach(() => {
  network.requests = [];
  for (const flag of ['MAX_RUNTIME_V1', 'MAX_EXTENDED_QUERIES', 'MAX_MARKETING', 'MAX_HANDOFF']) vi.stubEnv(flag, 'true');
  vi.stubEnv('MAX_ROLLOUT_ORGS', enabled);
});
afterEach(() => vi.unstubAllEnvs());

describe('organization rollout at executable boundaries', () => {
  it('does not advertise enabled tools for a nonpilot or an unselected organization', () => {
    for (const orgId of ['other-org', undefined]) {
      expect(catalog(orgId).tools.find(t => t.id === 'marketing.generate')?.enabled).toBe(false);
      expect(catalog(orgId).tools.find(t => t.id === 'property.list')?.enabled).toBe(false);
    }
    expect(catalog('pilot-org').tools.find(t => t.id === 'marketing.generate')?.enabled).toBe(true);
  });

  it.each(['', '{}', 'not json', '[]', '{"*\":["runtime","queries","marketing"]}', '{"pilot-org":["unknown"]}'])('fails closed for missing, invalid or unselected rollout: %s', value => {
    vi.stubEnv('MAX_ROLLOUT_ORGS', value);
    expect(catalog('pilot-org').tools.find(t => t.id === 'marketing.generate')?.enabled).toBe(false);
  });

  it('requires both the per-org feature and the global switch', () => {
    vi.stubEnv('MAX_ROLLOUT_ORGS', JSON.stringify({ 'pilot-org': ['runtime', 'queries'] }));
    expect(catalog('pilot-org').tools.find(t => t.id === 'marketing.generate')?.enabled).toBe(false);
    expect(catalog('pilot-org').tools.find(t => t.id === 'property.list')?.enabled).toBe(true);
    vi.stubEnv('MAX_EXTENDED_QUERIES', 'false');
    expect(catalog('pilot-org').tools.find(t => t.id === 'property.list')?.enabled).toBe(false);
  });

  it('does not offer new reads to another tenant even if policy grants them', () => {
    expect(ferramentasDoTurno({ identity: identity('other-org'), policy: ['property.list'], texto: 'liste os imóveis' }).entradas).toHaveLength(0);
    expect(ferramentasDoTurno({ identity: identity('pilot-org'), policy: ['property.list'], texto: 'liste os imóveis' }).entradas.map(t => t.nome)).toContain('listar_imoveis');
    expect(ferramentasDoTurno({ identity: identity('pilot-org'), policy: [], texto: 'liste os imóveis' }).entradas).toHaveLength(0);
  });

  it('blocks direct adapters for nonpilot tenants before network access', async () => {
    const request = { orgId: 'other-org', rawPhone: '+5511999990888', subject: { kind: 'user' as const, userId: 'user' }, args: {} };
    expect(await executarAcao({ ...request, verb: 'marketing.options' })).toMatchObject({ status: 403 });
    expect(await consultarEscopo({ ...request, verb: 'property.list' })).toBeNull();
    expect(network.requests).toEqual([]);
  });

  it('allows the selected organization through the same adapters and preserves existing reads outside the pilot', async () => {
    const request = { orgId: 'pilot-org', rawPhone: '+5511999990888', subject: { kind: 'user' as const, userId: 'user' }, args: {} };
    expect(await executarAcao({ ...request, verb: 'marketing.options' })).toMatchObject({ status: 200 });
    expect(await consultarEscopo({ ...request, verb: 'property.list' })).toMatchObject({ items: [{ id: 'fixture' }] });
    expect(await executarAcao({ ...request, orgId: 'other-org', verb: 'proposal.list' })).toMatchObject({ status: 200 });
    expect(network.requests).toHaveLength(3);
  });

  it('discards a pending marketing approval after its organization leaves the rollout', async () => {
    let effects = 0;
    const result = await marketingStep({ orgId: 'other-org', text: 'sim', messageId: 'confirm', now: 1000, canWrite: true, policy: ['marketing.read', 'marketing.generate'], pending: { briefId: 'brief', confirmationDigest: 'a'.repeat(64), expiresAt: 2000, summary: 'Synthetic' } }, async () => { effects++; return { status: 200, body: { job: { id: 'job', state: 'succeeded' } } }; });
    expect(result).toMatchObject({ pending: null, event: 'marketing_disabled' });
    expect(effects).toBe(0);
  });
});

it('preserves tracking and authenticated status of accepted marketing after disable',async()=>{
 vi.stubEnv('MAX_MARKETING','false');vi.stubEnv('MAX_ROLLOUT_ORGS','{}');
 const pending={briefId:'accepted',confirmationDigest:'a'.repeat(64),expiresAt:2000,summary:'Synthetic',phase:'tracking' as const,jobId:'accepted-job'};
 const action=vi.fn(async()=>({status:200,body:{job:{id:'accepted-job',state:'running'}}}));
 const p={orgId:'other-org',text:'ficou pronto?',messageId:'status',now:3000,canWrite:false,policy:['marketing.read'],pending};
 expect(await marketingStep(p,action)).toMatchObject({pending,event:'marketing_status'});
 expect(action).toHaveBeenCalledWith('marketing.status',{jobId:'accepted-job'});
 expect(await executarAcao({orgId:p.orgId,rawPhone:'+5511999990888',subject:{kind:'user',userId:'user'},verb:'marketing.status',args:{jobId:pending.jobId}})).toMatchObject({status:200});
 expect(await executarAcao({orgId:p.orgId,rawPhone:'+5511999990888',subject:{kind:'user',userId:'user'},verb:'marketing.generate',args:{}})).toMatchObject({status:403});
 action.mockClear();expect(await marketingStep({...p,policy:[]},action)).toMatchObject({pending,event:'marketing_status_denied'});expect(action).not.toHaveBeenCalled();
 expect(await marketingStep({...p,text:'quero outro vídeo'},action)).toMatchObject({pending,event:'marketing_tracking_preserved'});
});
