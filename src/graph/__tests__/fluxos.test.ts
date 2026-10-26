import { describe, it, expect, vi } from "vitest";

/**
 * Os dois fluxos de criação (decisão do Olavo, 06/10): proposta completa pelo
 * WhatsApp × formulário de negócio pelo popup. O que está sob teste é a
 * MÁQUINA DE ESTADO — o servidor e o extrator são dublês.
 */

const F = await import("../fluxos");
type Fluxo = import("../fluxos").Fluxo;

const TUDO = ["proposal.create", "proposal.send", "form.create"] as const;
const agora = 1_000_000;

function deps(over: Partial<import("../fluxos").DepsDoFluxo> = {}) {
  return {
    acao: vi.fn().mockResolvedValue(null),
    extrairProposta: vi.fn().mockResolvedValue({}),
    extrairCampos: vi.fn().mockResolvedValue({}),
    ...over,
  };
}

const ctx = (texto: string, extra: Partial<import("../fluxos").ContextoDoTurno> = {}) => ({
  texto,
  messageId: `m-${texto.slice(0, 8)}`,
  policy: [...TUDO],
  agora,
  ...extra,
});

const DADOS_OK: import("../fluxos").DadosDaProposta = {
  proponente: { nome: "Letícia Gonçalves Nogueira", telefone: "11999990000", cpf: "12345678909" },
  imovel: { endereco: "Rua Senador Godoi, 606", bairro: "Vila São Geraldo" },
  valor: 1_500_000,
  pagamento: { forma: "200 mil financiado, restante à vista" },
};

describe("entrada", () => {
  it.each([
    "Crie uma nova proposta da Letícia",
    "Faz uma proposta do João",
    "Cria uma proposta da Letícia",
    "Monta a proposta do Carlos pro apto 52",
    "Crie uma proposta de compra do Pedro",
    "Max, crie proposta da Ana",
  ])("não bloqueia criação de proposta para uma pessoa: %s", async (pedido) => {
    const p = await F.iniciarFluxo({ tipo: "proposta", pedido, policy: [...TUDO], agora }, deps());
    expect(p.fluxo?.kind).toBe("escolha");
  });
  it.each([
    "Max, tranforme a proposta da Letícia em negócio e gere o link do formulário",
    "Aproveite a proposta da Letícia e gere um link",
    "Gere um formulário a partir de PROP-2026-0001",
    "Gere um formulário com os dados dessa proposta",
  ])("barra criação avulsa mesmo com classificação errada: %s", async (pedido) => {
    const d = deps();
    const p = await F.iniciarFluxo({ tipo: "venda", pedido, policy: [...TUDO], agora }, d);
    expect(p.fluxo).toBeNull();
    expect(p.evento).toBe("criacao_referencia_existente");
    expect(d.acao).not.toHaveBeenCalled();
  });
  it("continua permitindo um formulário novo sem referência existente", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 200, body: { campos: [] } }) });
    const p = await F.iniciarFluxo({ tipo: "venda", pedido: "Crie um formulário novo de venda", policy: [...TUDO], agora }, d);
    expect(p.fluxo?.kind).toBe("negocio");
  });
  it("pedido de proposta pergunta proposta × negócio", async () => {
    const p = await F.iniciarFluxo({ tipo: "proposta", policy: [...TUDO], agora }, deps());
    expect(p.reply).toBe(F.TEXTO_ESCOLHA);
    expect(p.fluxo?.kind).toBe("escolha");
  });

  it("sem form.create, proposta vai direto (não oferece o que não pode)", async () => {
    const p = await F.iniciarFluxo({ tipo: "proposta", policy: ["proposal.create"], agora }, deps());
    expect(p.fluxo?.kind).toBe("proposta");
    expect(p.reply).toContain("venda");
  });

  it("sem nenhuma capability, recusa sem fluxo", async () => {
    const p = await F.iniciarFluxo({ tipo: "proposta", policy: [], agora }, deps());
    expect(p.fluxo).toBeNull();
  });

  it("'1' escolhe proposta; '2' escolhe negócio", () => {
    expect(F.lerEscolha("1")).toBe("proposta");
    expect(F.lerEscolha("proposta rápida")).toBe("proposta");
    expect(F.lerEscolha("2")).toBe("negocio");
    expect(F.lerEscolha("formulário de negócio")).toBe("negocio");
    expect(F.lerEscolha("sei lá")).toBeNull();
  });
});

describe("fluxo de NEGÓCIO", () => {
  const OPCOES = {
    status: 200,
    body: {
      campos: [
        { chave: "titleParts.endereco", rotulo: "Endereço", obrigatorio: true },
        { chave: "title", rotulo: "Título livre", obrigatorio: false },
      ],
      gerente: { obrigatorio: false },
    },
  };

  it("escolha → venda → só os obrigatórios → resumo → SIM → link", async () => {
    const d = deps({
      acao: vi.fn().mockImplementation(async (verb: string) =>
        verb === "form.options"
          ? OPCOES
          : { status: 201, body: { formulario: { id: "f1", link: "https://imobpro.ia.br/f/tok/x" } } }
      ),
      extrairCampos: vi.fn().mockResolvedValue({ "titleParts.endereco": "Rua A, 10" }),
    });
    let f: Fluxo | null = { kind: "escolha", atualizadoEm: agora };
    let p = await F.conduzirFluxo(f, ctx("2"), d);
    expect(p.reply).toContain("venda");
    f = p.fluxo!;
    p = await F.conduzirFluxo(f, ctx("venda"), d);
    expect(p.reply).toContain("Endereço");
    expect(p.reply).not.toContain("Título livre");
    p = await F.conduzirFluxo(p.fluxo!, ctx("Rua A, 10"), d);
    expect(p.reply).toContain("Rua A, 10");
    expect(p.reply).toContain("SIM");
    p = await F.conduzirFluxo(p.fluxo!, ctx("sim", { messageId: "msg-sim" }), d);
    expect(p.reply).toContain("https://imobpro.ia.br/f/tok/x");
    expect(p.fluxo).toBeNull();
    expect(d.acao).toHaveBeenCalledWith(
      "form.create",
      { tipo: "venda", campos: { titleParts: { endereco: "Rua A, 10" } } },
      "msg-sim"
    );
  });

  it("B4 — duplicado recente pergunta, e o SIM seguinte FORÇA (não entra em laço)", async () => {
    const acao = vi
      .fn()
      .mockResolvedValueOnce({ status: 409, body: { error: "duplicate_recent" } })
      .mockResolvedValueOnce({ status: 201, body: { formulario: { link: "https://imobpro.ia.br/f/t2/x" } } });
    const d = deps({ acao });
    const f: Fluxo = { kind: "negocio", etapa: "revisao", tipo: "venda", campos: [], valores: {}, atualizadoEm: agora };
    let p = await F.conduzirFluxo(f, ctx("sim", { messageId: "s1" }), d);
    expect(p.reply).toContain("Já existe");
    p = await F.conduzirFluxo(p.fluxo!, ctx("sim", { messageId: "s2" }), d);
    expect(acao.mock.calls[1]![1]).toMatchObject({ campos: { force: true } });
    expect(acao.mock.calls[1]![2]).toBe("s2");
    expect(p.reply).toContain("https://imobpro.ia.br/f/t2/x");
  });

  it("opção fora da lista do popup não é aceita", async () => {
    const d = deps({ extrairCampos: vi.fn().mockResolvedValue({ finalidade: "industrial" }) });
    const f: Fluxo = {
      kind: "negocio", etapa: "campos", tipo: "locacao",
      campos: [{ chave: "finalidade", rotulo: "Finalidade", obrigatorio: true, opcoes: ["residencial", "comercial"] }],
      valores: {}, atualizadoEm: agora,
    };
    const p = await F.conduzirFluxo(f, ctx("industrial"), d);
    expect(p.liberar).toBe(true);
  });

  it("gerente obrigatório sem padrão: diz o caminho, não inventa gerente", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 200, body: { campos: [], gerente: { obrigatorio: true } } }) });
    const p = await F.iniciarFluxo({ tipo: "venda", policy: [...TUDO], agora }, d);
    expect(p.reply).toContain("gerente");
    expect(p.fluxo).toBeNull();
  });
});

