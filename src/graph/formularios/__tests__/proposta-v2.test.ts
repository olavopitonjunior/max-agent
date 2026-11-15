import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RespostaDoServidor } from "../../fluxos";
import { novoFluxoV2 } from "../estado";
import type { OptionsV2, Pendencia } from "../contrato";
import { consultarOptions, faltandoV2, salvarParcial, textoDoParcial } from "../proposta-v2";

const agora = 1_000_000;
const CPF = "52998224725"; // sintético, DV válido

function deps(resposta: RespostaDoServidor | null) {
  const acao = vi.fn(async (_verb: string, _args: Record<string, unknown>, _chave?: string) => resposta);
  return { acao };
}

const fluxo = (extra: Partial<ReturnType<typeof novoFluxoV2>> = {}) => ({
  ...novoFluxoV2({ esteira: "venda", agora, schemaType: "compra_venda_v1" }),
  ...extra,
});

const pend = (campo: string, posicao = 1): Pendencia => ({
  signatario: { posicao, papel: "comprador" },
  campo,
  motivo: "obrigatorio_da_org",
});

const optionsV2: OptionsV2 = {
  metodos: [], signatarios: [], assinaturaConfigurada: true,
  modalidades: [], obrigatorios: [], tiposDeAssinatura: [], fluxoV2: true,
};

describe("faltandoV2: a fonte é o servidor", () => {
  it("a resposta do create/update vence o options", () => {
    const doOptions = [pend("comprador.cpf")];
    const daResposta = [pend("negociacao.valor")];
    expect(faltandoV2({ ...optionsV2, faltando: doOptions }, { faltando: daResposta })).toEqual(daResposta);
  });

  it("sem resposta, usa o faltando do options (com alvo)", () => {
    expect(faltandoV2({ ...optionsV2, faltando: [pend("imovel.endereco")] })).toEqual([pend("imovel.endereco")]);
  });

  it("nenhum dos dois traz a lista: vazio, nunca inventado", () => {
    expect(faltandoV2(optionsV2)).toEqual([]);
    expect(faltandoV2(optionsV2, {})).toEqual([]);
  });

  it("o módulo não usa a conta local de pendências do v1", () => {
    const fonte = readFileSync(join(__dirname, "..", "proposta-v2.ts"), "utf8");
    expect(fonte).not.toContain("faltandoNaProposta");
  });

  it("o faltando do servidor sai exatamente como veio: o v1 teria outra lista", () => {
    // Item que o v1 local jamais produziria (obrigatório da org, ex.: creci do corretor).
    const doServidor: Pendencia[] = [{ signatario: null, campo: "corretor.creci", motivo: "obrigatorio_da_org" }];
    expect(faltandoV2(optionsV2, { faltando: doServidor })).toBe(doServidor);
  });
});

describe("consultarOptions", () => {
  it("sem alvo: manda tipo e schemaType, sem proposta_id", async () => {
    const d = deps({ status: 200, body: { ...optionsV2 } });
    const o = await consultarOptions(d, { tipo: "venda", schemaType: "compra_venda_v1" });
    expect(d.acao.mock.calls[0]!.slice(0, 2)).toEqual(["proposal.options", { tipo: "venda", schemaType: "compra_venda_v1" }]);
    expect(d.acao.mock.calls[0]![1]).not.toHaveProperty("proposta_id");
    expect(o?.fluxoV2).toBe(true);
  });

  it("com alvo: manda o proposta_id e o faltando vem junto", async () => {
    const d = deps({ status: 200, body: { ...optionsV2, faltando: [pend("comprador.email")] } });
    const o = await consultarOptions(d, { tipo: "venda", alvo: { proposalId: "prop-1" } });
    expect(d.acao.mock.calls[0]![1]).toEqual({ tipo: "venda", proposta_id: "prop-1" });
    expect(o && "faltando" in o ? o.faltando : null).toEqual([pend("comprador.email")]);
  });

  it("servidor com a flag desligada devolve fluxoV2 false: o chamador fica no v1", async () => {
    const d = deps({ status: 200, body: { metodos: [], signatarios: [], assinaturaConfigurada: true, fluxoV2: false } });
    expect((await consultarOptions(d, { tipo: "venda" }))?.fluxoV2).toBe(false);
  });

  it("sem resposta utilizável, null (e não inventa um options)", async () => {
    expect(await consultarOptions(deps(null), { tipo: "venda" })).toBeNull();
    expect(await consultarOptions(deps({ status: 400, body: { error: "invalid_body" } }), { tipo: "venda" })).toBeNull();
    expect(await consultarOptions(deps({ status: 500, body: {} }), { tipo: "venda" })).toBeNull();
  });
});

