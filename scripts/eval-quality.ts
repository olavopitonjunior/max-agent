/** Evaluation-only metrics; no runtime permissions or customer data. */
export interface QualityRow {
  caseId: string; repetition: number; turn: number; response: string;
  textChecks: number; actionChecks: number; textFailures: string[]; actionFailures: string[];
  safetyFailures: string[]; latencyMs: number; costUsd: number | null; model: string;
  memoryChecks: number; memoryFailures: number;
  /** Golden set (opcionais, para não quebrar a bateria antiga): efeitos de escrita do turno, tarefa e card. */
  writes?: number; tarefa?: TipoDeTarefa | null; cardExibido?: boolean;
  promessas?: string[]; formato?: string[];
}
export type TipoDeTarefa = 'proposta' | 'captacao';
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
    ...goldenMetrics(rows),
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

// ─── Golden set: promessa sem efeito, perguntas por tarefa e formato ─────────
// Heurísticas de texto (sem modelo): sinais, não prova semântica.

/** Promessa em presente/futuro de um efeito que o Max só produz com uma escrita. */
/**
 * `condicional`: promessa que vira card legítimo quando o texto pede o SIM
 * ("Vou ajustar ...: Confirma?"). As outras nunca são isentas: "Ajusto. Responda SIM"
 * é exatamente o defeito W46 (promete sem mostrar o resumo atualizado).
 */
const PROMESSAS:{re:RegExp;condicional:boolean}[]=[
  {re:/\bajusto\b/i,condicional:false},
  {re:/\bvou (ajustar|atualizar|gerar|criar)\b/i,condicional:true},
  {re:/\bj[aá] (atualizo|ajusto)\b/i,condicional:false},
  {re:/\bte (atualizo|aviso)\b/i,condicional:false},
  {re:/\bser[aá] criad[oa]s?\b/i,condicional:true},
];
/** Pergunta de confirmação: o card que pede o SIM. */
const PEDE_CONFIRMACAO=/\b[Cc]onfirma\?|\bSIM\b/;
/** Trechos de promessa no texto; ignora negação logo antes ("não vou gerar") e, só nas condicionais, o card com SIM. */
export function promessasNoTexto(text:string):string[]{
  const pedeSim=PEDE_CONFIRMACAO.test(text);
  const found:string[]=[];
  for(const {re,condicional} of PROMESSAS){
    if(condicional&&pedeSim)continue;
    const m=re.exec(text);
    if(!m)continue;
    if(/\bn[aã]o\s+(?:\S+\s+)?$/i.test(text.slice(Math.max(0,m.index-16),m.index)))continue;
    found.push(m[0].toLowerCase());
  }
  return found;
}
/** Promessa sem efeito: o texto promete e o turno não executou nenhuma escrita. */
export function detectaPromessaSemEfeito(text:string,escritas:number):string[]{
  return escritas>0?[]:promessasNoTexto(text);
}