describe("fluxo de PROPOSTA", () => {
  it("coleta em várias mensagens, só pede o que falta, e o resumo é do código", async () => {
    const d = deps({
      extrairProposta: vi
        .fn()
        .mockResolvedValueOnce({ proponente: { nome: "Letícia Gonçalves Nogueira" }, valor: 1_500_000 })
        .mockResolvedValueOnce({ imovel: { endereco: "Rua Senador Godoi, 606" }, proponente: { telefone: "11999990000" } }),
    });
    let p = await F.conduzirFluxo({ kind: "proposta", etapa: "natureza", dados: {}, atualizadoEm: agora }, ctx("venda"), d);
    expect(p.reply).toContain("Comprador");
    p = await F.conduzirFluxo(p.fluxo!, ctx("compradora Letícia, 1,5 milhão"), d);
    expect(p.reply).toContain("endereço do imóvel");
    expect(p.reply).toContain("telefone do comprador");
    expect(p.reply).not.toContain("valor");
    p = await F.conduzirFluxo(p.fluxo!, ctx("Rua Senador Godoi 606, tel 11 99999-0000"), d);
    expect(p.fluxo).toMatchObject({ kind: "proposta", etapa: "revisao" });
    expect(p.reply).toContain("R$");
    expect(p.reply).toContain("Está correto?");
  });

  it("SIM gera o rascunho com a messageId do sim e devolve o link do PDF", async () => {
    const d = deps({
      acao: vi.fn().mockResolvedValue({
        status: 201,
        body: { proposal: { id: "p1", codigo: "P-12" }, pdf: { link: "https://imobpro.ia.br/api/public/proposal-pdf/x" } },
      }),
    });
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS_OK, atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("sim", { messageId: "msg-sim" }), d);
    expect(d.acao).toHaveBeenCalledWith(
      "proposal.create",
      expect.objectContaining({ schemaType: "compra_venda_v1", valor: 1_500_000, canal: "whatsapp" }),
      "msg-sim"
    );
    expect(p.reply).toContain("P-12");
    expect(p.reply).toContain("https://imobpro.ia.br/api/public/proposal-pdf/x");
    expect(p.fluxo).toMatchObject({ etapa: "ajustes", propostaId: "p1" });
  });

  it("B2 — sem resposta no SIM: não afirma nada, e o SIM repetido reusa a MESMA chave (não duplica)", async () => {
    const acao = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 201, body: { proposal: { id: "p1", codigo: "P-1" } } });
    const d = deps({ acao });
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS_OK, atualizadoEm: agora };
    const p1 = await F.conduzirFluxo(f, ctx("sim", { messageId: "sim-1" }), d);
    expect(p1.reply).toBe(F.TEXTO_ESCRITA_INCERTA);
    expect(p1.reply).not.toContain("nada foi feito");
    const p2 = await F.conduzirFluxo(p1.fluxo!, ctx("sim", { messageId: "sim-2" }), d);
    expect(acao.mock.calls.map((c) => c[2])).toEqual(["sim-1", "sim-1"]);
    expect(p2.reply).toContain("P-1");
  });

  it("B2 — com escrita em aberto, mudar dado é bloqueado até o SIM conferir (não abre 2ª chave)", async () => {
    const acao = vi.fn().mockResolvedValue(null);
    const d = deps({ acao, extrairProposta: vi.fn().mockResolvedValue({ valor: 1_400_000 }) });
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS_OK, atualizadoEm: agora };
    let p = await F.conduzirFluxo(f, ctx("sim", { messageId: "sim-1" }), d);
    p = await F.conduzirFluxo(p.fluxo!, ctx("na verdade 1,4 milhão", { messageId: "x" }), d);
    expect(p.reply).toContain("preciso conferir o pedido anterior");
    expect(d.extrairProposta).not.toHaveBeenCalled();
    await F.conduzirFluxo(p.fluxo!, ctx("sim", { messageId: "sim-3" }), d);
    expect(acao.mock.calls.map((c) => c[2])).toEqual(["sim-1", "sim-1"]);
  });

  it("envio sem resposta + interrupção: a chave do ENVIO sobrevive até o SIM seguinte", async () => {
    const acao = vi.fn().mockImplementation(async (verb: string) =>
      verb === "proposal.options"
        ? { status: 200, body: { metodos: [{ valor: "email", rotulo: "E-mail" }], signatarios: [{ nome: "Letícia Gonçalves Nogueira", papel: "proponente" }] } }
        : null
    );
    const d = deps({ acao });
    const f: Fluxo = {
      kind: "proposta", etapa: "envio", natureza: "venda", dados: DADOS_OK, propostaId: "p1",
      metodo: { valor: "email", rotulo: "E-mail" }, assinantes: [{ nome: "L", papel: "proponente" }], atualizadoEm: agora,
    };
    let p = await F.conduzirFluxo(f, ctx("sim", { messageId: "env-1" }), d);
    expect(p.reply).toBe(F.TEXTO_ESCRITA_INCERTA);
    const rebaixado = F.rebaixarFluxo(p.fluxo)!;
    p = await F.conduzirFluxo(rebaixado, ctx("sim", { messageId: "x" }), d);
    p = await F.conduzirFluxo(p.fluxo!, ctx("sim", { messageId: "env-2" }), d);
    const envios = acao.mock.calls.filter((c) => c[0] === "proposal.send").map((c) => c[2]);
    expect(envios).toEqual(["env-1", "env-1"]);
  });

  it("409 sem o código em_andamento NÃO prende num laço de SIM", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 409, body: { error: "outro" } }) });
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS_OK, atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("sim"), d);
    expect(p.reply).not.toBe(F.TEXTO_ESCRITA_INCERTA);
  });

  it("409 no create (mesma chave em processamento) é incerto: guarda a chave", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 409, body: { error: "em_andamento" } }) });
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS_OK, atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("sim", { messageId: "k1" }), d);
    expect(p.reply).toBe(F.TEXTO_ESCRITA_INCERTA);
    expect(p.fluxo).toMatchObject({ chave: { verbo: "proposal.create", valor: "k1" } });
  });

  it("B1 — ajuste mostra o resumo novo e SÓ atualiza depois do SIM; o PDF novo volta", async () => {
    const d = deps({
      extrairProposta: vi.fn().mockResolvedValue({ valor: 1_400_000 }),
      acao: vi.fn().mockResolvedValue({
        status: 200,
        body: { proposta: { id: "p1" }, pdf: { link: "https://imobpro.ia.br/pdf/2", expiraEm: "2026-10-06T20:00:00Z" } },
      }),
    });
    const f: Fluxo = { kind: "proposta", etapa: "ajustes", natureza: "venda", dados: DADOS_OK, propostaId: "p1", codigo: "P-12", atualizadoEm: agora };
    let p = await F.conduzirFluxo(f, ctx("o valor é 1,4 milhão"), d);
    expect(d.acao).not.toHaveBeenCalled();
    expect(p.reply).toContain("1.400.000");
    expect(p.reply).toContain("Atualizo o rascunho assim?");
    p = await F.conduzirFluxo(p.fluxo!, ctx("sim", { messageId: "sim-aj" }), d);
    expect(d.acao).toHaveBeenCalledWith("proposal.update", expect.objectContaining({ proposta_id: "p1", valor: 1_400_000 }), "sim-aj");
    expect(p.reply).toContain("Atualizei");
    expect(p.reply).toContain("https://imobpro.ia.br/pdf/2");
    // A validade vem do servidor, em horário de Brasília — não é inventada.
    expect(p.reply).toContain("17:00");
  });

  it("B1 — mensagem sem dado nos ajustes é LIBERADA e não escreve nada", async () => {
    const d = deps({ extrairProposta: vi.fn().mockResolvedValue({}) });
    const f: Fluxo = { kind: "proposta", etapa: "ajustes", natureza: "venda", dados: DADOS_OK, propostaId: "p1", atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("qual o status da P-10?"), d);
    expect(p.liberar).toBe(true);
    expect(d.acao).not.toHaveBeenCalled();
  });

  describe("smoke real 26/10 — telefone errado no rascunho", () => {
    const DADOS_JOAO: import("../fluxos").DadosDaProposta = {
      proponente: { nome: "João da Silva", telefone: "2998224725", cpf: "52998224725" },
      imovel: { endereco: "Rua Santo Antão, 560" },
      valor: 1_000_000,
    };
    const rascunho = (extra: Partial<Extract<Fluxo, { kind: "proposta" }>> = {}): Fluxo =>
      ({ kind: "proposta", etapa: "ajustes", natureza: "venda", dados: DADOS_JOAO, propostaId: "p1", codigo: "PROP-2026-0002", atualizadoEm: agora, ...extra }) as Fluxo;

    it("só o telefone certo (11 dígitos sem máscara) depois do rascunho é ajuste de telefone, não proposta_liberada", async () => {
      const d = deps({ extrairProposta: vi.fn().mockResolvedValue({ proponente: { telefone: "11999063228" } }) });
      const p = await F.conduzirFluxo(rascunho(), ctx("11999063228"), d);
      expect(p.liberar).toBeUndefined();
      expect(p.evento).toBe("proposta_revisao_ajuste");
      expect(p.reply).toContain("João da Silva · 11999063228 · CPF 52998224725");
      expect(p.fluxo).toMatchObject({ etapa: "revisao_ajuste", dados: { proponente: { telefone: "11999063228", cpf: "52998224725" } } });
      expect(d.acao).not.toHaveBeenCalled();
    });

    it("'O telefone está errado' (campo sem valor) NÃO vai ao modelo: o fluxo pede o telefone certo e espera", async () => {
      const d = deps();
      const p = await F.conduzirFluxo(rascunho(), ctx("O telefone está errado"), d);
      expect(p.liberar).toBeUndefined();
      expect(p.evento).toBe("ajuste_aguarda_valor");
      expect(p.reply).toContain("telefone");
      expect(p.reply).toMatch(/me (mande|passe|diga)/i);
      expect(p.fluxo).toMatchObject({ etapa: "ajustes", aguardaCampo: { pessoa: "proponente", campo: "telefone" } });
      expect(d.acao).not.toHaveBeenCalled();
    });

    it("com o campo pendente, 'Isso'/'ok' NÃO segue para a assinatura com o telefone velho", async () => {
      const d = deps();
      const f = rascunho({ aguardaCampo: { pessoa: "proponente", campo: "telefone" } });
      for (const t of ["Isso", "ok", "sim"]) {
        const p = await F.conduzirFluxo(f, ctx(t), d);
        expect(p.evento).toBe("ajuste_aguarda_valor");
        expect(p.fluxo).toMatchObject({ etapa: "ajustes", aguardaCampo: { campo: "telefone" } });
      }
      expect(d.acao).not.toHaveBeenCalled();
    });

    it("com o campo pendente, o valor sozinho é aplicado sem depender do extrator, e a pendência sai", async () => {
      const d = deps({ extrairProposta: vi.fn().mockResolvedValue({}) });
      const f = rascunho({ aguardaCampo: { pessoa: "proponente", campo: "telefone" } });
      const p = await F.conduzirFluxo(f, ctx("(11) 99906-3228"), d);
      expect(p.evento).toBe("proposta_revisao_ajuste");
      // Vale o que a pessoa escreveu (regra do conferirDitado), com a máscara dela.
      expect(p.reply).toContain("(11) 99906-3228");
      expect(p.fluxo).toMatchObject({ etapa: "revisao_ajuste", dados: { proponente: { telefone: "(11) 99906-3228" } } });
      expect((p.fluxo as { aguardaCampo?: unknown }).aguardaCampo).toBeUndefined();
    });

    it("com o campo pendente, telefone que passa no DV de CPF é aplicado como telefone (review 26/10)", async () => {
      const d = deps({ extrairProposta: vi.fn().mockResolvedValue({}) });
      const f = rascunho({ aguardaCampo: { pessoa: "proponente", campo: "telefone" } });
      const p = await F.conduzirFluxo(f, ctx("21987654382"), d);
      expect(p.evento).toBe("proposta_revisao_ajuste");
      expect(p.fluxo).toMatchObject({ etapa: "revisao_ajuste", dados: { proponente: { telefone: "21987654382" } } });
    });

    it("pergunta sobre o telefone (sem sinal de correção) continua liberada ao modelo", async () => {
      const d = deps();
      const p = await F.conduzirFluxo(rascunho(), ctx("qual o telefone cadastrado na proposta?"), d);
      expect(p.liberar).toBe(true);
    });
  });

  it("B1 — trocar o comprador NÃO herda CPF e telefone do anterior", () => {
    const m = F.mesclarDados(DADOS_OK, F.sanearDados({ proponente: { nome: "Maria Souza Lima" } }));
    expect(m.proponente).toEqual({ nome: "Maria Souza Lima" });
    // Completar o MESMO comprador continua mesclando.
    const n = F.mesclarDados(DADOS_OK, F.sanearDados({ proponente: { email: "l@x.com" } }));
    expect(n.proponente?.cpf).toBe("12345678909");
    expect(n.proponente?.email).toBe("l@x.com");
  });

  it("OK depois do rascunho → tipos de assinatura liberados → assinantes → SIM envia com o método", async () => {
    const d = deps({
      acao: vi.fn().mockImplementation(async (verb: string) =>
        verb === "proposal.options"
          ? {
              status: 200,
              body: {
                metodos: [
                  { valor: "email", rotulo: "E-mail (token)" },
                  { valor: "whatsapp", rotulo: "WhatsApp (token)" },
                ],
                signatarios: [
                  { nome: "Letícia Gonçalves Nogueira", papel: "proponente" },
                  { nome: "Carlos Souza", papel: "vendedor" },
                ],
              },
            }
          : { status: 200, body: { signatarios: 2 } }
      ),
    });
    let p = await F.conduzirFluxo(
      { kind: "proposta", etapa: "ajustes", natureza: "venda", dados: DADOS_OK, propostaId: "p1", codigo: "P-12", atualizadoEm: agora },
      ctx("ok"),
      d
    );
    expect(p.reply).toContain("1. E-mail (token)");
    p = await F.conduzirFluxo(p.fluxo!, ctx("2"), d);
    expect(p.reply).toContain("WhatsApp (token)");
    expect(p.reply).toContain("Letícia Gonçalves Nogueira — comprador");
    expect(p.reply).not.toMatch(/cobrad[ao]s?/);
    expect(p.reply).toContain("Responda *SIM* para enviar");
    p = await F.conduzirFluxo(p.fluxo!, ctx("sim", { messageId: "msg-envio" }), d);
    expect(d.acao).toHaveBeenLastCalledWith("proposal.send", { proposta_id: "p1", metodo: "whatsapp" }, "msg-envio");
    expect(p.reply).toContain("enviada para assinatura");
    expect(p.fluxo).toBeNull();
  });

  it("sem proposal.send na política: para no rascunho, sem prometer envio", async () => {
    const f: Fluxo = { kind: "proposta", etapa: "ajustes", natureza: "venda", dados: DADOS_OK, propostaId: "p1", atualizadoEm: agora };
    const d = deps();
    const p = await F.conduzirFluxo(f, ctx("ok", { policy: ["proposal.create"] }), d);
    expect(p.reply).toContain("pelo sistema");
    expect(d.acao).not.toHaveBeenCalled();
  });

  it("pendências no envio viram pergunta e voltam aos ajustes", async () => {
    const d = deps({
      acao: vi.fn().mockResolvedValue({
        status: 422,
        body: { error: "pendencias", faltando: [{ signatario: { posicao: 2, papel: "vendedor" }, campo: "cpf" }] },
      }),
    });
    const f: Fluxo = {
      kind: "proposta", etapa: "envio", natureza: "venda", dados: DADOS_OK, propostaId: "p1",
      metodo: { valor: "email", rotulo: "E-mail" }, assinantes: [], atualizadoEm: agora,
    };
    const p = await F.conduzirFluxo(f, ctx("sim"), d);
    expect(p.reply).toContain("CPF (vendedor)");
    expect(p.fluxo).toMatchObject({ etapa: "ajustes" });
  });

  it("rascunho retomado: CPF inválido é explicado e pode ser corrigido pelo Max após confirmação", async () => {
    const acao = vi.fn().mockImplementation(async (verb: string) =>
      verb === "proposal.send"
        ? { status: 422, body: { error: "pendencias", faltando: [{ signatario: { posicao: 1, papel: "proponente" }, campo: "cpf", motivo: "CPF inválido" }] } }
        : { status: 200, body: { pdf: { link: "https://imobpro.ia.br/pdf/1" } } }
    );
    const d = deps({ acao });
    const f: Fluxo = {
      kind: "proposta", etapa: "envio", dados: {}, propostaId: "p1", codigo: "P-12",
      metodo: { valor: "whatsapp", rotulo: "WhatsApp" }, assinantes: [{ nome: "Letícia", papel: "proponente" }], atualizadoEm: agora,
    };
    let p = await F.conduzirFluxo(f, ctx("sim"), d);
    expect(p.reply).toContain("CPF válido do proponente");
    expect(p.reply).toContain("Me mande o CPF correto");
    expect(p.reply).not.toContain("tela de propostas");
    expect(p.fluxo).toMatchObject({ etapa: "ajustes", pendenciaCpf: true });

    p = await F.conduzirFluxo(p.fluxo!, ctx("288.268.569-03"), d);
    expect(p.reply).toContain("não passou na validação");
    expect(acao).toHaveBeenCalledTimes(1);

    p = await F.conduzirFluxo(p.fluxo!, ctx("ok"), d);
    expect(p.reply).toContain("Me mande o CPF correto");
    expect(p.fluxo).toMatchObject({ etapa: "ajustes", pendenciaCpf: true });
    expect(acao).toHaveBeenCalledTimes(1);

    p = await F.conduzirFluxo(p.fluxo!, ctx("envie a proposta novamente"), d);
    expect(p.reply).toContain("Me mande o CPF correto");
    expect(acao).toHaveBeenCalledTimes(1);

    p = await F.conduzirFluxo(p.fluxo!, ctx("CPF do vendedor é 529.982.247-25"), d);
    expect(p.reply).toContain("CPF do proponente");
    expect(p.fluxo).toMatchObject({ etapa: "ajustes", pendenciaCpf: true });
    expect(acao).toHaveBeenCalledTimes(1);

    p = await F.conduzirFluxo(p.fluxo!, ctx("O CPF correto é 529.982.247-25"), d);
    expect(p.reply).toContain("corrigir apenas o CPF");
    expect(p.reply).toContain("P-12");
    expect(p.reply).toContain("Responda *SIM*");
    expect(acao).toHaveBeenCalledTimes(1);

    p = await F.conduzirFluxo(p.fluxo!, ctx("não"), d);
    expect(p.reply).toContain("O que você quer mudar?");
    p = await F.conduzirFluxo(p.fluxo!, ctx("O CPF correto é 111.444.777-35"), d);
    expect(p.reply).toContain("11144477735");
    expect(p.reply).not.toContain("52998224725");
    expect(acao).toHaveBeenCalledTimes(1);

    p = await F.conduzirFluxo(p.fluxo!, ctx("sim", { messageId: "confirmar-cpf" }), d);
    expect(acao).toHaveBeenLastCalledWith("proposal.update", { proposta_id: "p1", proponente: { cpf: "11144477735" } }, "confirmar-cpf");
    expect(p.reply).toContain("Atualizei o rascunho");
  });

  it("CPF pendente em rascunho retomado: sem permissão para editar, não promete correção pelo Max", async () => {
    const acao = vi.fn().mockResolvedValue({
      status: 422,
      body: { error: "pendencias", faltando: [{ signatario: { posicao: 1, papel: "proponente" }, campo: "cpf" }] },
    });
    const f: Fluxo = { kind: "proposta", etapa: "envio", dados: {}, propostaId: "p1", codigo: "P-12", atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("sim", { policy: ["proposal.send"] }), deps({ acao }));
    expect(p.reply).toContain("CPF válido");
    expect(p.reply).toContain("tela de propostas");
    expect(p.reply).not.toContain("ajusto por aqui");
    expect(p.fluxo).toBeNull();
  });

  it("NÃO no envio não envia e diz que o rascunho continua", async () => {
    const d = deps();
    const f: Fluxo = {
      kind: "proposta", etapa: "envio", natureza: "venda", dados: DADOS_OK, propostaId: "p1", codigo: "P-12",
      metodo: { valor: "email", rotulo: "E-mail" }, assinantes: [], atualizadoEm: agora,
    };
    const p = await F.conduzirFluxo(f, ctx("não"), d);
    expect(d.acao).not.toHaveBeenCalled();
    expect(p.reply).toContain("não enviei");
    expect(p.fluxo).toBeNull();
  });
});

