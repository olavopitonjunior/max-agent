/**
 * O envio para assinatura no fluxo v2 (PR-D, T14): testemunhas, tipo de assinatura, preflight,
 * resumo com o instrumento e o "sim" que manda. Tudo em texto numerado (o Newton nunca tem Flow); o
 * Max com `MAX_FLOW_ID_REVISAR_ASSINATURA` ganha o Flow de assinatura (testemunhas + tipo) com o
 * token/nonce do C2 (`fv2:assinatura:<nonce>`).
 *
 * Regras que este arquivo cumpre (CONTRATO max.md §18.13):
 *  - TODA escrita passa por cartão + "sim" (`lerConfirmacao`: "ok", "blz" e afins são `vago`, nunca
 *    valem). Nenhum envio sem "sim" e nenhum envio com instrumento diferente do que o corretor VIU;
 *  - `idempotencyKey` = `messageId` do PRIMEIRO "sim" do cartão. Resposta perdida ou 409
 *    `ja_enviando` guarda a chave em `f.chave` e o "sim" seguinte a REPETE (não duplica); 409
 *    `instrumento_mudou` é canônico no servidor: a chave morre, refaz o preflight, novo resumo, novo "sim";
 *  - o canal é escolhido AQUI, na hora da assinatura: o rascunho nasce sem `canal` (D4) e
 *    `tipo_assinatura` só aparece no preflight/update/send deste passo;
 *  - `tipoEfetivo`/`bloqueio` do preflight vêm do estado GRAVADO: para mudar o canal grava-se antes
 *    (`proposal.update { tipo_assinatura }`, com cartão e "sim") e repete-se o preflight;
 *  - 409 `documento_proprio`: o aviso de perda de edição (`avisoDeRegerar`) vem ANTES de qualquer "sim"
 *    que regere o documento;
 *  - 403 `fluxo_desligado` em verbo v2: rebaixa para o v1 com o que existe e segue o v1, sem mensagem
 *    de erro (D3);
 *  - nunca escreve ao cliente final: só o corretor fala aqui. O canal do envio é decidido pelo servidor
 *    no `proposal.send`, depois do "sim";
 *  - sem dado pessoal em log ou checkpoint: o estado só leva ids opacos e escolhas.
 *
 * Nenhuma chamada de modelo é feita neste arquivo (nada a registrar em `AIUsage`).
 */

import { featureEnabled } from "@/lib/runtime/rollout";
import {
  TEXTO_DO_BLOQUEIO,
  TEXTO_ESCRITA_INCERTA,
  TEXTO_NAO_ENCONTREI,
  TEXTO_SEM_RESPOSTA,
  oferecerMetodos,
  pedeEnvio,
  textoSemPermissao,
  type ContextoDoTurno,
  type DepsDoFluxo,
  type PassoDoFluxo,
} from "../fluxos";
import {
  flowDisponivel,
  flowDoTexto,
  lerRespostaDoFlow,
  lerTestemunhasDoFlow,
  montarEnvioDoFlow,
  novoNonceDoFlow,
  registrarFlowDoTurno,
  tokenDoBotao,
  tokenDoFlow,
} from "../../lib/meta-flow";
import { lerConfirmacao, normalizar } from "../tools";
import {
  rascunhoPorGrupo,
  resolverCelular,
  type MotivoSemCaminho,
  avisoDeRegerar,
  comObrigatorias,
  definirTestemunhas,
  lerEscolhaDeTestemunhas,
  lerTipoDeAssinatura,
  marcadasPorPadrao,
  moeda,
  opcoesDeTipo,
  precisaDePassoDeTestemunhas,
  regraDeTestemunhas,
  textoDoErroDeTestemunhas,
  textoDeTestemunhas,
  textoDeTipos,
  textoDoCartaoDeTestemunhas,
  textoSalvarComoPadrao,
  tipoPorPalavra,
} from "./assinatura-v2";
import type { CampoObrigatorio, OptionsV2, Pendencia, TipoDeAssinatura } from "./contrato";
import {
  contarEntradaDoFluxo,
  novoFluxoV2,
  type AssinaturaEmCurso,
  type FluxoFormularioV2,
  type PassoDaAssinatura,
} from "./estado";
import { consultarOptionsDetalhado, faltandoV2, proximaPergunta, registrarPergunta } from "./proposta-v2";
import { ehFluxoDesligado, escolherVersao, rebaixarParaV1 } from "./selecao";

type Passo = PassoDoFluxo;
type Resposta = Extract<Passo, { reply: string }>;

// ─── Textos ─────────────────────────────────────────────────────────────────

const TEXTO_FLOW_ILEGIVEL =
  "Não consegui ler o formulário, então não anotei nada. Confira os campos e envie de novo, ou me diga em texto o que quer.";
const TEXTO_FLOW_ANTIGO =
  "Esse formulário é de uma etapa anterior e não vale mais, então não anotei nada. Use o formulário atual, ou me diga em texto o que quer.";
const TEXTO_FLOW_DIGITADO =
  "Isso tem cara de resposta de formulário, mas não veio do formulário desta etapa, então não anotei nada. Toque em *Revisar* ou me diga em texto o que quer.";
const TEXTO_RESOLVER_ANTES =
  "Antes de mudar qualquer coisa, preciso conferir o pedido anterior: responda *SIM* (não duplica) ou CANCELAR.";
const TEXTO_SEM_TIPO = "Nenhum tipo de assinatura está disponível para esta proposta agora. Confira as configurações de assinatura no sistema.";
const TEXTO_NAO_ENVIEI = "Certo, não enviei. O rascunho continua salvo, sem envio.";

const MOTIVOS_DO_DOCUMENTO: Record<string, string> = {
  google_doc_unavailable:
    "Não consegui gerar ou acessar o documento no Google Docs. Um administrador precisa verificar o acesso ao modelo da imobiliária.",
  google_docs: "O modelo da imobiliária está sem um documento Google Docs utilizável. Um administrador precisa revisar o modelo.",
  no_template: "Não há modelo ativo para gerar esta proposta. Um administrador precisa ativar o modelo da imobiliária.",
  edited_with_hidden: "O documento editado tem campos ocultos incompatíveis com o envio. É preciso revisar essa configuração na proposta.",
};

