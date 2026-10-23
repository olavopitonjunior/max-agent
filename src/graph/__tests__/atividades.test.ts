import { describe, it, expect, vi } from "vitest";
import type { Capability } from "../policy";
import { autorizarChamada } from "../despachante";
import { ferramentasDoTurno, REGISTRO_DE_TOOLS } from "../tools";
import {
  conduzirAtividade,
  iniciarAtividade,
  lerVencimento,
  TEXTO_ATIVIDADE_INDISPONIVEL,
  TEXTO_ATIVIDADE_NAO_LIBERADA,
  textoDoErro,
  type FluxoAtividade,
} from "../atividades";
import { rebaixarFluxo, type ContextoDoTurno, type DepsDoFluxo } from "../fluxos";
import { ehPayloadDeAtividade, parsePayloadDeAtividade, rotearBotaoDeAtividade } from "@/lib/atividade-botao";
import type { ResultadoDeLeitura } from "@/lib/scope";

const usuario = { orgId: "org1", orgName: "Imob", kind: "user" as const, userId: "u1", userName: "Marcia" };
const corretor = { orgId: "org1", orgName: "Imob", kind: "broker" as const, splitRecipientId: "s1", label: "Beto" };

const COM: Capability[] = ["activity.list", "activity.write"];
const SEM: Capability[] = ["activity.list", "deal.list"];
const FERRAMENTAS_DE_ESCRITA = ["criar_atividade", "comentar_atividade", "concluir_atividade", "recusar_atividade"];

function ctx(texto: string, over: Partial<ContextoDoTurno> = {}): ContextoDoTurno {
  return { texto, messageId: "m1", policy: COM, agora: 1_000, orgName: "Imob", ...over };
}

function deps(resposta: Awaited<ReturnType<DepsDoFluxo["acao"]>> | Error) {
  const acao = vi.fn(async (_verb: string, _args: Record<string, unknown>, _key?: string) => {
    if (resposta instanceof Error) throw resposta;
    return resposta;
  });
  return { acao, extrairProposta: vi.fn(), extrairCampos: vi.fn() } as unknown as DepsDoFluxo & { acao: typeof acao };
}

const ALVO = { id: "atv_1", rotulo: "Ligar para o João" };

// ─── NEGADO primeiro (fail-closed) ────────────────────────────────────────

describe("sem activity.write nada escreve", () => {
  it("as tools de escrita não são oferecidas sem a capability", () => {
    const { entradas } = ferramentasDoTurno({ policy: SEM, texto: "cria uma atividade de ligação, conclui a atividade 2", identity: usuario });
    const nomes = entradas.map((e) => e.nome);
    for (const n of FERRAMENTAS_DE_ESCRITA) expect(nomes).not.toContain(n);
  });

  it("nem para corretor comissionado (sem login), mesmo com a capability concedida", () => {
    const { entradas } = ferramentasDoTurno({ policy: COM, texto: "conclui a atividade 2", identity: corretor });
    for (const n of FERRAMENTAS_DE_ESCRITA) expect(entradas.map((e) => e.nome)).not.toContain(n);
  });

  it("com a capability e usuário interno, as quatro são oferecidas", () => {
    const { entradas } = ferramentasDoTurno({ policy: COM, texto: "conclui a atividade 2", identity: usuario });
    for (const n of FERRAMENTAS_DE_ESCRITA) expect(entradas.map((e) => e.nome)).toContain(n);
  });

  it.each(FERRAMENTAS_DE_ESCRITA)("%s: autorizarChamada recusa por capability_negada sem activity.write", (nome) => {
    const r = autorizarChamada({ chamada: { name: nome, args: { numero: 1 } }, oferecidas: [nome], policy: SEM, identity: usuario });
    expect(r).toMatchObject({ ok: false, motivo: "capability_negada" });
  });

  it.each(FERRAMENTAS_DE_ESCRITA)("%s: recusa identidade sem login e tool não oferecida", (nome) => {
    expect(autorizarChamada({ chamada: { name: nome, args: {} }, oferecidas: [nome], policy: COM, identity: corretor }))
      .toMatchObject({ ok: false, motivo: "identidade_nao_escreve" });
    expect(autorizarChamada({ chamada: { name: nome, args: {} }, oferecidas: [], policy: COM, identity: usuario }))
      .toMatchObject({ ok: false, motivo: "nao_oferecida" });
  });

  it.each(FERRAMENTAS_DE_ESCRITA)("%s: com a capability, autoriza", (nome) => {
    expect(autorizarChamada({ chamada: { name: nome, args: {} }, oferecidas: [nome], policy: COM, identity: usuario }))
      .toMatchObject({ ok: true, capability: "activity.write" });
  });

  it("iniciarAtividade sem a capability: resposta fixa, sem fluxo, nenhuma chamada", () => {
    for (const operacao of ["criar", "comentar", "concluir", "recusar"] as const) {
      const r = iniciarAtividade({ operacao, alvo: ALVO, tipo: "ligacao", titulo: "x", vencimento: "2026-11-01", texto: "oi", motivo: "não posso" }, ctx("", { policy: SEM }));
      expect(r.fluxo).toBeNull();
      expect(r.reply).toBe(TEXTO_ATIVIDADE_NAO_LIBERADA);
    }
  });

  it("a política some entre o resumo e o SIM: nada é chamado", async () => {
    const f = iniciarAtividade({ operacao: "concluir", alvo: ALVO }, ctx("")).fluxo as FluxoAtividade;
    const d = deps({ status: 200, body: {} });
    const r = await conduzirAtividade(f, ctx("sim", { policy: SEM }), d);
    expect(d.acao).not.toHaveBeenCalled();
    expect("reply" in r && r.reply).toBe(TEXTO_ATIVIDADE_NAO_LIBERADA);
  });

  it("nenhuma tool de atividade cita ou contata parte/cliente", () => {
    const todas = REGISTRO_DE_TOOLS.filter((e) => /atividade/.test(e.nome));
    expect(todas.length).toBeGreaterThanOrEqual(6);
    for (const e of todas) {
      const props = Object.keys((e.def.parameters as { properties?: Record<string, unknown> }).properties ?? {});
      expect(props).not.toContain("responsaveis");
      expect(props).not.toContain("mensagem");
    }
  });
});

