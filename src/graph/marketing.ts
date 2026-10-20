import {runEvent} from '@/lib/runtime/context';
interface Property {id:string;tipo?:string;bairro?:string;cidade?:string;dormitorios?:number}
interface Template {id:string;name:string}
export interface MarketingPending {briefId:string;confirmationDigest:string;expiresAt:number;summary:string;phase?:'property'|'template'|'approval'|'tracking';properties?:Property[];templates?:Template[];propertyId?:string;modality?:'copy'|'artwork'|'video';cursor?:string;jobId?:string}
type Action=(verb:string,args:Record<string,unknown>,key?:string)=>Promise<{status:number;body:Record<string,unknown>}|null>;
interface Step {reply:string;pending:MarketingPending|null;event:string}
const isRequest=(text:string)=>/\b(marketing|arte|an[uú]ncio|campanha|v[ií]deo|divulga\w*|post)\b/i.test(text)||/texto.*im[oó]vel/i.test(text);
const statusRequest=(text:string)=>/\b(pront[oa]|termin|ficou|status|andamento|como est)/i.test(text);
function propertyLabel(p:Property):string{return [p.tipo,p.bairro,p.cidade,p.dormitorios?`${p.dormitorios} dormitórios`:null].filter(Boolean).join(' • ')||'Imóvel cadastrado';}
function optionsReply(items:Property[],more:boolean):string{return `Qual imóvel você quer divulgar?\n${items.map((p,i)=>`${i+1}. ${propertyLabel(p)}`).join('\n')}\nResponda com o número${more?' ou diga mais imóveis':''}.`;}
function jobReply(job:{state?:string;stale?:boolean}):string {
 if(job.stale)return 'Os dados do imóvel mudaram desde a geração. Confira a peça no estúdio e prepare uma nova versão com os dados atuais.';
 const replies:Record<string,string>={succeeded:'Sua peça está pronta. Confira e baixe os arquivos no estúdio de marketing do ImobPro.',unknown:'O resultado ainda é incerto. Estou preservando a mesma geração para evitar nova cobrança.',running:'Sua peça está sendo preparada. Você pode perguntar se ficou pronta.',queued:'Sua peça está aguardando processamento. Você pode perguntar se ficou pronta.',failed:'A geração da sua peça falhou. Confira os detalhes no estúdio ImobPro.',cancelled:'A geração da sua peça foi cancelada.'};
 return replies[job.state??'']??'Não consegui confirmar o estado da peça. Confira o estúdio ImobPro.';
}
/** No ids need to be typed: visible properties/templates are selected by number. */
export async function marketingStep(p:{text:string;messageId:string;now:number;canWrite:boolean;policy:readonly string[];pending:MarketingPending|null},action:Action):Promise<Step|null>{
 if(process.env.MAX_MARKETING!=='true')return p.pending?{reply:'Marketing indisponível agora. A confirmação foi descartada.',pending:null,event:'marketing_disabled'}:null;
 const text=p.text.trim(),previous=p.pending;
 async function prepare(propertyId:string,template:Template,modality:'copy'|'artwork'|'video'):Promise<Step>{
  if(!p.canWrite||!p.policy.includes('marketing.generate'))return {reply:'A geração de marketing não está liberada para você.',pending:null,event:'marketing_denied'};
  const result=await action('marketing.prepare',{propertyId,templateId:template.id,modality},p.messageId);
  if(!result||result.status>=400)return {reply:'Não consegui preparar a peça. Confira imóvel, marca e cota no estúdio ImobPro.',pending:null,event:'marketing_prepare_failed'};
  const b=result.body,s=b.snapshot as {copy?:string;template?:string;quotaUnits?:number}|undefined,expiresAt=Date.parse(String(b.expiresAt));
  if(typeof b.briefId!=='string'||typeof b.confirmationDigest!=='string'||!/^[a-f0-9]{64}$/i.test(b.confirmationDigest)||!Number.isFinite(expiresAt)||expiresAt<=p.now||!Number.isSafeInteger(s?.quotaUnits)||Number(s?.quotaUnits)<1||Number(s?.quotaUnits)>100)return {reply:'Não consegui validar a preparação da peça.',pending:null,event:'marketing_prepare_invalid'};
  const summary=`${s?.copy??''}\nModelo: ${s?.template??template.name}. Usa ${s!.quotaUnits} ${s!.quotaUnits===1?'unidade':'unidades'} da sua cota de ${{copy:'texto',artwork:'arte',video:'vídeo'}[modality]}.`;
  return {reply:`${summary}\nConfirma a geração desta peça? Responda sim.`,pending:{briefId:b.briefId,confirmationDigest:b.confirmationDigest,expiresAt,summary,phase:'approval',modality},event:'marketing_waiting_approval'};
 }
 if(previous?.phase==='tracking'&&previous.jobId&&statusRequest(text)){
  const r=await action('marketing.status',{jobId:previous.jobId});const job=r?.body.job as {state?:string;stale?:boolean}|undefined;
  return {reply:job?jobReply(job):'Não consegui consultar sua peça agora. Tente novamente em instantes.',pending:previous,event:'marketing_status'};
 }
 if(previous&&previous.phase!=='tracking'){
  if(previous.expiresAt<=p.now)return {reply:'A preparação de marketing expirou. Peça novamente com os dados atuais do imóvel.',pending:null,event:'marketing_expired'};
  if(previous.phase==='property'){
   if(/mais im[oó]veis/i.test(text)&&previous.cursor){
    const more=await action('property.list',{limite:10,cursor:previous.cursor});const items=more?.body.items as Property[]|undefined;
    return items?.length?{reply:optionsReply(items,!!more?.body.nextCursor),pending:{...previous,properties:items,cursor:more?.body.nextCursor as string|undefined},event:'marketing_property_page'}:{reply:'Não consegui consultar outros imóveis agora.',pending:previous,event:'marketing_query_failed'};
   }
   const selected=/^\d+[.!\s]*$/.test(text)?previous.properties?.[Number.parseInt(text,10)-1]:previous.properties?.find(item=>propertyLabel(item).toLocaleLowerCase().includes(text.toLocaleLowerCase()));
   if(!selected)return {reply:'Para escolher o imóvel, responda com o número da lista. Para cancelar, diga cancelar.',pending:/^cancelar$/i.test(text)?null:previous,event:'marketing_property_selection'};
   const templates=previous.templates??[];
   if(templates.length===1)return prepare(selected.id,templates[0],previous.modality??'copy');
   return {reply:`Qual modelo você prefere?\n${templates.map((t,i)=>`${i+1}. ${t.name}`).join('\n')}\nResponda com o número.`,pending:{...previous,phase:'template',propertyId:selected.id},event:'marketing_template_selection'};
  }
  if(previous.phase==='template'){
   const selected=previous.templates?.[Number.parseInt(text,10)-1];
   if(!selected)return {reply:'Escolha um dos modelos pelo número ou diga cancelar.',pending:/^cancelar$/i.test(text)?null:previous,event:'marketing_template_selection'};
   return prepare(previous.propertyId!,selected,previous.modality??'copy');
  }
  runEvent('skill.started','confirmation');
  if(!/^(sim|confirmo|pode gerar|gerar|confirmar)[.!\s]*$/i.test(text))return {reply:'Geração descartada. Quando quiser, peça uma arte, um texto ou um vídeo para divulgar um imóvel.',pending:null,event:'marketing_cancelled'};
  if(!p.canWrite||!p.policy.includes('marketing.generate'))return {reply:'Marketing não está liberado para você.',pending:null,event:'marketing_denied'};
  const key=`marketing:${previous.briefId}`;
  const result=await action('marketing.generate',{briefId:previous.briefId,confirmationDigest:previous.confirmationDigest,confirmed:true,idempotencyKey:key},key);
  runEvent('skill.completed','confirmation');
  if(!result||result.status>=500||result.body.error==='execution_unknown')return {reply:'O resultado da geração está incerto. Não vou iniciar outra cobrança; consulte a biblioteca no estúdio ImobPro.',pending:null,event:'marketing_unknown'};
  if(result.status>=400)return {reply:'Não consegui gerar: confira a permissão, a cota e os dados atuais no estúdio ImobPro.',pending:null,event:'marketing_rejected'};
  const job=result.body.job as {id?:string;state?:string;stale?:boolean}|undefined;
  return {reply:job?jobReply(job):'A geração foi aceita. Consulte o status no estúdio ImobPro.',pending:job?.id?{...previous,phase:'tracking',jobId:job.id,expiresAt:p.now+24*3600000}:null,event:'marketing_generated'};
 }
 if(!isRequest(text))return null;
 if(!p.canWrite||!p.policy.includes('marketing.read'))return {reply:'Marketing não está liberado para você.',pending:null,event:'marketing_denied'};
 runEvent('specialist.started','marketing');
 // Dev command remains optional; conversation never requires internal ids.
 const explicitProperty=/im[oó]vel\s+([\w-]+)\s+template\s+([\w-]+)/i.exec(text);
 const modality=/v[ií]deo/i.test(text)?'video':/arte|an[uú]ncio|post/i.test(text)?'artwork':'copy';
 if(explicitProperty)return prepare(explicitProperty[1],{id:explicitProperty[2],name:'selecionado'},modality);
 const options=await action('marketing.options',{});
 const templates=Array.isArray(options?.body.templates)?options!.body.templates as Template[]:[];
 if(!templates.length)return {reply:'O marketing ainda não tem modelos disponíveis. Peça ao gerente para configurar a marca e os modelos no ImobPro.',pending:null,event:'marketing_unconfigured'};
 const properties=await action('property.list',{limite:10});const items=properties?.body.items as Property[]|undefined;
 if(!items?.length)return {reply:'Não encontrei imóveis disponíveis para você divulgar. Confira seu acesso à carteira no ImobPro.',pending:null,event:'marketing_no_properties'};
 runEvent('specialist.completed','marketing');
 return {reply:optionsReply(items,!!properties?.body.nextCursor),pending:{briefId:'',confirmationDigest:'',expiresAt:p.now+10*60000,summary:'',phase:'property',modality,properties:items,templates,cursor:properties?.body.nextCursor as string|undefined},event:'marketing_property_selection'};
}