const TEXTO_DO_BLOQUEIO_DO_PREFLIGHT: Record<string, string> = {
  nao_editavel: "Essa proposta não está mais em rascunho, então não dá para enviar por aqui.",
  already_sending: "Já existe um envio desta proposta em andamento. Aguarde o resultado antes de tentar de novo.",
  not_configured: TEXTO_DO_BLOQUEIO.clicksign_nao_configurada ?? "",
  collision: TEXTO_DO_BLOQUEIO.signatarios_em_conflito ?? "",
  routing: TEXTO_DO_BLOQUEIO.roteamento_indisponivel ?? "",
  no_signers: TEXTO_DO_BLOQUEIO.sem_signatarios ?? "",
};

/** "manter" e variações: a escolha é o que a lista mostra marcado (e não o padrão do cadastro). */
const MANTER = /^(manter|mantem|mantenho|deixa assim|deixar assim|padrao|o padrao|igual|igual ao padrao)$/;

/** R22: quanto tempo o resumo do envio vale para um "sim". */
const VALIDADE_DO_RESUMO_MS = 15 * 60 * 1000;

const ROTULO_DO_TIPO: Record<TipoDeAssinatura, string> = { email: "e-mail", whatsapp: "WhatsApp", aceite: "Aceite no celular" };
const PAPEIS_QUE_O_MAX_EDITA = new Set(["proponente", "comprador", "vendedor", "proprietario", "locatario", "inquilino", "locador", "contraparte"]);

// ─── Entrada e utilidades ───────────────────────────────────────────────────

interface E {
  f: FluxoFormularioV2;
  options: OptionsV2;
  obrigatorios: CampoObrigatorio[];
  ctx: ContextoDoTurno;
  deps: DepsDoFluxo;
  prefixo?: string;
}

const fechar = (f: FluxoFormularioV2, ctx: ContextoDoTurno): FluxoFormularioV2 => ({
  ...contarEntradaDoFluxo(f),
  ultimaEntradaEm: ctx.agora,
  atualizadoEm: ctx.agora,
});

function dizer(e: E, f: FluxoFormularioV2 | null, reply: string, evento: string): Resposta {
  const texto = e.prefixo ? `${e.prefixo}\n${reply}` : reply;
  return { reply: texto, fluxo: f ? fechar(f, e.ctx) : null, evento };
}

/** O estado do fluxo com o passo da assinatura trocado. `aguardaCampo` só sobrevive no passo do celular. */
function noPasso(e: E, patch: Partial<AssinaturaEmCurso> & { passo: PassoDaAssinatura }): FluxoFormularioV2 {
  return {
    ...e.f,
    etapa: patch.passo === "envio_cartao" ? "envio" : "assinatura",
    fichaAgendadaEm: undefined,
    aguardaCampo: patch.passo === "celular" ? e.f.aguardaCampo : undefined,
    assinatura: { ...e.f.assinatura, ...patch },
  };
}

/** Sai do passo da assinatura (o rascunho segue no fluxo v2, sem nada a fazer). */
function semAssinatura(f: FluxoFormularioV2): FluxoFormularioV2 {
  const { assinatura: _a, chave: _c, ...resto } = f;
  return { ...resto, etapa: "compor", aguardaCampo: undefined, fichaAgendadaEm: undefined };
}

/** A chave de uma escrita: a do "sim" que já tentou (mesmo verbo), senão a `messageId` DESTE "sim". */
function chaveDe(e: E, verbo: string): string {
  return e.f.chave?.verbo === verbo ? e.f.chave.valor : e.ctx.messageId;
}

function esteiraDe(options: OptionsV2): "venda" | "locacao" {
  const locacao = (options.signatarios ?? []).some((s) => ["inquilino", "locatario", "locador"].includes(normalizar(s.papel)));
  return locacao ? "locacao" : "venda";
}

/** 403 `fluxo_desligado` num verbo v2: rebaixa para o v1 e segue o v1, sem dizer que houve erro (D3). */
async function paraOV1(e: E): Promise<Resposta> {
  const v1 = rebaixarParaV1({ ...semAssinatura(e.f), atualizadoEm: e.ctx.agora }, {});
  // `oferecerMetodos` do v1 sempre devolve resposta (nunca `liberar`), como no `retomarEnvio` do v1.
  return (await oferecerMetodos(v1, e.ctx, e.deps)) as Resposta;
}

function textoSemSistema(): string {
  return TEXTO_SEM_RESPOSTA;
}

// ─── Abertura ───────────────────────────────────────────────────────────────

/**
 * Pelo `retomarEnvio` do v1 (sem fluxo v2 aberto): só com a feature `formularios_v2` da org ligada E o
 * servidor dizendo `fluxoV2:true` para esta proposta. Qualquer outra coisa devolve `null` SEM ter
 * chamado nada: o v1 segue byte a byte.
 */
export async function abrirEnvioV2(a: {
  proposalId: string;
  natureza?: "venda" | "locacao";
  ctx: ContextoDoTurno;
  deps: DepsDoFluxo;
}): Promise<Resposta | null> {
  const { ctx, deps } = a;
  if (!ctx.orgId || !featureEnabled("formularios_v2", ctx.orgId)) return null;
  if (!deps.janelaDoTurno || !deps.extrairComJanela) return null;
  if (!ctx.policy.includes("proposal.send")) return null;
  const consulta = await consultarOptionsDetalhado(deps, { alvo: { proposalId: a.proposalId } });
  if (!consulta.ok || consulta.options.fluxoV2 !== true) return null;
  const options: OptionsV2 = consulta.options;
  if (escolherVersao({ orgId: ctx.orgId, options }) !== 2) return null;
  const f = { ...novoFluxoV2({ esteira: a.natureza ?? esteiraDe(options), agora: ctx.agora }), proposalId: a.proposalId };
  return iniciar({ f, options, obrigatorios: options.obrigatorios ?? [], ctx, deps });
}

function iniciar(e: E): Promise<Resposta> {
  const f: FluxoFormularioV2 = { ...e.f, assinatura: { passo: "testemunhas" }, chave: undefined };
  return avancar({ ...e, f });
}

// ─── O turno ────────────────────────────────────────────────────────────────