describe("saídas e travas", () => {
  it("N2 — cancelar depois do rascunho diz que ele continua salvo, não 'nada foi criado'", async () => {
    const f: Fluxo = { kind: "proposta", etapa: "metodo", natureza: "venda", dados: DADOS_OK, propostaId: "p1", codigo: "P-9", atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("cancelar"), deps());
    expect(p.reply).toContain("P-9 continua salvo");
    expect(p.reply).not.toContain("Nada foi criado");
  });

  it("N2 — cancelar com escrita incerta não afirma que nada existe", async () => {
    const f: Fluxo = {
      kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS_OK,
      chave: { verbo: "proposal.create", valor: "k" }, atualizadoEm: agora,
    };
    const p = await F.conduzirFluxo(f, ctx("cancelar"), deps());
    expect(p.reply).toContain("pode ter sido registrado");
  });

  it("N1 — depois de uma interrupção, o ajuste pendente volta ao resumo em vez de ir à assinatura", async () => {
    const d = deps();
    const rebaixado = F.rebaixarFluxo({
      kind: "proposta", etapa: "revisao_ajuste", natureza: "venda", dados: DADOS_OK, propostaId: "p1", atualizadoEm: agora,
    })!;
    const p = await F.conduzirFluxo(rebaixado, ctx("ok"), d);
    expect(p.reply).toContain("Atualizo o rascunho assim?");
    expect(d.acao).not.toHaveBeenCalled();
  });

  it("N1 — 'sim' na coleta completa mostra o resumo, não cria", async () => {
    const d = deps();
    const p = await F.conduzirFluxo({ kind: "proposta", etapa: "coleta", natureza: "venda", dados: DADOS_OK, atualizadoEm: agora }, ctx("sim"), d);
    expect(p.reply).toContain("Está correto?");
    expect(d.acao).not.toHaveBeenCalled();
  });

  it("nome PARCIAL da mesma pessoa completa em vez de substituir", () => {
    const m = F.mesclarDados(DADOS_OK, F.sanearDados({ proponente: { nome: "Letícia", email: "l@x.com" } }));
    expect(m.proponente).toMatchObject({ nome: "Letícia Gonçalves Nogueira", telefone: "11999990000", email: "l@x.com" });
  });

  it("B5 — pergunta no meio da coleta é LIBERADA, sem 'Anotado' falso", async () => {
    const d = deps({ extrairProposta: vi.fn().mockResolvedValue({}) });
    const f: Fluxo = { kind: "proposta", etapa: "coleta", natureza: "venda", dados: {}, atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("como funciona a assinatura?"), d);
    expect(p.liberar).toBe(true);
    expect(p.fluxo).toBe(f);
  });

  it("B5 — escolha que não é 1/2 é liberada em vez de repetir para sempre", async () => {
    const p = await F.conduzirFluxo({ kind: "escolha", atualizadoEm: agora }, ctx("quanto custa o ITBI?"), deps());
    expect(p.liberar).toBe(true);
  });

  it("B5 — 'não' no resumo pergunta o que mudar, não joga os dados fora", async () => {
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS_OK, atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("não"), deps());
    expect(p.reply).toBe("O que você quer mudar?");
    expect(p.fluxo).toMatchObject({ etapa: "coleta", dados: DADOS_OK });
  });

  it("B5 — 'não quero mais a proposta' cancela", () => {
    expect(F.querCancelar("não quero mais a proposta")).toBe(true);
    expect(F.querCancelar("Cancela isso")).toBe(true);
    expect(F.querCancelar("o valor não para em 1 milhão")).toBe(false);
  });

  it("B3 — interrupção tira o fluxo de toda etapa em que o próximo SIM escreve", () => {
    const base = { natureza: "venda" as const, dados: DADOS_OK, propostaId: "p1", atualizadoEm: agora };
    expect(F.rebaixarFluxo({ kind: "proposta", etapa: "envio", ...base })).toMatchObject({ etapa: "ajustes" });
    expect(F.rebaixarFluxo({ kind: "proposta", etapa: "metodo", ...base })).toMatchObject({ etapa: "ajustes" });
    expect(F.rebaixarFluxo({ kind: "proposta", etapa: "revisao_ajuste", ...base })).toMatchObject({ etapa: "ajustes" });
    expect(F.rebaixarFluxo({ kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS_OK, atualizadoEm: agora })).toMatchObject({ etapa: "coleta" });
    expect(F.rebaixarFluxo({ kind: "negocio", etapa: "revisao", valores: {}, forcar: true, atualizadoEm: agora })).toMatchObject({ etapa: "campos", forcar: undefined });
    expect(F.rebaixarFluxo(null)).toBeNull();
  });

  it("dados que vieram no PEDIDO não são pedidos de novo", async () => {
    const d = deps({ extrairProposta: vi.fn().mockResolvedValue({ proponente: { nome: "Letícia Gonçalves Nogueira" }, valor: 1_500_000 }) });
    const p = await F.conduzirFluxo(
      { kind: "escolha", natureza: "venda", pedido: "proposta pra Letícia Gonçalves Nogueira, 1,5 mi", atualizadoEm: agora },
      ctx("1"),
      d
    );
    expect(d.extrairProposta).toHaveBeenCalledWith("proposta pra Letícia Gonçalves Nogueira, 1,5 mi", "venda");
    expect(p.reply).toContain("ainda falta");
    expect(p.reply).not.toContain("nome completo do comprador");
    expect(p.reply).not.toMatch(/falta:[^\n]*valor/);
  });

  it("campo do resumo não forja linhas nem negrito", () => {
    const d = F.sanearDados({ pagamento: { forma: "à vista\nValor: R$ 100 *SIM*" } });
    expect(d.pagamento?.forma).toBe("à vista Valor: R$ 100 SIM");
  });

  it("CANCELAR encerra qualquer etapa sem chamar o servidor", async () => {
    const d = deps();
    const p = await F.conduzirFluxo(
      { kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS_OK, atualizadoEm: agora },
      ctx("cancelar"),
      d
    );
    expect(p.reply).toBe(F.TEXTO_FLUXO_CANCELADO);
    expect(p.fluxo).toBeNull();
    expect(d.acao).not.toHaveBeenCalled();
  });

  it("fluxo vence após 30 min de inatividade", () => {
    const f: Fluxo = { kind: "escolha", atualizadoEm: agora };
    expect(F.fluxoExpirou(f, agora + F.FLUXO_TTL_MS + 1)).toBe(true);
    expect(F.fluxoExpirou(f, agora + 60_000)).toBe(false);
  });

  it("valor vazio do extrator nunca apaga o que já se sabia", () => {
    const m = F.mesclar(DADOS_OK, F.sanearDados({ proponente: { nome: "" }, valor: 0 }));
    expect(m?.proponente?.nome).toBe("Letícia Gonçalves Nogueira");
    expect(m?.valor).toBe(1_500_000);
  });

  it("sanearDados descarta tipos errados e porcentagem absurda", () => {
    const d = F.sanearDados({ valor: "muito", comissao: { percentual: 600 }, canal: "fax" });
    expect(d.valor).toBeUndefined();
    expect(d.comissao?.percentual).toBeUndefined();
    expect(d.canal).toBeUndefined();
  });

  it("faltandoNaProposta espelha o buildProposalPayload", () => {
    expect(F.faltandoNaProposta(DADOS_OK)).toEqual([]);
    expect(F.faltandoNaProposta({ ...DADOS_OK, proponente: { nome: "Letícia", telefone: "11999990000" } })).toEqual([
      "sobrenome de Letícia",
    ]);
    expect(F.faltandoNaProposta({ ...DADOS_OK, vendedor: { nome: "Carlos Souza" } })).toEqual([
      "telefone ou e-mail do vendedor",
    ]);
    expect(F.faltandoNaProposta({ ...DADOS_OK, proponente: { ...DADOS_OK.proponente, cpf: "288.268.569-03" } })).toEqual([
      "CPF válido de quem faz a proposta",
    ]);
  });

  it("faltandoNaProposta({ temLead: true }) pula nome e valor — vêm do proposal.create — mas endereço/telefone seguem exigidos", () => {
    expect(F.faltandoNaProposta({}, { temLead: true })).toEqual(["endereço do imóvel", "telefone do comprador, com DDD"]);
    expect(F.faltandoNaProposta({ imovel: { endereco: "Rua X, 1" }, valor: 1000, proponente: { telefone: "11999990000" } }, { temLead: true })).toEqual([]);
    // Sem o flag, o comportamento de hoje continua intacto.
    expect(F.faltandoNaProposta({ imovel: { endereco: "Rua X, 1" }, valor: 1000, proponente: { telefone: "11999990000" } })).toEqual([
      "nome completo do comprador",
    ]);
  });

  it("locação usa o schema de locação e chama o valor de aluguel", () => {
    expect(F.argsDaProposta({ natureza: "locacao", dados: DADOS_OK }).schemaType).toBe("locacao_residencial_v1");
    expect(F.resumoDaProposta({ natureza: "locacao", dados: DADOS_OK })).toContain("Aluguel");
  });

  it("leaseClientId: vai no args do create, nunca na atualização, e o resumo mostra 'dados do lead analisado' sem CPF/telefone", () => {
    const f = { natureza: "locacao" as const, dados: DADOS_OK, leaseClientId: "lc1" };
    expect(F.argsDaProposta(f).leaseClientId).toBe("lc1");
    expect(F.argsDaProposta(f, { atualizacao: true }).leaseClientId).toBeUndefined();
    expect(F.argsDaProposta({ ...f, leaseClientId: undefined }).leaseClientId).toBeUndefined();

    const resumo = F.resumoDaProposta(f);
    expect(resumo).toContain("Inquilino: Letícia Gonçalves Nogueira (dados do lead analisado)");
    expect(resumo).not.toContain("11999990000");
    expect(resumo).not.toContain("12345678909");
  });

  it("iniciarProposta com leaseClientId: campos iniciais não pedem Inquilino/CPF nem valor do aluguel", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 200, body: { modelo: true, assinatura: true } }) });
    const p = await F.iniciarProposta("locacao", undefined, agora, d, undefined, "lc1");
    expect(p.fluxo).toMatchObject({ kind: "proposta", etapa: "coleta", leaseClientId: "lc1" });
    expect(p.reply).not.toContain("CPF");
    expect(p.reply).not.toContain("Valor do aluguel");
    expect(p.reply).toContain("Telefone");
  });
});

