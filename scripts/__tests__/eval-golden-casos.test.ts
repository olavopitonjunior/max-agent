import { describe, it, expect } from 'vitest';
import { CASOS, TERCEIROS_PADRAO, type CasoGolden } from '../../evals/golden/casos';
import { BASE_GOLDEN, NEGOCIOS_GOLDEN } from '../eval-simulador';
import { VERBOS_DE_LEITURA } from '../../src/graph/scope-contract';
import { VERBOS_DE_ACAO } from '../../src/lib/acao';

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

  it('todo verbo citado (acoes, acoesProibidas, args) existe no catálogo de leitura ou de ação', () => {
    const conhecidos = new Set<string>([...VERBOS_DE_LEITURA, ...VERBOS_DE_ACAO]);
    for (const c of CASOS) {
      for (const t of c.turnos) {
        const e = t.esperado;
        const citados = [...(e.acoes ?? []), ...(e.acoesProibidas ?? []), ...(e.args ?? []).map((a) => a.verbo)];
        for (const v of citados) expect(conhecidos.has(v), `${c.id}: verbo desconhecido ${v}`).toBe(true);
      }
    }
  });

  it('O4 + busca: os oito casos existem, no ambiente de consultas, com a origem datada', () => {
    const o4 = CASOS.filter((c) => c.origem.includes('O4 + busca (16/11)'));
    expect(o4.map((c) => c.id).sort()).toEqual([
      'o4-boleto-nao-envia', 'o4-busca-corretor-indisponivel', 'o4-busca-negocio-do-joao-silva', 'o4-busca-sem-resultado',
      'o4-certidoes-do-negocio', 'o4-cobranca-comissao-paga', 'o4-detalhe-negocio-por-nome', 'o4-documentos-do-negocio',
    ]);
    for (const c of o4) {
      expect(c.bot, c.id).toBe('max');
      expect(c.ambiente, c.id).toEqual(['consultas']);
      expect(c.turnos, c.id).toHaveLength(1);
    }
  });

  it('O4 + busca: todo caso nega markdown, id cru e link; só o corretor muda de identidade', () => {
    const exemplos = ['**negrito**', 'ccccccccccccccccccccccccc', 'dn-teste1', 'veja https://x.test/a'];
    for (const c of CASOS.filter((x) => x.origem.includes('O4 + busca'))) {
      const nao = c.turnos[0]!.esperado.naoContem ?? [];
      for (const exemplo of exemplos) expect(nao.some((r) => (r instanceof RegExp ? r.test(exemplo) : exemplo.includes(r))), `${c.id} deixa passar ${exemplo}`).toBe(true);
      expect(c.identidade ?? 'usuario', c.id).toBe(c.id === 'o4-busca-corretor-indisponivel' ? 'corretor' : 'usuario');
    }
  });

  it('O4 + busca: expectativas do brief (verbos, argumentos e frases)', () => {
    const e = (id: string) => CASOS.find((c) => c.id === id)!.turnos[0]!.esperado;
    expect(e('o4-detalhe-negocio-por-nome').acoes).toEqual(['deal.list', 'deal.detail']);
    expect(e('o4-detalhe-negocio-por-nome').args![0]!.contem.busca).toEqual(/TESTE1/i);
    expect(e('o4-busca-negocio-do-joao-silva').acoes).toEqual(['deal.list']);
    expect(e('o4-busca-corretor-indisponivel').acoesProibidas).toEqual(['deal.list']);
    expect(e('o4-busca-sem-resultado').acoesProibidas).toEqual(['deal.detail']);
    expect(e('o4-certidoes-do-negocio').acoes).toEqual(['certidao.status']);
    expect(e('o4-documentos-do-negocio').acoes).toEqual(['document.list']);
    // document.list termina cada linha com a URL da tela do negócio: ela passa, link de arquivo não.
    const docNao = e('o4-documentos-do-negocio').naoContem as RegExp[];
    expect(docNao.some((r) => r.test('https://imobpro.ia.br/deals/deal-1?tab=anexos'))).toBe(false);
    expect(docNao.some((r) => r.test('https://abc.public.blob.vercel-storage.com/rg.pdf'))).toBe(true);
    expect(docNao.some((r) => r.test('https://imobpro.ia.br/api/files/rg.pdf'))).toBe(true);
    expect(e('o4-cobranca-comissao-paga').acoes).toEqual(['charge.status']);
    // O pedido de envio de boleto não pode escrever nada: sem proposta, formulário nem captação.
    expect(e('o4-boleto-nao-envia').acoesProibidas).toEqual(expect.arrayContaining(['proposal.send', 'proposal.create', 'form.create', 'captacao.send']));
    expect(e('o4-boleto-nao-envia').naoContem!.some((r) => r instanceof RegExp && r.test('Enviei o boleto'))).toBe(true);
  });
});