/**
 * O turno do passo da assinatura. `null` = a fala não é deste passo (o condutor segue: extração, ficha).
 * Roda ANTES do passo 2 do condutor: a `chave` de um envio sem resposta é daqui.
 */
export async function conduzirAssinatura(a: {
  f0: FluxoFormularioV2;
  options: OptionsV2;
  obrigatorios: CampoObrigatorio[];
  ctx: ContextoDoTurno;
  deps: DepsDoFluxo;
  cancelar: () => Promise<void>;
  temPendencia: boolean;
}): Promise<Passo | null> {
  const { f0, ctx } = a;
  const e: E = { f: f0, options: a.options, obrigatorios: a.obrigatorios, ctx, deps: a.deps };
  const conf = lerConfirmacao(ctx.texto);
  const as = f0.assinatura;
  const pedeOEnvio = pedeEnvio(ctx.texto);

  if (!as) {
    if (!pedeOEnvio || !f0.proposalId || f0.chave || a.temPendencia || !ctx.policy.includes("proposal.send")) return null;
    await a.cancelar();
    return iniciar(e);
  }

  // O celular de quem assina vem pelo caminho normal do condutor (campo lido, ficha, "sim"); só a
  // pergunta, a troca de tipo e o recomeço são daqui.
  if (as.passo === "celular") return conduzirCelular(e, a.temPendencia, conf, pedeOEnvio, a.cancelar);

  // Dado lido esperando o "sim" da ficha: é do condutor; gravar derruba o passo (o resumo envelhece).
  if (a.temPendencia) return null;

  if (pedeOEnvio && !f0.chave && conf === "nenhum") {
    await a.cancelar();
    return iniciar(e);
  }
  if (f0.chave && conf !== "sim") {
    await a.cancelar();
    return dizer(e, f0, TEXTO_RESOLVER_ANTES, "escrita_em_aberto");
  }

  const doFlow = await lerFlow(e, as);
  if (doFlow) {
    await a.cancelar();
    return doFlow;
  }

  let r: Resposta | null;
  switch (as.passo) {
    case "testemunhas":
      r = await passoTestemunhas(e, as, conf);
      break;
    case "testemunhas_cartao":
      r = await passoCartaoDeTestemunhas(e, as, conf);
      break;
    case "tipo":
      r = await passoTipo(e, conf);
      break;
    case "canal_cartao":
      r = await passoCanal(e, as, conf, false);
      break;
    case "regerar":
      r = await passoCanal(e, as, conf, true);
      break;
    case "envio_cartao":
      r = await passoEnvio(e, as, conf);
      break;
    default:
      r = null;
  }
  if (r) await a.cancelar();
  return r;
}

/** Depois de gravar o celular do assinante (o "sim" da ficha): segue para o preflight. */
export function retomarAposCelular(a: { f: FluxoFormularioV2; options: OptionsV2; obrigatorios: CampoObrigatorio[]; ctx: ContextoDoTurno; deps: DepsDoFluxo; prefixo?: string }): Promise<Resposta> {
  return avancar({ ...a, f: { ...a.f, aguardaCampo: undefined } });
}

// ─── Flow de assinatura (R21) ───────────────────────────────────────────────

async function lerFlow(e: E, as: AssinaturaEmCurso): Promise<Resposta | null> {
  const token = tokenDoBotao(e.ctx.botao);
  const bruto = flowDoTexto(e.ctx.texto);
  const podeFlow = as.passo === "testemunhas" || as.passo === "tipo";
  const textoComCaraDeFlow = bruto !== null && flowDisponivel("assinatura") !== null;
  if (token === null && !textoComCaraDeFlow) return null;
  // Sem token = digitado; token que não é o do último envio = antigo/forjado: nada é lido nem anotado.
  if (token === null) return dizer(e, e.f, TEXTO_FLOW_DIGITADO, "formulario_flow_sem_token");
  if (!podeFlow || !as.nonce || token !== tokenDoFlow("assinatura", as.nonce)) return dizer(e, e.f, TEXTO_FLOW_ANTIGO, "formulario_flow_antigo");
  if (!bruto) return dizer(e, e.f, TEXTO_FLOW_ILEGIVEL, "formulario_flow_invalido");
  const leitura = lerRespostaDoFlow(bruto, "assinatura");
  const testemunhas = lerTestemunhasDoFlow(bruto, e.options);
  if (!("tipo_assinatura" in leitura) || testemunhas === null) return dizer(e, e.f, TEXTO_FLOW_ILEGIVEL, "formulario_flow_invalido");
  if (!opcoesDeTipo(e.options).some((o) => o.tipo === leitura.tipo_assinatura)) {
    return dizer(e, e.f, `${TEXTO_FLOW_ILEGIVEL} Esse tipo de assinatura não está disponível para esta proposta.`, "formulario_flow_invalido");
  }
  // O Flow só preenche o cartão: o "sim" grava. Nunca grava sozinho.
  const ids = comObrigatorias(e.options, testemunhas);
  const f = noPasso(e, { passo: "testemunhas_cartao", tipo: leitura.tipo_assinatura, testemunhas: ids, nonce: undefined });
  return dizer(e, f, textoDoCartaoDeTestemunhas(e.options, ids), "assinatura_testemunhas_cartao");
}

// ─── Passos ─────────────────────────────────────────────────────────────────

/** Decide o que perguntar ou fazer agora, na ordem: pendências, testemunhas, tipo, celular, preflight. */
async function avancar(e: E): Promise<Resposta> {
  const as = e.f.assinatura ?? { passo: "testemunhas" as const };
  const { options, ctx } = e;
  if (ctx.podeEscrever === false) return dizer(e, semAssinatura(e.f), textoSemPermissao(), "sem_permissao");
  if (options.assinaturaConfigurada === false) {
    return dizer(e, semAssinatura(e.f), `${TEXTO_DO_BLOQUEIO.clicksign_nao_configurada} O rascunho continua salvo, sem envio.`, "envio_sem_clicksign");
  }
  const pendentes = (faltandoV2(options) ?? []).filter((p) => p.motivo !== "minimo_de_testemunhas");
  if (pendentes.length > 0) return voltarParaFicha(e, pendentes);

  if (!as.testemunhasOk && testemunhasAplicam(e)) return perguntarTestemunhas(e);
  if (!as.tipo) return perguntarTipo(e);
  const celular = proximoCelular(options, as.tipo);
  if (celular?.tipo === "tela") return perguntarTipo({ ...e, f: noPasso(e, { passo: "tipo", tipo: undefined, mostrado: undefined }), prefixo: celular.texto });
  if (celular) return perguntarCelular(e, celular.s);
  return preflightEResumo(e);
}