describe("contrato com o PR A (revisão lado a lado)", () => {
  const base = { natureza: "venda" as const, dados: DADOS_OK, propostaId: "p1", codigo: "P-3", atualizadoEm: agora };

  it("form.create 201 com link relativo: diz que criou (não 'não consegui', que levaria a duplicar)", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 201, body: { formulario: { link: "/f/tok/x" } } }) });
    const f: Fluxo = { kind: "negocio", etapa: "revisao", tipo: "venda", campos: [], valores: {}, atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("sim"), d);
    expect(p.reply).toContain("formulário criado");
    expect(p.fluxo).toBeNull();
  });

  it("update 409 edicao_pela_tela: manda ajustar pela tela e não promete nada", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 409, body: { error: "edicao_pela_tela" } }) });
    const p = await F.conduzirFluxo({ kind: "proposta", etapa: "revisao_ajuste", ...base }, ctx("sim"), d);
    expect(p.reply).toContain("pela tela");
    expect(p.fluxo).toBeNull();
  });

  it("update 409 em_andamento é incerto e guarda a chave", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 409, body: { error: "em_andamento" } }) });
    const p = await F.conduzirFluxo({ kind: "proposta", etapa: "revisao_ajuste", ...base }, ctx("sim", { messageId: "u1" }), d);
    expect(p.reply).toBe(F.TEXTO_ESCRITA_INCERTA);
    expect(p.fluxo).toMatchObject({ chave: { verbo: "proposal.update", valor: "u1" } });
  });

  it("send 409 em_andamento é incerto e guarda a chave do envio", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 409, body: { error: "em_andamento" } }) });
    const f: Fluxo = { kind: "proposta", etapa: "envio", ...base, metodo: { valor: "email", rotulo: "E-mail" }, assinantes: [] };
    const p = await F.conduzirFluxo(f, ctx("sim", { messageId: "e1" }), d);
    expect(p.reply).toBe(F.TEXTO_ESCRITA_INCERTA);
    expect(p.fluxo).toMatchObject({ chave: { verbo: "proposal.send", valor: "e1" } });
  });

  it("o método escolhido é anunciado; um só método liberado não manda `metodo`", async () => {
    const opcoes = (metodos: unknown[]) =>
      vi.fn().mockImplementation(async (verb: string) =>
        verb === "proposal.options"
          ? { status: 200, body: { metodos, signatarios: [{ nome: "Letícia G N", papel: "proponente" }, { nome: "Carlos S", papel: "proprietário" }] } }
          : { status: 200, body: {} }
      );
    let acao = opcoes([{ valor: "email", rotulo: "E-mail" }, { valor: "whatsapp", rotulo: "WhatsApp" }]);
    let p = await F.conduzirFluxo({ kind: "proposta", etapa: "ajustes", ...base }, ctx("ok"), deps({ acao }));
    p = await F.conduzirFluxo(p.fluxo!, ctx("2"), deps({ acao }));
    expect(p.reply).toContain("por *WhatsApp*");
    expect(p.reply).toContain("Carlos S — vendedor");

    acao = opcoes([{ valor: "email", rotulo: "E-mail" }]);
    p = await F.conduzirFluxo({ kind: "proposta", etapa: "ajustes", ...base }, ctx("ok"), deps({ acao }));
    await F.conduzirFluxo(p.fluxo!, ctx("sim", { messageId: "s" }), deps({ acao }));
    expect(acao).toHaveBeenLastCalledWith("proposal.send", { proposta_id: "p1", metodo: undefined }, "s");
  });

  it("pendência com campo/papel do servidor ('name', 'proprietário') sai em português", async () => {
    const d = deps({
      acao: vi.fn().mockResolvedValue({
        status: 422,
        body: { error: "pendencias", faltando: [{ signatario: { posicao: 2, papel: "proprietário" }, campo: "name" }] },
      }),
    });
    const f: Fluxo = { kind: "proposta", etapa: "envio", ...base, metodo: { valor: "email", rotulo: "E-mail" }, assinantes: [] };
    const p = await F.conduzirFluxo(f, ctx("sim"), d);
    expect(p.reply).toContain("nome completo (vendedor)");
  });
});

