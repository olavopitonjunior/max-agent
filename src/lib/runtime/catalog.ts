import { featureEnabled, rolloutStatus, durableRuntimeEnabled } from './rollout';
import { CAPABILITIES, type Capability } from "@/graph/policy";
import { MARKETING_WORKERS } from "./marketing-events";
import { VERBOS_DE_ACAO,timeoutDoVerbo } from '../acao';
import { VERBOS_DE_LEITURA } from '@/graph/scope-contract';
import { DEFAULT_MODEL } from '../llm';
import { CATALOG_VERSION, WORKFLOW_VERSION } from './contracts';
import { deployProfile } from '../deploy-profile';
export const READ_ACTIONS = new Set<string>(['proposal.list','proposal.status','proposal.options','proposal.preflight','form.options','credit.preflight','credit.status','captacao.options','captacao.preflight','captacao.list','captacao.autorizacao.listar','marketing.options','marketing.library','marketing.status']);
export function isWriteVerb(verb:string):boolean {return !READ_ACTIONS.has(verb);}
export const NEW_QUERIES=['notification.list','activity.list','activity.get','metrics.get','property.list','property.detail','contract.status','template.decisions'];
export interface CatalogTool {
 id:string;version:string;status:'current'|'disabled'|'planned';installed:boolean;enabled:boolean;executor:'scope-action'|'scope-query'|'graph'|null;effect:'read'|'write'|'paid';flag?:string;recoveryOnly?:boolean;
 schema:Record<string,unknown>;permission:Capability|null;policyCapability:Capability|null;domainScope:string;projection:string;dataClass:string;timeoutMs:number;retry:string;reconciliation:string;confirmation:boolean;evaluationCases:string[];provenance:string;
}
const POLICY_MAPPING: Record<string, Capability | null> = {
 'proposal.status': null, 'proposal.options': null, 'proposal.preflight': null,
 'proposal.update': 'proposal.create', 'proposal.cancel': 'proposal.send', 'proposal.remind': 'proposal.send',
 'proposal.complete': 'proposal.send', 'proposal.recreate': 'proposal.create',
 'proposal.convert': 'proposal.create', 'proposal.duplicate': 'proposal.create',
 'form.options': 'form.create',
 'activity.get': 'activity.list',
 'form.remind': 'form.create', 'activity.postpone': 'activity.write',
 'activity.create': 'activity.write', 'activity.comment': 'activity.write', 'activity.complete': 'activity.write', 'activity.refuse': 'activity.write',
};
const DOMAIN_SCOPE: Record<string, string> = {
 'proposal.list': 'Authenticated user; tenant + proposalScopeWhere visibility (scope-action); scope-query also applies Max policy.',
 'proposal.status': 'Authenticated user; tenant + proposalScopeWhere visibility.',
 'proposal.options': 'Authenticated user; tenant + proposalScopeWhere visibility.',
 'proposal.preflight': 'Authenticated user; organization configuration and proposal schema validation; no target mutation.',
 'proposal.create': 'PROPOSAL_CREATE; tenant + subject permissions.',
 'proposal.update': 'PROPOSAL_CREATE or PROPOSAL_SEND; proposalScopeWhere + creator ownership + editable state.',
 'proposal.cancel': 'PROPOSAL_CANCEL; proposalScopeWhere + envelope state.',
 'proposal.remind': 'PROPOSAL_RESEND; proposalScopeWhere + creator ownership + reminder-eligible state.',
 'proposal.complete': 'PROPOSAL_SEND; proposalScopeWhere + proposal state.',
 'proposal.recreate': 'PROPOSAL_CREATE; proposalScopeWhere + proposal state.',
 'proposal.convert': 'PROPOSAL_CONVERT; DEAL_CREATE or LEASE_CREATE; proposalScopeWhere + pipeline scope.',
 'proposal.duplicate': 'PROPOSAL_CREATE; proposalScopeWhere + proposal state.',
 'proposal.delete': 'PROPOSAL_DELETE; proposalScopeWhere + deletion constraints.',
 'form.options': 'DEAL_CREATE or LEASE_CREATE; department pipeline scope + enabled module.',
 'form.create': 'DEAL_CREATE or LEASE_CREATE; department pipeline scope + enabled module.',
};
function capability(id:string):Capability|null {
 if(Object.hasOwn(POLICY_MAPPING,id))return POLICY_MAPPING[id];
 if(id.startsWith('marketing.'))return id==='marketing.generate'||id==='marketing.prepare'?'marketing.generate':'marketing.read';
 if(id.startsWith('credit.'))return id==='credit.request'?'credit.request':'credit.read';
 if(id==='lead.upsert')return 'credit.request';
 if(id.startsWith('captacao.')&&!['captacao.send','captacao.list','captacao.autorizacao.pedir','captacao.autorizacao.decidir','captacao.autorizacao.listar'].includes(id))return 'captacao.create';
 if(id==='captacao.autorizacao.listar')return 'captacao.autorizacao.decidir';
 return (CAPABILITIES as readonly string[]).includes(id)?id as Capability:null;
}
function tool(id:string,executor:CatalogTool['executor'],orgId?:string):CatalogTool {
 const isQuery=executor==='scope-query';
 const effect:CatalogTool['effect']=id==='marketing.generate'||id==='credit.request'?'paid':isQuery||!isWriteVerb(id)?'read':'write';
 // Installed is distinct from switched on. Existing domain flags remain unchanged.
 const flag=id.startsWith('marketing.')&&id!=='marketing.status'?'MAX_MARKETING':NEW_QUERIES.includes(id)?'MAX_EXTENDED_QUERIES':undefined;
 const enabled=id==='marketing.status'?!!orgId:flag==='MAX_MARKETING'?featureEnabled('marketing',orgId):flag==='MAX_EXTENDED_QUERIES'?featureEnabled('queries',orgId):true;
 const schema:Record<string,unknown>={type:'object',additionalProperties:true,description:'Arguments validated again by authenticated ImobPro executor; subject+phone are server bound.'};
 if(id==='marketing.prepare')Object.assign(schema,{required:['propertyId','templateId','modality'],properties:{propertyId:{type:'string'},templateId:{type:'string'},modality:{enum:['copy','artwork','video']},headline:{type:'string'},callToAction:{type:'string'}}});
 if(id==='marketing.generate')Object.assign(schema,{required:['briefId','confirmationDigest','confirmed','idempotencyKey'],properties:{briefId:{type:'string'},confirmationDigest:{type:'string',pattern:'^[a-f0-9]{64}$'},confirmed:{const:true},idempotencyKey:{type:'string',minLength:8,maxLength:160}}});
 if(isQuery)Object.assign(schema,{properties:{limite:{type:'integer',minimum:1,maximum:50},cursor:{type:'string'},estado:{type:'string'},negocio_id:{type:'string'},proposta_id:{type:'string'},imovel_id:{type:'string'}}});
 return {id,...(id==='marketing.status'?{recoveryOnly:true}:{}),version:CATALOG_VERSION,status:enabled?'current':'disabled',installed:true,enabled,executor,effect,...(flag?{flag}:{}),schema,permission:capability(id),policyCapability:capability(id),domainScope:executor===null?'Planned; no executable permission.':DOMAIN_SCOPE[id]??'Live ImobPro subject RBAC, tenant scope and domain guards; Max policy alone does not grant domain access.',projection:isQuery?'ImobPro server projection per subject; broker restricted':'ImobPro live subject RBAC and domain projection',dataClass:id.startsWith('credit.')||id==='lead.upsert'?'sensitive-credit':effect==='read'?'tenant-operational':'tenant-write',timeoutMs:executor==='scope-action'?timeoutDoVerbo(id as Parameters<typeof timeoutDoVerbo>[0]):8000,retry:effect==='read'?'caller-controlled; fresh read':'never automatically retry uncertain effect; stable idempotency key',reconciliation:effect==='read'?'fresh-query':id.startsWith('marketing.')?'marketing.status':'domain status plus execution_intent unknown review',confirmation:effect!=='read',evaluationCases:effect==='read'?['tenant-isolation','role-revocation','projection','pagination']:['approval-content-bound','idempotency','lost-ack-unknown','takeover-fence'],provenance:executor==='scope-action'?'src/lib/acao.ts → ImobPro scope-action':'src/lib/scope.ts → ImobPro scope-query'};
}
export function catalog(orgId?:string) {
 // Agente, prompt e canal vêm do perfil do deploy: o catálogo do Newton não se anuncia como Max.
 const perfil=deployProfile();
 const tools:CatalogTool[]=[...VERBOS_DE_ACAO.map(id=>tool(id,'scope-action',orgId)),...VERBOS_DE_LEITURA.filter(id=>!VERBOS_DE_ACAO.includes(id as typeof VERBOS_DE_ACAO[number])).map(id=>tool(id,'scope-query',orgId)),...['deep-research','calendar.external','finance.read','documents.create','rental.manage'].map(id=>({...tool(id,null,orgId),status:'planned' as const,installed:false,enabled:false,executor:null}))];
 const flagEnabled=(flag?:string)=>flag==='MAX_MARKETING'?featureEnabled('marketing',orgId):!flag||process.env[flag]==='true';
 const agent=(id:string,toolIds:string[],instruction:string,flag?:string)=>({id,version:WORKFLOW_VERSION,status:flagEnabled(flag)?'current':'disabled',installed:true,enabled:flagEnabled(flag),executor:'langgraph',instructionSummary:instruction,promptVersion:WORKFLOW_VERSION,toolAllowlist:toolIds,skillAllowlist:['confirmation','tenant-projection','effect-idempotency'],maxConcurrency:3,...(flag?{flag}:{})});
 const marketingTools=tools.filter(t=>t.id.startsWith('marketing.')).map(t=>t.id);
 return {agentKey:perfil.agentKey,agentName:perfil.agentName,rollout:rolloutStatus(orgId),catalogVersion:CATALOG_VERSION,workflowVersion:WORKFLOW_VERSION,agents:[agent(perfil.agentKey,tools.filter(t=>t.installed).map(t=>t.id),'Route requests to deterministic domain flows, preserve user confirmation and server authorization.'),agent('proposals',tools.filter(t=>t.id.startsWith('proposal.')||t.id.startsWith('form.')).map(t=>t.id),'Collect dictated facts, preflight live data, summarize and require content-bound confirmation before writes.'),agent('credit',tools.filter(t=>t.id.startsWith('credit.')||t.id==='lead.upsert').map(t=>t.id),'Sensitive credit stays task scoped; do not learn financial details as general memory.','MAX_CREDITO'),agent('captacao',tools.filter(t=>t.id.startsWith('captacao.')).map(t=>t.id),'Collect capture authorization and confirm signature send with immutable idempotency key.','MAX_CAPTACAO'),agent('marketing',marketingTools,'Use official property snapshots, governed template and source/brand versions; prepare, explicitly confirm, generate once, query status.','MAX_MARKETING'),...MARKETING_WORKERS.map(worker=>({id:worker.name,version:worker.version,remoteExecutor:worker.executor,remoteSkill:worker.skill,status:featureEnabled('marketing',orgId)?'current':'disabled',installed:true,enabled:featureEnabled('marketing',orgId),executor:'imobpro.marketing.pipeline',owner:'ImobPro',implementation:'deterministic-worker',model:null,instructionSummary:'Versioned ImobPro pipeline stage: official facts, governed layout, real-photo video and deterministic quality checks; emits server pipeline events.',toolAllowlist:marketingTools,skillAllowlist:['tenant-projection','confirmation']})),{id:'research',status:'planned',installed:false,enabled:false,executor:null,toolAllowlist:[],skillAllowlist:[]}],tools,skills:[{id:'confirmation',version:WORKFLOW_VERSION,status:'current',provenance:'graph/tools.ts + deterministic flows'},{id:'tenant-projection',version:WORKFLOW_VERSION,status:'current',provenance:'ImobPro authenticated subject projections + lib/scope.ts'},{id:'effect-idempotency',version:WORKFLOW_VERSION,status:orgId&&durableRuntimeEnabled(orgId)?'current':'disabled',flag:'MAX_RUNTIME_V1',provenance:'lib/runtime/store.ts'},{id:'marketing-factual-qa-v1',version:'1',status:featureEnabled('marketing',orgId)?'current':'disabled',provenance:'ImobPro pipeline/evaluateCampaign; deterministic fact and brand checks, model:null'}],prompts:[{id:`${perfil.agentKey}.system`,version:WORKFLOW_VERSION,visibility:'private',instructionSummary:'Platform governed conversation instructions; raw private prompt intentionally omitted.'}],models:[{id:DEFAULT_MODEL,status:'current',usage:'per-call',default:true}],adapters:[{id:'imobpro.scope-action',executor:'lib/acao.ts',auth:'per-tenant Bearer + live phone/subject authorization'},{id:'imobpro.scope-query',executor:'lib/scope.ts',auth:'per-tenant Bearer + per-subject projection'},{id:'openrouter',executor:'lib/llm.ts',usage:'measured per call; synthetic fixture in simulation'},{id:`whatsapp.${perfil.transport}`,executor:'lib/transport',guard:'conversation control fence; window checks; transport intent'}],release:{workflowVersion:WORKFLOW_VERSION,catalogVersion:CATALOG_VERSION,newCapabilitiesDefault:false,frameworkUpgrade:false}};
}
export function executableTool(id:string,executor?:CatalogTool['executor'],orgId?:string):CatalogTool|undefined {return catalog(orgId).tools.find(t=>t.id===id&&t.enabled&&t.installed&&t.executor!==null&&(!executor||t.executor===executor));}
