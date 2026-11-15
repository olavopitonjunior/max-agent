import { describe, expect, it, vi } from "vitest";
import {
  avisoDeRegerar,
  caminhoDoCelular,
  rascunhoPorGrupo,
  resolverCelular,
  comObrigatorias,
  definirTestemunhas,
  lerEscolhaDeTestemunhas,
  lerTipoDeAssinatura,
  marcadasPorPadrao,
  opcoesDeTipo,
  textoDeTestemunhas,
  textoDeTipos,
  textoDoCartaoDeTestemunhas,
  textoDoErroDeTestemunhas,
  textoSalvarComoPadrao,
} from "../assinatura-v2";
import type { OptionsV2 } from "../contrato";
import type { DepsDoFluxo, RespostaDoServidor } from "../../fluxos";

/**
 * T13 (PR-D): testemunhas e tipo de assinatura. Negados primeiro. CPF só o sintético 52998224725
 * (e nunca aparece nos textos: o contrato nem o manda).
 */

const LINK = "https://app.exemplo.test/configuracoes/testemunhas";

function options(extra: Record<string, unknown> = {}): OptionsV2 {
  return {
    metodos: [],
    signatarios: [],
    assinaturaConfigurada: true,
    fluxoV2: true,
    testemunhas: {
      minimo: 1,
      maximo: 4,
      padrao: [
        { idPadrao: "t-1", nome: "Ana Testemunha", obrigatoria: true, podeAceite: true },
        { idPadrao: "t-2", nome: "Beto Testemunha", obrigatoria: false, podeAceite: true },
        { idPadrao: "t-3", nome: "Caio Testemunha", obrigatoria: false, podeAceite: false },
      ],
      linkConfiguracoes: LINK,
    },
    tiposDeAssinatura: [
      { tipo: "email", disponivel: true, texto: "E-mail" },
      { tipo: "whatsapp", disponivel: true, texto: "WhatsApp" },
      { tipo: "aceite", disponivel: true, custoCentavos: 99, texto: "Aceite" },
    ],
    ...extra,
  } as unknown as OptionsV2;
}

function depsCom(resposta: RespostaDoServidor | null) {
  const acao = vi.fn(async (_v: string, _a: Record<string, unknown>, _k?: string) => resposta);
  return { acao, deps: { acao } as unknown as DepsDoFluxo };
}

describe("negados: a escrita das testemunhas", () => {
  it("sem chave de idempotência nunca chama o servidor", async () => {
    const t = depsCom({ status: 200, body: {} });
    const r = await definirTestemunhas(t.deps, "prop-1", ["t-1"]);
    expect(r).toEqual({ ok: false, erro: "sem_chave" });
    expect(t.acao).not.toHaveBeenCalled();
  });

  it("403 fluxo_desligado vira erro próprio (o chamador rebaixa para o v1, sem mensagem de erro)", async () => {
    const t = depsCom({ status: 403, body: { error: "fluxo_desligado" } });
    expect(await definirTestemunhas(t.deps, "prop-1", ["t-1"], "wamid.1")).toEqual({ ok: false, erro: "fluxo_desligado" });
  });

  it("403 de política não é fluxo_desligado: é falta de permissão", async () => {
    const t = depsCom({ status: 403, body: { error: "politica_nao_concede" } });
    expect(await definirTestemunhas(t.deps, "prop-1", ["t-1"], "wamid.1")).toEqual({ ok: false, erro: "sem_permissao" });
  });

  it("sem resposta, ou 409 de operação em curso: resultado incerto (a mesma chave repete)", async () => {
    expect(await definirTestemunhas(depsCom(null).deps, "prop-1", ["t-1"], "wamid.1")).toEqual({ ok: false, erro: "incerta" });
    const emCurso = depsCom({ status: 409, body: { error: "ja_enviando" } });
    expect(await definirTestemunhas(emCurso.deps, "prop-1", ["t-1"], "wamid.1")).toEqual({ ok: false, erro: "incerta" });
  });

  it("409 ja_enviada, nao_editavel e envio_em_andamento são recusas distintas", async () => {
    const enviada = depsCom({ status: 409, body: { error: "ja_enviada", estado: "Enviada" } });
    expect(await definirTestemunhas(enviada.deps, "p", [], "k")).toEqual({ ok: false, erro: "ja_enviada", estado: "Enviada" });
    const naoEditavel = depsCom({ status: 409, body: { error: "nao_editavel" } });
    expect(await definirTestemunhas(naoEditavel.deps, "p", [], "k")).toEqual({ ok: false, erro: "nao_editavel" });
    // M4: `envio_em_andamento` não é "saiu do rascunho": tem erro e frase próprios.
    const emAndamento = depsCom({ status: 409, body: { error: "envio_em_andamento" } });
    expect(await definirTestemunhas(emAndamento.deps, "p", [], "k")).toEqual({ ok: false, erro: "envio_em_andamento" });
  });

  it("M4: envio_em_andamento diz que o envio está em andamento, não que saiu do rascunho", () => {
    const texto = textoDoErroDeTestemunhas("envio_em_andamento");
    expect(texto).toMatch(/envio .*em andamento/);
    expect(texto).not.toMatch(/rascunho/);
    expect(texto).toMatch(/n[aã]o gravei/i);
    expect(textoDoErroDeTestemunhas("nao_editavel")).toMatch(/rascunho/);
  });

  it("nenhum texto de erro afirma que gravou", () => {
    for (const erro of ["teto_testemunhas", "testemunha_obrigatoria", "nao_editavel", "envio_em_andamento", "sem_permissao", "dados_invalidos", "incerta"] as const) {
      expect(textoDoErroDeTestemunhas(erro)).toMatch(/n[aã]o gravei|n[aã]o consegui|n[aã]o tem permiss/i);
    }
  });
});

