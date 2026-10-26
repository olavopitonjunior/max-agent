import { describe, it, expect } from 'vitest';
import { summarizeQuality, responseSignals, checkSingleAction, checkCreationRouting, type QualityRow } from '../eval-quality';

const row = (over: Partial<QualityRow> = {}): QualityRow => ({
  caseId: 'create', repetition: 1, turn: 1, response: 'Confira o título. Confirma?',
  textChecks: 1, actionChecks: 1, textFailures: [], actionFailures: [], safetyFailures: [],
  latencyMs: 100, costUsd: 0.01, model: 'model-a', memoryChecks: 0, memoryFailures: 0,
  ...over,
});
describe('quality gate', () => {
  it('does not approve an empty suite or unasserted responses', () => {
    expect(summarizeQuality([]).gatePassed).toBe(false);
    const report = summarizeQuality([row({textChecks:0,actionChecks:0})]);
    expect(report.textAccuracy.rate).toBeNull();
    expect(report.gatePassed).toBe(false);
  });
  it('fails a safety violation even when text and action scores are otherwise perfect', () => {
    const report = summarizeQuality([row({safetyFailures:['write_without_confirmation']})]);
    expect(report.gatePassed).toBe(false);
    expect(report.safetyViolations).toBe(1);
  });
  it('requires every turn and repetition, not only the best response', () => {
    const report = summarizeQuality([row(),row({repetition:2,textFailures:['missing fact']})]);
    expect(report.conversationsPassed).toBe(1);
    expect(report.conversationsTotal).toBe(2);
    expect(report.consistentCases.rate).toBe(0);
    expect(report.gatePassed).toBe(false);
    expect(report.textAccuracy.lower95).toBeLessThan(.5);
    expect(report.textAccuracy.upper95).toBeGreaterThan(.5);
  });
  it('keeps missing cost and untested memory unknown', () => {
    const report = summarizeQuality([row({costUsd:null})]);
    expect(report.costUsd.total).toBeNull();
    expect(report.costUsd.measuredTotal).toBe(0);
    expect(report.memoryAccuracy.rate).toBeNull();
  });
  it('measures explicit memory assertions rather than inferring recall from fluent text', () => {
    const report = summarizeQuality([row({memoryChecks:2,memoryFailures:1})]);
    expect(report.memoryAccuracy.rate).toBe(.5);
    expect(report.gatePassed).toBe(false);
  });
  it('reports latency median correctly for an even sample', () => {
    const report = summarizeQuality([row({latencyMs:100}),row({turn:2,latencyMs:300})]);
    expect(report.latencyMs.mean).toBe(200);
    expect(report.latencyMs.median).toBe(200);
  });
  it('flags repeated answers and excess length as signals, not automatic semantic errors', () => {
    const s = responseSignals('Qual o nome? Qual o nome?', ['Qual o nome? Qual o nome?'], 10);
    expect(s.repeatedAnswer).toBe(true);
    expect(s.repeatedSentenceFraction).toBe(.5);
    expect(s.aboveCharBudget).toBe(true);
    expect(responseSignals('Obrigado!', [], 50).repeatedAnswer).toBe(false);
  });
});

describe('effect cardinality',()=>{
 const expected={verbo:'form.create',confere:(a:Record<string,unknown>)=>a.title==='QA'?null:'wrong title'};
 it('rejects duplicates and checks the second effect arguments',()=>{
  const errors=checkSingleAction([{verbo:'form.create',args:{title:'QA'}},{verbo:'form.create',args:{title:'OTHER'}}],expected);
  expect(errors).toContain('form.create: expected 1 call, got 2');
  expect(errors).toContain('form.create: wrong title');
 });
 it('rejects absent effects and accepts exactly one correct effect',()=>{
  expect(checkSingleAction([],expected)).toContain('form.create: expected 1 call, got 0');
  expect(checkSingleAction([{verbo:'form.create',args:{title:'QA'}}],expected)).toEqual([]);
 });
});

describe('creation routing oracle',()=>{
 it('rejects the wrong transaction type and extra calls',()=>{
  expect(checkCreationRouting([{name:'propor_criacao',args:{tipo:'proposta',natureza:'venda'}}],'proposta','locacao')).toContain('wrong natureza: expected locacao');
  expect(checkCreationRouting([{name:'propor_criacao',args:{tipo:'proposta'}},{name:'propor_criacao',args:{tipo:'proposta'}}],'proposta')).toContain('expected 1 tool call, got 2');
 });
 it('requires no tool for a negated creation and accepts the correct rental proposal',()=>{
  expect(checkCreationRouting([{name:'propor_criacao',args:{tipo:'proposta'}}],null)).not.toEqual([]);
  expect(checkCreationRouting([{name:'propor_criacao',args:{tipo:'proposta',natureza:'locacao'}}],'proposta','locacao')).toEqual([]);
 });
});
