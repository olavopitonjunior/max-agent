import { describe, expect, it, vi } from "vitest";
import {
  avisoDeRegerar,
  caminhoDoCelular,
  comObrigatorias,
  definirTestemunhas,
  lerEscolhaDeTestemunhas,
  lerTipoDeAssinatura,
  marcadasPorPadrao,
  opcoesDeTipo,
  textoDeTestemunhas,
  textoDeTipos,
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
    const emAndamento = depsCom({ status: 409, body: { error: "envio_em_andamento" } });
    expect(await definirTestemunhas(emAndamento.deps, "p", [], "k")).toEqual({ ok: false, erro: "nao_editavel" });
  });

  it("nenhum texto de erro afirma que gravou", () => {
    for (const erro of ["teto_testemunhas", "testemunha_obrigatoria", "nao_editavel", "sem_permissao", "dados_invalidos", "incerta"] as const) {
      expect(textoDoErroDeTestemunhas(erro)).toMatch(/n[aã]o gravei|n[aã]o consegui|n[aã]o tem permiss/i);
    }
  });
});

describe("T13: testemunhas e tipo de assinatura", () => {
  it("padrão por escopo vem marcado; não existe padrão por corretor", () => {
    const o = options();
    // Todas as do cadastro vêm marcadas; a obrigatória nunca sai da escolha.
    expect(marcadasPorPadrao(o)).toEqual(["t-1", "t-2", "t-3"]);
    expect(comObrigatorias(o, [])).toEqual(["t-1"]);
    expect(comObrigatorias(o, ["t-3"])).toEqual(["t-1", "t-3"]);
    // O padrão é lido só do `options` (por escopo): outro options (outro escopo) dá outro padrão, sem estado de corretor.
    const outroEscopo = options({ testemunhas: { minimo: 0, maximo: 4, padrao: [{ idPadrao: "x-9", nome: "Dora", obrigatoria: false, podeAceite: true }], linkConfiguracoes: LINK } });
    expect(marcadasPorPadrao(outroEscopo)).toEqual(["x-9"]);
    expect(marcadasPorPadrao(o)).toEqual(["t-1", "t-2", "t-3"]);
    // A lista mostra as marcadas e a obrigatória.
    const texto = textoDeTestemunhas(o, marcadasPorPadrao(o));
    expect(texto).toContain("1. ✅ Ana Testemunha (obrigatória)");
    expect(texto).toContain("2. ✅ Beto Testemunha");
  });

  it("lê números, manter e nenhuma; número fora da lista é recusa e a obrigatória nunca sai", () => {
    const o = options();
    expect(lerEscolhaDeTestemunhas("2", o)).toEqual({ tipo: "escolha", ids: ["t-1", "t-2"] });
    expect(lerEscolhaDeTestemunhas("2 3", o)).toEqual({ tipo: "escolha", ids: ["t-1", "t-2", "t-3"] });
    expect(lerEscolhaDeTestemunhas("manter", o)).toEqual({ tipo: "escolha", ids: ["t-1", "t-2", "t-3"] });
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
    // ...e o caminho que o condutor vai perguntar é o canônico do comprador.
    expect(caminhoDoCelular({ posicao: 1, papel: "proponente" })).toBe("compradores[0].telefone");
    expect(caminhoDoCelular({ posicao: 2, papel: "vendedor" })).toBe("vendedores[1].telefone");
    // Cônjuge e testemunha o Max não grava: o Aceite com um assim faltando não é oferecido.
    expect(caminhoDoCelular({ posicao: 1, papel: "conjuge" })).toBeNull();
    const semComoGravar = options({
      tiposDeAssinatura: [
        { tipo: "aceite", disponivel: false, motivo: "assinante_sem_celular", assinantesSemCelular: [{ posicao: 1, papel: "testemunha", nome: "Dora" }], texto: "Aceite" },
      ],
    });
    expect(opcoesDeTipo(semComoGravar)).toEqual([]);
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
