/** Evaluation-only metrics; no runtime permissions or customer data. */
import { SUFIXO_RESTO } from "../src/graph/compose";
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

// ─── Persona e tool calling do Newton ───────────────────────────────────────
//
// Medidas de TEXTO e de CHAMADA por turno, sem modelo e sem rede: o eval entrega
// o que o agente respondeu e o que ele chamou, e este trecho só conta e compara.
// A persona do Newton ainda não está no motor (PR próprio): o que se mede hoje é
// a linha de base, e estes gates dizem o que a persona precisa melhorar.

const SEM_ACENTO = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/gu;
const BULLET = /^[ \t]*(?:[-•*–—▪◦·])[ \t]+\S/gm;
const NUMERADO = /^[ \t]*\d{1,2}[.)][ \t]+\S/gm;
const OFERTA_FINAL: RegExp[] = [
  /\bposso (te |lhe |mais )?ajudar\b/,
  /\bem que (mais )?(eu )?posso (te |lhe )?ajudar\b/,
  /\bmais alguma (coisa|duvida|ajuda|informacao)\b/,
  /\bprecisa (de )?(mais )?(alguma coisa|algo)\b/,
  /\balgo mais\b/,
  /\bqualquer (coisa|duvida)\b[^.!?\n]{0,40}\b(e so|estou|fico|me (chama|avisa|fala|diga))\b/,
  /\bfico (a|à) disposicao\b/,
  /\bestou (a|à) disposicao\b/,
  /\b(se|caso) (precisar|quiser|tiver)\b[^.!?\n]{0,60}\b(e so|me (chama|avisa|fala|diga)|estou|fico)\b/,
  /\bconte comigo\b/,
];
const VERBOS_DE_CONSULTA = "(consult|verific|checar|buscar|pesquis|procur|levant|conferir|olhar|ver\\b)";
const NARRACAO: RegExp[] = [
  new RegExp(`\\b(vou|irei|ja vou|vou so|vou ja)\\b[^.!?\\n]{0,30}\\b${VERBOS_DE_CONSULTA}`),
  new RegExp(`\\b(deixa|deixe)( eu| me|-me)\\b[^.!?\\n]{0,30}\\b${VERBOS_DE_CONSULTA}`),
  /\bestou (consultando|verificando|buscando|checando|conferindo|olhando|pesquisando|procurando|levantando)\b/,
  /\b(so um|um) (instante|momento|minutinho|minuto)\b/,
  /\baguarde\b/,
];

export interface SinaisDePersona {
  emojis: number; bullets: number; numerados: number;
  ofertaFinal: boolean; narracaoDeTool: boolean; continuacao: boolean;
}
/**
 * "Quer ver o resto?" (`SUFIXO_RESTO`) é CONTINUAÇÃO — o teto de tamanho cortou a
 * resposta —, não oferta de ajuda: sai do texto antes de procurar a oferta final.
 */
export function sinaisDePersona(texto: string): SinaisDePersona {
  const continuacao = texto.includes(SUFIXO_RESTO);
  const semSufixo = texto.split(SUFIXO_RESTO).join(" ");
  return {
    emojis: (texto.match(EMOJI) ?? []).length,
    bullets: (texto.match(BULLET) ?? []).length,
    numerados: (texto.match(NUMERADO) ?? []).length,
    ofertaFinal: OFERTA_FINAL.some((r) => r.test(SEM_ACENTO(semSufixo.trim().slice(-220)))),
    narracaoDeTool: NARRACAO.some((r) => r.test(SEM_ACENTO(semSufixo))),
    continuacao,
  };
}

const TOKEN_NUMERICO = /\d[\d.,/:]*\d|\d/g;
/**
 * O `nc-guard` do sidecar como métrica: número na resposta sem nenhuma tool no
 * turno é fabricação. Número que a PESSOA escreveu na mensagem e voltou no texto
 * ("o negócio 3") não conta.
 */
export function numerosSemTool(resposta: string, fala: string, chamadasDeTool: number): string[] {
  if (chamadasDeTool > 0) return [];
  const eco = new Set(fala.match(TOKEN_NUMERICO) ?? []);
  return (resposta.match(TOKEN_NUMERICO) ?? []).filter((t) => !eco.has(t));
}

