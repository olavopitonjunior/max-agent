import { describe, it, expect } from 'vitest';
import {
  summarizeQuality, goldenMetrics, goldenGate, promessasNoTexto, detectaPromessaSemEfeito,
  violacoesDeFormato, vocativoErrado, perguntasPorTarefa, type QualityRow,
} from '../eval-quality';

const row = (over: Partial<QualityRow> = {}): QualityRow => ({
  caseId: 'c', repetition: 1, turn: 1, response: 'ok',
  textChecks: 1, actionChecks: 1, textFailures: [], actionFailures: [], safetyFailures: [],
  latencyMs: 1, costUsd: 0, model: 'm', memoryChecks: 0, memoryFailures: 0,
  ...over,
});

describe('promessaSemEfeito', () => {
  it.each([
    'Ajusto o complemento para apartamento 1.',
    'Vou ajustar o complemento agora.',
    'Já atualizo a proposta.',
    'Te atualizo em seguida.',
    'Te aviso quando sair.',
    'Vou gerar o link.',
    'O rascunho será criado em instantes.',
  ])('detecta a promessa sem escrita: %s', (texto) => {
    expect(detectaPromessaSemEfeito(texto, 0)).not.toEqual([]);
  });
  it('não conta quando o turno executou uma escrita', () => {
    expect(detectaPromessaSemEfeito('Vou gerar o link.', 1)).toEqual([]);
  });
  it('não conta a negação nem o card que pede o SIM', () => {
    expect(promessasNoTexto('Não vou gerar nada sem a sua confirmação.')).toEqual([]);
    expect(promessasNoTexto('Vou ajustar na proposta PROP-1:\n- Complemento: apto 1\n\nResponda SIM para confirmar.')).toEqual([]);
    expect(promessasNoTexto('Vou ajustar o complemento. Confirma?')).toEqual([]);
  });
  it('SIM no texto não isenta "ajusto" nem "te aviso" (defeito W46)', () => {
    expect(promessasNoTexto('Ajusto o complemento. Responda SIM.')).toEqual(['ajusto']);
    expect(promessasNoTexto('Te aviso quando sair. Responda SIM.')).toEqual(['te aviso']);
    expect(promessasNoTexto('Já atualizo. Confirma?')).toEqual(['já atualizo']);
  });
  it('negação curta também não é promessa', () => {
    expect(promessasNoTexto('Não te aviso por aqui.')).toEqual([]);
    expect(promessasNoTexto('Ainda não ajusto nada.')).toEqual([]);
  });
  it('texto neutro não é promessa', () => {
    expect(promessasNoTexto('A proposta PROP-2026-0012 está em rascunho.')).toEqual([]);
  });
  it('agrega por turno em goldenMetrics, com meta 0', () => {
    const m = goldenMetrics([row({ promessas: ['vou gerar'] }), row({ turn: 2 })]);
    expect(m.promessaSemEfeito.turnos).toBe(1);
    expect(m.promessaSemEfeito.meta).toBe(0);
    expect(m.promessaSemEfeito.casos[0]).toMatchObject({ caseId: 'c', turn: 1 });
  });
});

describe('formato', () => {
  it('conta ** , ##, colchetes, n= e códigos internos', () => {
    const v = violacoesDeFormato('**Negrito**\n## Título\n⟨x⟩ n=3 sem_permissao deal.list');
    expect(v).toEqual(expect.arrayContaining(['**', '##', '⟨', '⟩', 'n=3', 'sem_permissao', 'deal.list']));
    expect(v.filter((x) => x === '**')).toHaveLength(2);
  });
  it('snake_case colado a @, / ou . não conta (e-mail, caminho, arquivo)', () => {
    expect(violacoesDeFormato('Mande para renato_lima@exemplo.com ou veja docs/meu_arquivo e foto.meu_anexo')).toEqual([]);
  });
  it('WhatsApp normal passa: negrito de uma estrela, URL e prosa', () => {
    expect(violacoesDeFormato('Responda *SIM* para confirmar.\nVeja https://app.imobpro.test/p/rascunho_final.pdf e o item #1.')).toEqual([]);
  });
  it('CPF mascarado (***.***.777-35) não conta como markdown', () => {
    expect(violacoesDeFormato('Anotei: CPF ***.***.777-35. Responda *SIM*.')).toEqual([]);
    expect(violacoesDeFormato('CPF ***.***.777-35 e **negrito**')).toEqual(['**', '**']);
  });
  it('agrega ocorrências e turnos em goldenMetrics, com meta 0', () => {
    const m = goldenMetrics([row({ formato: ['**', 'n=2'] }), row({ turn: 2 })]);
    expect(m.formato).toMatchObject({ turnos: 1, ocorrencias: 2, meta: 0 });
  });
});