function testemunhasAplicam(e: E): boolean {
  return precisaDePassoDeTestemunhas(e.options) && e.ctx.policy.includes("proposal.create");
}

// Testemunhas ................................................................

function perguntarTestemunhas(e: E): Resposta {
  const regra = regraDeTestemunhas(e.options)!;
  const faltaMinimo = (faltandoV2(e.options) ?? []).some((p) => p.motivo === "minimo_de_testemunhas");
  if (regra.padrao.length === 0) {
    // Sem testemunha no cadastro: só importa se o mínimo ainda falta. Aí o caminho é o cadastro (não há padrão por corretor).
    if (!faltaMinimo) return perguntarTipo({ ...e, f: noPasso(e, { passo: "tipo", testemunhasOk: true }) });
    return dizer(e, semAssinatura(e.f), textoDeTestemunhas(e.options, []), "assinatura_sem_testemunhas_no_cadastro");
  }
  const marcadas = e.f.assinatura?.testemunhas ?? marcadasPorPadrao(e.options);
  const reply = textoDeTestemunhas(e.options, marcadas);
  // O Flow de assinatura (Max): testemunhas + tipo de uma vez. O corpo é a lista numerada (reserva em texto).
  let nonce: string | undefined;
  if (flowDisponivel("assinatura") && opcoesDeTipo(e.options).length > 0) {
    const n = novoNonceDoFlow();
    const flow = montarEnvioDoFlow("assinatura", e.options, {}, reply, n);
    if (flow) {
      registrarFlowDoTurno(e.ctx.messageId, flow, e.ctx.agora);
      nonce = n;
    }
  }
  return dizer(e, noPasso(e, { passo: "testemunhas", testemunhas: e.f.assinatura?.testemunhas, nonce }), reply, "assinatura_testemunhas");
}

async function passoTestemunhas(e: E, as: AssinaturaEmCurso, conf: ReturnType<typeof lerConfirmacao>): Promise<Resposta | null> {
  // "sim"/"manter" valem o que a lista mostra marcado: as marcadas do estado (depois de um 422 de teto, só as
  // obrigatórias) ou, na primeira vez, o padrão semeado. Nunca o cadastro inteiro.
  const marcadas = comObrigatorias(e.options, as.testemunhas ?? marcadasPorPadrao(e.options));
  const lida = conf === "sim" ? null : lerEscolhaDeTestemunhas(e.ctx.texto, e.options);
  const escolha = lida === null || (lida.tipo === "escolha" && MANTER.test(normalizar(e.ctx.texto))) ? ({ tipo: "escolha", ids: marcadas } as const) : lida;
  switch (escolha.tipo) {
    case "salvar_padrao":
      return dizer(e, e.f, textoSalvarComoPadrao(e.options), "assinatura_salvar_padrao");
    case "invalida":
      return dizer(e, e.f, `Esse número não está na lista.\n${textoDeTestemunhas(e.options, as.testemunhas ?? marcadasPorPadrao(e.options))}`, "assinatura_testemunhas");
    case "escolha": {
      const f = noPasso(e, { passo: "testemunhas_cartao", testemunhas: escolha.ids });
      return dizer(e, f, textoDoCartaoDeTestemunhas(e.options, escolha.ids), "assinatura_testemunhas_cartao");
    }
    default:
      return respostaCurta(e, conf) ? dizer(e, e.f, textoDeTestemunhas(e.options, as.testemunhas ?? marcadasPorPadrao(e.options)), "assinatura_testemunhas") : null;
  }
}

async function passoCartaoDeTestemunhas(e: E, as: AssinaturaEmCurso, conf: ReturnType<typeof lerConfirmacao>): Promise<Resposta | null> {
  if (conf === "nao") {
    return perguntarTestemunhas({ ...e, f: noPasso(e, { passo: "testemunhas", testemunhas: undefined }), prefixo: "Certo, não gravei." });
  }
  if (conf !== "sim") {
    if (!respostaCurta(e, conf)) return null;
    return dizer(e, e.f, `${textoDoCartaoDeTestemunhas(e.options, as.testemunhas ?? [])}`, "assinatura_testemunhas_cartao");
  }
  if (e.ctx.podeEscrever === false) return dizer(e, semAssinatura(e.f), textoSemPermissao(), "sem_permissao");
  const chave = chaveDe(e, "proposal.witnesses.set");
  const r = await definirTestemunhas(e.deps, e.f.proposalId!, as.testemunhas ?? [], chave);
  if (r.ok) {
    const f = { ...noPasso(e, { passo: "tipo", testemunhasOk: true, testemunhas: undefined }), chave: undefined };
    return avancar({ ...e, f, prefixo: "Gravei as testemunhas." });
  }
  switch (r.erro) {
    case "incerta":
    case "sem_chave":
      return dizer(e, { ...e.f, chave: { verbo: "proposal.witnesses.set", valor: chave } }, TEXTO_ESCRITA_INCERTA, "incerta_witnesses_set");
    case "fluxo_desligado":
      return paraOV1(e);
    case "teto_testemunhas":
      // Não repete o mesmo conjunto (laço de 422): volta à lista explicando o teto, só com as obrigatórias marcadas.
      return perguntarTestemunhas({
        ...e,
        f: { ...noPasso(e, { passo: "testemunhas", testemunhas: comObrigatorias(e.options, []) }), chave: undefined },
        prefixo: textoDoErroDeTestemunhas(r.erro, { maximo: r.maximo ?? regraDeTestemunhas(e.options)?.maximo }),
      });
    case "testemunha_obrigatoria":
    case "dados_invalidos":
      return perguntarTestemunhas({
        ...e,
        f: { ...noPasso(e, { passo: "testemunhas", testemunhas: undefined }), chave: undefined },
        prefixo: textoDoErroDeTestemunhas(r.erro, { maximo: r.maximo ?? regraDeTestemunhas(e.options)?.maximo }),
      });
    case "ja_enviada":
      return dizer(e, null, textoDoErroDeTestemunhas(r.erro), "ja_enviada");
    default:
      return dizer(e, semAssinatura(e.f), textoDoErroDeTestemunhas(r.erro), `witnesses_${r.erro}`);
  }
}