// ─── Proposta → confirmação → chamada ─────────────────────────────────────

describe("proposta, confirmação e chamada com idempotency key", () => {
  it("comentar: propõe, só chama no SIM, com a messageId do SIM como chave", async () => {
    const abre = iniciarAtividade({ operacao: "comentar", alvo: ALVO, texto: "Liguei, sem resposta" }, ctx("comenta isso"));
    expect(abre.reply).toContain("Confirma?");
    expect(abre.reply).toContain("Liguei, sem resposta");
    const d = deps({ status: 200, body: { ok: true } });
    const nenhum = await conduzirAtividade(abre.fluxo as FluxoAtividade, ctx("talvez mais tarde", { messageId: "m2" }), d);
    expect(d.acao).not.toHaveBeenCalled();
    expect(nenhum).toMatchObject({ liberar: true });

    const fim = await conduzirAtividade(abre.fluxo as FluxoAtividade, ctx("sim", { messageId: "m-sim" }), d);
    expect(d.acao).toHaveBeenCalledTimes(1);
    expect(d.acao).toHaveBeenCalledWith("activity.comment", { atividade_id: "atv_1", texto: "Liguei, sem resposta" }, "m-sim");
    expect("fluxo" in fim && fim.fluxo).toBeNull();
    expect("reply" in fim && fim.reply).toContain("Comentário registrado");
  });

  it("comentar sem texto: pergunta, depois propõe com o texto dito, depois SIM", async () => {
    const pergunta = iniciarAtividade({ operacao: "comentar", alvo: ALVO }, ctx(""));
    expect(pergunta.fluxo).toMatchObject({ etapa: "texto" });
    const d = deps({ status: 200, body: {} });
    const proposta = await conduzirAtividade(pergunta.fluxo as FluxoAtividade, ctx("Cliente pediu retorno amanhã"), d);
    expect(d.acao).not.toHaveBeenCalled();
    expect("fluxo" in proposta && proposta.fluxo).toMatchObject({ etapa: "confirmacao", dados: { texto: "Cliente pediu retorno amanhã" } });
    await conduzirAtividade((proposta as { fluxo: FluxoAtividade }).fluxo, ctx("sim", { messageId: "m3" }), d);
    expect(d.acao).toHaveBeenCalledWith("activity.comment", { atividade_id: "atv_1", texto: "Cliente pediu retorno amanhã" }, "m3");
  });

  it("concluir: vai direto à confirmação e chama activity.complete no SIM", async () => {
    const abre = iniciarAtividade({ operacao: "concluir", alvo: ALVO }, ctx(""));
    expect(abre.fluxo).toMatchObject({ etapa: "confirmacao" });
    const d = deps({ status: 200, body: { ok: true } });
    const fim = await conduzirAtividade(abre.fluxo as FluxoAtividade, ctx("sim", { messageId: "m9" }), d);
    expect(d.acao).toHaveBeenCalledWith("activity.complete", { atividade_id: "atv_1" }, "m9");
    expect("reply" in fim && fim.reply).toContain("concluída");
  });

  it("criar: valida, propõe e chama activity.create com negocio_id e vencimento com segundos", async () => {
    const abre = iniciarAtividade(
      { operacao: "criar", alvo: { id: "neg_1", rotulo: "Apto Centro" }, tipo: "visita", titulo: "Visitar o imóvel", vencimento: "2026-11-05T14:30-03:00" },
      ctx("")
    );
    expect(abre.fluxo).toMatchObject({ etapa: "confirmacao" });
    const d = deps({ status: 201, body: { ok: true, atividade: { id: "novo" } } });
    const fim = await conduzirAtividade(abre.fluxo as FluxoAtividade, ctx("sim", { messageId: "mc" }), d);
    expect(d.acao).toHaveBeenCalledWith(
      "activity.create",
      { negocio_id: "neg_1", tipo: "visita", titulo: "Visitar o imóvel", vencimento: "2026-11-05T14:30:00-03:00" },
      "mc"
    );
    expect("reply" in fim && fim.reply).toContain("criada");
  });

  it("criar com tipo ou vencimento inválido (ou sem fuso): sem fluxo e sem chamada", () => {
    const base = { operacao: "criar" as const, alvo: ALVO, titulo: "x" };
    for (const dado of [
      { tipo: "viagem", vencimento: "2026-11-05" },
      { tipo: "visita", vencimento: "amanhã" },
      { tipo: "visita", vencimento: "2026-11-05T14:30" },
      { tipo: "visita", vencimento: "2026-13-45" },
    ]) {
      const r = iniciarAtividade({ ...base, ...dado }, ctx(""));
      expect(r.fluxo).toBeNull();
      expect(r.evento).toBe("atividade_dado_invalido");
    }
    expect(lerVencimento("2026-11-05")).toBe("2026-11-05");
  });

  it("NÃO cancela sem escrever; um 'não' encerra o fluxo", async () => {
    const f = iniciarAtividade({ operacao: "concluir", alvo: ALVO }, ctx("")).fluxo as FluxoAtividade;
    const d = deps({ status: 200, body: {} });
    const r = await conduzirAtividade(f, ctx("não"), d);
    expect(d.acao).not.toHaveBeenCalled();
    expect("fluxo" in r && r.fluxo).toBeNull();
  });

  it("escrita incerta (null ou 409 em_andamento): a MESMA chave é reusada no próximo SIM", async () => {
    const f = iniciarAtividade({ operacao: "concluir", alvo: ALVO }, ctx("")).fluxo as FluxoAtividade;
    const incerto = deps(null);
    const r1 = await conduzirAtividade(f, ctx("sim", { messageId: "m-a" }), incerto);
    const f2 = (r1 as { fluxo: FluxoAtividade }).fluxo;
    expect(f2.chave).toEqual({ verbo: "activity.complete", valor: "m-a" });

    const ok = deps({ status: 200, body: {} });
    await conduzirAtividade(f2, ctx("sim", { messageId: "m-b" }), ok);
    expect(ok.acao).toHaveBeenCalledWith("activity.complete", { atividade_id: "atv_1" }, "m-a");

    const emAndamento = deps({ status: 409, body: { error: "em_andamento" } });
    const r2 = await conduzirAtividade(f, ctx("sim", { messageId: "m-c" }), emAndamento);
    expect((r2 as { fluxo: FluxoAtividade }).fluxo.chave?.valor).toBe("m-c");
  });

  it("rebaixarFluxo: confirmação vira resumo; o SIM seguinte só reapresenta, sem escrever", async () => {
    const f = iniciarAtividade({ operacao: "concluir", alvo: ALVO }, ctx("")).fluxo as FluxoAtividade;
    const rebaixado = rebaixarFluxo(f) as FluxoAtividade;
    expect(rebaixado.etapa).toBe("resumo");
    const d = deps({ status: 200, body: {} });
    const r = await conduzirAtividade(rebaixado, ctx("sim"), d);
    expect(d.acao).not.toHaveBeenCalled();
    expect((r as { fluxo: FluxoAtividade }).fluxo.etapa).toBe("confirmacao");
  });
});

