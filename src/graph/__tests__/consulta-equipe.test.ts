import { describe, it, expect, vi } from "vitest";
import { pedidoDeLista, mesPedido, responderListaFiltrada } from "../consulta-equipe";
import { pedeConsulta, responderConsulta } from "../consulta";
import { termoDeBusca } from "../localizar";
import type { DepsDoFluxo } from "../fluxos";

/**
 * Lista por mês, por várias situações e da equipe (02/11/2026, gerente da Newcore).
 * As três frases abaixo foram escritas por ela no WhatsApp; antes, "outubro" virava
 * busca por nome de cliente e a lista saía vazia ou com o filtro errado.
 */

const AGORA = new Date("2026-11-02T15:00:00Z");

const ADELIA_1 = "Quero todas as propostas de outubro pendentes e concluídas";
const ADELIA_2 = "Outubro de 2026 somente as destinadas Adélia como gerente, acrescentar nome do corretor";
const ADELIA_3 = "Todas propostas pendentes, enviadas para assinatura e formulários";

function depsCom(body: Record<string, unknown> | null, status = 200) {
  const acao = vi.fn().mockResolvedValue(body ? { status, body } : null);
  return { deps: { acao } as unknown as DepsDoFluxo, acao };
}

const item = (codigo: string, extra: Record<string, unknown> = {}) => ({
  id: codigo, codigo, titulo: "Apto 1", status: "enviada", estado: "Enviada", signatarios: [], ...extra,
});

describe("mesPedido", () => {
  it("reconhece o mês, com e sem ano", () => {
    expect(mesPedido("propostas de outubro", AGORA)).toEqual({ mes: "2026-10", rotulo: "outubro de 2026" });
    expect(mesPedido("Outubro de 2025", AGORA)?.mes).toBe("2025-10");
    expect(mesPedido("de dezembro", AGORA)?.mes).toBe("2025-12");
    expect(mesPedido("deste mês", AGORA)?.mes).toBe("2026-11");
    expect(mesPedido("mês passado", AGORA)?.mes).toBe("2026-10");
  });
  it("não confunde 'Março' nome próprio com o mês", () => {
    expect(mesPedido("propostas do Março Silva", AGORA)).toBeNull();
    expect(mesPedido("propostas de março", AGORA)?.mes).toBe("2026-03");
  });
});

describe("mês só vale como período, nunca dentro de um nome (review 02/11)", () => {
  it.each([
    "status da proposta da Rua Sete de Setembro 120",
    "proposta da Av. Primeiro de Maio 300",
    "proposta da Rua 15 de Novembro 40",
    "tem proposta da Maio Imóveis?",
  ])("%s", (t) => {
    expect(mesPedido(t, AGORA)).toBeNull();
    expect(pedidoDeLista(t, AGORA)).toBeNull();
  });
  it("e o nome do logradouro segue na busca", () => {
    expect(termoDeBusca("status da proposta da Rua Sete de Setembro 120")).toContain("setembro");
    expect(termoDeBusca("proposta da Rua 15 de Novembro 40")).toContain("novembro");
  });
});

describe("regressões do fluxo antigo (review 02/11)", () => {
  it("nome citado + só situação: a situação é a pergunta", () => {
    expect(pedidoDeLista("a proposta da Letícia já foi assinada e concluída?", AGORA)).toBeNull();
    expect(pedidoDeLista("tem proposta pendente da Letícia?", AGORA)).toBeNull();
  });
  it("'sou gerente da equipe' é equipe; 'do Time Brasil' é nome", () => {
    expect(pedidoDeLista("sou gerente da equipe, propostas de outubro", AGORA)?.escopo).toBe("equipe");
    expect(pedidoDeLista("propostas do Time Brasil pendentes", AGORA)).toBeNull();
  });
  it("plataforma antiga: pedido que o fluxo de sempre atendia não vira recusa", async () => {
    const { deps, acao } = depsCom({ total: 1, items: [item("PROP-2026-0001")] });
    const r = await responderConsulta(deps, "quais propostas estão pendentes e concluídas?");
    expect(r.evento).not.toBe("consulta_filtro_indisponivel");
    expect(acao).toHaveBeenCalledTimes(2);
  });
  it("nome do papel e formulários são ditos na resposta, não descartados em silêncio", async () => {
    const { deps } = depsCom({ escopo: "responsavel", total: 1, items: [item("PROP-2026-0033")] });
    const r = await responderListaFiltrada(deps, pedidoDeLista("Outubro de 2026 destinadas Adélia como gerente e formulários", AGORA)!);
    expect(r.reply).toContain('Entendi "Adélia" como você');
    expect(r.reply).toContain("Formulários não entram");
  });
});

describe("termoDeBusca ignora mês, situação e papel", () => {
  // A frase 2 leva o nome dela: quem o tira é pedidoDeLista (frase de papel), testado abaixo.
  it.each([ADELIA_1, ADELIA_3])("%s", (t) => {
    expect(termoDeBusca(t)).toBeNull();
  });
});