describe("T13: testemunhas e tipo de assinatura", () => {
  it("padrão por escopo vem marcado como o servidor semeia (obrigatórias + completa o par); não existe padrão por corretor", () => {
    const o = options();
    // Obrigatória t-1 + completa o par com a primeira do cadastro (t-2). t-3 fica de fora.
    expect(marcadasPorPadrao(o)).toEqual(["t-1", "t-2"]);
    expect(comObrigatorias(o, [])).toEqual(["t-1"]);
    expect(comObrigatorias(o, ["t-3"])).toEqual(["t-1", "t-3"]);
    // O padrão é lido só do `options` (por escopo): outro options (outro escopo) dá outro padrão, sem estado de corretor.
    const outroEscopo = options({ testemunhas: { minimo: 0, maximo: 4, padrao: [{ idPadrao: "x-9", nome: "Dora", obrigatoria: false, podeAceite: true }], linkConfiguracoes: LINK } });
    expect(marcadasPorPadrao(outroEscopo)).toEqual(["x-9"]);
    expect(marcadasPorPadrao(o)).toEqual(["t-1", "t-2"]);
    // A lista mostra as marcadas e a obrigatória.
    const texto = textoDeTestemunhas(o, marcadasPorPadrao(o));
    expect(texto).toContain("1. ✅ Ana Testemunha (obrigatória)");
    expect(texto).toContain("2. ✅ Beto Testemunha");
    expect(texto).toContain("3. ⬜ Caio Testemunha");
  });

  // I1 (revisão): o padrão marcado espelha a semeadura do servidor, para "SIM"/"manter" nunca estourar o teto.
  describe("I1: o padrão marcado não passa do que o servidor semeia", () => {
    const quatro = (obrig: boolean[]) =>
      options({
        testemunhas: {
          minimo: 2,
          maximo: 4,
          padrao: obrig.map((ob, i) => ({ idPadrao: `c-${i + 1}`, nome: `Pessoa ${i + 1}`, obrigatoria: ob, podeAceite: true })),
          linkConfiguracoes: LINK,
        },
      });

    it("cadastro de 4 sem obrigatória: marca só o par (as 2 primeiras), não as 4", () => {
      expect(marcadasPorPadrao(quatro([false, false, false, false]))).toEqual(["c-1", "c-2"]);
    });

    it("cadastro de 4 com 1 obrigatória (a última): ela + a primeira completam o par", () => {
      expect(marcadasPorPadrao(quatro([false, false, false, true]))).toEqual(["c-1", "c-4"]);
    });

    it("2 obrigatórias: só elas; 3 obrigatórias: as 3 (nunca corta obrigatória)", () => {
      expect(marcadasPorPadrao(quatro([true, false, true, false]))).toEqual(["c-1", "c-3"]);
      expect(marcadasPorPadrao(quatro([true, true, true, false]))).toEqual(["c-1", "c-2", "c-3"]);
    });

    it("cadastro com 1 só: marca 1 (o par não inventa testemunha)", () => {
      expect(marcadasPorPadrao(quatro([false]))).toEqual(["c-1"]);
    });

    it("nunca passa do `maximo` do servidor", () => {
      const o = options({
        testemunhas: {
          minimo: 2,
          maximo: 2,
          padrao: [1, 2, 3].map((n) => ({ idPadrao: `c-${n}`, nome: `P${n}`, obrigatoria: false, podeAceite: true })),
          linkConfiguracoes: LINK,
        },
      });
      expect(marcadasPorPadrao(o).length).toBeLessThanOrEqual(2);
    });

    it("'manter' e 'sim' na lista valem o padrão semeado, não o cadastro inteiro", () => {
      const o = quatro([false, false, false, false]);
      expect(lerEscolhaDeTestemunhas("manter", o)).toEqual({ tipo: "escolha", ids: ["c-1", "c-2"] });
    });
  });

  // I2 (revisão): regravar SUBSTITUI o conjunto da proposta, inclusive o que foi mexido na tela.
  it("I2: o cartão diz que a escolha substitui as testemunhas atuais, inclusive as da tela", () => {
    const texto = textoDoCartaoDeTestemunhas(options(), ["t-1", "t-2"], "PROP-1");
    expect(texto).toMatch(/substitui as testemunhas atuais/);
    expect(texto).toMatch(/adicionadas na tela/);
    expect(texto).toContain("Responda *SIM* para gravar.");
    expect(texto).not.toMatch(/\d{11}/);
  });

  it("lê números, manter e nenhuma; número fora da lista é recusa e a obrigatória nunca sai", () => {
    const o = options();
    expect(lerEscolhaDeTestemunhas("2", o)).toEqual({ tipo: "escolha", ids: ["t-1", "t-2"] });
    expect(lerEscolhaDeTestemunhas("2 3", o)).toEqual({ tipo: "escolha", ids: ["t-1", "t-2", "t-3"] });
    expect(lerEscolhaDeTestemunhas("manter", o)).toEqual({ tipo: "escolha", ids: ["t-1", "t-2"] });
    expect(lerEscolhaDeTestemunhas("nenhuma", o)).toEqual({ tipo: "escolha", ids: ["t-1"] });
    expect(lerEscolhaDeTestemunhas("9", o)).toEqual({ tipo: "invalida", motivo: "numero_fora" });
    expect(lerEscolhaDeTestemunhas("ok", o)).toEqual({ tipo: "nenhuma_leitura" });
    expect(lerEscolhaDeTestemunhas("blz", o)).toEqual({ tipo: "nenhuma_leitura" });
  });

  it("'salvar como padrão' responde com link de Configurações e não grava nada", async () => {
    const o = options();
    expect(lerEscolhaDeTestemunhas("salvar como padrão", o)).toEqual({ tipo: "salvar_padrao" });
    expect(lerEscolhaDeTestemunhas("quero salvar essas como padrao", o)).toEqual({ tipo: "salvar_padrao" });
    const texto = textoSalvarComoPadrao(o);
    expect(texto).toContain(LINK);
    expect(texto).toContain("Nada foi gravado");
  });

  it("teto 4: 422 teto_testemunhas vira frase com o teto", async () => {
    const t = depsCom({ status: 422, body: { error: "teto_testemunhas", maximo: 4 } });
    const r = await definirTestemunhas(t.deps, "prop-1", ["t-1", "t-2", "t-3", "t-4", "t-5"], "wamid.9");
    expect(r).toEqual({ ok: false, erro: "teto_testemunhas", maximo: 4 });
    expect(r.ok === false && textoDoErroDeTestemunhas(r.erro, { maximo: r.maximo })).toContain("máximo é de 4 testemunhas");
    // A escrita foi com a chave do primeiro SIM e só com ids (nenhum dado pessoal).
    expect(t.acao).toHaveBeenCalledWith(
      "proposal.witnesses.set",
      { proposta_id: "prop-1", testemunhas: [{ idPadrao: "t-1" }, { idPadrao: "t-2" }, { idPadrao: "t-3" }, { idPadrao: "t-4" }, { idPadrao: "t-5" }] },
      "wamid.9"
    );
  });

  it("422 testemunha_obrigatoria e nao_editavel viram frases; 200 devolve só nomes e faltando", async () => {
    const obrig = depsCom({ status: 422, body: { error: "testemunha_obrigatoria" } });
    expect(await definirTestemunhas(obrig.deps, "p", [], "k")).toEqual({ ok: false, erro: "testemunha_obrigatoria" });
    const ok = depsCom({
      status: 200,
      body: { testemunhas: [{ nome: "Ana Testemunha", obrigatoria: true, canal: "email", cpf: "52998224725" }], faltando: [] },
    });
    const r = await definirTestemunhas(ok.deps, "p", ["t-1"], "k");
    expect(r).toEqual({ ok: true, testemunhas: [{ nome: "Ana Testemunha", obrigatoria: true, canal: "email" }], faltando: [] });
    // O CPF que o servidor eventualmente mandasse não atravessa a função.
    expect(JSON.stringify(r)).not.toContain("52998224725");
  });

  it("tipo Aceite sem celular do signatário pede o celular antes do preflight", () => {
    const o = options({
      signatarios: [{ nome: "Letícia Gonçalves", papel: "proponente" }],
      tiposDeAssinatura: [
        { tipo: "email", disponivel: true, texto: "E-mail" },
        {
          tipo: "aceite",
          disponivel: false,
          motivo: "assinante_sem_celular",
          assinantesSemCelular: [{ posicao: 1, papel: "proponente", nome: "Letícia Gonçalves" }],
          texto: "Aceite",
        },
      ],
    });
    // O Aceite aparece na lista (o celular se pergunta DEPOIS da escolha, antes do preflight)...
    expect(opcoesDeTipo(o).map((x) => x.tipo)).toEqual(["email", "aceite"]);
    expect(textoDeTipos(opcoesDeTipo(o))).toContain("falta o celular de Letícia Gonçalves");
    // ...mas sem o rascunho por grupo (R25: o `options` não o traz) não há caminho: a escolha manda para a tela.
    expect(caminhoDoCelular({ papel: "proponente", nome: "Letícia Gonçalves" }, rascunhoPorGrupo(o))).toBeNull();
    // Com o rascunho (fonte futura do CM), o caminho seria o canônico do comprador.
    expect(caminhoDoCelular({ papel: "proponente", nome: "Letícia Gonçalves" }, { compradores: [{ nome: "Letícia Gonçalves" }], vendedores: [] })).toBe("compradores[0].telefone");
    // Cônjuge e testemunha o Max não grava, mas o Aceite NÃO some em silêncio: é oferecido, e a escolha explica.
    expect(caminhoDoCelular({ papel: "conjuge", nome: "Letícia Gonçalves" }, { compradores: [{ nome: "Letícia Gonçalves" }], vendedores: [] })).toBeNull();
    const semComoGravar = options({
      tiposDeAssinatura: [
        { tipo: "aceite", disponivel: false, motivo: "assinante_sem_celular", assinantesSemCelular: [{ posicao: 1, papel: "testemunha", nome: "Dora" }], texto: "Aceite" },
      ],
    });
    expect(opcoesDeTipo(semComoGravar).map((x) => x.tipo)).toEqual(["aceite"]);
  });

  // R25: a contagem e o nome são conferidos contra o RASCUNHO (a mesma fonte que o `proposal.update` indexa),
  // nunca contra `signatarios` (só quem ASSINA: um vendedor fora da assinatura sumiria da conta).
  describe("R25: o celular só é gravado com UMA pessoa no grupo do RASCUNHO e o nome batendo", () => {
    const valter = { nome: "Valter Vendedor" };
    const vera = { nome: "Vera Vendedora" };
    const leticia = { nome: "Letícia Gonçalves" };

    it("negado primeiro: rascunho com 2 vendedores (só 1 incluído na assinatura) não grava, para nenhum dos dois", () => {
      const rascunho = { compradores: [leticia], vendedores: [valter, vera] };
      for (const quem of [valter, vera]) {
        expect(resolverCelular({ papel: "vendedor", nome: quem.nome }, rascunho)).toEqual({ ok: false, motivo: "varias_pessoas" });
        expect(caminhoDoCelular({ papel: "vendedor", nome: quem.nome }, rascunho)).toBeNull();
      }
    });

    it("negado: rascunho indisponível (null/undefined) não grava, mesmo com um único signatário de nome igual", () => {
      expect(resolverCelular({ papel: "vendedor", nome: "Valter Vendedor" }, null)).toEqual({ ok: false, motivo: "rascunho_indisponivel" });
      expect(resolverCelular({ papel: "proponente", nome: "Letícia Gonçalves" }, undefined)).toEqual({ ok: false, motivo: "rascunho_indisponivel" });
    });

    it("negado: o agente não tem fonte do rascunho; `signatarios` NUNCA vira rascunho", () => {
      const o = options({ signatarios: [{ nome: "Valter Vendedor", papel: "vendedor" }, { nome: "Letícia Gonçalves", papel: "proponente" }] });
      expect(rascunhoPorGrupo(o)).toBeNull();
    });

    it("negado: 1 vendedor no rascunho com nome divergente não grava", () => {
      const rascunho = { compradores: [leticia], vendedores: [valter] };
      expect(resolverCelular({ papel: "vendedor", nome: "Outro Nome" }, rascunho)).toEqual({ ok: false, motivo: "nome_divergente" });
      expect(resolverCelular({ papel: "vendedor", nome: "" }, rascunho)).toEqual({ ok: false, motivo: "nome_divergente" });
    });

    it("negado: grupo vazio no rascunho não grava", () => {
      expect(resolverCelular({ papel: "proponente", nome: "Letícia Gonçalves" }, { compradores: [], vendedores: [valter] })).toEqual({ ok: false, motivo: "nome_divergente" });
    });

    it("negado: dois do mesmo grupo com o mesmo nome também não gravam", () => {
      const rascunho = { compradores: [], vendedores: [{ nome: "Maria Silva" }, { nome: "maria  silva" }] };
      expect(resolverCelular({ papel: "vendedor", nome: "Maria Silva" }, rascunho)).toEqual({ ok: false, motivo: "varias_pessoas" });
    });

    it("1 vendedor no rascunho com o mesmo nome (normalizado): grava em vendedores[0]", () => {
      const rascunho = { compradores: [leticia], vendedores: [valter] };
      expect(caminhoDoCelular({ papel: "vendedor", nome: "valter  VENDEDOR" }, rascunho)).toBe("vendedores[0].telefone");
      expect(caminhoDoCelular({ papel: "proprietario", nome: "Valter Vendedor" }, rascunho)).toBe("vendedores[0].telefone");
      expect(caminhoDoCelular({ papel: "proponente", nome: "Leticia Goncalves" }, rascunho)).toBe("compradores[0].telefone");
    });

    it("a posição do destinatário nem entra na conta", () => {
      expect(caminhoDoCelular({ posicao: 99, papel: "vendedor", nome: "Valter Vendedor" }, { compradores: [], vendedores: [valter] })).toBe("vendedores[0].telefone");
    });

    it("papel que o Max não grava (cônjuge, testemunha): não grava", () => {
      expect(resolverCelular({ papel: "testemunha", nome: "Dora" }, { compradores: [], vendedores: [{ nome: "Dora" }] })).toEqual({ ok: false, motivo: "papel_nao_gravavel" });
    });

    it("sem como casar, o Aceite continua na lista (nada some em silêncio): a escolha é que explica", () => {
      const o = options({
        signatarios: [{ nome: "Letícia Gonçalves", papel: "proponente" }],
        tiposDeAssinatura: [
          { tipo: "email", disponivel: true, texto: "E-mail" },
          { tipo: "aceite", disponivel: false, motivo: "assinante_sem_celular", assinantesSemCelular: [{ posicao: 2, papel: "vendedor", nome: "Valter Vendedor" }], texto: "Aceite" },
        ],
      });
      expect(opcoesDeTipo(o).map((x) => x.tipo)).toEqual(["email", "aceite"]);
    });
  });

  it("conta sem Plus: tipo indisponível não aparece", () => {
    const o = options({
      tiposDeAssinatura: [
        { tipo: "email", disponivel: true, texto: "E-mail" },
        { tipo: "whatsapp", disponivel: false, motivo: "plano_sem_plus", texto: "WhatsApp" },
        { tipo: "aceite", disponivel: false, motivo: "aceite_desligado", texto: "Aceite" },
      ],
    });
    expect(opcoesDeTipo(o).map((x) => x.tipo)).toEqual(["email"]);
    expect(lerTipoDeAssinatura("whatsapp", opcoesDeTipo(o))).toBe("indisponivel");
    expect(lerTipoDeAssinatura("1", opcoesDeTipo(o))).toEqual({ tipo: "email" });
    // Assinatura não configurada: nada é oferecido.
    expect(opcoesDeTipo(options({ assinaturaConfigurada: false }))).toEqual([]);
    // WhatsApp sem Plus mas que cabe como Aceite: aparece dizendo que sai como Aceite.
    const saiComoAceite = options({
      tiposDeAssinatura: [{ tipo: "whatsapp", disponivel: true, saiComo: "aceite", motivo: "plano_sem_plus", custoCentavos: 99, texto: "WhatsApp" }],
    });
    expect(textoDeTipos(opcoesDeTipo(saiComoAceite))).toContain("vai sair como *Aceite*");
  });

  it("409 documento_proprio: o aviso de perda de edição é a frase exata do contrato", () => {
    expect(avisoDeRegerar()).toBe("Isso refaz o documento e apaga as edições feitas nele. Confirma? SIM/NÃO");
  });
});
