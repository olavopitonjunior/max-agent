import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextoDoTurno, DepsDoFluxo, PassoDoFluxo } from "../../fluxos";
import { rebaixarFluxo } from "../../fluxos";
import { conduzirCorrecaoTexto, iniciarCorrecaoTexto, renderizarAntesDepois, type FluxoCorrecaoTexto } from "../correcao-texto";
import { derivarInterativo } from "@/lib/interativo";

/**
 * PR-E (T15): o fluxo "sugerir, mostrar antes/depois, esperar o SIM, aplicar". Contrato: CM §18.13.14.
 * Só dado sintético. O texto do documento (antes/depois/trecho) é marcado e procurado no estado.
 */

process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString("base64");

const ANTES = "ANTES-MARCADOR: multa de 20% sobre o valor do contrato.";
const DEPOIS = "DEPOIS-MARCADOR: multa de 10% sobre o valor do contrato.";
const TRECHO_A = "TRECHO-A-MARCADOR cláusula sétima, da multa";
const TRECHO_B = "TRECHO-B-MARCADOR cláusula nona, da multa rescisória";
const TRECHO_C = "TRECHO-C-MARCADOR cláusula décima";
const TRECHO_D = "TRECHO-D-MARCADOR cláusula décima primeira";

const acao = vi.fn<DepsDoFluxo["acao"]>();
const deps = { acao, extrairProposta: vi.fn(), extrairCampos: vi.fn() } as unknown as DepsDoFluxo;

let seq = 0;
const ctx = (texto: string, extra: Partial<ContextoDoTurno> = {}): ContextoDoTurno => ({
  texto, messageId: `wamid.M${++seq}`, policy: ["document.text.edit"], agora: 1_000_000, orgName: "Imob Sintetica",
  thread: "thread-sintetico", orgId: "org-1", podeEscrever: true, ...extra,
});

const SUGESTAO = { estado: "sugestao", sugestaoId: "sug-1", paragrafoId: "p4", hashParagrafo: "h".repeat(16), antes: ANTES, depois: DEPOIS, link: "https://docs.google.com/document/d/abc/edit" };
const ok = (body: Record<string, unknown>) => ({ status: 200, body });
const erro = (status: number, error: string, extra: Record<string, unknown> = {}) => ({ status, body: { error, ...extra } });

const PEDIDO = "troca a multa para 10%";
const entrada = { alvo: "proposal" as const, id: "prop-1", rotulo: "PROP-2026-0001", pedido: PEDIDO };

const fluxoDe = (r: PassoDoFluxo): FluxoCorrecaoTexto => {
  expect(r.fluxo).not.toBeNull();
  expect(r.fluxo!.kind).toBe("correcao_texto");
  return r.fluxo as FluxoCorrecaoTexto;
};

/** Todo o estado serializado: nada do texto do documento pode estar nele (R29). */
const semTextoDoDocumento = (f: unknown) => {
  const s = JSON.stringify(f);
  for (const m of [ANTES, DEPOIS, TRECHO_A, TRECHO_B, TRECHO_C, "MARCADOR", PEDIDO, "multa"]) expect(s).not.toContain(m);
};

beforeEach(() => {
  acao.mockReset();
});

describe("gate: sem a capability o fluxo nem é oferecido (negado primeiro)", () => {
  it("sem document.text.edit, text.suggest nem é chamado", async () => {
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO, { policy: ["proposal.list", "proposal.create"] }), deps, entrada);
    expect(acao).not.toHaveBeenCalled();
    expect(r.fluxo).toBeNull();
    expect(r.reply).toMatch(/não está liberado/i);
  });

  it("sem poder escrever (RBAC de identidade) ou com política indisponível: nada é chamado", async () => {
    await iniciarCorrecaoTexto(ctx(PEDIDO, { podeEscrever: false }), deps, entrada);
    await iniciarCorrecaoTexto(ctx(PEDIDO, { podeEscrever: undefined }), deps, entrada);
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO, { politicaIndisponivel: true }), deps, entrada);
    expect(acao).not.toHaveBeenCalled();
    expect(r.reply).toMatch(/validar sua permissão/);
  });

  it("a capability some no meio do fluxo: o SIM não aplica", async () => {
    acao.mockResolvedValueOnce(ok(SUGESTAO));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    acao.mockClear();
    const fim = await conduzirCorrecaoTexto(fluxoDe(r), ctx("sim", { policy: [] }), deps);
    expect(acao).not.toHaveBeenCalled();
    expect(fim.fluxo).toBeNull();
  });

  it("pedido curto demais ou grande demais não chama o servidor", async () => {
    const curto = await iniciarCorrecaoTexto(ctx("oi"), deps, { ...entrada, pedido: "oi" });
    const longo = await iniciarCorrecaoTexto(ctx("x"), deps, { ...entrada, pedido: "x".repeat(501) });
    expect(acao).not.toHaveBeenCalled();
    expect(curto.reply).toMatch(/3 a 500/);
    expect(longo.reply).toMatch(/500/);
  });
});

