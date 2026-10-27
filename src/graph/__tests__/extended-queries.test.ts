import {describe,it,expect,vi,afterEach} from 'vitest';
import {ferramentasDoTurno} from '../tools';
import {PERIODOS_DE_METRICA,QUEBRAS_DE_METRICA} from '../scope-contract';
const identity={kind:'user' as const,orgId:'fixture',orgName:'Fixture',userId:'fixture',userName:'Fixture'};
afterEach(()=>vi.unstubAllEnvs());
describe('extended reads rollout',()=>{
 it('does not offer extended queries until separate flag is enabled',()=>{
  expect(ferramentasDoTurno({identity,policy:['property.list'],texto:'liste os imóveis'}).entradas).toHaveLength(0);
  vi.stubEnv('MAX_ROLLOUT_ORGS',JSON.stringify({fixture:['queries']}));vi.stubEnv('MAX_EXTENDED_QUERIES','true');
  expect(ferramentasDoTurno({identity,policy:['property.list'],texto:'liste os imóveis'}).entradas.map(e=>e.nome)).toContain('listar_imoveis');
 });
 it('still requires live policy with flag on',()=>{vi.stubEnv('MAX_ROLLOUT_ORGS',JSON.stringify({fixture:['queries']}));vi.stubEnv('MAX_EXTENDED_QUERIES','true');expect(ferramentasDoTurno({identity,policy:[],texto:'minhas notificações e atividades'}).entradas).toHaveLength(0);});
});
describe('resumo_carteira com período e quebra (receptor inerte)',()=>{
 const oferta=(texto:string)=>ferramentasDoTurno({identity,policy:['metrics.get'],texto}).entradas.map(e=>e.nome);
 it('só é oferecida com MAX_EXTENDED_QUERIES + rollout, como as outras leituras',()=>{
  expect(oferta('quero os números do mês')).toHaveLength(0);
  vi.stubEnv('MAX_EXTENDED_QUERIES','true');
  expect(oferta('quero os números do mês')).toHaveLength(0);
  vi.stubEnv('MAX_ROLLOUT_ORGS',JSON.stringify({fixture:['queries']}));
  expect(oferta('quero os números do mês')).toEqual(['resumo_carteira']);
  expect(oferta('como foi o desempenho da equipe')).toEqual(['resumo_carteira']);
  expect(oferta('resumo da carteira')).toEqual(['resumo_carteira']);
 });
 it('declara periodo e quebra com os enums do contrato',()=>{
  vi.stubEnv('MAX_ROLLOUT_ORGS',JSON.stringify({fixture:['queries']}));vi.stubEnv('MAX_EXTENDED_QUERIES','true');
  const def=ferramentasDoTurno({identity,policy:['metrics.get'],texto:'resumo da carteira'}).entradas[0].def as any;
  expect(def.parameters.properties.periodo.enum).toEqual([...PERIODOS_DE_METRICA]);
  expect(def.parameters.properties.quebra.enum).toEqual([...QUEBRAS_DE_METRICA]);
  expect(def.parameters.required).toEqual([]);
 });
 it('o prefiltro novo não rouba a frase de outras tools',()=>{
  vi.stubEnv('MAX_ROLLOUT_ORGS',JSON.stringify({fixture:['queries']}));vi.stubEnv('MAX_EXTENDED_QUERIES','true');
  const todas=['metrics.get','activity.list','property.list','contract.status','notification.list'] as const;
  const nomes=(t:string)=>ferramentasDoTurno({identity,policy:[...todas],texto:t}).entradas.map(e=>e.nome);
  expect(nomes('liste os imóveis')).not.toContain('resumo_carteira');
  expect(nomes('minhas atividades de hoje')).not.toContain('resumo_carteira');
  expect(nomes('situação do contrato')).not.toContain('resumo_carteira');
 });
});
