import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { NextRequest } from 'next/server';
import { query } from '../../db';
vi.mock('../../inbound',()=>({sweepInbound:async()=>({claimed:0,done:0,retry:0,failed:0,blocked:0}),podarTextoDaFila:async()=>0}));
const {GET}=await import('@/app/api/cron/inbound/route');
const d=process.env.DATABASE_URL?describe:describe.skip;
const task='82111111-1111-4111-8111-111111111111',intent='83111111-1111-4111-8111-111111111111';
d('accepted work recovery is independent of admission',()=>{
 beforeEach(async()=>{vi.stubEnv('CRON_SECRET','recovery-fixture');vi.spyOn(Date.prototype,'getMinutes').mockReturnValue(17);await query('DELETE FROM runtime_task WHERE id=$1',[task]);});
 afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
 it.each(['false','true'])('expires crashed task/intent with runtime and marketing OFF; handoff=%s',async handoff=>{
  vi.stubEnv('MAX_RUNTIME_V1','false');vi.stubEnv('MAX_MARKETING','false');vi.stubEnv('MAX_HANDOFF',handoff);vi.stubEnv('MAX_ROLLOUT_ORGS','{}');
  await query("INSERT INTO runtime_task(id,org_id,conversation_id,subject_digest,workflow_version,mode,state,lease_until) VALUES($1,'lease-fixture','fixture','fixture','fixture','live','running',now()-interval '1 minute')",[task]);
  await query("INSERT INTO execution_intent(id,task_id,org_id,idempotency_key,verb,content_digest,subject_digest,state) VALUES($1,$2,'lease-fixture','crashed','marketing.generate','fixture','fixture','running')",[intent,task]);
  expect((await GET(new NextRequest('https://fixture.test/api/cron/inbound',{headers:{authorization:'Bearer recovery-fixture'}}))).status).toBe(200);
  expect((await query('SELECT state FROM runtime_task WHERE id=$1',[task]))[0].state).toBe('unknown');
  expect((await query('SELECT state FROM execution_intent WHERE id=$1',[intent]))[0].state).toBe('unknown');
 });
});