describe("canal na atualização", () => {
  it("só vai quando a pessoa disse; o padrão deduzido não desfaz troca feita pela tela", () => {
    expect(F.argsDaProposta({ natureza: "venda", dados: DADOS_OK }, { atualizacao: true }).canal).toBeUndefined();
    expect(F.argsDaProposta({ natureza: "venda", dados: { ...DADOS_OK, canal: "email" } }, { atualizacao: true }).canal).toBe("email");
    expect(F.argsDaProposta({ natureza: "venda", dados: DADOS_OK }).canal).toBe("whatsapp");
  });
});

describe("pendência de quem o Max não edita", () => {
  it("cônjuge/testemunha faltando: orienta a tela, não volta aos ajustes", async () => {
    const d = deps({
      acao: vi.fn().mockResolvedValue({
        status: 422,
        body: { error: "pendencias", faltando: [{ signatario: { posicao: 3, papel: "testemunha" }, campo: "cpf" }] },
      }),
    });
    const f: Fluxo = {
      kind: "proposta", etapa: "envio", natureza: "venda", dados: DADOS_OK, propostaId: "p1", codigo: "P-4",
      metodo: { valor: "email", rotulo: "E-mail" }, assinantes: [], atualizadoEm: agora,
    };
    const p = await F.conduzirFluxo(f, ctx("sim"), d);
    expect(p.reply).toContain("pela tela");
    expect(p.fluxo).toBeNull();
  });
});

