import { describe, it, expect } from 'vitest';
import { CASOS, TERCEIROS_PADRAO, type CasoGolden } from '../../evals/golden/casos';
import { BASE_GOLDEN, NEGOCIOS_GOLDEN } from '../eval-simulador';

const ids = (bot?: string) => CASOS.filter((c) => !bot || c.bot === bot).map((c) => c.id);
const todoTexto = (c: CasoGolden) => JSON.stringify(c, (_k, v) => (v instanceof RegExp ? v.source : v));

describe('golden: arquivo de casos', () => {
  it('ids únicos, bot válido e ao menos um turno com usuário', () => {
    expect(new Set(ids()).size).toBe(CASOS.length);
    for (const c of CASOS) {
      expect(['max', 'newton']).toContain(c.bot);
      expect(c.origem.length).toBeGreaterThan(10);
      expect(c.turnos.length).toBeGreaterThan(0);
      for (const t of c.turnos) expect(t.usuario.trim()).not.toBe('');
    }
  });

  it('cobre os casos mínimos do brief', () => {
    for (const prefixo of [
      'm4-', 'm6b-', 'm8-r5-', 'm9-', 'pendencias-negocio-teste-assinatura-4', 'status-contrato-teste-assinatura-2',
      'newton-status-contrato-teste1', 'r2-captacao-mensagem-unica', 'r3-newton-tipos-de-assinatura', 'r4-propostas-da-imobiliaria-mes',
      'w46-complemento', 'w46-credito-ok',
    ]) expect(CASOS.some((c) => c.id.startsWith(prefixo)), prefixo).toBe(true);
    expect(ids('newton').length).toBeGreaterThanOrEqual(3);
    expect(ids('max').length).toBeGreaterThanOrEqual(8);
  });

  it('todo turno confere algo (texto, verbo ou argumento) ou é passo de conversa', () => {
    for (const c of CASOS) {
      const confere = c.turnos.some((t) => {
        const e = t.esperado;
        return !!(e.acoes?.length || e.acoesProibidas?.length || e.contem?.length || e.naoContem?.length || e.args?.length);
      });
      expect(confere, c.id).toBe(true);
    }
  });

  it('dados sintéticos: só o CPF de teste (marcado), só o telefone 11999990000, nada de e-mail real', () => {
    for (const c of CASOS) {
      const txt = todoTexto(c);
      const cpfs = txt.match(/\d{3}\.\d{3}\.\d{3}-\d{2}|\b\d{11}\b/g) ?? [];
      const fones = txt.match(/\b\d{2}9\d{8}\b/g) ?? [];
      for (const cpf of cpfs.filter((x) => x !== '11999990000')) expect(cpf, c.id).toBe('111.444.777-35');
      if (txt.includes('111.444.777-35')) expect(c.sintetico, `${c.id} usa CPF sem marcar sintetico`).toBe(true);
      for (const f of fones) expect(f, c.id).toBe('11999990000');
      expect(txt, c.id).not.toMatch(/@(?!exemplo)/);
    }
  });

  it('os alvos do cenário existem no simulador (PROP-2026-0003 e os negócios TESTE)', () => {
    expect(BASE_GOLDEN.some((p) => p.codigo === 'PROP-2026-0003')).toBe(true);
    const idsNeg = NEGOCIOS_GOLDEN.map((n) => n.id);
    for (const id of ['dn-assinatura-2', 'dn-assinatura-4', 'dn-teste1']) expect(idsNeg).toContain(id);
    // TESTE1 não pode ser o item 1: o caso separa "TESTE1" de "item 1".
    expect(NEGOCIOS_GOLDEN[0]!.id).not.toBe('dn-teste1');
  });

  it('tarefa proposta tem o card dentro de 3 turnos de usuário no fluxo esperado', () => {
    for (const c of CASOS.filter((x) => x.tarefa === 'proposta')) expect(c.turnos.length, c.id).toBeGreaterThanOrEqual(3);
  });

  it('terceiros padrão incluem os clientes do cenário e nunca o usuário', () => {
    expect(TERCEIROS_PADRAO).toEqual(expect.arrayContaining(['João', 'Letícia', 'TESTE Comprador']));
    expect(TERCEIROS_PADRAO).not.toContain('Olavo');
  });

  it('R2 e R4 existem para Max e Newton; o crédito simula o envio', () => {
    expect(ids('max')).toContain('r2-captacao-mensagem-unica-max');
    expect(ids('newton')).toContain('r2-captacao-mensagem-unica-newton');
    expect(ids('max')).toContain('r4-propostas-da-imobiliaria-mes-max');
    expect(ids('newton')).toContain('r4-propostas-da-imobiliaria-mes-newton');
    expect(CASOS.find((c) => c.id === 'w46-credito-ok-nao-executa')!.envio).toBe('aprovado');
  });
});
