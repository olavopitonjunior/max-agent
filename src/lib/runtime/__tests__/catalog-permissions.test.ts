import { expect, it } from 'vitest';
import { catalog } from '../catalog';
import { CAPABILITIES } from '@/graph/policy';
it('separates canonical Max policy capabilities from authenticated domain scope',()=>{
 const tools=catalog().tools;
 for(const [id,policyCapability,domainScope] of [
  ['proposal.status',null,'proposalScopeWhere'],['proposal.options',null,'proposalScopeWhere'],
  ['proposal.preflight',null,'organization configuration'],['proposal.update','proposal.create','PROPOSAL_CREATE or PROPOSAL_SEND'],
  ['form.options','form.create','DEAL_CREATE or LEASE_CREATE'],['proposal.cancel','proposal.send','PROPOSAL_CANCEL'],
  ['proposal.complete','proposal.send','PROPOSAL_SEND'],['proposal.convert','proposal.create','PROPOSAL_CONVERT'],
 ]) {expect(tools.find(t=>t.id===id)).toMatchObject({policyCapability,permission:policyCapability,domainScope:expect.stringContaining(domainScope!)});}
 for(const tool of tools)if(tool.permission!==null)expect(CAPABILITIES).toContain(tool.permission);
 for(const tool of tools.filter(t=>!t.installed))expect(tool.permission).toBeNull();
});