describe("recusa do servidor", () => {
  it("create inválido (422 dados_invalidos + message) vira a frase de negócio e volta à coleta", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 422, body: { error: "dados_invalidos", message: "Falta o endereço do imóvel." } }) });
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS_OK, atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("sim"), d);
    expect(p.reply).toContain("Falta o endereço do imóvel.");
    expect(p.fluxo).toMatchObject({ etapa: "coleta" });
  });

  it("código sem frase (dados_invalidos) não vai para a pessoa", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 422, body: { error: "dados_invalidos" } }) });
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS_OK, atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("sim"), d);
    expect(p.reply).not.toContain("dados_invalidos");
  });

  it("403 SEM leaseClientId segue o caminho de hoje: sem permissão, fluxo encerra", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 403, body: {} }) });
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS_OK, atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("sim"), d);
    expect(p.reply).toBe("Sua conta não tem permissão para isso pelo Max. Fale com o administrador da imobiliária.");
    expect(p.fluxo).toBeNull();
  });
});

describe("proposta ligada ao lead do crédito (M3): leaseClientId", () => {
  it("create recusa a POSSE (404) COM leaseClientId: oferece abrir sem vínculo, nunca afirma criação", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 404, body: {} }) });
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "locacao", dados: DADOS_OK, leaseClientId: "lc1", atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("sim", { messageId: "sim-1" }), d);
    expect(p.reply).toBe("Não consegui ligar a proposta ao lead agora. Quer abrir a proposta sem o vínculo? (SIM)");
    expect(p.evento).not.toContain("criada");
    expect(p.fluxo).toMatchObject({ kind: "proposta", etapa: "revisao", ofertaSemVinculo: true, leaseClientId: "lc1" });
  });

  it("create recusa com 403 (RBAC/política) COM leaseClientId: sem permissão, NUNCA a oferta sem vínculo", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 403, body: {} }) });
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "locacao", dados: DADOS_OK, leaseClientId: "lc1", atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("sim", { messageId: "sim-1" }), d);
    expect(p.reply).toBe("Sua conta não tem permissão para isso pelo Max. Fale com o administrador da imobiliária.");
    expect(p.fluxo).toBeNull();
  });

  it("create recusa com 400 (corpo inválido/idempotência) COM leaseClientId: recusa normal (como sem lead), NUNCA a oferta sem vínculo", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 400, body: { message: "Idempotency-Key inválida." } }) });
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "locacao", dados: DADOS_OK, leaseClientId: "lc1", atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("sim", { messageId: "sim-1" }), d);
    expect(p.reply).toContain("Idempotency-Key inválida.");
    expect(p.reply).not.toContain("vínculo");
    expect(p.fluxo).toMatchObject({ kind: "proposta", etapa: "coleta", leaseClientId: "lc1" });
    expect((p.fluxo as { ofertaSemVinculo?: boolean })?.ofertaSemVinculo).toBeUndefined();
  });

  it("422 COM leaseClientId (lead sem nome/valor): próxima interação pede o dado; SIM de novo não chama proposal.create outra vez (sem loop)", async () => {
    const acao = vi.fn().mockResolvedValue({ status: 422, body: { error: "dados_invalidos", message: "Falta o valor do aluguel." } });
    const d = deps({ acao });
    const semNomeSemValor: import("../fluxos").DadosDaProposta = { imovel: { endereco: "Rua Senador Godoi, 606" }, proponente: { telefone: "11999990000" } };
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "locacao", dados: semNomeSemValor, leaseClientId: "lc1", atualizadoEm: agora };
    const p1 = await F.conduzirFluxo(f, ctx("sim", { messageId: "sim-1" }), d);
    expect(p1.reply).toContain("Falta o valor do aluguel.");
    expect(p1.fluxo).toMatchObject({ kind: "proposta", etapa: "coleta", leaseClientId: "lc1", leadIncompleto: true });

    const p2 = await F.conduzirFluxo(p1.fluxo!, ctx("sim", { messageId: "sim-2" }), d);
    expect(p2.reply).toContain("valor");
    expect(p2.reply).toContain("nome completo do comprador");
    expect(p2.fluxo).toMatchObject({ kind: "proposta", etapa: "coleta", leaseClientId: "lc1" });
    expect(acao).toHaveBeenCalledTimes(1);
  });

  it("NÃO à oferta: encerra sem abrir a proposta (e sem reusar a chave do SIM anterior)", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 404, body: {} }) });
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "locacao", dados: DADOS_OK, leaseClientId: "lc1", atualizadoEm: agora };
    const p1 = await F.conduzirFluxo(f, ctx("sim", { messageId: "sim-1" }), d);
    const p2 = await F.conduzirFluxo(p1.fluxo!, ctx("não", { messageId: "nao-1" }), d);
    expect(p2.fluxo).toBeNull();
    expect(d.acao).toHaveBeenCalledTimes(1);
  });

  it("SIM à oferta, com tudo já conhecido: vai direto ao resumo normal (sem o id, sem a frase do lead)", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 404, body: {} }) });
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "locacao", dados: DADOS_OK, leaseClientId: "lc1", atualizadoEm: agora };
    const p1 = await F.conduzirFluxo(f, ctx("sim", { messageId: "sim-1" }), d);
    const p2 = await F.conduzirFluxo(p1.fluxo!, ctx("sim", { messageId: "sim-2" }), d);
    expect(p2.fluxo).toMatchObject({ kind: "proposta", etapa: "revisao", leaseClientId: undefined, ofertaSemVinculo: undefined });
    expect(p2.reply).not.toContain("dados do lead analisado");
  });

  it("SIM à oferta, com dado faltando: volta à coleta pedindo nome/telefone/CPF como antes desta feature", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 404, body: {} }) });
    const semNome: import("../fluxos").DadosDaProposta = { imovel: { endereco: "Rua Senador Godoi, 606" }, proponente: { telefone: "11999990000" } };
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "locacao", dados: semNome, leaseClientId: "lc1", atualizadoEm: agora };
    const p1 = await F.conduzirFluxo(f, ctx("sim", { messageId: "sim-1" }), d);
    const p2 = await F.conduzirFluxo(p1.fluxo!, ctx("sim", { messageId: "sim-2" }), d);
    expect(p2.fluxo).toMatchObject({ kind: "proposta", etapa: "coleta", leaseClientId: undefined });
    expect(p2.reply).toContain("CPF");
    expect(p2.reply).toContain("nome completo do comprador");
  });

  it("create aceita o leaseClientId (201): rascunho normal, sem oferta nenhuma", async () => {
    const acao = vi.fn().mockResolvedValue({ status: 201, body: { proposal: { id: "p1", codigo: "P-1" } } });
    const d = deps({ acao });
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "locacao", dados: DADOS_OK, leaseClientId: "lc1", atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("sim", { messageId: "sim-1" }), d);
    expect(acao).toHaveBeenCalledWith("proposal.create", expect.objectContaining({ leaseClientId: "lc1" }), "sim-1");
    expect(p.fluxo).toMatchObject({ etapa: "ajustes", propostaId: "p1", leaseClientId: "lc1" });
  });
});

