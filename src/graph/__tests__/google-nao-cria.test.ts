import { describe, expect, it } from 'vitest';
import { GOOGLE_READ_INSTRUCTIONS } from '../google-workspace';

// Medido no playground de staging: "crie a atividade X" virou proposta de
// reagendar outra atividade da lista. O texto é o que o modelo recebe.
describe('Google: pedido de criar atividade', () => {
  it('avisa o modelo de que não há criação e proíbe aplicar o pedido a outra atividade', () => {
    expect(GOOGLE_READ_INSTRUCTIONS).toContain('não criam atividade nova');
    expect(GOOGLE_READ_INSTRUCTIONS).toContain('nunca aplique o pedido a outra atividade da lista');
  });
});