// ─── Recusa exige motivo ──────────────────────────────────────────────────

describe("recusar exige motivo", () => {
  it("sem motivo: pergunta e não chama", async () => {
    const r = iniciarAtividade({ operacao: "recusar", alvo: ALVO }, ctx(""));
    expect(r.fluxo).toMatchObject({ etapa: "texto", operacao: "recusar" });
    expect(r.reply).toContain("motivo");
  });

  it("motivo curto demais (< 3) e 'sim' puro não avançam nem chamam", async () => {
    const d = deps({ status: 200, body: {} });
    const f = iniciarAtividade({ operacao: "recusar", alvo: ALVO }, ctx("")).fluxo as FluxoAtividade;
    const curto = await conduzirAtividade(f, ctx("ok"), d);
    expect((curto as { fluxo: FluxoAtividade }).fluxo.etapa).toBe("texto");
    const sim = await conduzirAtividade(f, ctx("sim"), d);
    expect((sim as { fluxo: FluxoAtividade }).fluxo.etapa).toBe("texto");
    expect(d.acao).not.toHaveBeenCalled();
    const curtoNaOrigem = iniciarAtividade({ operacao: "recusar", alvo: ALVO, motivo: "no" }, ctx(""));
    expect(curtoNaOrigem.fluxo).toMatchObject({ etapa: "texto" });
  });

  it("com motivo: propõe e chama activity.refuse só no SIM", async () => {
    const d = deps({ status: 200, body: { ok: true, devolvidaA: "u2" } });
    const f = iniciarAtividade({ operacao: "recusar", alvo: ALVO, motivo: "Estou de férias" }, ctx("")).fluxo as FluxoAtividade;
    expect(d.acao).not.toHaveBeenCalled();
    const fim = await conduzirAtividade(f, ctx("sim", { messageId: "mr" }), d);
    expect(d.acao).toHaveBeenCalledWith("activity.refuse", { atividade_id: "atv_1", motivo: "Estou de férias" }, "mr");
    expect("reply" in fim && fim.reply).toContain("recusada");
  });
});

