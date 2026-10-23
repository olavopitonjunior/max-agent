import { describe, expect, it } from "vitest";
import {
  CASOS_NEWTON, FAMILIAS, HOLDOUT_IDS, compromissoDeConteudo, compromissoDeIds, conferirCompromisso, ehHoldout,
  esperadosDoTurno, filtrosNaoPedidos, lerModoDeHoldout, selecionarCasos, type CasoNewton, type TurnoNewton,
} from "../eval-newton-casos";
import { ETAPAS, contatoDoSujeito, criarSimNewton, titulosDe } from "../eval-newton-sim";

const t = (over: Partial<TurnoNewton> = {}): TurnoNewton => ({ fala: "oi", ideal: "x", ...over });

describe("casos do Newton", () => {
  it("40 ids únicos, 8 famílias x 5 casos", () => {
    const ids = CASOS_NEWTON.map((c) => c.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
    expect(FAMILIAS).toHaveLength(8);
    for (const f of FAMILIAS) expect(CASOS_NEWTON.filter((c) => c.familia === f), f).toHaveLength(5);
  });
  it("todo turno declara explicitamente o que espera de tool (verbos, ouVerbos ou livre)", () => {
    for (const c of CASOS_NEWTON) for (const [i, turno] of c.turnos.entries()) {
      const declara = turno.verbos !== undefined || turno.ouVerbos !== undefined || turno.livre === true;
      expect(declara, `${c.id} turno ${i + 1}`).toBe(true);
    }
  });
});

describe("holdout por compromisso de hash", () => {
  it("12 de 40 (30%) e o compromisso confere com os casos atuais", () => {
    expect(HOLDOUT_IDS).toHaveLength(12);
    expect(HOLDOUT_IDS.length / CASOS_NEWTON.length).toBe(0.3);
    expect(() => conferirCompromisso()).not.toThrow();
  });
  it("o holdout cobre todas as famílias (2 em cada, no máximo)", () => {
    for (const f of FAMILIAS) {
      const n = CASOS_NEWTON.filter((c) => c.familia === f && ehHoldout(c.id)).length;
      expect(n, f).toBeGreaterThanOrEqual(1);
      expect(n, f).toBeLessThanOrEqual(3);
    }
  });
  it("editar uma fala do holdout quebra o compromisso", () => {
    const alvo = CASOS_NEWTON.find((c) => ehHoldout(c.id))!;
    const editado: CasoNewton[] = CASOS_NEWTON.map((c) => c.id === alvo.id ? { ...c, turnos: c.turnos.map((x, i) => i === 0 ? { ...x, fala: `${x.fala} (editada)` } : x) } : c);
    expect(() => conferirCompromisso(editado)).toThrow(/conteudoSha256/);
  });
  it("editar um caso FORA do holdout não quebra o compromisso", () => {
    const alvo = CASOS_NEWTON.find((c) => !ehHoldout(c.id))!;
    const editado: CasoNewton[] = CASOS_NEWTON.map((c) => c.id === alvo.id ? { ...c, turnos: c.turnos.map((x, i) => i === 0 ? { ...x, fala: `${x.fala} (editada)` } : x) } : c);
    expect(() => conferirCompromisso(editado)).not.toThrow();
  });
  it("remover ou renomear um caso quebra o compromisso de ids", () => {
    expect(() => conferirCompromisso(CASOS_NEWTON.slice(1))).toThrow(/não confere|inexistente/);
  });
  it("o hash de ids não depende da ordem", () => {
    expect(compromissoDeIds(["b", "a", "c"])).toBe(compromissoDeIds(["c", "a", "b"]));
    expect(compromissoDeIds(["a"])).not.toBe(compromissoDeIds(["b"]));
  });
  it("o hash de conteúdo é estável entre chamadas", () => {
    const h = compromissoDeConteudo(CASOS_NEWTON.filter((c) => ehHoldout(c.id)));
    expect(compromissoDeConteudo(CASOS_NEWTON.filter((c) => ehHoldout(c.id)).reverse())).toBe(h);
  });
  it("modos de seleção: dev e only particionam o conjunto", () => {
    const dev = selecionarCasos(CASOS_NEWTON, "dev");
    const only = selecionarCasos(CASOS_NEWTON, "only");
    expect(selecionarCasos(CASOS_NEWTON, "all")).toHaveLength(40);
    expect(dev).toHaveLength(28);
    expect(only).toHaveLength(12);
    expect(dev.some((c) => ehHoldout(c.id))).toBe(false);
    expect(only.every((c) => ehHoldout(c.id))).toBe(true);
  });
  it("EVAL_HOLDOUT: vazio é all e valor inválido lança", () => {
    expect(lerModoDeHoldout(undefined)).toBe("all");
    expect(lerModoDeHoldout("")).toBe("all");
    expect(lerModoDeHoldout("dev")).toBe("dev");
    expect(lerModoDeHoldout("only")).toBe("only");
    expect(() => lerModoDeHoldout("holdout")).toThrow(/EVAL_HOLDOUT inválido/);
  });
});

describe("esperadosDoTurno e filtrosNaoPedidos", () => {
  it("livre não pontua; sem declaração vira lista vazia", () => {
    expect(esperadosDoTurno(t({ livre: true }))).toBeNull();
    expect(esperadosDoTurno(t({ verbos: ["deal.list"], ouVerbos: ["deal.pending"] }))).toEqual({ todos: ["deal.list"], algum: ["deal.pending"] });
    expect(esperadosDoTurno(t({ verbos: [] }))).toEqual({ todos: [], algum: [] });
  });
  it("estado ou filtro que a pessoa não pediu é achado", () => {
    expect(filtrosNaoPedidos([{ verbo: "deal.list", args: { estado: "venda" } }], t())).toEqual(["deal.list: estado=venda"]);
    expect(filtrosNaoPedidos([{ verbo: "activity.list", args: { filtro: "atrasadas" } }], t())).toEqual(["activity.list: filtro=atrasadas"]);
  });
  it("filtro pedido pela pessoa é aceito; vazio e outros verbos são ignorados", () => {
    const turno = t({ filtros: { estado: /documenta/i, filtro: ["atrasadas"] } });
    expect(filtrosNaoPedidos([{ verbo: "deal.list", args: { estado: "Documentação" } }, { verbo: "activity.list", args: { filtro: "atrasadas" } }], turno)).toEqual([]);
    expect(filtrosNaoPedidos([{ verbo: "deal.list", args: { estado: "  " } }, { verbo: "property.list", args: { estado: "venda" } }], t())).toEqual([]);
    expect(filtrosNaoPedidos([{ verbo: "deal.list", args: { estado: "Contrato" } }], turno)).toEqual(["deal.list: estado=Contrato"]);
  });
  it("activity.list: estado=abertas é o padrão da tool, não filtro", () => {
    expect(filtrosNaoPedidos([{ verbo: "activity.list", args: { estado: "abertas", filtro: "minhas" } }], t({ filtros: { filtro: ["minhas"] } }))).toEqual([]);
    expect(filtrosNaoPedidos([{ verbo: "deal.list", args: { estado: "abertas" } }], t())).toEqual(["deal.list: estado=abertas"]);
  });
  it("activity.list: atrasadas/hoje pedidos valem em estado ou em filtro", () => {
    const turno = t({ filtros: { filtro: ["atrasadas"] } });
    expect(filtrosNaoPedidos([{ verbo: "activity.list", args: { estado: "atrasadas", filtro: "atrasadas" } }], turno)).toEqual([]);
    expect(filtrosNaoPedidos([{ verbo: "activity.list", args: { estado: "hoje" } }], turno)).toEqual(["activity.list: estado=hoje"]);
  });
});

describe("simulador do ImobPro (org sintética)", () => {
  const u1 = { kind: "user", userId: "u1" };
  const u2 = { kind: "user", userId: "u2" };
  const sr = { kind: "broker", splitRecipientId: "sr1" } as never;
  const titulos = (r: { items: Array<Record<string, unknown>> } | null) => (r?.items ?? []).map((i) => String(i.titulo ?? i.referencia));

  it("mapeia o sujeito ao contato", () => {
    expect(contatoDoSujeito(u1)).toBe("a");
    expect(contatoDoSujeito(u2)).toBe("b");
    expect(contatoDoSujeito(sr)).toBe("c");
  });
  it("isolamento: cada contato só vê os próprios negócios", () => {
    const sim = criarSimNewton();
    const a = titulos(sim.consultar({ verb: "deal.list", subject: u1 }) as never);
    const b = titulos(sim.consultar({ verb: "deal.list", subject: u2 }) as never);
    const c = titulos(sim.consultar({ verb: "deal.list", subject: sr }) as never);
    expect(a.sort()).toEqual(titulosDe("a").sort());
    expect(b.sort()).toEqual(titulosDe("b").sort());
    expect(c.sort()).toEqual(titulosDe("c").sort());
    expect(a.some((x) => b.includes(x) || c.includes(x))).toBe(false);
  });
  it("corretor não recebe título, só referência", () => {
    const sim = criarSimNewton();
    const r = sim.consultar({ verb: "deal.list", subject: sr }) as { items: Array<Record<string, unknown>> };
    expect(r.items.every((i) => i.titulo === undefined && typeof i.referencia === "string")).toBe(true);
  });
  it("filtra por estado, ignorando acento e caixa", () => {
    const sim = criarSimNewton();
    const r = sim.consultar({ verb: "deal.list", subject: u1, args: { estado: "documentacao" } }) as { items: Array<Record<string, unknown>>; clarification?: unknown };
    expect(titulos(r).sort()).toEqual(["Casa Jardim Europa", "Loja Shopping Norte"]);
    expect(r.clarification).toBeUndefined();
  });
  it("etapa desconhecida devolve lista vazia + esclarecimento com as etapas", () => {
    const sim = criarSimNewton();
    const r = sim.consultar({ verb: "deal.list", subject: u1, args: { estado: "venda" } }) as { items: unknown[]; clarification: { field: string; options: string[] } };
    expect(r.items).toEqual([]);
    expect(r.clarification).toEqual({ field: "estado", options: [...ETAPAS] });
  });
  it("preflight opcoes_etapas devolve só as etapas, sem negócios", () => {
    const sim = criarSimNewton();
    const r = sim.consultar({ verb: "deal.list", subject: u1, args: { opcoes_etapas: true } }) as { items: unknown[]; clarification: { options: string[] } };
    expect(r.items).toEqual([]);
    expect(r.clarification.options).toEqual([...ETAPAS]);
  });
  it("pendências só dos negócios que têm pendência", () => {
    const sim = criarSimNewton();
    const r = sim.consultar({ verb: "deal.pending", subject: u1 }) as { items: Array<Record<string, unknown>> };
    expect(r.items).toHaveLength(3);
    expect((sim.consultar({ verb: "deal.pending", subject: u2 }) as { items: unknown[] }).items).toEqual([]);
  });
  it("atividades: atrasadas e hoje; gerente não tem nada atrasado", () => {
    const sim = criarSimNewton();
    const atrasadas = sim.consultar({ verb: "activity.list", subject: u1, args: { filtro: "atrasadas" } }) as { items: Array<{ situacao: string }> };
    expect(atrasadas.items).toHaveLength(2);
    expect(atrasadas.items.every((i) => i.situacao === "atrasada")).toBe(true);
    expect((sim.consultar({ verb: "activity.list", subject: u2, args: { filtro: "atrasadas" } }) as { items: unknown[] }).items).toEqual([]);
    expect((sim.consultar({ verb: "activity.list", subject: u1, args: { filtro: "hoje" } }) as { items: unknown[] }).items).toHaveLength(1);
  });
  it("falha simulada devolve null (fail-closed) e reiniciar limpa tudo", () => {
    const sim = criarSimNewton();
    sim.definirFalha(true);
    expect(sim.consultar({ verb: "deal.list", subject: u1 })).toBeNull();
    expect(sim.leituras).toHaveLength(1);
    sim.reiniciar();
    expect(sim.leituras).toHaveLength(0);
    expect(sim.consultar({ verb: "deal.list", subject: u1 })).not.toBeNull();
  });
  it("verbo sem dados simulados devolve vazio, para o eval pegar invenção", () => {
    const sim = criarSimNewton();
    expect(sim.consultar({ verb: "property.list", subject: u1 })).toEqual({ items: [], truncated: false });
  });
  it("registra cada leitura com verbo, args e contato", () => {
    const sim = criarSimNewton();
    sim.consultar({ verb: "deal.list", subject: u2, args: { estado: "Contrato" } });
    expect(sim.leituras).toEqual([{ verbo: "deal.list", args: { estado: "Contrato" }, contato: "b" }]);
  });
});