// Tipo ........................................................................

function perguntarTipo(e: E): Resposta {
  const opcoes = opcoesDeTipo(e.options);
  if (opcoes.length === 0) return dizer(e, semAssinatura(e.f), TEXTO_SEM_TIPO, "assinatura_sem_tipo");
  return dizer(e, noPasso(e, { passo: "tipo", tipo: undefined, mostrado: undefined, nonce: undefined }), textoDeTipos(opcoes), "assinatura_tipo");
}

async function passoTipo(e: E, conf: ReturnType<typeof lerConfirmacao>): Promise<Resposta | null> {
  const opcoes = opcoesDeTipo(e.options);
  const leitura = lerTipoDeAssinatura(e.ctx.texto, opcoes);
  if (leitura && leitura !== "indisponivel") {
    return avancar({ ...e, f: noPasso(e, { passo: "tipo", tipo: leitura.tipo, canalGravado: false, mostrado: undefined }) });
  }
  if (leitura === "indisponivel") return dizer(e, e.f, `Esse tipo de assinatura não está disponível para esta proposta.\n${textoDeTipos(opcoes)}`, "assinatura_tipo");
  return respostaCurta(e, conf) ? dizer(e, e.f, textoDeTipos(opcoes), "assinatura_tipo") : null;
}

// Celular (Aceite) ...........................................................

type ProximoCelular =
  | { tipo: "pergunta"; s: { posicao: number; papel: string; nome: string; path: string } }
  | { tipo: "tela"; texto: string }
  | null;

const POR_QUE_NAO_GRAVA: Record<MotivoSemCaminho, string> = {
  papel_nao_gravavel: "esse é um papel (cônjuge ou testemunha) que eu não edito por aqui",
  varias_pessoas: "com mais de um vendedor ou comprador o celular é preenchido na tela",
  nome_divergente: "o nome não bate com o que está no rascunho, então não sei com segurança de quem é",
  rascunho_indisponivel: "não consigo conferir no rascunho de quem é esse celular",
};

/**
 * O que fazer com o celular do Aceite (R25). Só se grava com UMA pessoa no grupo do RASCUNHO e o nome batendo
 * (`resolverCelular`); hoje o agente não tem o rascunho por grupo (`rascunhoPorGrupo` = null), então sempre tela;
 * se QUALQUER um não dá para gravar com segurança, nada é perguntado: explica e manda para a tela (sem metade feita).
 */
function proximoCelular(options: OptionsV2, tipo: TipoDeAssinatura): ProximoCelular {
  if (tipo !== "aceite") return null;
  const aceite = (options.tiposDeAssinatura ?? []).find((o) => o.tipo === "aceite");
  const achados: Array<{ posicao: number; papel: string; nome: string; path: string }> = [];
  const rascunho = rascunhoPorGrupo(options);
  for (const s of aceite?.assinantesSemCelular ?? []) {
    const r = resolverCelular(s, rascunho);
    if (!r.ok) {
      return {
        tipo: "tela",
        texto:
          `Para o Aceite falta o celular de *${s.nome}*, mas ${POR_QUE_NAO_GRAVA[r.motivo]}, então não gravei nada. ` +
          "Complete pela tela do sistema, ou escolha outro tipo de assinatura.",
      };
    }
    achados.push({ ...s, path: r.path });
  }
  const primeiro = achados[0];
  return primeiro ? { tipo: "pergunta", s: primeiro } : null;
}

function perguntarCelular(e: E, s: { posicao: number; papel: string; nome: string; path: string }): Resposta {
  const base = noPasso(e, { passo: "celular" });
  const f = registrarPergunta({ ...base, aguardaCampo: undefined }, { pergunta: "", aguarda: { parteRef: `${normalizar(s.papel)}:${s.posicao}`, path: s.path }, chave: `${s.path}#aceite` }, e.ctx.agora);
  return dizer(
    e,
    f,
    `O Aceite chega pelo celular de cada assinante e ainda falta o de *${s.nome}*. Qual é o celular com DDD? (Ou diga *e-mail* ou *WhatsApp* para mudar o tipo.)`,
    "assinatura_celular"
  );
}

async function conduzirCelular(e: E, temPendencia: boolean, conf: ReturnType<typeof lerConfirmacao>, pedeOEnvio: boolean, cancelar: () => Promise<void>): Promise<Passo | null> {
  if (pedeOEnvio && !e.f.chave && !temPendencia && conf === "nenhum") {
    await cancelar();
    return iniciar(e);
  }
  const texto = e.ctx.texto;
  const palavra = tipoPorPalavra(texto);
  const pareceCelular = texto.replace(/\D/g, "").length >= 8;
  if (!temPendencia && palavra && palavra !== "aceite" && !pareceCelular) {
    await cancelar();
    return avancar({ ...e, f: noPasso(e, { passo: "tipo", tipo: palavra, canalGravado: false, mostrado: undefined }) });
  }
  if (!temPendencia && conf === "nao") {
    await cancelar();
    return perguntarTipo({ ...e, f: { ...e.f, aguardaCampo: undefined }, prefixo: "Certo, deixei o Aceite de lado." });
  }
  // A resposta (o número) e o "sim" da ficha seguem pelo condutor.
  if (temPendencia || e.f.aguardaCampo) return null;
  if (conf === "nenhum" && texto.trim().split(/\s+/).length > 5) return null;
  await cancelar();
  const celular = proximoCelular(e.options, "aceite");
  return celular?.tipo === "pergunta" ? perguntarCelular(e, celular.s) : avancar(e);
}

// Preflight e resumo ..........................................................

interface Preflight {
  instrumento: "envelope" | "aceite";
  tipoEfetivo: TipoDeAssinatura;
  assinantes: Array<{ nome: string; papel: string; canal?: string; via?: string }>;
  consomeEnvioDoPlano: boolean;
  custoCentavos?: number;
  semLembrete: boolean;
  avisos: string[];
}