// ─── Erros do CM viram mensagem legível ───────────────────────────────────

describe("erros do contractmaker", () => {
  const casos: Array<[number, Record<string, unknown>, RegExp]> = [
    [403, { error: "Forbidden", reason: "politica_nao_concede" }, /não está liberado/],
    [403, { error: "Forbidden", reason: "verbo_requer_sujeito_usuario" }, /não está liberado/],
    [403, { error: "PERMISSION_DENIED", reason: "x" }, /perfil no sistema não permite/],
    [404, { error: "NOT_FOUND" }, /não está mais disponível/],
    [409, { error: "ALREADY_DONE" }, /já estava concluída/],
    [409, { error: "CANCELED" }, /foi cancelada/],
    [422, { error: "REFUSE_SELF" }, /não pode recusar/],
    [422, { error: "SOURCE_LOCKED" }, /processo automático/],
    [422, { error: "NO_RETURN_TARGET" }, /para quem devolver/],
    [400, { error: "invalid_args", reason: "vencimento_invalido" }, /vencimento/],
  ];
  it.each(casos)("%i %j vira frase legível, sem afirmar que deu certo", (status, body, esperado) => {
    const texto = textoDoErro("concluir", status, body);
    expect(texto).toMatch(esperado);
    expect(texto).not.toMatch(/\bconcluída\.$/);
  });

  it("no fluxo, o erro encerra o fluxo e a frase chega à pessoa", async () => {
    const f = iniciarAtividade({ operacao: "concluir", alvo: ALVO }, ctx("")).fluxo as FluxoAtividade;
    const r = await conduzirAtividade(f, ctx("sim"), deps({ status: 409, body: { error: "ALREADY_DONE" } }));
    expect(r).toMatchObject({ fluxo: null });
    expect("reply" in r && r.reply).toContain("já estava concluída");
  });
});

// ─── Botão atv:<id>:<acao> ────────────────────────────────────────────────