describe("sem modelo de proposta ativo (prod 07/10: FINCasa com modelos arquivados)", () => {
  it("o preflight barra no INÍCIO, antes de pedir qualquer dado", async () => {
    const acao = vi.fn().mockResolvedValue({ status: 200, body: { modelo: false } });
    const d = deps({ acao });
    const p = await F.conduzirFluxo({ kind: "proposta", etapa: "natureza", dados: {}, atualizadoEm: agora }, ctx("venda"), d);
    expect(acao).toHaveBeenCalledWith("proposal.preflight", { schemaType: "compra_venda_v1" });
    expect(p.reply).toContain("não tem um modelo de proposta de venda ativo");
    expect(p.fluxo).toBeNull();
    expect(d.extrairProposta).not.toHaveBeenCalled();
  });

  it("locação só é barrada quando NENHUM dos dois modelos existe (comercial-only segue)", async () => {
    const soComercial = vi.fn().mockImplementation(async (_v: string, a: { schemaType: string }) => ({
      status: 200,
      body: { modelo: a.schemaType === "locacao_comercial_v1" },
    }));
    let p = await F.conduzirFluxo({ kind: "proposta", etapa: "natureza", dados: {}, atualizadoEm: agora }, ctx("locação"), deps({ acao: soComercial }));
    expect(p.reply).toContain("Inquilino");
    const nenhum = vi.fn().mockResolvedValue({ status: 200, body: { modelo: false } });
    p = await F.conduzirFluxo({ kind: "proposta", etapa: "natureza", dados: {}, atualizadoEm: agora }, ctx("locação"), deps({ acao: nenhum }));
    expect(p.reply).toContain("locação ativo");
    expect(nenhum).toHaveBeenCalledTimes(2);
  });

  it("preflight 400 (sistema ainda sem o verbo) não bloqueia", async () => {
    const acao = vi.fn().mockResolvedValue({ status: 400, body: { error: "invalid_body" } });
    const p = await F.conduzirFluxo({ kind: "proposta", etapa: "natureza", dados: {}, atualizadoEm: agora }, ctx("venda"), deps({ acao }));
    expect(p.reply).toContain("Comprador");
  });

  it("update com sem_modelo: avisa e manda terminar o rascunho pelo sistema (sem 2º rascunho)", async () => {
    const d = deps({
      acao: vi.fn().mockResolvedValue({ status: 200, body: { proposta: { id: "p1" }, pdf: null, pdfIndisponivel: "sem_modelo" } }),
    });
    const f: Fluxo = { kind: "proposta", etapa: "revisao_ajuste", natureza: "venda", dados: DADOS_OK, propostaId: "p1", codigo: "P-8", atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("sim"), d);
    expect(p.reply).toContain("termine o rascunho P-8 por lá");
    expect(p.reply).not.toContain("me pedir de novo");
    expect(p.fluxo).toBeNull();
  });

  it("preflight sem resposta não bloqueia (o create avisa depois)", async () => {
    const p = await F.conduzirFluxo({ kind: "proposta", etapa: "natureza", dados: {}, atualizadoEm: agora }, ctx("locação"), deps());
    expect(p.reply).toContain("Inquilino");
  });

  it("create com pdfIndisponivel=sem_modelo: diz que salvou, explica, não manda link falso", async () => {
    const d = deps({
      acao: vi.fn().mockResolvedValue({
        status: 201,
        body: { proposal: { id: "p1", codigo: "P-8" }, pdf: null, pdfIndisponivel: "sem_modelo" },
      }),
    });
    const f: Fluxo = { kind: "proposta", etapa: "revisao", natureza: "venda", dados: DADOS_OK, atualizadoEm: agora };
    const p = await F.conduzirFluxo(f, ctx("sim"), d);
    expect(p.reply).toContain("P-8 salvo");
    expect(p.reply).toContain("não tem um modelo");
    expect(p.reply).not.toContain("http");
    expect(p.fluxo).toBeNull();
  });
});
