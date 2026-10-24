import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {query} from '../db';
import {conversationKey} from '../phone';
import {redigirCredito} from '../pii';
import {contentDigest} from './contracts';
export const PlaygroundRequestSchema=z.object({orgId:z.string().min(1),phone:z.string().regex(/^\+[1-9]\d{6,14}$/),sessionId:z.string().uuid(),requestId:z.string().uuid(),mode:z.enum(['simulation','staging']).default('simulation'),text:z.string().min(1).max(2000).optional(),novo:z.boolean().optional()}).strict().refine(b=>b.novo===true||b.text!==undefined,{message:'text required'});
export function stagingIdentityAllowed(orgId:string,phone:string):boolean {
 try{const entries:unknown=JSON.parse(process.env.MAX_PLAYGROUND_STAGING_IDENTITIES??'[]');return Array.isArray(entries)&&entries.some(e=>e&&typeof e==='object'&&e.orgId===orgId&&conversationKey(e.phone??'')===conversationKey(phone));}catch{return false;}
}
export async function savePlaygroundMessage(sessionId:string,taskId:string,role:'user'|'assistant',text:string):Promise<void>{
 await query(`INSERT INTO playground_message(id,session_id,task_id,role,text) VALUES($1,$2,$3,$4,$5)`,[randomUUID(),sessionId,taskId,role,redigirCredito(text)]);
}
export async function playgroundHistory(p:{orgId:string;phone:string;sessionId:string;mode:string;subjectDigest?:string}){
 const session=await query(`SELECT id,conversation_id FROM playground_session WHERE id=$1 AND org_id=$2 AND phone_digest=$3 AND mode=$4 AND ($5::text IS NULL OR subject_digest=$5)`,[p.sessionId,p.orgId,contentDigest(conversationKey(p.phone)),p.mode,p.subjectDigest??null]);
 if(!session.length)return null;
 const tasks=await query(`SELECT t.id,t.state,t.workflow_version AS "workflowVersion",t.created_at AS "createdAt",t.updated_at AS "updatedAt",COALESCE(jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'name',e.name,'at',e.at,'data',e.data) ORDER BY e.at) FILTER(WHERE e.id IS NOT NULL),'[]') AS events FROM runtime_task t LEFT JOIN runtime_event e ON e.task_id=t.id AND e.org_id=t.org_id WHERE t.org_id=$1 AND t.conversation_id=$2 GROUP BY t.id ORDER BY t.created_at DESC LIMIT 100`,[p.orgId,session[0].conversation_id??`playground:${p.mode}:${contentDigest({orgId:p.orgId,phone:conversationKey(p.phone),sessionId:p.sessionId})}`]);
 const messages=await query(`SELECT id,role,text,created_at AS "createdAt" FROM (SELECT id,role,text,created_at FROM playground_message WHERE session_id=$1 ORDER BY created_at DESC LIMIT 200) m ORDER BY created_at,id`,[p.sessionId]);
 return {sessionId:p.sessionId,mode:p.mode,tasks,messages};
}