describe("pedidoDeLista", () => {
  it("frase 1: mês + pendentes e concluídas, só as dela", () => {
    const p = pedidoDeLista(ADELIA_1, AGORA)!;
    expect(p.escopo).toBe("minhas");
    expect(p.mes).toBe("2026-10");
    expect(p.estados).toContain("aguardando_vendedor");
    expect(p.estados).toContain("completa");
    expect(p.estados).not.toContain("cancelada");
    expect(p.busca).toBeUndefined();
  });
  it("frase 2: como gerente = responsável, sem o nome dela virar busca", () => {
    const p = pedidoDeLista(ADELIA_2, AGORA)!;
    expect(p.escopo).toBe("responsavel");
    expect(p.mes).toBe("2026-10");
    expect(p.busca).toBeUndefined();
  });
  it("frase 3: várias situações numa lista só", () => {
    const p = pedidoDeLista(ADELIA_3, AGORA)!;
    expect(p.estados).toContain("rascunho");
    expect(p.estados).toContain("enviada");
  });
  it("equipe só por pedido explícito", () => {
    expect(pedidoDeLista("propostas da equipe de outubro", AGORA)?.escopo).toBe("equipe");
    expect(pedidoDeLista("propostas de todos pendentes", AGORA)?.escopo).toBe("equipe");
    expect(pedidoDeLista("quais propostas em que sou responsável", AGORA)?.escopo).toBe("responsavel");
  });
  it("o fluxo antigo segue: lista simples, um estado, nome, código", () => {
    expect(pedidoDeLista("liste as minhas propostas", AGORA)).toBeNull();
    expect(pedidoDeLista("quais propostas estão em rascunho?", AGORA)).toBeNull();
    expect(pedidoDeLista("procure a proposta da Letícia", AGORA)).toBeNull();
    expect(pedidoDeLista("como está a PROP-2026-0013", AGORA)).toBeNull();
  });
  it("nome de cliente junto do mês continua busca", () => {
    expect(pedidoDeLista("propostas da Letícia em outubro", AGORA)?.busca).toBe("leticia");
  });
});

describe("pedeConsulta reconhece os três pedidos", () => {
  it.each([ADELIA_1, ADELIA_2, ADELIA_3])("%s", (t) => {
    expect(pedeConsulta(t)).toBe(true);
  });
  it("criar proposta continua não sendo consulta", () => {
    expect(pedeConsulta("faz uma proposta de outubro")).toBe(false);
  });
});

describe("responderListaFiltrada", () => {
  it("manda escopo, mês e estados ao servidor e escreve corretor e data", async () => {
    const { deps, acao } = depsCom({
      escopo: "responsavel", total: 2,
      items: [
        item("PROP-2026-0033", { corretor: "Carlos Dias", criadoEm: "2026-10-14T15:00:00Z" }),
        item("PROP-2026-0030", { corretor: "Ana Lima", criadoEm: "2026-10-02T03:30:00Z", estado: "Assinada" }),
      ],
    });
    const r = await responderListaFiltrada(deps, pedidoDeLista(ADELIA_2, AGORA)!);
    expect(acao).toHaveBeenCalledWith("proposal.list", { escopo: "responsavel", mes: "2026-10" });
    expect(r.evento).toBe("consulta_lista_filtrada");
    expect(r.reply).toContain("2 propostas em que você é responsável em outubro de 2026");
    expect(r.reply).toContain("PROP-2026-0033 — Apto 1 — Enviada — corretor: Carlos Dias — criada em 14/10");
    // 02/10 00:30 em Brasília: dia no relógio de Brasília, não UTC.
    expect(r.reply).toContain("criada em 02/10");
  });
  it("vazio diz o recorte e, nas dela, ensina a pedir a equipe", async () => {
    const { deps } = depsCom({ escopo: "minhas", total: 0, items: [] });
    const r = await responderListaFiltrada(deps, pedidoDeLista(ADELIA_1, AGORA)!);
    expect(r.evento).toBe("consulta_vazia");
    expect(r.reply).toContain("Não achei propostas criadas por você em outubro de 2026");
    expect(r.reply).toContain("propostas da equipe");
  });
  it("servidor antigo (sem eco do escopo) não responde outra pergunta", async () => {
    const { deps } = depsCom({ total: 1, items: [item("PROP-2026-0001")] });
    const r = await responderListaFiltrada(deps, pedidoDeLista(ADELIA_1, AGORA)!);
    expect(r.evento).toBe("consulta_filtro_indisponivel");
    expect(r.reply).not.toContain("PROP-2026-0001");
  });
  it("avisa quando há mais do que mostrou e quando a busca foi truncada", async () => {
    const { deps } = depsCom({ escopo: "equipe", total: 40, truncado: true, items: [item("PROP-2026-0001")] });
    const r = await responderListaFiltrada(deps, pedidoDeLista("propostas da equipe de outubro", AGORA)!);
    expect(r.reply).toContain("Mostrando 1 de 40");
    expect(r.reply).toContain("500 mais recentes");
  });
  it("sem resposta do servidor", async () => {
    const { deps } = depsCom(null);
    const r = await responderListaFiltrada(deps, pedidoDeLista(ADELIA_1, AGORA)!);
    expect(r.evento).toBe("consulta_sem_resposta");
  });
});

describe("responderConsulta chama a lista filtrada", () => {
  it("a frase 1 nunca vira busca por 'outubro'", async () => {
    const { deps, acao } = depsCom({ escopo: "minhas", total: 0, items: [] });
    await responderConsulta(deps, ADELIA_1);
    const [verbo, args] = acao.mock.calls[0]!;
    expect(verbo).toBe("proposal.list");
    expect(args).not.toHaveProperty("busca");
    expect(args).toHaveProperty("mes");
    expect(args).toHaveProperty("estados");
  });
});