const TIPOS: ReadonlySet<string> = new Set(["email", "whatsapp", "aceite"]);

function lerPreflightPronto(body: Record<string, unknown>): Preflight | null {
  const instrumento = body.instrumento;
  const tipoEfetivo = body.tipoEfetivo;
  if ((instrumento !== "envelope" && instrumento !== "aceite") || typeof tipoEfetivo !== "string" || !TIPOS.has(tipoEfetivo)) return null;
  const assinantes = (Array.isArray(body.assinantes) ? body.assinantes : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as { nome?: unknown }).nome === "string")
    .map((x) => ({
      nome: x.nome as string,
      papel: typeof x.papel === "string" ? x.papel : "",
      ...(typeof x.canal === "string" ? { canal: x.canal } : {}),
      ...(typeof x.via === "string" ? { via: x.via } : {}),
    }));
  return {
    instrumento,
    tipoEfetivo: tipoEfetivo as TipoDeAssinatura,
    assinantes,
    consomeEnvioDoPlano: body.consomeEnvioDoPlano === true,
    ...(typeof body.custoCentavos === "number" ? { custoCentavos: body.custoCentavos } : {}),
    semLembrete: body.semLembrete === true,
    avisos: (Array.isArray(body.avisos) ? body.avisos : []).filter((x): x is string => typeof x === "string"),
  };
}

/** Códigos do servidor em português (`conjuge` → "cônjuge"). Código desconhecido não aparece: nunca cru. */
const ROTULO_DO_PAPEL: Record<string, string> = {
  proponente: "proponente",
  comprador: "comprador",
  vendedor: "vendedor",
  proprietario: "proprietário",
  locatario: "locatário",
  inquilino: "inquilino",
  locador: "locador",
  contraparte: "contraparte",
  conjuge: "cônjuge",
  testemunha: "testemunha",
};
const ROTULO_DO_CANAL: Record<string, string> = { email: "e-mail", "e-mail": "e-mail", whatsapp: "WhatsApp", celular: "celular" };

function linhaDoAssinante(s: { nome: string; papel: string; canal?: string; via?: string }): string {
  const papel = ROTULO_DO_PAPEL[normalizar(s.papel)];
  const canal = s.canal ? ROTULO_DO_CANAL[normalizar(s.canal)] : undefined;
  const como = normalizar(s.via ?? "") === "aceite" ? "pelo celular (Aceite)" : canal ? `por ${canal}` : "";
  return `   - ${s.nome}${papel ? ` (${papel})` : ""}${como ? `, ${como}` : ""}`;
}

function textoDoResumo(p: Preflight): string {
  const linhas = [
    "Antes de enviar, confira:",
    `• Instrumento: ${p.instrumento === "aceite" ? "Aceite no celular" : "envelope de assinatura digital"}`,
    `• Tipo: ${ROTULO_DO_TIPO[p.tipoEfetivo]}`,
    ...(p.assinantes.length > 0 ? ["• Assinantes:", ...p.assinantes.map(linhaDoAssinante)] : []),
    // Envelope nunca mostra preço em reais: o que consome é o limite do plano. Só o Aceite tem custo.
    ...(p.consomeEnvioDoPlano ? ["• Consome 1 envio do plano da conta."] : []),
    ...(p.instrumento === "aceite" && p.custoCentavos !== undefined ? [`• Custo: ${moeda(p.custoCentavos)}${p.semLembrete ? ", sem lembrete" : ""}.`] : []),
    ...p.avisos.map((a) => `• Aviso: ${a}`),
    "",
    "Confirma? Responda *SIM* para enviar.",
  ];
  return linhas.join("\n");
}

async function preflightEResumo(e: E): Promise<Resposta> {
  const as = e.f.assinatura!;
  const tipo = as.tipo!;
  const r = await e.deps.acao("proposal.preflight", { proposta_id: e.f.proposalId, tipo_assinatura: tipo });
  if (!r) return dizer(e, e.f, textoSemSistema(), "falha_proposal_preflight");
  if (ehFluxoDesligado(r)) return paraOV1(e);
  if (r.status === 403) return dizer(e, semAssinatura(e.f), textoSemPermissao(), "sem_permissao");
  if (r.status === 404) return dizer(e, semAssinatura(e.f), TEXTO_NAO_ENCONTREI, "proposta_nao_encontrada");
  if (r.status !== 200) return dizer(e, e.f, textoSemSistema(), `proposal_preflight_${r.status}`);

  const bloqueio = r.body.bloqueio;
  if (bloqueio && typeof bloqueio === "object") return tratarBloqueio(e, bloqueio as Record<string, unknown>, Array.isArray(r.body.faltando) ? (r.body.faltando as Pendencia[]) : []);
  const faltando = Array.isArray(r.body.faltando) ? (r.body.faltando as Pendencia[]) : [];
  if (faltando.length > 0) return voltarParaFicha(e, faltando);

  const p = lerPreflightPronto(r.body);
  if (!p) return dizer(e, e.f, textoSemSistema(), "proposal_preflight_ilegivel");

  const divergenciaAceita = tipo === "whatsapp" && p.tipoEfetivo === "aceite";
  if (p.tipoEfetivo !== tipo && !divergenciaAceita && !as.canalGravado) {
    const f = noPasso(e, { passo: "canal_cartao", mostrado: undefined });
    return dizer(
      e,
      f,
      `Hoje esta proposta está configurada para sair como ${ROTULO_DO_TIPO[p.tipoEfetivo]}. ` +
        `Para sair como ${ROTULO_DO_TIPO[tipo]} preciso gravar esse canal nos assinantes.\n\nConfirma? Responda *SIM* para gravar.`,
      "assinatura_canal_cartao"
    );
  }
  const f = noPasso(e, { passo: "envio_cartao", mostrado: { instrumento: p.instrumento, tipoEfetivo: p.tipoEfetivo, mostradoEm: e.ctx.agora } });
  return dizer(e, f, textoDoResumo(p), "envio_resumo");
}