const VERBOS_INTERNOS=/\b(?:deal|proposal|captacao|credit|form|lead|contract|metrics|pending|property|activity|notification|template)\.[a-z_]+(?:\.[a-z_]+)?\b/;
/** Formato proibido no WhatsApp: markdown `**`/`##`, colchetes ⟨⟩, `n=`, códigos internos (snake_case, verbos). */
export function violacoesDeFormato(text:string):string[]{
  // URL e CPF mascarado (***.***.777-35) não são markdown.
  const t=text.replace(/https?:\/\/\S+/g,' ').replace(/\*{3}\.\*{3}\.\d{3}-\d{2}/g,' ');
  const out:string[]=[];
  for(const m of t.matchAll(/\*\*/g))out.push(m[0]);
  for(const m of t.matchAll(/^\s*#{2,}\s/gm))out.push('##');
  for(const m of t.matchAll(/[⟨⟩]/g))out.push(m[0]);
  for(const m of t.matchAll(/\bn=\d+/g))out.push(m[0]);
  // snake_case colado a @, / ou . é e-mail, caminho ou arquivo, não código interno.
  for(const m of t.matchAll(/(?<![@/.\w])[a-z]+(?:_[a-z]+)+(?![\w@/]|\.\w)/g))out.push(m[0]);
  const v=VERBOS_INTERNOS.exec(t);
  if(v)out.push(v[0]);
  return out;
}

/** O Max chama a pessoa por nome de cliente/terceiro ("Pronto, Letícia!"). Devolve o nome, ou null. */
export function vocativoErrado(text:string,terceiros:string[]):string|null{
  for(const nome of terceiros){
    const n=nome.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const re=new RegExp(`(?:^|[\\n.!?]\\s*|\\b(?:oi|ol[aá]|ok|certo|pronto|beleza|valeu|obrigad[oa]|bom dia|boa tarde|boa noite)[,!]?\\s+)${n}\\s*[,!]`,'i');
    if(re.test(text))return nome;
  }
  return null;
}

/** Nº de turnos do usuário até o card de confirmação aparecer (1-based); null = tarefa não concluída. */
export function perguntasPorTarefa(turns:{cardExibido?:boolean}[]):number|null{
  const i=turns.findIndex(t=>t.cardExibido);
  return i<0?null:i+1;
}
/** Metas do gate (por tipo de tarefa); captação sem meta definida no brief. */
export const METAS_DE_TAREFA:Partial<Record<TipoDeTarefa,number>>={proposta:3};

export function goldenMetrics(rows:QualityRow[]){
  const promessaSemEfeito=rows.filter(r=>r.promessas?.length).map(r=>({caseId:r.caseId,repetition:r.repetition,turn:r.turn,promessas:r.promessas}));
  const formatoTurnos=rows.filter(r=>r.formato?.length);
  const porConversa=new Map<string,QualityRow[]>();
  for(const r of rows)if(r.tarefa)porConversa.set(JSON.stringify([r.caseId,r.repetition]),[...(porConversa.get(JSON.stringify([r.caseId,r.repetition]))||[]),r]);
  const tarefas=[...porConversa.values()].map(g=>({tipo:g[0]!.tarefa as TipoDeTarefa,caseId:g[0]!.caseId,repetition:g[0]!.repetition,perguntas:perguntasPorTarefa(g)}));
  const porTipo:Record<string,{conversas:number;concluidas:number;media:number|null;max:number|null;meta:number|null;dentroDaMeta:boolean|null}>={};
  for(const tipo of new Set(tarefas.map(t=>t.tipo))){
    const ts=tarefas.filter(t=>t.tipo===tipo),ok=ts.map(t=>t.perguntas).filter((v):v is number=>v!==null);
    const meta=METAS_DE_TAREFA[tipo]??null;
    porTipo[tipo]={conversas:ts.length,concluidas:ok.length,media:ok.length?ok.reduce((a,b)=>a+b,0)/ok.length:null,max:ok.length?Math.max(...ok):null,meta,
      dentroDaMeta:meta===null?null:ok.length===ts.length&&ok.every(v=>v<=meta)};
  }
  return {
    promessaSemEfeito:{turnos:promessaSemEfeito.length,meta:0,casos:promessaSemEfeito},
    perguntasPorTarefa:{porTipo,conversas:tarefas},
    formato:{turnos:formatoTurnos.length,ocorrencias:formatoTurnos.reduce((n,r)=>n+(r.formato?.length||0),0),meta:0,
      detalhe:formatoTurnos.map(r=>({caseId:r.caseId,repetition:r.repetition,turn:r.turn,formato:r.formato}))},
  };
}

/** Gate do golden set: 0 promessa sem efeito, 0 formato, ≥98% das ações certas (e ao menos uma ação conferida). */
export const META_ACOES_CORRETAS=0.98;
export function goldenGate(rows:QualityRow[]){
  const m=goldenMetrics(rows),acao=rows.filter(r=>r.actionChecks>0);
  const certas=acao.filter(r=>!r.actionFailures.length).length;
  const taxa=acao.length?certas/acao.length:null;
  const motivos:string[]=[];
  if(!rows.length)motivos.push('golden vazio');
  if(m.promessaSemEfeito.turnos>0)motivos.push(`promessaSemEfeito=${m.promessaSemEfeito.turnos} (meta 0)`);
  if(m.formato.turnos>0)motivos.push(`formato=${m.formato.ocorrencias} em ${m.formato.turnos} turnos (meta 0)`);
  if(taxa===null)motivos.push('nenhuma ação conferida');
  else if(taxa<META_ACOES_CORRETAS)motivos.push(`acoesCorretas=${(100*taxa).toFixed(1)}% (meta >=98%)`);
  for(const [tipo,v] of Object.entries(m.perguntasPorTarefa.porTipo))if(v.dentroDaMeta===false)motivos.push(`perguntasPorTarefa(${tipo}) fora da meta ${v.meta}`);
  return {passed:motivos.length===0,motivos,acoesCorretas:{certas,total:acao.length,taxa}};
}