describe("salvarParcial: negados primeiro", () => {
  it("sem schemaType não chama o servidor: o create v2 exige", async () => {
    const d = deps({ status: 201, body: {} });
    const f = novoFluxoV2({ esteira: "venda", agora }); // sem schemaType
    const r = await salvarParcial(d, f, { compradores: [{ nome: "Maria Teste" }] }, { idempotencyKey: "m1" });
    expect(d.acao).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, erro: "dados_invalidos", campos: ["schemaType"] });
  });

  it("422 dados_invalidos: diz o motivo do servidor e NÃO diz 'anotei'", async () => {
    const d = deps({
      status: 422,
      body: { error: "dados_invalidos", message: "Preciso de pelo menos um dado da proposta para abrir o rascunho." },
    });
    const r = await salvarParcial(d, fluxo(), { observacoes: "" }, { idempotencyKey: "m1" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erro).toBe("dados_invalidos");
    const texto = textoDoParcial(r, {});
    expect(texto).toContain("Preciso de pelo menos um dado da proposta");
    expect(texto.toLowerCase()).not.toContain("anotei");
    // o rascunho segue sem existir; o fluxo continua aberto e sem chave presa
    expect(r.fluxo).toMatchObject({ kind: "proposta_v2" });
    expect(r.fluxo && "chave" in r.fluxo ? r.fluxo.chave : undefined).toBeUndefined();
  });

  it("o código do erro nunca vai para o corretor", async () => {
    const d = deps({ status: 422, body: { error: "dados_invalidos" } });
    const r = await salvarParcial(d, fluxo(), { observacoes: "x" }, { idempotencyKey: "m1" });
    if (r.ok) throw new Error("esperava recusa");
    expect(textoDoParcial(r, {})).not.toContain("dados_invalidos");
  });

  it("sem resposta (rede): incerta, guarda a chave e não afirma nada", async () => {
    const d = deps(null);
    const r = await salvarParcial(d, fluxo(), { compradores: [{ nome: "Maria Teste" }] }, { idempotencyKey: "msg-7" });
    expect(r).toMatchObject({ ok: false, erro: "incerta" });
    if (r.ok) return;
    expect(r.fluxo && "chave" in r.fluxo ? r.fluxo.chave : null).toEqual({ verbo: "proposal.create", valor: "msg-7" });
    expect(textoDoParcial(r, {}).toLowerCase()).not.toContain("anotei");
  });

  it("409 em_andamento é tão incerto quanto a falta de resposta", async () => {
    const d = deps({ status: 409, body: { error: "em_andamento" } });
    const r = await salvarParcial(d, fluxo(), { compradores: [{ nome: "Maria Teste" }] }, { idempotencyKey: "m1" });
    expect(r).toMatchObject({ ok: false, erro: "incerta" });
  });

  it("a retentativa reusa a chave guardada, não a da mensagem nova", async () => {
    const d = deps({ status: 201, body: { proposal: { id: "prop-1", codigo: "PROP-1" }, faltando: [] } });
    const f = fluxo({ chave: { verbo: "proposal.create", valor: "msg-7" } });
    await salvarParcial(d, f, { compradores: [{ nome: "Maria Teste" }] }, { idempotencyKey: "msg-9" });
    expect(d.acao.mock.calls[0]![2]).toBe("msg-7");
  });

  it("chave guardada de OUTRO verbo não é reaproveitada", async () => {
    const d = deps({ status: 201, body: { proposal: { id: "prop-1" }, faltando: [] } });
    const f = fluxo({ chave: { verbo: "proposal.update", valor: "msg-3" } });
    await salvarParcial(d, f, { compradores: [{ nome: "Maria Teste" }] }, { idempotencyKey: "msg-9" });
    expect(d.acao.mock.calls[0]![2]).toBe("msg-9");
  });

  it("403 que não é o gate da flag é falta de permissão, sem rebaixar para o v1", async () => {
    const d = deps({ status: 403, body: { error: "politica_nao_concede" } });
    const r = await salvarParcial(d, fluxo(), { observacoes: "x" }, { idempotencyKey: "m1" });
    expect(r).toMatchObject({ ok: false, erro: "sem_permissao", fluxo: null });
  });

  it("403 fluxo_desligado rebaixa para o v1 no mesmo turno, sem erro para o corretor", async () => {
    const d = deps({ status: 403, body: { error: "fluxo_desligado" } });
    const r = await salvarParcial(d, fluxo(), { observacoes: "x" }, { idempotencyKey: "m1" });
    expect(r).toMatchObject({ ok: false, erro: "fluxo_desligado" });
    if (r.ok) return;
    expect(r.fluxo).toMatchObject({ kind: "proposta", etapa: "coleta", natureza: "venda" });
    expect(textoDoParcial(r, {})).toBe("");
  });

  it("404 no update: não encontrei, fluxo encerrado", async () => {
    const d = deps({ status: 404, body: { error: "Not Found" } });
    const f = fluxo({ proposalId: "prop-x" });
    const r = await salvarParcial(d, f, { negociacao: { valor: 500000 } }, { idempotencyKey: "m1" });
    expect(r).toMatchObject({ ok: false, erro: "nao_encontrada", fluxo: null });
  });
});

