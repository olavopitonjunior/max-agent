import {describe,it,expect,vi,afterEach} from 'vitest';
import {ferramentasDoTurno} from '../tools';
const identity={kind:'user' as const,orgId:'fixture',orgName:'Fixture',userId:'fixture',userName:'Fixture'};
afterEach(()=>vi.unstubAllEnvs());
describe('extended reads rollout',()=>{
 it('does not offer extended queries until separate flag is enabled',()=>{
  expect(ferramentasDoTurno({identity,policy:['property.list'],texto:'liste os imóveis'}).entradas).toHaveLength(0);
  vi.stubEnv('MAX_EXTENDED_QUERIES','true');
  expect(ferramentasDoTurno({identity,policy:['property.list'],texto:'liste os imóveis'}).entradas.map(e=>e.nome)).toContain('listar_imoveis');
 });
 it('still requires live policy with flag on',()=>{vi.stubEnv('MAX_EXTENDED_QUERIES','true');expect(ferramentasDoTurno({identity,policy:[],texto:'minhas notificações e atividades'}).entradas).toHaveLength(0);});
});
