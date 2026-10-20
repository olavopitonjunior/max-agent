import { z } from 'zod';
import { runEvent } from './context';
/** Normative remote worker definitions. Version/skill names match ImobPro pipeline.ts. */
export const MARKETING_WORKERS = [
 {name:'marketing.brief',version:'1',skill:'marketing-brief-v1',executor:'runMarketingPipeline/brief',kind:'deterministic'},
 {name:'marketing.copy-script',version:'1',skill:'marketing-factual-copy-v1',executor:'buildCopyScript',kind:'deterministic'},
 {name:'marketing.template-layout',version:'1',skill:'marketing-template-layout-v1',executor:'renderArtwork',kind:'deterministic'},
 {name:'marketing.qa',version:'1',skill:'marketing-factual-qa-v1',executor:'evaluateCampaign',kind:'deterministic'},
 {name:'marketing.video',version:'1',skill:'marketing-creatomate-v1',executor:'CreatomateProvider.submit/inspect',kind:'provider'},
] as const;
const checks=new Set(['official_facts','brand_required_fields','real_property_photos','safe_artwork','supported_numeric_claims']);
const issues=new Set(['fato_oficial_ausente','roteiro_fora_da_fonte','identidade_obrigatoria_ausente','foto_real_ausente','foto_fora_da_fonte','identidade_visual_ausente','logo_obrigatorio_ausente','arte_insegura','afirmacao_sem_fonte']);
const eventSchema=z.object({kind:z.literal('worker'),name:z.string(),version:z.literal('1'),skill:z.string(),model:z.null(),status:z.enum(['succeeded','failed']),revision:z.number().int().min(0).max(2),metadata:z.object({checks:z.array(z.string()).max(20).optional(),issueCodes:z.array(z.string()).max(20).optional()}).default({})});
/** No source, arguments, URLs, raw timestamps, or free-form metadata cross this boundary. */
export function importMarketingEvents(body:unknown):void {
 if(!body||typeof body!=='object')return;
 const value=body as Record<string,unknown>;
 const snapshot=value.snapshot&&typeof value.snapshot==='object'?value.snapshot as Record<string,unknown>:undefined;
 const job=value.job&&typeof value.job==='object'?value.job as Record<string,unknown>:undefined;
 const events=snapshot?.events??job?.events;
 if(!Array.isArray(events))return;
 for(const raw of events.slice(0,32)){
  const parsed=eventSchema.safeParse(raw);if(!parsed.success)continue;
  const event=parsed.data,worker=MARKETING_WORKERS.find(w=>w.name===event.name&&w.skill===event.skill&&w.version===event.version);
  if(!worker)continue;
  runEvent('worker.completed',worker.name,{kind:'worker',version:worker.version,skill:worker.skill,model:null,outcome:event.status,revision:event.revision,checks:(event.metadata.checks??[]).filter(check=>checks.has(check)),issueCodes:(event.metadata.issueCodes??[]).filter(issue=>issues.has(issue)),executor:'imobpro.marketing.pipeline'});
 }
}