describe("salvarParcial: create", () => {
  it("o create não leva canal, mesmo que o patch traga um (D4: o rascunho nasce sem canal)", async () => {
    const d = deps({ status: 201, body: { proposal: { id: "prop-1", codigo: "PROP-2026-1" }, faltando: [], testemunhasSemeadas: 2 } });
    const patch = { compradores: [{ nome: "Maria Teste" }], canal: "whatsapp" } as Parameters<typeof salvarParcial>[2];
    const r = await salvarParcial(d, fluxo(), patch, { idempotencyKey: "m1" });
    const [verbo, args, chave] = d.acao.mock.calls[0]!;
    expect(verbo).toBe("proposal.create");
    expect(args).not.toHaveProperty("canal");
    expect(args).not.toHaveProperty("tipo_assinatura");
    expect(args.schemaType).toBe("compra_venda_v1");
    expect(chave).toBe("m1");
    expect(r).toMatchObject({ ok: true, proposalId: "prop-1", codigo: "PROP-2026-1", criou: true, testemunhasSemeadas: 2 });
  });

  it("o faltando devolvido é o do servidor, item por item", async () => {
    const doServidor = [pend("comprador.cpf"), { signatario: null, campo: "corretor.creci", motivo: "obrigatorio_da_org" } as Pendencia];
    const d = deps({ status: 201, body: { proposal: { id: "prop-1" }, faltando: doServidor } });
    const r = await salvarParcial(d, fluxo(), { compradores: [{ nome: "Maria Teste" }] }, { idempotencyKey: "m1" });
    if (!r.ok) throw new Error("esperava ok");
    expect(r.faltando).toEqual(doServidor);
  });

  it("'anotei' só depois do 201, e o fluxo passa a apontar para o rascunho sem chave presa", async () => {
    const d = deps({ status: 201, body: { proposal: { id: "prop-1", codigo: "PROP-2026-1" }, faltando: [] } });
    const r = await salvarParcial(d, fluxo({ chave: { verbo: "proposal.create", valor: "msg-7" } }), { compradores: [{ nome: "Maria Teste" }] }, { idempotencyKey: "m1" });
    if (!r.ok) throw new Error("esperava ok");
    expect(textoDoParcial(r, {})).toMatch(/anotei/i);
    expect(r.fluxo).toMatchObject({ kind: "proposta_v2", proposalId: "prop-1" });
    expect(r.fluxo && "chave" in r.fluxo ? r.fluxo.chave : undefined).toBeUndefined();
  });

  it("201 sem id utilizável: não afirma que gravou", async () => {
    const d = deps({ status: 201, body: {} });
    const r = await salvarParcial(d, fluxo(), { compradores: [{ nome: "Maria Teste" }] }, { idempotencyKey: "m1" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(textoDoParcial(r, {}).toLowerCase()).not.toContain("anotei");
  });

  it("sem modelo ativo: grava e avisa, sem PDF", async () => {
    const d = deps({ status: 201, body: { proposal: { id: "prop-1", codigo: "P-1" }, pdfIndisponivel: "sem_modelo", faltando: [] } });
    const r = await salvarParcial(d, fluxo(), { compradores: [{ nome: "Maria Teste" }] }, { idempotencyKey: "m1" });
    if (!r.ok) throw new Error("esperava ok");
    expect(r.pdfIndisponivel).toBe("sem_modelo");
  });
});

describe("salvarParcial: update", () => {
  it("dois compradores viram duas partes no update, por posição", async () => {
    const d = deps({ status: 200, body: { proposta: { id: "prop-1" }, pdf: null, faltando: [pend("comprador.cpf", 2)] } });
    const f = fluxo({ proposalId: "prop-1" });
    const r = await salvarParcial(
      d,
      f,
      { compradores: [{ nome: "Maria Teste", cpf: CPF }, { nome: "João Teste" }], negociacao: { valor: 520000 } },
      { idempotencyKey: "m2" }
    );
    const [verbo, args] = d.acao.mock.calls[0]!;
    expect(verbo).toBe("proposal.update");
    expect(args.proposta_id).toBe("prop-1");
    expect(args.compradores).toHaveLength(2);
    expect((args.compradores as Array<{ nome: string }>).map((c) => c.nome)).toEqual(["Maria Teste", "João Teste"]);
    expect(args).not.toHaveProperty("canal");
    expect(args).not.toHaveProperty("schemaType"); // nunca muda depois do create
    expect(r).toMatchObject({ ok: true, proposalId: "prop-1", criou: false });
    if (r.ok) expect(r.faltando).toEqual([pend("comprador.cpf", 2)]);
  });

  it("troca de pessoa só com substituir:true e nome novo (R38): o patch passa como veio", async () => {
    const d = deps({ status: 200, body: { proposta: { id: "prop-1" }, faltando: [] } });
    const f = fluxo({ proposalId: "prop-1" });
    await salvarParcial(d, f, { compradores: [{ nome: "Pedro Novo", substituir: true }] }, { idempotencyKey: "m3" });
    expect((d.acao.mock.calls[0]![1].compradores as Array<Record<string, unknown>>)[0]).toEqual({ nome: "Pedro Novo", substituir: true });
  });

  it("409 edicao_pela_tela encerra o fluxo e manda ajustar pela tela", async () => {
    const d = deps({ status: 409, body: { error: "edicao_pela_tela" } });
    const f = fluxo({ proposalId: "prop-1" });
    const r = await salvarParcial(d, f, { negociacao: { valor: 1 } }, { idempotencyKey: "m1" });
    expect(r).toMatchObject({ ok: false, erro: "edicao_pela_tela", fluxo: null });
    if (r.ok) return;
    const texto = textoDoParcial(r, { codigo: "PROP-2026-1" });
    expect(texto).toContain("PROP-2026-1");
    expect(texto).toMatch(/tela/);
    expect(texto.toLowerCase()).not.toContain("anotei");
  });

  it("409 edicao_pela_tela repassa o link quando o servidor manda um", async () => {
    const d = deps({ status: 409, body: { error: "edicao_pela_tela", link: "https://app.exemplo/propostas/prop-1" } });
    const r = await salvarParcial(d, fluxo({ proposalId: "prop-1" }), { negociacao: { valor: 1 } }, { idempotencyKey: "m1" });
    if (r.ok) throw new Error("esperava recusa");
    expect(r.link).toBe("https://app.exemplo/propostas/prop-1");
    expect(textoDoParcial(r, {})).toContain("https://app.exemplo/propostas/prop-1");
  });

  it("409 documento_proprio traz o link do Doc e o fluxo fica aberto (o corretor decide regerar)", async () => {
    const link = "https://docs.google.com/document/d/abc/edit";
    const d = deps({ status: 409, body: { error: "documento_proprio", link } });
    const f = fluxo({ proposalId: "prop-1" });
    const r = await salvarParcial(d, f, { negociacao: { valor: 1 } }, { idempotencyKey: "m1" });
    expect(r).toMatchObject({ ok: false, erro: "documento_proprio", link });
    if (r.ok) return;
    expect(r.fluxo).toMatchObject({ kind: "proposta_v2", proposalId: "prop-1" });
    expect(textoDoParcial(r, {})).toContain(link);
  });

  it("regerar_documento:true vai no patch quando o corretor autorizou", async () => {
    const d = deps({ status: 200, body: { proposta: { id: "prop-1" }, faltando: [], documento: { descartado: true } } });
    const r = await salvarParcial(d, fluxo({ proposalId: "prop-1" }), { negociacao: { valor: 1 }, regerar_documento: true }, { idempotencyKey: "m1" });
    expect(d.acao.mock.calls[0]![1].regerar_documento).toBe(true);
    if (r.ok) expect(r.documento).toEqual({ descartado: true });
  });

  it("409 nao_editavel, envio_em_andamento e signatarios_duplicados têm resposta própria", async () => {
    const f = fluxo({ proposalId: "prop-1" });
    const naoEditavel = await salvarParcial(deps({ status: 409, body: { error: "nao_editavel", estado: "enviada" } }), f, { observacoes: "x" }, { idempotencyKey: "m1" });
    expect(naoEditavel).toMatchObject({ ok: false, erro: "nao_editavel", fluxo: null });
    const emEnvio = await salvarParcial(deps({ status: 409, body: { error: "envio_em_andamento", message: "x" } }), f, { observacoes: "x" }, { idempotencyKey: "m1" });
    expect(emEnvio).toMatchObject({ ok: false, erro: "envio_em_andamento" });
    const dup = await salvarParcial(deps({ status: 409, body: { error: "signatarios_duplicados" } }), f, { observacoes: "x" }, { idempotencyKey: "m1" });
    expect(dup).toMatchObject({ ok: false, erro: "signatarios_duplicados" });
    if (!dup.ok) expect(dup.fluxo).toMatchObject({ kind: "proposta_v2", proposalId: "prop-1" });
  });

  it("422 do update mostra a frase do servidor e não diz 'anotei'", async () => {
    const d = deps({ status: 422, body: { error: "dados_invalidos", message: "Preciso do nome do comprador 2 para incluir na proposta." } });
    const r = await salvarParcial(d, fluxo({ proposalId: "prop-1" }), { compradores: [{}, { cpf: CPF }] }, { idempotencyKey: "m1" });
    if (r.ok) throw new Error("esperava recusa");
    const texto = textoDoParcial(r, {});
    expect(texto).toContain("Preciso do nome do comprador 2");
    expect(texto.toLowerCase()).not.toContain("anotei");
  });
});
