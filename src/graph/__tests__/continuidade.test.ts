import { beforeEach, describe, expect, it, vi } from "vitest";
import { conduzirContinuidade, iniciarContinuidade, pedeContinuidade, type FluxoContinuidade } from "../continuidade";
import { rebaixarFluxo, type ContextoDoTurno } from "../fluxos";

const acao = vi.fn();
const deps = { acao, extrairCampos: vi.fn(), extrairProposta: vi.fn() };
const ctx: ContextoDoTurno = { texto: "Concluir. Pode criar o formulário desse negócio.", messageId: "m1", agora: 1, policy: ["proposal.list", "proposal.send", "proposal.create"] };
const p = { id: "p1", codigo: "PROP-2026-0001", status: "assinada_proponente" };
const fluxo = (): FluxoContinuidade => ({ kind: "continuidade", etapa: "confirmacao", converter: true, alvo: p, atualizadoEm: 1 });
beforeEach(() => acao.mockReset());

describe("continuidade assinada", () => {
  it.each(["Concluir. Pode criar o formulário desse negócio.", "Converter PROP-2026-0001", "Pode criar o formulário dessa proposta assinada"])("intercepta %s", (texto) => expect(pedeContinuidade(texto)).toBe(true));
  it.each(["Como converter uma proposta?", "não conclua a proposta", "quero criar um formulário novo", "concluir o cadastro", "converter dólar em reais"])("não captura %s", (texto) => expect(pedeContinuidade(texto)).toBe(false));
  it("nega sem política antes de ler", async () => {
    await iniciarContinuidade({ ...ctx, policy: [] }, deps);
    expect(acao).not.toHaveBeenCalled();
  });
  it("várias candidatas exigem escolha, nunca a mais recente", async () => {
    acao.mockResolvedValue({ status: 200, body: { items: [p, { ...p, id: "p2", codigo: "PROP-2026-0002" }], total: 2 } });
    const r = await iniciarContinuidade(ctx, deps);
    expect(r.fluxo).toMatchObject({ etapa: "selecao" });
    const escolhido = await conduzirContinuidade(r.fluxo as FluxoContinuidade, { ...ctx, texto: "2" }, deps);
    expect(escolhido.reply).toContain("PROP-2026-0002");
    expect(acao).toHaveBeenCalledTimes(1);
  });
  it("não presume unicidade quando a lista está truncada", async () => {
    acao.mockResolvedValue({ status: 200, body: { items: [p], total: 6 } });
    expect((await iniciarContinuidade(ctx, deps)).fluxo).toMatchObject({ etapa: "selecao" });
  });
  it("nome explícito não pode escolher outra pessoa mesmo com candidata única", async () => {
    acao.mockResolvedValue({ status: 200, body: { items: [{ ...p, titulo: "Letícia" }], total: 1 } });
    expect((await iniciarContinuidade({ ...ctx, texto: "Converter a proposta da Maria" }, deps)).fluxo).not.toMatchObject({ etapa: "confirmacao" });
  });
  it("novo nome não herda o código da proposta anterior", async () => {
    const r = await conduzirContinuidade({ ...fluxo(), etapa: "concluida", resultado: "ok" }, { ...ctx, texto: "Converter a proposta da Maria" }, deps);
    expect(r.fluxo).toMatchObject({ etapa: "selecao" });
    expect(acao).not.toHaveBeenCalled();
  });
  it("selecionar completa não exige permissão de envio", async () => {
    const r = await conduzirContinuidade({ ...fluxo(), etapa: "selecao", alvo: undefined, candidatos: [{ ...p, status: "completa" }] }, { ...ctx, texto: "1", policy: ["proposal.list", "proposal.create"] }, deps);
    expect(r.fluxo).toMatchObject({ etapa: "confirmacao", alvo: { id: "p1" } });
  });
  it("código inexistente não cai em outra proposta nem cria form", async () => {
    acao.mockResolvedValue({ status: 404, body: {} });
    const r = await iniciarContinuidade({ ...ctx, texto: "Converter PROP-2026-9999" }, deps);
    expect(r.fluxo).toMatchObject({ etapa: "selecao" });
    expect(acao).toHaveBeenCalledTimes(1);
    expect(acao).toHaveBeenCalledWith("proposal.status", { codigo: "PROP-2026-9999" });
  });
  it("pedido só de conclusão pode ser seguido pela conversão da mesma proposta", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { status: "completa" } });
    const r = await conduzirContinuidade({ ...fluxo(), converter: false }, { ...ctx, texto: "sim" }, deps);
    acao.mockResolvedValueOnce({ status: 200, body: { proposta: { ...p, status: "completa" } } });
    const prox = await conduzirContinuidade(r.fluxo as FluxoContinuidade, { ...ctx, texto: "Pode criar o formulário dessa proposta" }, deps);
    expect(prox.fluxo).toMatchObject({ converter: true, etapa: "confirmacao", alvo: { id: "p1" } });
    expect(acao.mock.calls[1]).toEqual(["proposal.status", { codigo: p.codigo }]);
  });
  it("dossiê pendente mantém alvo e chave; retry não repete complete", async () => {
    acao.mockResolvedValueOnce({ status: 200, body: { status: "completa" } })
      .mockResolvedValueOnce({ status: 409, body: { error: "dossier_pending" } })
      .mockResolvedValueOnce({ status: 201, body: { negocio: { link: "/deals/d1" } } });
    const r = await conduzirContinuidade(fluxo(), { ...ctx, texto: "sim" }, deps);
    expect(r.fluxo).toMatchObject({ completou: true, chave: { verbo: "proposal.convert", valor: "m1" } });
    const fim = await conduzirContinuidade(r.fluxo as FluxoContinuidade, { ...ctx, texto: "sim", messageId: "m2" }, deps);
    expect("reply" in fim && fim.reply).toContain("https://imobpro.ia.br/deals/d1");
    expect(acao.mock.calls.map(([verb]) => verb)).toEqual(["proposal.complete", "proposal.convert", "proposal.convert"]);
    expect(acao.mock.calls[2][2]).toBe("m1");
    await conduzirContinuidade(fim.fluxo as FluxoContinuidade, { ...ctx, texto: "sim", messageId: "m3" }, deps);
    expect(acao).toHaveBeenCalledTimes(3);
  });
  it("timeout da conclusão conserva a mesma key", async () => {
    acao.mockResolvedValue(null);
    const r = await conduzirContinuidade(fluxo(), { ...ctx, texto: "sim" }, deps);
    await conduzirContinuidade(r.fluxo as FluxoContinuidade, { ...ctx, texto: "sim", messageId: "m2" }, deps);
    expect(acao.mock.calls.map((a) => a[2])).toEqual(["m1", "m1"]);
  });
  it("interrupção rebaixa: próximo sim não escreve", async () => {
    await conduzirContinuidade(rebaixarFluxo(fluxo()) as FluxoContinuidade, { ...ctx, texto: "sim" }, deps);
    expect(acao).not.toHaveBeenCalled();
  });
  it("negação não escreve", async () => {
    expect((await conduzirContinuidade(fluxo(), { ...ctx, texto: "não" }, deps)).fluxo).toBeNull();
    expect(acao).not.toHaveBeenCalled();
  });
  it("pergunta libera conversa e exige resumo novo antes de escrever", async () => {
    expect(await conduzirContinuidade(fluxo(), { ...ctx, texto: "como funciona o contrato?" }, deps)).toMatchObject({ liberar: true });
    expect(acao).not.toHaveBeenCalled();
  });
});