export function percentil(valores: number[], q: number): number | null {
  if (!valores.length) return null;
  const s = [...valores].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

export interface TurnoNewton {
  caseId: string; fala: string; resposta: string;
  /** null = o turno não pontua recall/precisão (`livre`). `algum`: basta UM destes. */
  esperados: { todos: string[]; algum: string[] } | null;
  /** Verbos de LEITURA chamados no turno (escritas ficam em `escritas`). */
  leituras: string[];
  /** Verbos de ESCRITA chamados: qualquer um é indevido enquanto `activity.write` está OFF. */
  escritas: string[];
  /** null = o turno não conferia argumentos. */
  argsOk: boolean | null;
  /** `estado`/`filtro` que a pessoa não pediu. */
  filtrosNaoPedidos: string[];
}

export const GATES_NEWTON = {
  p90Chars: 350, continuacoes: 0.05, recall: 0.85, precisao: 0.9, args: 0.9,
} as const;

export function resumoNewton(turnos: TurnoNewton[]) {
  const sinais = turnos.map((t) => sinaisDePersona(t.resposta));
  const chars = turnos.map((t) => t.resposta.length);
  const fabricacao = turnos.filter((t) => numerosSemTool(t.resposta, t.fala, t.leituras.length + t.escritas.length).length > 0);
  let esperadosTotal = 0, esperadosAtendidos = 0, chamadas = 0, chamadasCertas = 0;
  for (const t of turnos) {
    if (!t.esperados) continue;
    const { todos, algum } = t.esperados;
    esperadosTotal += todos.length + (algum.length ? 1 : 0);
    esperadosAtendidos += todos.filter((v) => t.leituras.includes(v)).length + (algum.length && algum.some((v) => t.leituras.includes(v)) ? 1 : 0);
    const aceitos = new Set([...todos, ...algum]);
    chamadas += t.leituras.length;
    chamadasCertas += t.leituras.filter((v) => aceitos.has(v)).length;
  }
  const conferiramArgs = turnos.filter((t) => t.argsOk !== null);
  const razao = (n: number, d: number) => (d ? n / d : null);
  const recall = razao(esperadosAtendidos, esperadosTotal);
  const precisao = razao(chamadasCertas, chamadas);
  const args = razao(conferiramArgs.filter((t) => t.argsOk).length, conferiramArgs.length);
  const continuacoes = razao(sinais.filter((s) => s.continuacao).length, turnos.length);
  const p90 = percentil(chars, 0.9);
  const contagem = {
    emojis: sinais.filter((s) => s.emojis > 0).length,
    ofertasFinais: sinais.filter((s) => s.ofertaFinal).length,
    narracoes: sinais.filter((s) => s.narracaoDeTool).length,
    filtrosNaoPedidos: turnos.reduce((n, t) => n + t.filtrosNaoPedidos.length, 0),
    fabricacoes: fabricacao.length,
    escritasIndevidas: turnos.reduce((n, t) => n + t.escritas.length, 0),
  };
  const haTurnos = turnos.length > 0;
  // Métrica sem denominador é NÃO MEDIDA, e não medida não aprova.
  const gates = [
    { id: "emoji", limite: "0", valor: contagem.emojis, ok: haTurnos && contagem.emojis === 0 },
    { id: "oferta_final", limite: "0", valor: contagem.ofertasFinais, ok: haTurnos && contagem.ofertasFinais === 0 },
    { id: "narracao_de_tool", limite: "0", valor: contagem.narracoes, ok: haTurnos && contagem.narracoes === 0 },
    { id: "p90_chars", limite: `<=${GATES_NEWTON.p90Chars}`, valor: p90, ok: p90 !== null && p90 <= GATES_NEWTON.p90Chars },
    { id: "continuacoes", limite: `<=${GATES_NEWTON.continuacoes * 100}%`, valor: continuacoes, ok: continuacoes !== null && continuacoes <= GATES_NEWTON.continuacoes },
    { id: "recall_de_tool", limite: `>=${GATES_NEWTON.recall * 100}%`, valor: recall, ok: recall !== null && recall >= GATES_NEWTON.recall },
    { id: "precisao_de_tool", limite: `>=${GATES_NEWTON.precisao * 100}%`, valor: precisao, ok: precisao !== null && precisao >= GATES_NEWTON.precisao },
    { id: "args_corretos", limite: `>=${GATES_NEWTON.args * 100}%`, valor: args, ok: args !== null && args >= GATES_NEWTON.args },
    { id: "filtros_nao_pedidos", limite: "0", valor: contagem.filtrosNaoPedidos, ok: haTurnos && contagem.filtrosNaoPedidos === 0 },
    { id: "fabricacao_de_numero", limite: "0", valor: contagem.fabricacoes, ok: haTurnos && contagem.fabricacoes === 0 },
    { id: "escrita_indevida", limite: "0", valor: contagem.escritasIndevidas, ok: haTurnos && contagem.escritasIndevidas === 0 },
  ];
  return {
    turnos: turnos.length,
    chars: { p50: percentil(chars, 0.5), p90, max: chars.length ? Math.max(...chars) : null },
    bullets: { turnosComBullet: sinais.filter((s) => s.bullets > 0).length, turnosAcimaDe2: sinais.filter((s) => s.bullets > 2).length, turnosNumerados: sinais.filter((s) => s.numerados > 0).length },
    continuacoes: { turnos: sinais.filter((s) => s.continuacao).length, taxa: continuacoes },
    tools: { recall, precisao, esperados: esperadosTotal, chamadas, args },
    contagem,
    casosComFabricacao: fabricacao.map((t) => `${t.caseId}: ${numerosSemTool(t.resposta, t.fala, 0).join(",")}`),
    gates,
    gatePassed: gates.every((g) => g.ok),
  };
}

// ─── Teto de custo ──────────────────────────────────────────────────────────

export const EVAL_MAX_USD_PADRAO = 0.5;
/** Chamada cujo custo o provedor não informou: melhor sobrestimar que gastar sem ver. */
export const CUSTO_ESTIMADO_POR_CHAMADA_USD = 0.002;

export function lerTetoDeCusto(bruto: string | undefined): number {
  if (bruto === undefined || bruto.trim() === "") return EVAL_MAX_USD_PADRAO;
  const n = Number(bruto);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`EVAL_MAX_USD inválido: "${bruto}" (esperado número > 0)`);
  return n;
}

/** Orçamento rígido: `gastar` acumula; `conferir` ABORTA a corrida ao atingir o teto. */
export function criarOrcamento(tetoUsd: number) {
  let gasto = 0;
  return {
    teto: tetoUsd,
    get gasto() { return gasto; },
    gastar(custos: Array<number | null | undefined>) {
      for (const c of custos) gasto += typeof c === "number" && Number.isFinite(c) ? c : CUSTO_ESTIMADO_POR_CHAMADA_USD;
    },
    conferir() {
      if (gasto >= tetoUsd) throw new Error(`EVAL_MAX_USD excedido: gasto US$ ${gasto.toFixed(4)} >= teto US$ ${tetoUsd}; corrida abortada`);
    },
  };
}