describe("suggest: a chamada e a sugestão", () => {
  it("proposta: args exatos, chave = messageId, nunca aceita_cancelar nem criar_documento sem pedir", async () => {
    acao.mockResolvedValueOnce(ok(SUGESTAO));
    const c = ctx(PEDIDO, { messageId: "wamid.SUG" });
    await iniciarCorrecaoTexto(c, deps, entrada);
    expect(acao).toHaveBeenCalledTimes(1);
    expect(acao).toHaveBeenCalledWith("proposal.text.suggest", { proposta_id: "prop-1", pedido: PEDIDO }, "wamid.SUG");
  });

  it("captação: captacaoId no lugar de proposta_id, verbo da captação", async () => {
    acao.mockResolvedValueOnce(ok(SUGESTAO));
    await iniciarCorrecaoTexto(ctx(PEDIDO, { messageId: "wamid.CAP" }), deps, { ...entrada, alvo: "captacao", id: "cap-9" });
    expect(acao).toHaveBeenCalledWith("captacao.text.suggest", { captacaoId: "cap-9", pedido: PEDIDO }, "wamid.CAP");
  });

  it("mostra antes e depois, o menu 1/2/3, e o estado guarda SÓ ids (R29)", async () => {
    acao.mockResolvedValueOnce(ok(SUGESTAO));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    expect(r.reply).toContain(ANTES);
    expect(r.reply).toContain(DEPOIS);
    expect(r.reply).toMatch(/Ainda não mudei nada/);
    expect(r.reply).toMatch(/1\. Aplicar\n2\. Ajustar\n3\. Ver no documento/);
    const f = fluxoDe(r);
    expect(f).toMatchObject({ etapa: "sugestao", sugestaoId: "sug-1", paragrafoId: "p4", hashParagrafo: "h".repeat(16) });
    semTextoDoDocumento(f);
  });

  it("R31: o menu vira lista interativa no Max (botões), e continua texto numerado sem interativo", async () => {
    acao.mockResolvedValueOnce(ok({ ...SUGESTAO, antes: "Multa de 20%.", depois: "Multa de 10%." }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    const i = derivarInterativo(r.reply);
    expect(i?.tipo).toBe("lista");
    expect(i?.opcoes.map((o) => o.titulo)).toEqual(["Aplicar", "Ajustar", "Ver no documento"]);
    expect(r.reply).toMatch(/^1\. Aplicar$/m); // Newton: o mesmo texto numerado
  });

  it("sem link do documento o menu não oferece 'Ver no documento'", async () => {
    acao.mockResolvedValueOnce(ok({ ...SUGESTAO, link: undefined }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    expect(r.reply).not.toContain("Ver no documento");
    expect(r.reply).toMatch(/1\. Aplicar\n2\. Ajustar/);
  });

  it("link que não é https não é repassado", async () => {
    acao.mockResolvedValueOnce(ok({ ...SUGESTAO, link: "javascript:alert(1)" }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    expect(r.reply).not.toContain("javascript");
    expect(fluxoDe(r).link).toBeUndefined();
  });

  it("renderizarAntesDepois separa os dois blocos", () => {
    expect(renderizarAntesDepois({ antes: "a", depois: "b" })).toBe("*Antes*\na\n\n*Depois*\nb");
  });
});

describe("R31: só o SIM explícito aplica", () => {
  async function aguardando() {
    acao.mockResolvedValueOnce(ok(SUGESTAO));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    acao.mockClear();
    return fluxoDe(r);
  }

  it.each(["ok", "blz", "beleza", "pode", "👍", "certo", "perfeito", "claro"])("'%s' nunca aplica: re-pergunta, o fluxo fica", async (vago) => {
    const f = await aguardando();
    const r = await conduzirCorrecaoTexto(f, ctx(vago), deps);
    expect(acao).not.toHaveBeenCalled();
    expect(r.reply).toMatch(/Para aplicar/);
    expect(fluxoDe(r).etapa).toBe("sugestao");
  });

  it.each(["sim", "1", "aplicar", "Aplica", "confirmo"])("'%s' aplica, com a chave da mensagem do SIM e sem cancelar_envio", async (sim) => {
    const f = await aguardando();
    acao.mockResolvedValueOnce(ok({ aplicado: true, avisos: [] }));
    const c = ctx(sim, { messageId: "wamid.SIM" });
    const r = await conduzirCorrecaoTexto(f, c, deps);
    expect(acao).toHaveBeenCalledTimes(1);
    expect(acao).toHaveBeenCalledWith("proposal.text.apply", { proposta_id: "prop-1", sugestaoId: "sug-1", hashParagrafo: "h".repeat(16) }, "wamid.SIM");
    expect(r.reply).toMatch(/apliquei a correção da proposta/);
    expect(r.fluxo).toBeNull();
  });

  it("captação aplica com captacao.text.apply e captacaoId", async () => {
    acao.mockResolvedValueOnce(ok(SUGESTAO));
    const r0 = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, { ...entrada, alvo: "captacao", id: "cap-9" });
    acao.mockResolvedValueOnce(ok({ aplicado: true, avisos: [] }));
    const r = await conduzirCorrecaoTexto(fluxoDe(r0), ctx("sim", { messageId: "wamid.S2" }), deps);
    expect(acao).toHaveBeenLastCalledWith("captacao.text.apply", { captacaoId: "cap-9", sugestaoId: "sug-1", hashParagrafo: "h".repeat(16) }, "wamid.S2");
    expect(r.reply).toMatch(/da captação/);
  });

  it("NÃO, cancelar e 'para' encerram sem aplicar", async () => {
    for (const nao of ["não", "cancela", "para"]) {
      const f = await aguardando();
      const r = await conduzirCorrecaoTexto(f, ctx(nao), deps);
      expect(acao).not.toHaveBeenCalled();
      expect(r.fluxo).toBeNull();
    }
  });

  it("2/Ajustar pede o pedido novo e NÃO chama o servidor; o pedido novo reusa o MESMO paragrafo_id", async () => {
    const f = await aguardando();
    const r = await conduzirCorrecaoTexto(f, ctx("2"), deps);
    expect(acao).not.toHaveBeenCalled();
    const aj = fluxoDe(r);
    expect(aj.etapa).toBe("ajustar");
    expect(aj.paragrafoId).toBe("p4");
    acao.mockResolvedValueOnce(ok({ ...SUGESTAO, sugestaoId: "sug-2" }));
    const c = ctx("coloca 12% em vez de 10%", { messageId: "wamid.AJ" });
    const r2 = await conduzirCorrecaoTexto(aj, c, deps);
    expect(acao).toHaveBeenCalledWith("proposal.text.suggest", { proposta_id: "prop-1", pedido: "coloca 12% em vez de 10%", paragrafo_id: "p4" }, "wamid.AJ");
    expect(fluxoDe(r2)).toMatchObject({ etapa: "sugestao", sugestaoId: "sug-2" });
  });

  it("3/Ver devolve o link e não escreve; o fluxo continua esperando o SIM", async () => {
    const f = await aguardando();
    const r = await conduzirCorrecaoTexto(f, ctx("3"), deps);
    expect(acao).not.toHaveBeenCalled();
    expect(r.reply).toContain("https://docs.google.com/document/d/abc/edit");
    expect(fluxoDe(r).etapa).toBe("sugestao");
    // e o "ok" depois do link continua não aplicando
    const r2 = await conduzirCorrecaoTexto(fluxoDe(r), ctx("ok"), deps);
    expect(acao).not.toHaveBeenCalled();
    expect(fluxoDe(r2).etapa).toBe("sugestao");
  });

  it("outro assunto libera o turno e desfaz o fluxo (nenhum SIM futuro aplica)", async () => {
    const f = await aguardando();
    const r = await conduzirCorrecaoTexto(f, ctx("qual o status da proposta do João?"), deps);
    expect(r.liberar).toBe(true);
    expect(r.fluxo).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });

  it("a interrupção (rebaixarFluxo) desfaz o fluxo: o SIM seguinte exige sugestão nova", async () => {
    const f = await aguardando();
    expect(rebaixarFluxo(f)).toBeNull();
  });
});

describe("R29: o estado nunca guarda o texto do documento nem o pedido em claro", () => {
  it("em todas as etapas, antes/depois/trecho/pedido ficam fora do estado", async () => {
    // candidatos
    acao.mockResolvedValueOnce(ok({ estado: "candidatos", candidatos: [{ paragrafoId: "p2", trecho: TRECHO_A }, { paragrafoId: "p5", trecho: TRECHO_B }] }));
    const cand = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    semTextoDoDocumento(fluxoDe(cand));
    expect(fluxoDe(cand).pedidoSelado).toMatch(/^ficha-selada:v1:/);
    // sem documento próprio
    acao.mockResolvedValueOnce(ok({ estado: "sem_documento_proprio" }));
    const sem = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    semTextoDoDocumento(fluxoDe(sem));
    // nenhum parágrafo
    acao.mockResolvedValueOnce(ok({ estado: "nenhum_paragrafo" }));
    const nenhum = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    semTextoDoDocumento(fluxoDe(nenhum));
    // sugestão, e depois a incerteza do apply
    acao.mockResolvedValueOnce(ok(SUGESTAO));
    const sug = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    semTextoDoDocumento(fluxoDe(sug));
    acao.mockResolvedValueOnce(null);
    const incerta = await conduzirCorrecaoTexto(fluxoDe(sug), ctx("sim"), deps);
    semTextoDoDocumento(incerta.fluxo);
  });

  it("o pedido selado só abre com a mesma thread (AAD)", async () => {
    acao.mockResolvedValueOnce(ok({ estado: "candidatos", candidatos: [{ paragrafoId: "p2", trecho: TRECHO_A }, { paragrafoId: "p5", trecho: TRECHO_B }] }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO, { thread: "thread-A" }), deps, entrada);
    // outra thread não abre o selo: cai no "repita o pedido", sem chamar o servidor
    const c = await conduzirCorrecaoTexto(fluxoDe(r), ctx("1", { thread: "thread-B" }), deps);
    expect(acao).toHaveBeenCalledTimes(1);
    expect(fluxoDe(c).etapa).toBe("ajustar");
  });

  it("sem thread no contexto não há selo: o pedido NÃO fica no estado e o corretor repete", async () => {
    acao.mockResolvedValueOnce(ok({ estado: "candidatos", candidatos: [{ paragrafoId: "p2", trecho: TRECHO_A }, { paragrafoId: "p5", trecho: TRECHO_B }] }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO, { thread: undefined }), deps, entrada);
    const f = fluxoDe(r);
    expect(f.pedidoSelado).toBeUndefined();
    semTextoDoDocumento(f);
    const c = await conduzirCorrecaoTexto(f, ctx("2", { thread: undefined }), deps);
    expect(fluxoDe(c)).toMatchObject({ etapa: "ajustar", paragrafoId: "p5" });
    expect(acao).toHaveBeenCalledTimes(1);
  });
});

describe("candidatos", () => {
  it("lista no máximo 3 trechos e guarda só os ids", async () => {
    acao.mockResolvedValueOnce(ok({ estado: "candidatos", candidatos: [
      { paragrafoId: "p2", trecho: TRECHO_A }, { paragrafoId: "p5", trecho: TRECHO_B },
      { paragrafoId: "p7", trecho: TRECHO_C }, { paragrafoId: "p9", trecho: TRECHO_D },
    ] }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    expect(r.reply).toContain(TRECHO_A);
    expect(r.reply).toContain(TRECHO_C);
    expect(r.reply).not.toContain(TRECHO_D);
    expect(r.reply).toMatch(/^3\. /m);
    expect(r.reply).not.toMatch(/^4\. /m);
    expect(fluxoDe(r).candidatos).toEqual(["p2", "p5", "p7"]);
  });

  it("a escolha repete o suggest com o paragrafo_id e o MESMO pedido (aberto do selo), chave da escolha", async () => {
    acao.mockResolvedValueOnce(ok({ estado: "candidatos", candidatos: [{ paragrafoId: "p2", trecho: TRECHO_A }, { paragrafoId: "p5", trecho: TRECHO_B }] }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    acao.mockResolvedValueOnce(ok(SUGESTAO));
    await conduzirCorrecaoTexto(fluxoDe(r), ctx("2", { messageId: "wamid.ESC" }), deps);
    expect(acao).toHaveBeenLastCalledWith("proposal.text.suggest", { proposta_id: "prop-1", pedido: PEDIDO, paragrafo_id: "p5" }, "wamid.ESC");
  });

  it("número fora da lista não escolhe nada; texto livre sai do fluxo", async () => {
    acao.mockResolvedValueOnce(ok({ estado: "candidatos", candidatos: [{ paragrafoId: "p2", trecho: TRECHO_A }, { paragrafoId: "p5", trecho: TRECHO_B }] }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    const f = fluxoDe(r);
    const fora = await conduzirCorrecaoTexto(f, ctx("3"), deps);
    expect(fora.liberar).toBe(true);
    expect(acao).toHaveBeenCalledTimes(1);
  });
});

describe("R27: nenhum_paragrafo", () => {
  it("pede para citar a passagem, sem retentativa", async () => {
    acao.mockResolvedValueOnce(ok({ estado: "nenhum_paragrafo" }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    expect(acao).toHaveBeenCalledTimes(1);
    expect(r.reply).toMatch(/Cole ou descreva a passagem/);
    expect(fluxoDe(r).etapa).toBe("citar");
  });

  it("a citação vira um pedido novo (pedido original + trecho), com chave da mensagem", async () => {
    acao.mockResolvedValueOnce(ok({ estado: "nenhum_paragrafo" }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    acao.mockResolvedValueOnce(ok(SUGESTAO));
    await conduzirCorrecaoTexto(fluxoDe(r), ctx("a cláusula da rescisão", { messageId: "wamid.CIT" }), deps);
    expect(acao).toHaveBeenLastCalledWith("proposal.text.suggest", { proposta_id: "prop-1", pedido: `${PEDIDO} (trecho: a cláusula da rescisão)` }, "wamid.CIT");
  });
});

describe("sem_documento_proprio", () => {
  it("proposta: oferece criar o documento com aviso, e só o SIM manda criar_documento", async () => {
    acao.mockResolvedValueOnce(ok({ estado: "sem_documento_proprio" }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    expect(r.reply).toMatch(/criar o documento da proposta/);
    expect(r.reply).toMatch(/cria o documento agora/i);
    expect(fluxoDe(r).etapa).toBe("oferta_documento");
    expect(acao).toHaveBeenCalledTimes(1);
    // "ok" não cria
    const vago = await conduzirCorrecaoTexto(fluxoDe(r), ctx("ok"), deps);
    expect(acao).toHaveBeenCalledTimes(1);
    expect(fluxoDe(vago).etapa).toBe("oferta_documento");
    // SIM cria
    acao.mockResolvedValueOnce(ok(SUGESTAO));
    await conduzirCorrecaoTexto(fluxoDe(r), ctx("sim", { messageId: "wamid.DOC" }), deps);
    expect(acao).toHaveBeenLastCalledWith("proposal.text.suggest", { proposta_id: "prop-1", pedido: PEDIDO, criar_documento: true }, "wamid.DOC");
  });

  it("captação não oferece criar o documento (o servidor ignora criar_documento): manda para a tela", async () => {
    acao.mockResolvedValueOnce(ok({ estado: "sem_documento_proprio" }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, { ...entrada, alvo: "captacao", id: "cap-9" });
    expect(r.fluxo).toBeNull();
    expect(r.reply).toMatch(/Gere pela tela/);
    expect(JSON.stringify(acao.mock.calls)).not.toContain("criar_documento");
  });

  it("sem selo disponível, o SIM pede o pedido de novo e ainda criará o documento", async () => {
    acao.mockResolvedValueOnce(ok({ estado: "sem_documento_proprio" }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO, { thread: undefined }), deps, entrada);
    const c = await conduzirCorrecaoTexto(fluxoDe(r), ctx("sim", { thread: undefined }), deps);
    expect(fluxoDe(c)).toMatchObject({ etapa: "ajustar", criarDocumento: true });
    acao.mockResolvedValueOnce(ok(SUGESTAO));
    await conduzirCorrecaoTexto(fluxoDe(c), ctx("troca a multa para 10%", { messageId: "wamid.R", thread: undefined }), deps);
    expect(acao).toHaveBeenLastCalledWith("proposal.text.suggest", { proposta_id: "prop-1", pedido: "troca a multa para 10%", criar_documento: true }, "wamid.R");
  });
});

describe("R26: documento em assinatura (explica e manda para a tela)", () => {
  const FIXO = /cancelar o envio e enviar de novo/;

  it("suggest 200 em_assinatura: explica, sem R$, sem chamar apply, sem aceita_cancelar", async () => {
    acao.mockResolvedValueOnce(ok({ estado: "em_assinatura", instrumento: "envelope", destinatarios: ["Maria"], consomeEnvioDoPlano: true }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    expect(r.reply).toMatch(FIXO);
    expect(r.reply).toMatch(/consome um envio do plano/);
    expect(r.reply).not.toMatch(/R\$/);
    expect(r.fluxo).toBeNull();
    const json = JSON.stringify(acao.mock.calls);
    expect(json).not.toContain("aceita_cancelar");
    expect(json).not.toContain("cancelar_envio");
    expect(acao).toHaveBeenCalledTimes(1);
  });

  it("suggest 409 requer_cancelamento: mesma resposta", async () => {
    acao.mockResolvedValueOnce(erro(409, "requer_cancelamento", { instrumento: "aceite", destinatarios: [] }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    expect(r.reply).toMatch(FIXO);
    expect(r.fluxo).toBeNull();
  });

  it("apply 409 requer_cancelamento: explica, nunca repete o apply com cancelar_envio, nem com SIM seguinte", async () => {
    acao.mockResolvedValueOnce(ok(SUGESTAO));
    const r0 = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    acao.mockResolvedValueOnce(erro(409, "requer_cancelamento", { instrumento: "envelope", destinatarios: ["x"] }));
    const r = await conduzirCorrecaoTexto(fluxoDe(r0), ctx("sim"), deps);
    expect(r.reply).toMatch(FIXO);
    expect(r.reply).not.toMatch(/R\$/);
    expect(r.fluxo).toBeNull();
    const json = JSON.stringify(acao.mock.calls);
    expect(json).not.toContain("cancelar_envio");
    expect(json).not.toContain("aceita_cancelar");
    expect(acao.mock.calls.filter(([v]) => v.endsWith(".apply"))).toHaveLength(1);
  });
});

describe("R28: o documento mudou entre a sugestão e o SIM", () => {
  async function pronto() {
    acao.mockResolvedValueOnce(ok(SUGESTAO));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    acao.mockClear();
    return fluxoDe(r);
  }

  it.each(["paragrafo_mudou", "sugestao_expirada"])("%s: refaz o suggest com chave NOVA e pede SIM de novo (nunca aplica sozinho)", async (codigo) => {
    const f = await pronto();
    acao.mockResolvedValueOnce(erro(409, codigo));
    const novo = { ...SUGESTAO, sugestaoId: "sug-NOVA", hashParagrafo: "n".repeat(16), depois: "DEPOIS-NOVO-MARCADOR: multa de 10% e 1 mês de aluguel." };
    acao.mockResolvedValueOnce(ok(novo));
    const r = await conduzirCorrecaoTexto(f, ctx("sim", { messageId: "wamid.SIM2" }), deps);
    expect(acao).toHaveBeenCalledTimes(2);
    expect(acao).toHaveBeenNthCalledWith(1, "proposal.text.apply", expect.anything(), "wamid.SIM2");
    expect(acao).toHaveBeenNthCalledWith(2, "proposal.text.suggest", { proposta_id: "prop-1", pedido: PEDIDO, paragrafo_id: "p4" }, "wamid.SIM2:r");
    expect(r.reply).toContain("DEPOIS-NOVO-MARCADOR");
    expect(r.reply).toMatch(/Refiz com o texto atual/);
    expect(fluxoDe(r)).toMatchObject({ etapa: "sugestao", sugestaoId: "sug-NOVA", hashParagrafo: "n".repeat(16) });
    // e só um SIM NOVO aplica a nova sugestão
    acao.mockResolvedValueOnce(ok({ aplicado: true, avisos: [] }));
    await conduzirCorrecaoTexto(fluxoDe(r), ctx("sim", { messageId: "wamid.SIM3" }), deps);
    expect(acao).toHaveBeenLastCalledWith("proposal.text.apply", { proposta_id: "prop-1", sugestaoId: "sug-NOVA", hashParagrafo: "n".repeat(16) }, "wamid.SIM3");
  });

  it("sugestão vencida no relógio local: nem tenta aplicar, refaz", async () => {
    const f = await pronto();
    acao.mockResolvedValueOnce(ok({ ...SUGESTAO, sugestaoId: "sug-2" }));
    const r = await conduzirCorrecaoTexto(f, ctx("sim", { agora: 1_000_000 + 31 * 60 * 1000, messageId: "wamid.VENC" }), deps);
    expect(acao).toHaveBeenCalledTimes(1);
    expect(acao).toHaveBeenCalledWith("proposal.text.suggest", expect.objectContaining({ paragrafo_id: "p4" }), "wamid.VENC:r");
    expect(r.reply).toMatch(/venceu/);
    expect(fluxoDe(r).sugestaoId).toBe("sug-2");
  });

  it("sem selo (pedido indisponível), refazer pede ao corretor repetir o pedido, sem chamar suggest", async () => {
    acao.mockResolvedValueOnce(ok(SUGESTAO));
    const r0 = await iniciarCorrecaoTexto(ctx(PEDIDO, { thread: undefined }), deps, entrada);
    acao.mockClear();
    acao.mockResolvedValueOnce(erro(409, "paragrafo_mudou"));
    const r = await conduzirCorrecaoTexto(fluxoDe(r0), ctx("sim", { thread: undefined }), deps);
    expect(acao).toHaveBeenCalledTimes(1);
    expect(r.reply).toMatch(/Me diga de novo o que mudar/);
    expect(fluxoDe(r)).toMatchObject({ etapa: "ajustar", paragrafoId: "p4" });
  });

  it.each([
    ["sugestao_ja_aplicada", 409, /já foi aplicada/],
    ["estado_mudou", 409, /Não repeti nada/],
    ["sugestao_nao_encontrada", 404, /Não encontrei essa sugestão/],
  ])("%s: informa e encerra, sem nova tentativa", async (codigo, status, re) => {
    const f = await pronto();
    acao.mockResolvedValueOnce(erro(status, codigo));
    const r = await conduzirCorrecaoTexto(f, ctx("sim"), deps);
    expect(acao).toHaveBeenCalledTimes(1);
    expect(r.reply).toMatch(re);
    expect(r.fluxo).toBeNull();
  });

  it("documento_bloqueado, assinado e encerrado informam sem repetir", async () => {
    for (const [codigo, re] of [["documento_bloqueado", /indisponível para edição/], ["documento_assinado", /já foi assinado/], ["documento_encerrado", /encerrado sem assinatura/]] as const) {
      const f = await pronto();
      acao.mockResolvedValueOnce(erro(409, codigo));
      const r = await conduzirCorrecaoTexto(f, ctx("sim"), deps);
      expect(r.reply).toMatch(re);
      expect(r.fluxo).toBeNull();
      expect(acao).toHaveBeenCalledTimes(1);
      acao.mockClear();
    }
  });

  it("avisos do apply são mostrados ao corretor", async () => {
    const f = await pronto();
    acao.mockResolvedValueOnce(ok({ aplicado: true, avisos: ["O parágrafo 7 também mudou durante a correção. Confira o documento."] }));
    const r = await conduzirCorrecaoTexto(f, ctx("sim"), deps);
    expect(r.reply).toMatch(/apliquei a correção/);
    expect(r.reply).toMatch(/Atenção:\n- O parágrafo 7 também mudou/);
  });

  it("apply 502: frase fixa, sem retentativa automática; o SIM seguinte tenta de novo com chave nova", async () => {
    const f = await pronto();
    acao.mockResolvedValueOnce(erro(502, "documento_indisponivel"));
    const r = await conduzirCorrecaoTexto(f, ctx("sim", { messageId: "wamid.A" }), deps);
    expect(acao).toHaveBeenCalledTimes(1);
    expect(r.reply).toMatch(/Não consegui falar com o Google/);
    expect(fluxoDe(r).etapa).toBe("sugestao");
    acao.mockResolvedValueOnce(ok({ aplicado: true, avisos: [] }));
    await conduzirCorrecaoTexto(fluxoDe(r), ctx("sim", { messageId: "wamid.B" }), deps);
    expect(acao).toHaveBeenLastCalledWith("proposal.text.apply", expect.anything(), "wamid.B");
  });
});

describe("escrita incerta (apply sem resposta)", () => {
  it("guarda a chave; o SIM seguinte repete a MESMA chave (não duplica); outra coisa não aplica", async () => {
    acao.mockResolvedValueOnce(ok(SUGESTAO));
    const r0 = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    acao.mockResolvedValueOnce(null);
    const r = await conduzirCorrecaoTexto(fluxoDe(r0), ctx("sim", { messageId: "wamid.I1" }), deps);
    expect(r.reply).toMatch(/não sei se deu certo/);
    expect(fluxoDe(r).chave).toEqual({ verbo: "proposal.text.apply", valor: "wamid.I1" });
    // interrupção não solta a chave
    expect(rebaixarFluxo(fluxoDe(r))).not.toBeNull();
    // "ok" não repete
    acao.mockClear();
    const vago = await conduzirCorrecaoTexto(fluxoDe(r), ctx("ok"), deps);
    expect(acao).not.toHaveBeenCalled();
    expect(fluxoDe(vago).chave).toBeDefined();
    // SIM repete com a chave guardada
    acao.mockResolvedValueOnce(ok({ aplicado: true, avisos: [] }));
    await conduzirCorrecaoTexto(fluxoDe(r), ctx("sim", { messageId: "wamid.I2" }), deps);
    expect(acao).toHaveBeenCalledWith("proposal.text.apply", expect.anything(), "wamid.I1");
  });

  it("suggest sem resposta: diz que nada foi alterado e encerra", async () => {
    acao.mockResolvedValueOnce(null);
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    expect(r.reply).toMatch(/Nada foi alterado/);
    expect(r.fluxo).toBeNull();
  });
});

describe("erros do suggest (frases fixas, sem retentativa)", () => {
  it("409 documento_aprovado: diz quem pode desaprovar e traz o link", async () => {
    acao.mockResolvedValueOnce(erro(409, "documento_aprovado", { quemPodeDesaprovar: ["Ana Gerente", "Bia Dona"], link: "https://imobpro.ia.br/propostas/1" }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    expect(r.reply).toMatch(/aprovado/);
    expect(r.reply).toContain("Ana Gerente, Bia Dona");
    expect(r.reply).toContain("https://imobpro.ia.br/propostas/1");
    expect(r.fluxo).toBeNull();
    expect(acao).toHaveBeenCalledTimes(1);
  });

  it("409 documento_assinado e documento_encerrado", async () => {
    acao.mockResolvedValueOnce(erro(409, "documento_assinado"));
    expect((await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada)).reply).toMatch(/já foi assinado/);
    acao.mockResolvedValueOnce(erro(409, "documento_encerrado"));
    expect((await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada)).reply).toMatch(/encerrado sem assinatura/);
  });

  it("409 sem_ancora traz o link", async () => {
    acao.mockResolvedValueOnce(erro(409, "sem_ancora", { link: "https://imobpro.ia.br/x" }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    expect(r.reply).toMatch(/dado pessoal escrito direto/);
    expect(r.reply).toContain("https://imobpro.ia.br/x");
  });

  it("404 paragrafo_nao_encontrado", async () => {
    acao.mockResolvedValueOnce(erro(404, "paragrafo_nao_encontrado"));
    expect((await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada)).reply).toMatch(/não está mais no documento/);
  });

  it("422 sugestao_invalida: não repete, e não vaza o motivo", async () => {
    acao.mockResolvedValueOnce(erro(422, "sugestao_invalida", { motivo: "valor-inventado-12345" }));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    expect(r.reply).toMatch(/não passou na conferência/);
    expect(r.reply).not.toContain("valor-inventado");
    expect(acao).toHaveBeenCalledTimes(1);
  });

  it("429 limite_de_sugestoes: frase fixa, sem retentativa", async () => {
    acao.mockResolvedValueOnce(erro(429, "limite_de_sugestoes"));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    expect(r.reply).toMatch(/3 sugestões/);
    expect(r.fluxo).toBeNull();
    expect(acao).toHaveBeenCalledTimes(1);
  });

  it.each([
    [502, "documento_indisponivel", /Google/],
    [502, "redacao_indisponivel", /redigir a correção/],
    [503, "nao_configurado", /não está configurada/],
  ])("%s %s: frase fixa, sem retentativa", async (status, codigo, re) => {
    acao.mockResolvedValueOnce(erro(status, codigo));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    expect(r.reply).toMatch(re);
    expect(r.fluxo).toBeNull();
    expect(acao).toHaveBeenCalledTimes(1);
  });

  it("403 politica_nao_concede e captacao_desligada", async () => {
    acao.mockResolvedValueOnce(erro(403, "Forbidden", { reason: "politica_nao_concede" }));
    expect((await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada)).reply).toMatch(/não está liberado/);
    acao.mockResolvedValueOnce(erro(403, "captacao_desligada"));
    expect((await iniciarCorrecaoTexto(ctx(PEDIDO), deps, { ...entrada, alvo: "captacao", id: "c" })).reply).toMatch(/captação não está ligada/);
  });

  it("403 fluxo_desligado: libera o turno em silêncio (o comportamento de hoje segue)", async () => {
    acao.mockResolvedValueOnce(erro(403, "fluxo_desligado"));
    const r = await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada);
    expect(r.liberar).toBe(true);
    expect(r.fluxo).toBeNull();
  });

  it("404 sem corpo conhecido: documento não encontrado", async () => {
    acao.mockResolvedValueOnce(erro(404, "Not Found"));
    expect((await iniciarCorrecaoTexto(ctx(PEDIDO), deps, entrada)).reply).toMatch(/Não encontrei esse documento/);
  });
});
