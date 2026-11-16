import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Pendência leva à ação (PR-O3-MA, tarefa 7). Não existe verbo genérico de "resolver pendência": o Max LÊ a pendência
 * (`deal.pending`) e aponta o caminho que já existe — proposta pelo fluxo `proposal.update`, negócio pela tela do sistema.
 * Nunca promete gravar, resolver ou registrar o que não tem tool.
 */

vi.mock("@/lib/scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/scope")>()),
  consultarEscopo: vi.fn(),
}));
vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));
vi.mock("@/lib/acao", async (orig) => ({ ...(await orig<typeof import("@/lib/acao")>()), executarAcao: vi.fn() }));

const { despacharLeituras } = await import("../despachante");
const { ferramentasDoTurno, REGISTRO_DE_TOOLS, PENDENCIAS_DO_NEGOCIO } = await import("../tools");
const { pedeGestao } = await import("../gestao");
const { VERBOS_DE_ACAO } = await import("@/lib/acao");
const { consultarEscopo } = await import("@/lib/scope");
const escopo = vi.mocked(consultarEscopo);

const gerente = { orgId: "org1", orgName: "Imob", kind: "user" as const, userId: "u1", userName: "Marcia" };
const descricao = PENDENCIAS_DO_NEGOCIO.def.description;

beforeEach(() => vi.clearAllMocks());

describe("pendência de negócio: não promete o que não tem tool", () => {
  it("só `deal.pending` NÃO oferece nenhuma tool de escrita, mesmo com 'o que falta no negócio X'", () => {
    const { entradas } = ferramentasDoTurno({ identity: gerente, policy: ["deal.pending"], texto: "o que falta no negócio Casa Verde?" });
    expect(entradas.map((e) => e.nome)).toEqual(["pendencias_do_negocio"]);
    expect(entradas.every((e) => e.tipo === "leitura")).toBe(true);
  });

  it("não existe tool nem verbo genérico de resolver/registrar pendência", () => {
    const nomes = REGISTRO_DE_TOOLS.map((e) => e.nome);
    expect(nomes.filter((n) => /pendencia|pendente/.test(n) && REGISTRO_DE_TOOLS.find((e) => e.nome === n)?.tipo === "escrita")).toEqual([]);
    expect(nomes.filter((n) => /resolv|registrar_pend|baixar|quitar/.test(n))).toEqual([]);
    expect((VERBOS_DE_ACAO as readonly string[]).filter((v) => /resolve|pending|pendenc/.test(v))).toEqual([]);
  });

  it("a descrição diz que o Max não grava nem resolve pendência de negócio, e não se oferece para isso", () => {
    expect(descricao).toMatch(/n[ãa]o (registra|resolve|grava|corrige)/i);
    expect(descricao).not.toMatch(/\b(vou|posso|pode(?:mos)?) (resolver|registrar|marcar como resolvid|corrigir|baixar)/i);
  });

  it("a descrição mantém o escopo antigo (certidão/documento/travado) e não vira 'o que está pendente'", () => {
    expect(descricao).toMatch(/certid/i);
    expect(descricao).not.toMatch(/o que (está|esta) pendente/i);
  });
});

describe("pendência de negócio: aponta a tela", () => {
  it("manda resolver certidão/documento/etapa na tela do negócio no sistema", () => {
    expect(descricao).toMatch(/tela do neg[óo]cio|no sistema/i);
    expect(descricao).toMatch(/certid|documento/i);
  });
});

describe("pendência de proposta: aponta o fluxo proposal.update", () => {
  it("a descrição cita o pedido de ajuste de proposta, e esse pedido de fato abre a edição (gestão editar)", () => {
    expect(descricao).toMatch(/proposta/i);
    const exemplo = /"(muda o valor da proposta [^"]+)"/.exec(descricao)?.[1];
    expect(exemplo, "a descrição traz um exemplo literal de pedido de ajuste").toBeTruthy();
    expect(pedeGestao(exemplo ?? "")).toBe("editar");
  });
});

describe("'o que falta no negócio X' resolve o nome e chama deal.pending", () => {
  it("a tool é oferecida, vai ao servidor com deal.pending SEM nome/id inventado, e o modelo recebe só número + rótulo", async () => {
    const { entradas } = ferramentasDoTurno({ identity: gerente, policy: ["deal.pending"], texto: "o que falta no negócio Casa Verde?" });
    expect(entradas.map((e) => e.nome)).toContain("pendencias_do_negocio");
    // O schema não tem campo de nome: quem acha "Casa Verde" é o modelo, olhando o resultado.
    const props = (PENDENCIAS_DO_NEGOCIO.def.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(["limite"]);
    expect(descricao).toMatch(/nome|endere[çc]o/i);

    escopo.mockResolvedValue({
      items: [
        { id: "d1", titulo: "Casa Verde", pendencias: [{ tipo: "certidao", rotulo: "Matrícula" }] },
        { id: "d2", titulo: "Apto Centro", pendencias: [] },
      ],
      truncated: false,
    } as never);
    const r = await despacharLeituras({
      chamadas: [{ name: "pendencias_do_negocio", args: {} }],
      oferecidas: ["pendencias_do_negocio"],
      policy: ["deal.pending"] as never,
      identity: gerente,
      fromPhone: "5511999990000",
      referencias: null,
      turno: "m1",
    });
    expect(escopo).toHaveBeenCalledTimes(1);
    expect(escopo.mock.calls[0]?.[0]).toMatchObject({ verb: "deal.pending" });
    expect(Object.keys((escopo.mock.calls[0]?.[0] as { args: Record<string, unknown> }).args)).not.toContain("nome");
    expect(JSON.stringify(r.resultados[0])).not.toMatch(/"id"|d1|d2/);
    expect(r.resultados[0]?.items?.map((i) => (i as { n: number }).n)).toEqual([1, 2]);
    expect(r.referencias?.itens.map((i) => i.id)).toEqual(["d1", "d2"]);
  });

  it("sem deal.pending na política: nada é consultado", async () => {
    const r = await despacharLeituras({
      chamadas: [{ name: "pendencias_do_negocio", args: {} }],
      oferecidas: ["pendencias_do_negocio"],
      policy: ["deal.list"] as never,
      identity: gerente,
      fromPhone: "5511999990000",
      referencias: null,
      turno: "m1",
    });
    expect(escopo).not.toHaveBeenCalled();
    expect(r.resultados[0]?.items).toBeNull();
  });
});
