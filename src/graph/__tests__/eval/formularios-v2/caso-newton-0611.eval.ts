import { afterEach, describe, expect, it } from "vitest";
import { type Sessao, verificarTransversais } from "./harness";
import { rodarConversa } from "./rodar-conversa";
import { NEWTON_0611, TELEFONES } from "../../../../../scripts/fixtures/formularios-v2/conversas-mascaradas";
import { emailFicticio } from "../../../../../scripts/fixtures/formularios-v2/mascara";

/**
 * O caso do Newton de 06/11: o agente dizia "anotado" sem gravar, o extrator não tinha contexto das
 * mensagens anteriores e o playground achou "casado" descartado, e-mail da vendedora no comprador e correção
 * de nome apagando CPF e telefone. O texto original não foi preservado; a conversa é reconstruída da
 * descrição (ver o fixture). Aqui o que se afirma é o desfecho, não o texto.
 */
describe("eval fv2: Newton 06/11 (anotado sem gravar)", () => {
  let s: Sessao;
  afterEach(async () => {
    await verificarTransversais(s);
  });

  it("só afirma que anotou depois do 200, e o rascunho final guarda cada dado no lugar certo", async () => {
    s = await rodarConversa(NEWTON_0611);
    const r = s.servidor.rascunho!;

    // Antes do "sim" nenhum turno gravou nada e nenhum disse que anotou (T1 também cobre; aqui explícito).
    const turnoDoSim = s.turnos[s.turnos.length - 1]!;
    for (const t of s.turnos.slice(0, -1)) {
      expect(t.escritas, `turno ${t.indice} não grava`).toHaveLength(0);
      // "ainda não foi anotado" é a ficha avisando que nada foi gravado: não conta como afirmação.
      const afirmativo = (t.reply ?? "").replace(/ainda não foi anotado/gi, "");
      expect(afirmativo).not.toMatch(/\b(anotei|salvei|anotado)\b/i);
    }
    expect(turnoDoSim.escritas.map((w) => [w.verb, w.status])).toEqual([["proposal.create", 201]]);

    // "casado" não foi descartado.
    expect(r.compradores[0]?.estado_civil).toBe("casado");
    // A correção de nome não apagou CPF nem telefone.
    expect(r.compradores[0]?.nome).toContain("Junior");
    expect(r.compradores[0]?.cpf).toBeTruthy();
    expect(String(r.compradores[0]?.telefone).replace(/\D/g, "")).toContain(TELEFONES.comprador.slice(-8));
    // O e-mail da vendedora ficou na vendedora, nunca no comprador.
    expect(r.vendedores[0]?.email).toBe(emailFicticio("helena duarte"));
    expect(r.compradores[0]?.email).toBeUndefined();
    // Sem CPF não existe proposta salva: aqui ele foi lido e gravado.
    expect(r.negociacao.valor).toBe(800000);
  });
});