describe("payload de botão atv:", () => {
  it("parse: válidos", () => {
    expect(parsePayloadDeAtividade("atv:abc123:concluir")).toEqual({ atividadeId: "abc123", acao: "concluir" });
    expect(parsePayloadDeAtividade("atv:cm_X-9:comentar")).toEqual({ atividadeId: "cm_X-9", acao: "comentar" });
    expect(parsePayloadDeAtividade("atv:a:recusar")).toEqual({ atividadeId: "a", acao: "recusar" });
  });

  it.each(["atv:", "atv:abc", "atv:abc:", "atv::concluir", "atv:abc:apagar", "atv:a b:concluir", "atv:abc:concluir:x", "ATV:abc:concluir", "atv:../x:concluir", `atv:${"a".repeat(65)}:concluir`, "ok:abc", "", null, undefined])(
    "parse: malformado %j é null",
    (p) => {
      expect(parsePayloadDeAtividade(p as string | null | undefined)).toBeNull();
    }
  );

  it("ehPayloadDeAtividade reconhece o prefixo, mesmo malformado", () => {
    expect(ehPayloadDeAtividade("atv:abc:apagar")).toBe(true);
    expect(ehPayloadDeAtividade("ok:1")).toBe(false);
  });

  const lerCom = (items: unknown[]) => vi.fn(async (): Promise<ResultadoDeLeitura | null> => ({ items, truncated: false }));

  it("NEGADO: sem activity.write não lê nada e responde fixo", async () => {
    const ler = lerCom([{ id: "atv_1", titulo: "X" }]);
    const r = await rotearBotaoDeAtividade({ payload: "atv:atv_1:concluir", ctx: ctx("Concluir", { policy: SEM }), identity: usuario, ler });
    expect(ler).not.toHaveBeenCalled();
    expect(r).toMatchObject({ reply: TEXTO_ATIVIDADE_NAO_LIBERADA, fluxo: null });
  });

  it("NEGADO: corretor sem login não lê nem escreve", async () => {
    const ler = lerCom([{ id: "atv_1", titulo: "X" }]);
    const r = await rotearBotaoDeAtividade({ payload: "atv:atv_1:concluir", ctx: ctx("Concluir"), identity: corretor, ler });
    expect(ler).not.toHaveBeenCalled();
    expect(r.fluxo).toBeNull();
  });

  it("malformado, inexistente e de outra org: a MESMA resposta neutra", async () => {
    const malformado = await rotearBotaoDeAtividade({ payload: "atv:abc:apagar", ctx: ctx("x"), identity: usuario, ler: lerCom([]) });
    const inexistente = await rotearBotaoDeAtividade({ payload: "atv:nao_existe:concluir", ctx: ctx("x"), identity: usuario, ler: lerCom([]) });
    // O servidor devolve items:[] para outra org; um item de OUTRO id também não vale.
    const outraOrg = await rotearBotaoDeAtividade({ payload: "atv:de_outra_org:concluir", ctx: ctx("x"), identity: usuario, ler: lerCom([{ id: "outro", titulo: "Y" }]) });
    for (const r of [malformado, inexistente, outraOrg]) {
      expect(r.reply).toBe(TEXTO_ATIVIDADE_INDISPONIVEL);
      expect(r.fluxo).toBeNull();
    }
  });

  it("falha de leitura: mensagem própria, sem fluxo", async () => {
    const r = await rotearBotaoDeAtividade({ payload: "atv:atv_1:concluir", ctx: ctx("x"), identity: usuario, ler: vi.fn(async () => null) });
    expect(r.fluxo).toBeNull();
    expect(r.reply).toMatch(/Não consegui abrir/);
  });

  it("concluir: abre a proposta de conclusão (ainda pede confirmação) e não chama o verbo", async () => {
    const r = await rotearBotaoDeAtividade({ payload: "atv:atv_1:concluir", ctx: ctx("Concluir"), identity: usuario, ler: lerCom([{ id: "atv_1", titulo: "Ligar para o João" }]) });
    expect(r.fluxo).toMatchObject({ kind: "atividade", operacao: "concluir", etapa: "confirmacao", alvo: { id: "atv_1", rotulo: "Ligar para o João" } });
    expect(r.reply).toContain("Confirma?");
  });

  it("comentar e recusar: pedem o texto/motivo antes de propor", async () => {
    const item = [{ id: "atv_1", titulo: "Ligar para o João" }];
    const c = await rotearBotaoDeAtividade({ payload: "atv:atv_1:comentar", ctx: ctx("Comentar"), identity: usuario, ler: lerCom(item) });
    expect(c.fluxo).toMatchObject({ operacao: "comentar", etapa: "texto" });
    const r = await rotearBotaoDeAtividade({ payload: "atv:atv_1:recusar", ctx: ctx("Recusar"), identity: usuario, ler: lerCom(item) });
    expect(r.fluxo).toMatchObject({ operacao: "recusar", etapa: "texto" });
    expect(r.reply).toContain("motivo");
  });

  it("atividade já concluída ou cancelada: concluir/recusar não propõem; comentar segue", async () => {
    const encerrada = [{ id: "atv_1", titulo: "Ligar", concluidaEm: "2026-10-22T10:00:00Z" }];
    const a = await rotearBotaoDeAtividade({ payload: "atv:atv_1:concluir", ctx: ctx("x"), identity: usuario, ler: lerCom(encerrada) });
    expect(a.fluxo).toBeNull();
    expect(a.reply).toContain("já está concluída");
    const b = await rotearBotaoDeAtividade({ payload: "atv:atv_1:comentar", ctx: ctx("x"), identity: usuario, ler: lerCom(encerrada) });
    expect(b.fluxo).toMatchObject({ operacao: "comentar" });
  });
});