async function tratarBloqueio(e: E, b: Record<string, unknown>, faltando: Pendencia[]): Promise<Resposta> {
  const codigo = typeof b.codigo === "string" ? b.codigo : "";
  if (codigo === "preflight" && faltando.length > 0) return voltarParaFicha(e, faltando);
  if (faltando.length > 0 && !faltando.every((p) => p.motivo === "minimo_de_testemunhas")) return voltarParaFicha(e, faltando);
  if (faltando.length > 0) return voltarParaFicha(e, faltando);
  let texto = TEXTO_DO_BLOQUEIO_DO_PREFLIGHT[codigo];
  if (codigo === "document") texto = (typeof b.motivo === "string" ? MOTIVOS_DO_DOCUMENTO[b.motivo] : undefined) ?? "O documento desta proposta não está pronto para envio. Confira o rascunho no sistema.";
  const fim = ["nao_editavel"].includes(codigo);
  return dizer(
    e,
    fim ? null : semAssinatura(e.f),
    `${texto ?? "O envio não fecha agora do jeito que a proposta está. Confira o rascunho no sistema."} O rascunho continua salvo, sem envio.`,
    `envio_bloqueado_${codigo || "desconhecido"}`
  );
}

/** Pendência de dado: volta para a ficha e pergunta o próximo campo (ou manda completar no sistema). */
function voltarParaFicha(e: E, faltando: Pendencia[]): Resposta {
  const base = semAssinatura(e.f);
  const reais = faltando.filter((p) => p.motivo !== "minimo_de_testemunhas");
  if (reais.length === 0) {
    const m = faltando.find((p) => p.motivo === "minimo_de_testemunhas");
    const link = regraDeTestemunhas(e.options)?.linkConfiguracoes;
    return dizer(
      e,
      base,
      `Para enviar, a proposta pede ${m?.minimo ?? "mais"} testemunha${m?.minimo === 1 ? "" : "s"} e só há ${m?.atual ?? 0}. Cadastre testemunhas em Configurações${link ? `: ${link}` : ""} e me peça o envio de novo.`,
      "envio_testemunhas_insuficientes"
    );
  }
  const deOutro = reais.some((p) => p.signatario && !PAPEIS_QUE_O_MAX_EDITA.has(normalizar(p.signatario.papel)));
  if (deOutro) {
    return dizer(e, base, "Para enviar falta completar dados de um assinante que eu não edito por aqui (cônjuge ou testemunha). Complete pela tela; o rascunho continua salvo.", "envio_pendencia_outro_papel");
  }
  const p = proximaPergunta(reais, new Set(), e.obrigatorios);
  if (!p) return dizer(e, base, "Para enviar ainda falta completar dados da proposta. Complete pela tela; o rascunho continua salvo.", "envio_pendencias");
  return dizer(e, registrarPergunta(base, p, e.ctx.agora), `Para enviar ainda falta um dado.\n${p.pergunta}`, "envio_pendencias");
}

// Canal (proposal.update) ......................................................

async function passoCanal(e: E, as: AssinaturaEmCurso, conf: ReturnType<typeof lerConfirmacao>, regerar: boolean): Promise<Resposta | null> {
  if (conf === "nao") {
    return perguntarTipo({ ...e, f: { ...e.f, chave: undefined }, prefixo: regerar ? "Certo, não refiz o documento." : "Certo, não mudei o canal." });
  }
  if (conf !== "sim") {
    if (!respostaCurta(e, conf)) return null;
    const pergunta = regerar ? avisoDeRegerar() : "Confirma? Responda *SIM* para gravar o canal ou NÃO para voltar.";
    return dizer(e, e.f, pergunta, regerar ? "assinatura_regerar" : "assinatura_canal_cartao");
  }
  if (e.ctx.podeEscrever === false || !e.ctx.policy.includes("proposal.create")) return dizer(e, semAssinatura(e.f), textoSemPermissao(), "sem_permissao");
  const chave = chaveDe(e, "proposal.update");
  const args: Record<string, unknown> = { proposta_id: e.f.proposalId, tipo_assinatura: as.tipo, ...(regerar ? { regerar_documento: true } : {}) };
  const r = await e.deps.acao("proposal.update", args, chave);
  const incerta = !r || (r.status === 409 && (r.body.error === "em_andamento" || r.body.error === "ja_enviando"));
  if (incerta) return dizer(e, { ...e.f, chave: { verbo: "proposal.update", valor: chave } }, TEXTO_ESCRITA_INCERTA, "incerta_proposal_update");
  if (ehFluxoDesligado(r)) return paraOV1(e);
  const limpo = { ...e.f, chave: undefined };
  if (r.status === 200) {
    return preflightEResumo({ ...e, f: { ...noPasso({ ...e, f: limpo }, { passo: "tipo", canalGravado: true }), chave: undefined }, prefixo: "Gravei o canal." });
  }
  if (r.status === 403) return dizer(e, semAssinatura(limpo), textoSemPermissao(), "sem_permissao");
  if (r.status === 404) return dizer(e, semAssinatura(limpo), TEXTO_NAO_ENCONTREI, "proposta_nao_encontrada");
  const erro = typeof r.body.error === "string" ? r.body.error : "";
  if (r.status === 409 && erro === "documento_proprio" && !regerar) {
    // O documento da proposta é próprio (editado ou gerado à mão): mudar o canal o refaz. Avisa da perda ANTES do "sim".
    const f = noPasso({ ...e, f: limpo }, { passo: "regerar" });
    return dizer(
      e,
      f,
      "Essa proposta já tem um documento próprio. Para mudar o canal preciso refazer o documento (para ver ou editar o atual, abra a proposta no sistema).\n" + avisoDeRegerar(),
      "assinatura_regerar"
    );
  }
  if (r.status === 409 && erro === "ja_enviada") return dizer(e, null, "Essa proposta já foi enviada para assinatura.", "ja_enviada");
  if (r.status === 409) {
    const texto =
      erro === "signatarios_duplicados"
        ? "Há assinantes repetidos (mesmo CPF ou contato) na proposta. Corrija na tela de propostas."
        : "Essa proposta não está mais em rascunho, ou foi editada pela tela, então não mudo o canal por aqui.";
    return dizer(e, semAssinatura(limpo), `Não gravei o canal. ${texto}`, `proposal_update_${erro || r.status}`);
  }
  if (r.status === 422 || r.status === 400) {
    return perguntarTipo({ ...e, f: limpo, prefixo: "Não consegui gravar esse canal nos assinantes. Escolha outro tipo ou ajuste no sistema." });
  }
  return dizer(e, limpo, textoSemSistema(), `proposal_update_${r.status}`);
}

