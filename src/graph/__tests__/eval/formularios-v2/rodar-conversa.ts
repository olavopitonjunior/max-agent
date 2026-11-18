/**
 * Executa uma `ConversaMascarada` (fixture) pelo grafo real e confere cada turno.
 * Importa o harness PRIMEIRO (a ordem dos imports do outbox importa; ver harness.ts).
 */
import { expect } from "vitest";
import { ModeloFalso, ServidorFalso, Sessao, roteirosDe } from "./harness";
import type { ConversaMascarada, EsperaDoTurno } from "../../../../../scripts/fixtures/formularios-v2/conversas-mascaradas";

function confere(texto: string, trecho: string | RegExp, deve: boolean, rotulo: string): void {
  const achou = typeof trecho === "string" ? texto.includes(trecho) : trecho.test(texto);
  expect(achou, `${rotulo}: ${deve ? "faltou" : "não podia aparecer"} ${String(trecho)} em:\n${texto}`).toBe(deve);
}

export async function rodarConversa(c: ConversaMascarada): Promise<Sessao> {
  // O turno que abre o fluxo também passa pela extração (o próprio pedido entra na janela): patch vazio.
  const patches = c.turnos.flatMap((t) => (t.extracao ? [t.extracao] : t.abreFluxo ? [{}] : []));
  const modelo = new ModeloFalso();
  if (patches.length > 0) modelo.roteiro(...roteirosDe(patches));
  const conversa = c.turnos.flatMap((t) =>
    t.abreFluxo
      ? [{ toolCalls: [{ id: "c1", name: "propor_criacao", args: { tipo: t.abreFluxo.tipo, natureza: t.abreFluxo.natureza } }] }]
      : []
  );
  if (conversa.length > 0) modelo.conversa(...conversa);

  const servidor = new ServidorFalso({ exigeDocumento: c.exigeDocumento });
  if (c.rascunhoInicial) {
    const r = c.rascunhoInicial;
    servidor.rascunho = {
      id: r.id,
      codigo: r.codigo,
      schemaType: "compra_venda_v1",
      compradores: [{ nome: r.comprador.nome }],
      vendedores: [],
      imovel: {},
      negociacao: { valor: r.valor },
      corretor: {},
    };
  }
  const s = new Sessao({ bot: c.bot, modelo, servidor, nomes: c.nomes, cpfs: c.cpfs });
  await s.preparar();
  if (c.semeado) await s.semear();

  for (const [i, turno] of c.turnos.entries()) {
    const antesFichas = s.fichasAgendadas.length;
    const t = await s.fala(turno.corretor);
    const e: EsperaDoTurno = turno.espera ?? {};
    const rotulo = `${c.id} turno ${i + 1} ("${turno.corretor.slice(0, 40)}")`;
    if (e.silencioso) {
      expect(t.reply, `${rotulo}: devia ficar em silêncio (a ficha sai pelo outbox)`).toBeNull();
      expect(s.fichasAgendadas.length, `${rotulo}: devia agendar a ficha`).toBeGreaterThan(antesFichas);
    }
    const resposta = t.reply ?? "";
    for (const x of e.contem ?? []) confere(resposta, x, true, rotulo);
    for (const x of e.naoContem ?? []) confere(resposta, x, false, rotulo);
    if (e.fichaAgendadaContem) {
      const ficha = s.fichasAgendadas[s.fichasAgendadas.length - 1] ?? "";
      for (const x of e.fichaAgendadaContem) confere(ficha, x, true, `${rotulo} (ficha agendada)`);
    }
    if (e.grava) {
      expect(
        t.escritas.map((w) => [w.verb, w.status]),
        `${rotulo}: escritas do turno`
      ).toEqual(e.grava);
    }
  }
  return s;
}
