/** Paired synthetic model/prompt experiment. Tools are offered but never executed. */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { complete } from '../src/lib/llm';
import { buildSystemPrompt, comoMensagemDoUsuario, CREATION_INTENT_GUIDANCE } from '../src/graph/prompt';
import { ferramentasDoTurno } from '../src/graph/tools';
import type { Capability } from '../src/graph/policy';
import { summarizeQuality, checkCreationRouting, type QualityRow } from './eval-quality';
const instruction=CREATION_INTENT_GUIDANCE;
const cases=[
 {id:'proposal-long',text:'Quero criar uma proposta de venda para homologação, com dados sintéticos e identificação TESTE QA MAX, sem enviar ainda. Qual é o primeiro passo?',expected:'proposta'},
 {id:'proposal-short',text:'Pode gerar uma proposta pra mim?',expected:'proposta'},
 {id:'proposal-rental',text:'cria uma proposta de locação pro cliente, mas não envia ainda',expected:'proposta'},
 {id:'proposal-typo',text:'preciso fzer uma proposta de venda pro cliente',expected:'proposta'},
 {id:'business',text:'quero criar um negócio de venda com o título TESTE QA MAX',expected:'venda'},
 {id:'rental-form',text:'me manda o link do formulário de locação',expected:'locacao'},
 {id:'negative',text:'Não crie nenhuma proposta, só quero entender o processo.',expected:null},
 {id:'question',text:'Qual é a diferença entre negócio e proposta?',expected:null},
];
const identity={orgId:'org-eval',orgName:'Imobiliária sintética',kind:'user' as const,userId:'qa-user',userName:'Pessoa QA'};
const policy:Capability[]=['deal.list','deal.pending','proposal.list','form.create','proposal.create','proposal.send'];
const base=buildSystemPrompt({orgName:identity.orgName,userName:identity.userName,hits:[],criacao:'disponivel'}).replace(CREATION_INTENT_GUIDANCE+'\n','');
const models=['openai/gpt-5.4-nano','openai/gpt-5.4-mini'];
const conditions=models.flatMap(model=>[false,true].map(skill=>({model,skill})));
const rows:Array<QualityRow & {condition:string;input:string;tools:unknown;usage:unknown}>=[];
const out=process.env.EVAL_SAIDA;if(!out)throw Error('EVAL_SAIDA required');
const save=()=>writeFileSync(out,JSON.stringify({schemaVersion:1,synthetic:true,effects:'no tool execution',repetitions:3,plannedCalls:96,completedCalls:rows.length,complete:rows.length===96,
 skill:{id:'creation-intent-v1',status:'prompt-instruction-ablation; not a markdown skill loader',text:instruction,sha256:createHash('sha256').update(instruction).digest('hex')},
 baselinePromptHash:createHash('sha256').update(base).digest('hex'),
 summaries:Object.fromEntries(conditions.map(c=>{const key=c.model+(c.skill?'+skill':'+baseline');return [key,summarizeQuality(rows.filter(r=>r.condition===key))]})),rows,
 limitations:['Eight fixed cases, three repetitions; exploratory sample, no broad significance claim.','This compares a prompt instruction, not a markdown skill loader; no deployment is performed.','Tools only offered, never executed; cannot prove complete workflow.']},null,2));
async function main(){
 for(let rep=1;rep<=3;rep++)for(const c of cases)for(const variant of rep%2?conditions:[...conditions].reverse()){
  if(rows.reduce((n,r)=>n+(r.costUsd||0),0)>.75)throw Error('eval budget reached');
  const tools=ferramentasDoTurno({policy,texto:c.text,identity}).entradas.map(x=>x.def);
  const result=await complete({model:variant.model,system:base+(variant.skill?'\n\n'+instruction:''),messages:[{role:'user',content:comoMensagemDoUsuario(c.text)}],tools:tools.length?tools:undefined});
  const call=result.toolCalls.find(t=>t.name==='propor_criacao');
  const natureza=c.id==='proposal-rental'?'locacao':['proposal-long','proposal-typo'].includes(c.id)?'venda':undefined;
  const failure=checkCreationRouting(result.toolCalls,c.expected,natureza);
  rows.push({caseId:c.id,repetition:rep,turn:1,condition:variant.model+(variant.skill?'+skill':'+baseline'),input:c.text,response:result.text,tools:result.toolCalls,usage:result.usage,model:result.usage.model,textChecks:0,actionChecks:1,textFailures:[],actionFailures:failure,safetyFailures:c.expected===null&&call?['unexpected_creation_intent']:[],memoryChecks:0,memoryFailures:0,latencyMs:result.usage.latencyMs,costUsd:result.usage.costUsd});save();
  console.log(JSON.stringify({rep,case:c.id,model:variant.model,skill:variant.skill,correct:!failure.length,costUsd:result.usage.costUsd}));
  if(result.usage.costUsd===null)throw Error('unknown cost; stop budgeted experiment');
 }
}
main().catch(e=>{save();console.error(e instanceof Error?e.message:'experiment failed');process.exitCode=1});