// Envio ........................................................................

async function passoEnvio(e: E, as: AssinaturaEmCurso, conf: ReturnType<typeof lerConfirmacao>): Promise<Resposta | null> {
  if (conf === "nao") return dizer(e, semAssinatura(e.f), TEXTO_NAO_ENVIEI, "envio_cancelado");
  if (conf !== "sim") {
    // "ok", "blz" e afins nunca enviam: pedem o SIM de novo.
    if (!respostaCurta(e, conf)) return null;
    return dizer(e, e.f, "Para enviar, responda *SIM*. Se não for enviar, responda NÃO ou CANCELAR.", "envio_resumo");
  }
  if (e.ctx.podeEscrever === false) return dizer(e, semAssinatura(e.f), textoSemPermissao(), "sem_permissao");
  const mostrado = as.mostrado;
  if (!mostrado || !as.tipo) return perguntarTipo({ ...e, prefixo: "Preciso refazer o resumo antes de enviar." });
  // R22: o resumo vale 15 minutos. Depois, a lista de assinantes pode ter mudado na tela sem mudar o instrumento
  // (o `instrumento_confirmado` não cobre isso): refaz o preflight, mostra o resumo e pede NOVO "sim". Nunca envia.
  // R23: se um envio anterior ficou sem resposta (`f.chave` de `proposal.send`), a chave pendente SEGUE no estado e é a
  // que o próximo send usa: se aquele primeiro chegou ao servidor, ele deduplica em vez de enviar duas vezes.
  if (mostrado.mostradoEm === undefined || e.ctx.agora - mostrado.mostradoEm > VALIDADE_DO_RESUMO_MS) {
    const pendente = e.f.chave?.verbo === "proposal.send" ? e.f.chave : undefined;
    return preflightEResumo({
      ...e,
      f: { ...noPasso(e, { passo: "tipo", mostrado: undefined }), chave: pendente },
      prefixo: "O resumo tem mais de 15 minutos, então conferi de novo antes de enviar e não enviei nada.",
    });
  }
  const chave = chaveDe(e, "proposal.send");
  // §18.13.7: o envio leva os MESMOS parâmetros do preflight que o corretor viu (`tipo_assinatura` = o do preflight).
  const tipoDoEnvio: TipoDeAssinatura = as.tipo;
  const r = await e.deps.acao(
    "proposal.send",
    { proposta_id: e.f.proposalId, instrumento_confirmado: mostrado.instrumento, tipo_assinatura: tipoDoEnvio },
    chave
  );
  const incerta = !r || (r.status === 409 && (r.body.error === "em_andamento" || r.body.error === "ja_enviando"));
  if (incerta) return dizer(e, { ...e.f, chave: { verbo: "proposal.send", valor: chave } }, TEXTO_ESCRITA_INCERTA, "incerta_proposal_send");
  if (ehFluxoDesligado(r)) return paraOV1(e);
  const limpo = { ...e.f, chave: undefined };
  const erro = typeof r.body.error === "string" ? r.body.error : "";

  if (r.status === 200) {
    const avisos = (Array.isArray(r.body.avisos) ? r.body.avisos : []).filter((x): x is string => typeof x === "string").slice(0, 3);
    const como = mostrado.instrumento === "aceite" ? "Aceite no celular" : "envelope de assinatura";
    return dizer(e, null, `Proposta enviada para assinatura (${como}).${avisos.length ? `\n${avisos.map((a) => `• ${a}`).join("\n")}` : ""}`, "proposta_enviada");
  }
  if (r.status === 409 && erro === "instrumento_mudou") {
    // O que o corretor viu não vale mais: refaz o preflight, mostra o resumo novo e pede NOVO "sim" (chave nova).
    return preflightEResumo({ ...e, f: { ...noPasso({ ...e, f: limpo }, { passo: "tipo", mostrado: undefined }), chave: undefined }, prefixo: "O envio mudou desde o resumo que mostrei, então não enviei nada." });
  }
  if (r.status === 409 && erro === "ja_enviada") return dizer(e, null, "Essa proposta já foi enviada.", "ja_enviada");
  if (r.status === 403) return dizer(e, semAssinatura(limpo), textoSemPermissao(), "sem_permissao");
  if (r.status === 404) return dizer(e, semAssinatura(limpo), TEXTO_NAO_ENCONTREI, "proposta_nao_encontrada");
  if (r.status === 402) return dizer(e, null, "O plano de assinaturas da imobiliária esgotou. Fale com o administrador.", "plano_esgotado");
  if (r.status === 422 && erro === "pendencias" && Array.isArray(r.body.faltando)) return voltarParaFicha({ ...e, f: limpo }, r.body.faltando as Pendencia[]);
  if (erro === "documento_indisponivel") {
    const motivo = typeof r.body.motivo === "string" ? MOTIVOS_DO_DOCUMENTO[r.body.motivo] : undefined;
    return dizer(
      e,
      semAssinatura(limpo),
      `${motivo ?? "Não consegui preparar o documento para assinatura. A equipe responsável precisa verificar a geração do documento."} A proposta está salva, mas o envio falhou. Depois da correção, me peça para enviar esta mesma proposta novamente.`,
      "envio_bloqueado_documento_indisponivel"
    );
  }
  const bloqueio = TEXTO_DO_BLOQUEIO[erro];
  if (bloqueio) return dizer(e, null, `${bloqueio} O rascunho continua salvo, sem envio.`, `envio_bloqueado_${erro}`);
  return dizer(e, limpo, textoSemSistema(), `proposal_send_${r.status}`);
}

// ─── Utilidades de leitura ──────────────────────────────────────────────────

/** Fala curta e sem dado: é uma resposta mal formada ao passo, não outro assunto nem correção de dado. */
function respostaCurta(e: E, conf: ReturnType<typeof lerConfirmacao>): boolean {
  const t = e.ctx.texto;
  if (/@|\d{6,}/.test(t.replace(/[\s().-]/g, ""))) return false;
  return conf === "vago" || conf === "sim" || conf === "nao" || t.trim().split(/\s+/).length <= 4;
}
