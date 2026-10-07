import { describe, expect, it, vi } from "vitest";
import { conduzirFluxo, retomarEnvio, type ContextoDoTurno, type DepsDoFluxo, type Fluxo } from "../fluxos";

const ctx = (texto: string, messageId = texto): ContextoDoTurno => ({
  texto, messageId, policy: ["proposal.create", "proposal.send"], agora: 1_000_000,
});
const methods = [{ valor: "email", rotulo: "E-mail" }, { valor: "whatsapp", rotulo: "WhatsApp" }];
const options = { status: 200, body: { metodos: methods, signatarios: [{ nome: "Pessoa Teste", papel: "proponente" }] } };
const deps = (acao: DepsDoFluxo["acao"]): DepsDoFluxo => ({
  acao, extrairProposta: async () => null, extrairCampos: async () => null,
});
const draft = (estado = "Rascunho") => ({ id: "p1", codigo: "PROP-2026-0001", titulo: "Proposta — Pessoa Teste", estado });
const resumed = (): Extract<Fluxo, { kind: "proposta" }> => ({
  kind: "proposta", etapa: "ajustes", dados: {}, propostaId: "p1", codigo: "PROP-2026-0001",
  metodo: methods[1], atualizadoEm: 1_000_000,
});

describe("continuidade da proposta entre mensagens", () => {
  it("mantém envio incerto antes de qualquer seleção ou correção", async () => {
    const acao = vi.fn<DepsDoFluxo["acao"]>(async (verb) => verb === "proposal.list" ? { status: 200, body: { items: [draft(), { ...draft(), id: "p2" }] } } : options);
    const step = await retomarEnvio(ctx("Envie a proposta. CPF do proponente é 529.982.247-25"), deps(acao), { ...resumed(), chave: { verbo: "proposal.send", valor: "old-send" } });
    expect(step.fluxo).toMatchObject({ propostaId: "p1", chave: { verbo: "proposal.send", valor: "old-send" } });
    expect(step.fluxo).not.toMatchObject({ etapa: "selecao_envio" });
  });

  it("não apaga a identidade citada depois da correção de CPF", async () => {
    const step = await retomarEnvio(ctx("CPF do proponente é 529.982.247-25. Envie a proposta da Maria"), deps(async () => ({ status: 200, body: { items: [draft()] } })));
    expect(step.fluxo).toMatchObject({ etapa: "selecao_envio" });
    expect(step.fluxo).not.toMatchObject({ propostaId: "p1" });
  });

  it.each(["Vendedor: CPF", "Proprietária: CPF", "Testemunha: CPF"])("não atribui ao proponente o documento de %s", async (papel) => {
    const step = await retomarEnvio(ctx(`Envie a proposta PROP-2026-0001. ${papel} 529.982.247-25`), deps(async () => ({ status: 200, body: { items: [draft()] } })));
    expect(step.fluxo).not.toMatchObject({ etapa: "revisao_ajuste" });
  });

  it("resolve envio incerto antes de corrigir CPF", async () => {
    const step = await retomarEnvio(ctx("Envie a proposta PROP-2026-0001. CPF do proponente é 529.982.247-25"), deps(async (verb) => verb === "proposal.list" ? { status: 200, body: { items: [draft()] } } : options), {
      ...resumed(), chave: { verbo: "proposal.send", valor: "old-send" },
    });
    expect(step.fluxo).toMatchObject({ chave: { verbo: "proposal.send", valor: "old-send" } });
    expect(step.fluxo).not.toMatchObject({ etapa: "revisao_ajuste" });
  });

  it.each([1, 2])("preserva correção do pedido sem confundir CPF com citação (%i propostas)", async (count) => {
    const acao = vi.fn<DepsDoFluxo["acao"]>(async (verb) => verb === "proposal.list" ? { status: 200, body: { items: [draft(), ...(count === 2 ? [{ ...draft(), id: "p2", codigo: "PROP-2026-0002" }] : [])] } } : options);
    let step = await retomarEnvio(ctx("Envie a proposta. CPF do proponente é 529.982.247-25"), deps(acao));
    if (count === 2) {
      expect(step.fluxo).toMatchObject({ etapa: "selecao_envio" });
      step = await conduzirFluxo(step.fluxo!, ctx("1"), deps(acao)) as typeof step;
    }
    expect(step.fluxo).toMatchObject({ etapa: "revisao_ajuste", propostaId: "p1", dados: { proponente: { cpf: "52998224725" } } });
    expect(acao.mock.calls.some(([verb]) => verb === "proposal.update")).toBe(false);
  });

  it("usa o CPF do pedido inicial após confirmação, sem exigir redigitação", async () => {
    const acao = vi.fn<DepsDoFluxo["acao"]>(async (verb) => {
      if (verb === "proposal.list") return { status: 200, body: { items: [draft()] } };
      if (verb === "proposal.update") return { status: 200, body: { pdf: { link: "https://imobpro.ia.br/pdf/1" } } };
      return options;
    });
    let step = await retomarEnvio(ctx("Envia a proposta da Pessoa Teste. CPF dela é 529.982.247-25"), deps(acao));
    expect(step.fluxo).toMatchObject({ etapa: "revisao_ajuste", ajustePendente: true });
    expect(acao.mock.calls.map(([verb]) => verb)).toEqual(["proposal.list"]);
    step = await conduzirFluxo(step.fluxo!, ctx("sim", "confirmacao-cpf"), deps(acao)) as typeof step;
    expect(acao).toHaveBeenLastCalledWith("proposal.update", { proposta_id: "p1", proponente: { cpf: "52998224725" } }, "confirmacao-cpf");
    expect(step.evento).toBe("proposta_ajustada");
  });

  it("não aplica CPF de vendedor ao proponente ao retomar", async () => {
    const acao = vi.fn<DepsDoFluxo["acao"]>(async (verb) => verb === "proposal.list"
      ? { status: 200, body: { items: [draft()] } } : options);
    const step = await retomarEnvio(ctx("Envia a proposta da Pessoa Teste. CPF do vendedor é 529.982.247-25"), deps(acao));
    expect(step.fluxo).not.toMatchObject({ etapa: "revisao_ajuste" });
    expect(acao.mock.calls.some(([verb]) => verb === "proposal.update")).toBe(false);
  });

  it("reutiliza método válido depois do ajuste, pedindo somente confirmação final", async () => {
    const acao = vi.fn<DepsDoFluxo["acao"]>(async (verb) => verb === "proposal.send"
      ? { status: 200, body: {} } : options);
    let step = await conduzirFluxo(resumed(), ctx("Pode mandar"), deps(acao));
    expect(step.fluxo).toMatchObject({ etapa: "envio", metodo: { valor: "whatsapp" } });
    expect(acao.mock.calls.some(([verb]) => verb === "proposal.send")).toBe(false);
    step = await conduzirFluxo(step.fluxo!, ctx("sim", "confirmacao-envio"), deps(acao));
    expect(step.evento).toBe("proposta_enviada");
    expect(acao).toHaveBeenLastCalledWith("proposal.send", { proposta_id: "p1", metodo: "whatsapp" }, "confirmacao-envio");
  });

  it("pede nova escolha quando o método anterior deixa de ser permitido", async () => {
    const step = await conduzirFluxo(resumed(), ctx("Pode mandar"), deps(async () => ({
      ...options, body: { ...options.body, metodos: [methods[0], { valor: "selfie", rotulo: "Selfie" }] },
    })));
    expect(step.fluxo).toMatchObject({ etapa: "metodo" });
    if (step.fluxo?.kind === "proposta") expect(step.fluxo.metodo).toBeUndefined();
  });

  it("preserva proposta e método após falha de documento, exigindo nova confirmação antes de tentar", async () => {
    const acao = vi.fn<DepsDoFluxo["acao"]>(async (verb) => verb === "proposal.send"
      ? { status: 422, body: { error: "documento_indisponivel", motivo: "google_doc_unavailable" } } : options);
    const f = { ...resumed(), etapa: "envio" } as Fluxo;
    let step = await conduzirFluxo(f, ctx("sim", "envio-falhou"), deps(acao));
    expect(step.fluxo).toMatchObject({ propostaId: "p1", etapa: "ajustes", metodo: { valor: "whatsapp" } });
    expect(step.reply).toContain("Google");
    expect(step.reply).not.toContain("Confira o rascunho no sistema");
    step = await conduzirFluxo(step.fluxo!, ctx("sim", "sim-apos-falha"), deps(acao));
    expect(step.fluxo).toMatchObject({ etapa: "envio" });
    expect(acao.mock.calls.filter(([verb]) => verb === "proposal.send")).toHaveLength(1);
    step = await conduzirFluxo(step.fluxo!, ctx("sim", "novo-envio"), deps(acao));
    expect(acao).toHaveBeenLastCalledWith("proposal.send", { proposta_id: "p1", metodo: "whatsapp" }, "novo-envio");
  });

  it.each(["Falha no envio", "falha_envio"])("retoma %s sem sugerir nova proposta", async (estado) => {
    const step = await retomarEnvio(ctx("Envie a proposta PROP-2026-0001"), deps(async (verb) =>
      verb === "proposal.list" ? { status: 200, body: { items: [draft(estado)] } } : options));
    expect(step.fluxo).toMatchObject({ propostaId: "p1", etapa: "metodo" });
    expect(step.evento).not.toBe("envio_sem_rascunho");
  });
});