describe('vocativo', () => {
  it('pega o nome de terceiro como vocativo', () => {
    expect(vocativoErrado('Pronto, João! Enviei.', ['João'])).toBe('João');
    expect(vocativoErrado('Oi João, tudo bem?', ['João'])).toBe('João');
    expect(vocativoErrado('João, a proposta saiu.', ['João'])).toBe('João');
  });
  it('citar o cliente no meio da frase não é vocativo', () => {
    expect(vocativoErrado('A proposta do João está em rascunho.', ['João'])).toBeNull();
    expect(vocativoErrado('Pronto, Olavo!', ['João'])).toBeNull();
    expect(vocativoErrado('Signatários:\nCarlos: pendente', ['Carlos'])).toBeNull();
  });
});

describe('perguntasPorTarefa', () => {
  it('conta os turnos do usuário até o card (1-based)', () => {
    expect(perguntasPorTarefa([{}, {}, { cardExibido: true }, { cardExibido: true }])).toBe(3);
  });
  it('tarefa sem card é não concluída (null)', () => {
    expect(perguntasPorTarefa([{}, {}])).toBeNull();
  });
  it('proposta: dentro da meta (<=3) e fora dela', () => {
    const conversa = (cards: boolean[], caseId: string) =>
      cards.map((c, i) => row({ caseId, turn: i + 1, tarefa: 'proposta', cardExibido: c }));
    const dentro = goldenMetrics(conversa([false, false, true], 'a'));
    expect(dentro.perguntasPorTarefa.porTipo.proposta).toMatchObject({ concluidas: 1, max: 3, meta: 3, dentroDaMeta: true });
    const fora = goldenMetrics(conversa([false, false, false, true], 'b'));
    expect(fora.perguntasPorTarefa.porTipo.proposta?.dentroDaMeta).toBe(false);
    const naoConcluida = goldenMetrics(conversa([false, false], 'c'));
    expect(naoConcluida.perguntasPorTarefa.porTipo.proposta).toMatchObject({ concluidas: 0, dentroDaMeta: false });
  });
  it('captação não tem meta no gate', () => {
    const m = goldenMetrics([row({ tarefa: 'captacao', cardExibido: true })]);
    expect(m.perguntasPorTarefa.porTipo.captacao).toMatchObject({ meta: null, dentroDaMeta: null });
  });
});

describe('goldenGate e summarizeQuality', () => {
  it('summarizeQuality expõe as três métricas novas', () => {
    const s = summarizeQuality([row()]);
    expect(s.promessaSemEfeito.turnos).toBe(0);
    expect(s.formato.ocorrencias).toBe(0);
    expect(s.perguntasPorTarefa.conversas).toEqual([]);
  });
  it('passa com 0 promessa, 0 formato e todas as ações certas', () => {
    expect(goldenGate([row(), row({ turn: 2 })]).passed).toBe(true);
  });
  it('reprova por promessa, por formato e por ações abaixo de 98%', () => {
    expect(goldenGate([row({ promessas: ['vou gerar'] })]).motivos.join()).toMatch(/promessaSemEfeito=1/);
    expect(goldenGate([row({ formato: ['**'] })]).motivos.join()).toMatch(/formato=1/);
    const rows = Array.from({ length: 50 }, (_, i) => row({ turn: i + 1, actionFailures: i < 2 ? ['x'] : [] }));
    const g = goldenGate(rows);
    expect(g.passed).toBe(false);
    expect(g.acoesCorretas).toMatchObject({ certas: 48, total: 50 });
    expect(g.motivos.join()).toMatch(/acoesCorretas=96\.0%/);
  });
  it('49/50 = 98% ainda passa; 48/50 não', () => {
    const mk = (falhas: number) => Array.from({ length: 50 }, (_, i) => row({ turn: i + 1, actionFailures: i < falhas ? ['x'] : [] }));
    expect(goldenGate(mk(1)).passed).toBe(true);
    expect(goldenGate(mk(2)).passed).toBe(false);
  });
  it('sem nenhuma ação conferida não aprova', () => {
    expect(goldenGate([row({ actionChecks: 0 })]).passed).toBe(false);
  });
});
