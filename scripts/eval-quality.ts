/** Evaluation-only metrics; no runtime permissions or customer data. */
export interface QualityRow {
  caseId: string; repetition: number; turn: number; response: string;
  textChecks: number; actionChecks: number; textFailures: string[]; actionFailures: string[];
  safetyFailures: string[]; latencyMs: number; costUsd: number | null; model: string;
  memoryChecks: number; memoryFailures: number;
}
/** Wilson interval, descriptive only: turns in one conversation are correlated. */
function rate(successes: number, total: number) {
  if (!total) return {successes,total,rate:null,lower95:null,upper95:null};
  const p=successes/total,z=1.959964,d=1+z*z/total;
  const center=(p+z*z/(2*total))/d;
  const half=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/d;
  return {successes,total,rate:p,lower95:Math.max(0,center-half),upper95:Math.min(1,center+half)};
}
function distribution(values: number[]) {
  const xs=[...values].sort((a,b)=>a-b),n=xs.length;
  return {n,mean:n?xs.reduce((a,b)=>a+b,0)/n:null,
    median:n?(n%2?xs[(n-1)/2]:(xs[n/2-1]+xs[n/2])/2):null,
    p95:n?xs[Math.ceil(.95*n)-1]:null};
}
const normalize=(text:string)=>text.toLocaleLowerCase('pt-BR').replace(/\s+/g,' ').trim();
export function responseSignals(text: string, previous: string[], maxChars=500) {
  const sentences=text.split(/[.!?\n]+/).map(normalize).filter(Boolean);
  return {chars:text.length,words:text.split(/\s+/u).filter(Boolean).length,
    lines:text.split('\n').filter(x=>x.trim()).length,
    questions:(text.match(/\?/g)||[]).length,
    aboveCharBudget:text.length>maxChars,
    repeatedAnswer:!!text.trim()&&previous.some(p=>normalize(p)===normalize(text)),
    repeatedSentenceFraction:sentences.length?(sentences.length-new Set(sentences).size)/sentences.length:0};
}
export function summarizeQuality(rows: QualityRow[]) {
  const evaluated=rows.filter(r=>r.textChecks+r.actionChecks+r.memoryChecks>0);
  const passed=(r:QualityRow)=>r.textChecks+r.actionChecks+r.memoryChecks>0&&!r.textFailures.length&&!r.actionFailures.length&&!r.safetyFailures.length&&!r.memoryFailures;
  const groups=new Map<string,QualityRow[]>(),cases=new Map<string,QualityRow[]>();
  for (const r of rows) {
    const key=JSON.stringify([r.caseId,r.repetition]);
    groups.set(key,[...(groups.get(key)||[]),r]);
    cases.set(r.caseId,[...(cases.get(r.caseId)||[]),r]);
  }
  const text=rows.filter(r=>r.textChecks>0),action=rows.filter(r=>r.actionChecks>0);
  const costs=rows.map(r=>r.costUsd).filter((v):v is number=>v!==null);
  const totalMemory=rows.reduce((n,r)=>n+r.memoryChecks,0);
  const safetyViolations=rows.reduce((n,r)=>n+r.safetyFailures.length,0);
  return {
    turns:rows.length,checkedTurns:evaluated.length,uncheckedTurns:rows.length-evaluated.length,
    gatePassed:rows.length>0&&rows.every(passed),safetyViolations,
    textAccuracy:rate(text.filter(r=>!r.textFailures.length).length,text.length),
    actionAccuracy:rate(action.filter(r=>!r.actionFailures.length).length,action.length),
    memoryAccuracy:rate(totalMemory-rows.reduce((n,r)=>n+r.memoryFailures,0),totalMemory),
    conversationsPassed:[...groups.values()].filter(g=>g.every(passed)).length,
    conversationsTotal:groups.size,
    consistentCases:rate([...cases.values()].filter(g=>g.every(passed)).length,cases.size),
    repetitionsPerCase:Object.fromEntries([...cases].map(([k,v])=>[k,new Set(v.map(r=>r.repetition)).size])),
    latencyMs:distribution(rows.map(r=>r.latencyMs)),
    costUsd:{total:costs.length===rows.length?costs.reduce((a,b)=>a+b,0):null,
      measuredTotal:costs.reduce((a,b)=>a+b,0),unknownTurns:rows.length-costs.length,...distribution(costs)},
    models:[...new Set(rows.map(r=>r.model))],
    limits:['Wilson intervals are descriptive; turns are not independent.',
      'Repeated wording is a signal, not proof of an unnecessary question.',
      'No memory assertion means unmeasured memory, not perfect recall.',
      'Mocked effects do not prove provider delivery or server authorization.'],
  };
}

/** One expected effect must occur once, with every observed argument checked. */
export function checkSingleAction(calls: Array<{verbo:string;args:Record<string,unknown>}>, expected: {verbo:string;confere:(args:Record<string,unknown>)=>string|null}): string[] {
  const matching=calls.filter(c=>c.verbo===expected.verbo);
  const errors=matching.length===1?[]:[`${expected.verbo}: expected 1 call, got ${matching.length}`];
  for(const call of matching){const error=expected.confere(call.args);if(error)errors.push(`${expected.verbo}: ${error}`);}
  return errors;
}

export function checkCreationRouting(calls:Array<{name:string;args:Record<string,unknown>}>,tipo:string|null,natureza?:string):string[]{
  if(tipo===null)return calls.length?['expected no tool calls']:[];
  const errors=calls.length===1?[]:[`expected 1 tool call, got ${calls.length}`];
  const creation=calls.filter(c=>c.name==='propor_criacao');
  if(creation.length!==1)errors.push('expected exactly one propor_criacao');
  for(const call of creation){
    if(call.args.tipo!==tipo)errors.push(`wrong tipo: expected ${tipo}`);
    if(natureza&&call.args.natureza!==natureza)errors.push(`wrong natureza: expected ${natureza}`);
  }
  return errors;
}
