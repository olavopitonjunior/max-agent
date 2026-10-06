import { describe, it, expect } from "vitest";

/**
 * A conversa real de 2026-10-06: "Pode gerar uma proposta pra mim?" → "venda ou
 * locação?" → "Venda" → cinco turns de coleta → "proposta criada". Nada foi
 * criado. Três defeitos, três travas — e as frases do Max abaixo são as que ele
 * mandou de verdade.
 */

const { ferramentasDoTurno, pedidoEmAberto } = await import("../tools");
const { argsDaCriacao } = await import("../despachante");
const { afirmaCriacao, travarCriacaoFalsa, TEXTO_NADA_CRIADO, TEXTO_NADA_CRIADO_SEM_CRIACAO } =
  await import("../compose");

const olavo = { orgId: "org1", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };
const corretor = {
  orgId: "org1", orgName: "FINCasa", kind: "broker" as const, splitRecipientId: "sr1", label: "Wesley",
};
const TUDO = ["deal.list", "deal.pending", "proposal.list", "form.create", "proposal.create"] as const;
const nomes = (r: { entradas: { nome: string }[] }) => r.entradas.map((e) => e.nome);

describe("o pedido de criação atravessa a resposta de desambiguação", () => {
  const historico = [
    { role: "user" as const, content: "Pode gerar uma proposta pra mim?" },
    { role: "assistant" as const, content: "Posso sim, Olavo. É proposta de venda ou de locação?" },
  ];

  it("pedidoEmAberto devolve o pedido que o Max deixou com uma pergunta", () => {
    expect(pedidoEmAberto(historico)).toBe("Pode gerar uma proposta pra mim?");
    expect(pedidoEmAberto([])).toBeNull();
  });

  it("sem pergunta do Max no fim, o pedido antigo não reabre a escrita", () => {
    expect(
      pedidoEmAberto([
        { role: "user", content: "gera uma proposta" },
        { role: "assistant", content: "Pronto, segue o link." },
      ])
    ).toBeNull();
  });

  it("'Venda' sozinho não oferece a criação — era o defeito", () => {
    expect(nomes(ferramentasDoTurno({ policy: [...TUDO], texto: "Venda", identity: olavo }))).not.toContain(
      "propor_criacao"
    );
  });

  it("'Venda' depois do pedido oferece a criação", () => {
    const r = ferramentasDoTurno({
      policy: [...TUDO],
      texto: "Venda",
      identity: olavo,
      textoAnterior: pedidoEmAberto(historico),
    });
    expect(nomes(r)).toContain("propor_criacao");
  });

  it("o pedido em aberto NÃO fura política nem identidade", () => {
    const anterior = pedidoEmAberto(historico);
    expect(
      nomes(ferramentasDoTurno({ policy: ["deal.list"], texto: "Venda", identity: olavo, textoAnterior: anterior }))
    ).not.toContain("propor_criacao");
    expect(
      nomes(ferramentasDoTurno({ policy: [...TUDO], texto: "Venda", identity: corretor, textoAnterior: anterior }))
    ).not.toContain("propor_criacao");
  });
});

describe("o cliente nunca é quem fala", () => {
  it("nome igual ao do falante some (o nano punha 'Olavo' como cliente)", () => {
    expect(argsDaCriacao({ tipo: "proposta", nome_cliente: "Olavo" }, "Olavo Piton")?.nomeCliente).toBeUndefined();
    expect(argsDaCriacao({ tipo: "proposta", nome_cliente: "olávo piton" }, "Olavo Piton")?.nomeCliente).toBeUndefined();
  });

  it("o cliente citado passa — inclusive o xará", () => {
    expect(
      argsDaCriacao({ tipo: "proposta", nome_cliente: "Letícia Gonçalves Nogueira" }, "Olavo")?.nomeCliente
    ).toBe("Letícia Gonçalves Nogueira");
    expect(argsDaCriacao({ tipo: "proposta", nome_cliente: "Maria Souza" }, "Maria Silva")?.nomeCliente).toBe(
      "Maria Souza"
    );
  });

  it("sem falante conhecido, nada muda", () => {
    expect(argsDaCriacao({ tipo: "proposta", nome_cliente: "Olavo" })?.nomeCliente).toBe("Olavo");
  });
});

describe("afirmação de criação sem escrita", () => {
  it("pega as frases de conclusão (a primeira é a que o Max mandou)", () => {
    expect(afirmaCriacao("Ok, proposta de venda rascunho criada “como está” para análise do vendedor/equipe.")).toBe(true);
    expect(afirmaCriacao("Pronto, criei o formulário para você.")).toBe(true);
    expect(afirmaCriacao("Gerei a proposta.")).toBe(true);
    expect(afirmaCriacao("Sua proposta já foi criada.")).toBe(true);
  });

  // Achado do code review do #55: o Max EXPLICA o processo, e explicação não é
  // afirmação. Trocar estas por "não criei nada" seria a mentira do outro lado.
  it.each([
    "Posso sim, Olavo. É proposta de venda ou de locação?",
    "A proposta 2 foi enviada e aguarda assinatura.",
    "Para criar, me diga se é venda ou locação.",
    "O link de assinatura é gerado quando a proposta é enviada.",
    "A proposta é criada em rascunho e você preenche os valores na tela.",
    "O negócio é criado quando a proposta é aceita.",
    "O formulário é gerado pelo seu corretor na plataforma.",
    "A ficha cadastral precisa ser criada pela imobiliária.",
    "Não consigo: a proposta não pode ser criada sem permissão.",
    "É o link que te enviei na mensagem anterior.",
    "Mandei a lista acima, item 2.",
    "Ainda não criei nada por aqui.",
  ])("não pega explicação, promessa, status nem negação: %s", (texto) => {
    expect(afirmaCriacao(texto)).toBe(false);
  });

  it("troca pelo texto honesto quando o turn não leu dados", () => {
    expect(travarCriacaoFalsa("Ok, proposta de venda rascunho criada.", { houveLeitura: false, podeCriar: true })).toEqual(
      { texto: TEXTO_NADA_CRIADO, travou: true }
    );
  });

  it("quem não pode criar não é mandado pedir a criação", () => {
    expect(travarCriacaoFalsa("Gerei a proposta.", { houveLeitura: false, podeCriar: false }).texto).toBe(
      TEXTO_NADA_CRIADO_SEM_CRIACAO
    );
  });

  it("com leitura no turn, não troca — pode ser data de criação de item listado", () => {
    const texto = "1. Proposta Rua A — criada em 05/10.";
    expect(travarCriacaoFalsa(texto, { houveLeitura: true, podeCriar: true })).toEqual({ texto, travou: false });
  });
});
