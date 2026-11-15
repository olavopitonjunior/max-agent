/**
 * O condutor do fluxo v2 de proposta (PR-C1).
 *
 * Um turno, nesta ordem:
 *   0. "cancelar" encerra (e cancela a ficha agendada);
 *   1. fail-closed: sem a janela de extração (feature desligada) ou com o servidor
 *      dizendo `fluxoV2:false`, o turno é liberado e o fluxo cai para o v1 (D3);
 *   2. escrita pendente sem resposta (`chave`) só aceita o SIM de volta (não duplica);
 *   3. "sim"/"não" ao cartão: só vale depois de o corretor ter VISTO a ficha;
 *   4. a resposta ao campo perguntado, ou a extração da janela de mensagens, vira
 *      CAMPO LIDO pendente (cofre cifrado; nada de PII no checkpoint). Nunca grava;
 *   5. ficha ✅/⬜/📄: na hora (pediu, completo, mídia lida, 20 s de silêncio) ou
 *      agendada para a pausa, e o turno fica em silêncio. Nunca "anotei".
 *
 * Quem grava é o "sim" ao cartão (`gravarLidos` → `salvarParcial`, com a messageId do
 * "sim" como idempotencyKey). O que o servidor diz que falta (`faltando`) é a autoridade:
 * o Max não recalcula pendência.
 *
 * PR-C2 (T11/T12): a REVISÃO do rascunho. Max com Flow publicado (`MAX_FLOW_ID_*`, flag e provedor):
 * um Flow por passo; sem Flow, e sempre no Newton, a ficha numerada. A resposta do Flow ("nfm_reply")
 * é DADO: só vale com o token do último envio (`fv2:<passo>:<nonce>`, no `button_payload`), passa por
 * zod e pela mesma leitura do texto livre, vira campo lido, ficha com cartão e o "sim" de sempre.
 * Nunca grava sozinha. Link da tela nunca: texto fixo "abra a proposta no sistema" (R20).
 *
 * Fora do escopo: escolha do canal de assinatura, envio e correção pós-envio (T13/C3).
 */

import {
  TEXTO_ESCRITA_INCERTA,
  TEXTO_FLUXO_CANCELADO,
  pedeEnvio,
  querCancelar,
  textoSemModelo,
  type ContextoDoTurno,
  type DepsDoFluxo,
  type PassoDoFluxo,
} from "../fluxos";
import {
  flowDisponivel,
  flowDoTexto,
  lerRespostaDoFlow,
  montarEnvioDoFlow,
  novoNonceDoFlow,
  registrarFlowDoTurno,
  tokenDoBotao,
  tokenDoFlow,
} from "../../lib/meta-flow";
import { lerConfirmacao, normalizar } from "../tools";
import type { CampoObrigatorio, OptionsV1, OptionsV2, Pendencia } from "./contrato";
import { contarEntradaDoFluxo, novoFluxoV2, type FluxoFormularioV2, type PassoDeRevisao, type RevisaoEmCurso } from "./estado";
import { camposDoPatchExtraido, TOOL_PATCH_V2 } from "./extracao";
import { deveMostrarFicha, montarResumo, pediuAFicha, renderizarFicha } from "./ficha";
import {
  gravarLidos,
  lidosDoCofre,
  registrarLidos,
  type CampoLido,
  type GrupoDaParte,
  type OpcoesDaGravacao,
  type PartesGravadas,
} from "./midia";
import { lerIntencaoDeFormulario, toleranteNaOrg } from "./intencao";
import { agendarFicha, cancelarFicha, fichaFoiEntregue, PAUSA_DA_FICHA_MS } from "./pausa";
import {
  caminhoCanonico,
  consultarOptions,
  consultarOptionsDetalhado,
  faltandoV2,
  lerRespostaAoCampo,
  pendenciasIniciais,
  proximaPergunta,
  registrarPergunta,
  textoDoParcial,
} from "./proposta-v2";
import { itensDaRevisao, lerCorrecaoNumerada, pedeRevisao, textoDaRevisao } from "./revisao";
import { signatariosPorLado } from "./partes";
import { conduzirAssinatura, retomarAposCelular } from "./envio-v2";
import { escolherVersao, rebaixarParaV1 } from "./selecao";

const TEXTO_SEM_SISTEMA = "Não consegui falar com o sistema agora. Tenta de novo em instantes.";
const TEXTO_SEM_COFRE =
  "Não consigo guardar isso com segurança agora, então não anotei nada. Mande de novo daqui a pouco ou preencha pelo sistema.";
const TEXTO_RESOLVER_ANTES =
  "Antes de mudar qualquer coisa, preciso conferir o pedido anterior: responda *SIM* (não duplica) ou CANCELAR.";
const TEXTO_DESCARTADO = "Descartei. Nada foi anotado.";

type Passo = PassoDoFluxo;

// ─── Partes que o servidor já tem ───────────────────────────────────────────

/** Nome por posição de quem já está no rascunho (de `options.signatarios`). Só vive no turno. */
export function partesDe(options: OptionsV2): PartesGravadas {
  const por = signatariosPorLado(options);
  return { compradores: por.compradores.map((s) => s.nome), vendedores: por.vendedores.map((s) => s.nome) };
}

// ─── schemaType ─────────────────────────────────────────────────────────────

/** O modelo da esteira: um só = esse; vários (locação residencial/comercial) = `null` (perguntar). */
export function derivarSchema(options: OptionsV2, esteira: "venda" | "locacao"): string | null {
  const candidatos = (options.modalidades ?? []).filter((m) => m.esteira === esteira && m.modeloDisponivel);
  return candidatos.length === 1 ? candidatos[0]!.schemaType : null;
}

function lerFinalidade(options: OptionsV2, esteira: "venda" | "locacao", texto: string): string | null {
  const t = normalizar(texto);
  const quer = /comercial/.test(t) ? "comercial" : /residencial/.test(t) ? "residencial" : null;
  if (!quer) return null;
  const achados = (options.modalidades ?? []).filter((m) => m.esteira === esteira && m.modeloDisponivel && normalizar(m.schemaType).includes(quer));
  return achados.length === 1 ? achados[0]!.schemaType : null;
}

// ─── Textos ─────────────────────────────────────────────────────────────────

function textoCancelado(f: FluxoFormularioV2): string {
  if (f.chave) return "Parei por aqui. O pedido anterior pode ter sido registrado — confira no sistema.";
  if (f.proposalId) return "Parei por aqui. O rascunho continua salvo no sistema, sem envio.";
  return TEXTO_FLUXO_CANCELADO;
}

const PAPEL_DO_GRUPO: Record<GrupoDaParte, string> = { compradores: "comprador", vendedores: "vendedor" };

function perguntaDoConflito(grupo: GrupoDaParte, posicao: number, nomeAtual: string | undefined): string {
  const papel = PAPEL_DO_GRUPO[grupo];
  const quem = nomeAtual ? `*${nomeAtual}* como ${papel} ${posicao + 1}` : `o ${papel} ${posicao + 1}`;
  return (
    `O rascunho já tem ${quem}, e não consegui confirmar que o que você mandou é da mesma pessoa. ` +
    `Responda *é um novo* (entra mais um ${papel}) ou *é o mesmo, troca* (substitui o que está no rascunho). ` +
    "Se quiser largar o que você mandou, diga *descarta*."
  );
}

type RespostaDoConflito = "novo" | "mesmo" | "nao" | null;

const PALAVRA_DE_NEGACAO = /^(?:nao|nunca|jamais|sem)$/;
const TERMO_NOVO = /\b(?:novo|nova|outro|outra|diferente|mais um|mais uma)\b/g;
const TERMO_MESMO = /\b(?:mesmo|mesma)\b/g;
const VERBO_DE_TROCA = /\b(?:troca|trocar|substitui|substituir|corrige|corrigir)\b/g;
const VERBO_DE_DESCARTE = /\b(?:descart\w*|esquec\w*|ignor\w*|deixa pra la|deixa isso pra la)\b/g;
/** Palavra que carrega voto/ordem: a janela da negação não a atravessa ("não corrige é outra": o "não" é do "corrige"). */
const PALAVRA_DE_VOTO = /^(?:novo|nova|outro|outra|diferente|mais|mesmo|mesma|troca|trocar|substitui|substituir|corrige|corrigir|descart\w*|esquec\w*|ignor\w*|deixa)$/;

/**
 * Para cada ocorrência do termo na oração: está negada, e qual "não" a negou? Negação ANTES
 * (até 2 palavras, sem atravessar outro termo/verbo) ou no FIM da oração ("é a mesma não").
 * `consumidas` guarda as posições dos "não" que já têm dono.
 */
function ocorrencias(re: RegExp, oracao: string, consumidas: Set<number>): boolean[] {
  const palavras = [...oracao.matchAll(/\w+/g)];
  return [...oracao.matchAll(re)].map((m) => {
    const ini = m.index ?? 0;
    const antes = palavras.filter((p) => (p.index ?? 0) + p[0].length <= ini);
    for (let i = 1; i <= 3 && i <= antes.length; i++) {
      const p = antes[antes.length - i]!;
      if (PALAVRA_DE_NEGACAO.test(p[0])) {
        consumidas.add(p.index ?? 0);
        return true;
      }
      if (PALAVRA_DE_VOTO.test(p[0])) break;
    }
    const depois = /^\s*(nao|nunca)\s*$/.exec(oracao.slice(ini + m[0].length));
    if (depois) {
      consumidas.add(oracao.lastIndexOf(depois[1]!));
      return true;
    }
    return false;
  });
}

/**
 * A resposta ao conflito (N1/I2), oração por oração. A negação vira o voto OPOSTO só onde o
 * oposto é a leitura natural ("não é o mesmo" = novo; "não é outro" = o mesmo); verbo de troca
 * negado ("não troca", "não corrige") NÃO vota: o corretor não disse o que quer, pergunta de novo.
 * Votos divergentes, "não" sozinho e silêncio também perguntam de novo. Só uma ordem explícita
 * ("descarta", "esquece") descarta: um "não" solto nunca joga fora o que o corretor mandou.
 */
function lerConflito(texto: string): RespostaDoConflito {
  const votos = new Set<"novo" | "mesmo">();
  let descarta = false;
  // Um "não" que nenhum termo/verbo da oração reivindicou ("não, é o mesmo", "é a mesma, não") ou
  // que negou um verbo de troca é dúvida: nunca deixa a resposta virar "o mesmo" (que substitui
  // o que está no rascunho).
  let negacaoSolta = false;
  for (const bruta of texto.split(/[,.;!?\n]+/)) {
    const o = normalizar(bruta);
    if (!o) continue;
    const consumidas = new Set<number>();
    for (const negado of ocorrencias(TERMO_NOVO, o, consumidas)) votos.add(negado ? "mesmo" : "novo");
    for (const negado of ocorrencias(TERMO_MESMO, o, consumidas)) votos.add(negado ? "novo" : "mesmo");
    // Verbo de troca negado ("não troca, é o mesmo") não vota E segura o voto "mesmo": mesmo caminho da negação solta.
    for (const negado of ocorrencias(VERBO_DE_TROCA, o, consumidas)) {
      if (negado) negacaoSolta = true;
      else votos.add("mesmo");
    }
    for (const negado of ocorrencias(VERBO_DE_DESCARTE, o, consumidas)) if (!negado) descarta = true;
    for (const m of o.matchAll(/\b(?:nao|nunca|jamais|sem)\b/g)) if (!consumidas.has(m.index ?? -1)) negacaoSolta = true;
  }
  if (votos.size > 1) return null;
  if (votos.size === 1) {
    if (descarta) return null;
    const voto = [...votos][0]!;
    return voto === "mesmo" && negacaoSolta ? null : voto;
  }
  return descarta ? "nao" : null;
}

// ─── Utilidades ─────────────────────────────────────────────────────────────

function limparLidos(f: FluxoFormularioV2): FluxoFormularioV2 {
  const { cofreLidos: _cofre, ...resto } = f;
  return { ...resto, lidosPendentes: [] };
}

/** A resposta ao campo (patch) como campos lidos, na forma canônica do cofre. */
function camposDoPatch(patch: unknown): CampoLido[] {
  const out: CampoLido[] = [];
  const achatar = (prefixo: string, v: unknown): void => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => achatar(`${prefixo}[${i}]`, item));
      return;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === "substituir") continue;
        achatar(prefixo ? `${prefixo}.${k}` : k, x);
      }
      return;
    }
    // `perguntado`: a posição vem do `faltando` do servidor (o Max perguntou por este campo), então
    // um CPF aqui é do dono da posição mesmo sem nome junto (I1).
    if (prefixo) out.push({ path: prefixo, valor: String(v), confianca: 1, perguntado: true });
  };
  achatar("", patch);
  return out;
}

/** CPF e CNPJ ocupam o mesmo lugar do rascunho: um cobre o outro. */
const mesmoLugar = (path: string): string => path.replace(/\.cnpj$/, ".cpf");

/** O que o servidor ainda pede MENOS o que já está lido (e aguarda o "sim"). */
function faltandoDepoisDosLidos(faltando: Pendencia[], lidos: CampoLido[]): Pendencia[] {
  const cobertos = new Set(lidos.map((c) => mesmoLugar(c.path)));
  return faltando.filter((p) => p.motivo === "minimo_de_testemunhas" || !cobertos.has(mesmoLugar(caminhoCanonico(p.campo, p.signatario))));
}

/**
 * I3: depois do SIM (gravou) ou do NÃO (descartou) a janela de extração recomeça. Chamar com o fluxo
 * já fechado (`fecha`): a mensagem do SIM/NÃO também fica para trás.
 */
function recomecaJanela(f: FluxoFormularioV2): FluxoFormularioV2 {
  return { ...f, janelaDesde: f.mensagensDoFluxo ?? 0 };
}

function textoDosDescartados(descartados: string[]): string {
  return descartados.length === 1
    ? "Um dado não cabe na proposta e ficou de fora."
    : `${descartados.length} dados não cabem na proposta e ficaram de fora.`;
}

// ─── O turno ────────────────────────────────────────────────────────────────

/**
 * Abertura do fluxo v2 (D3: a versão é decidida aqui, uma vez). `null` = segue o v1
 * (feature da org desligada, servidor sem `fluxoV2` ou sem resposta: nunca inventa o v2).
 *
 * Se o pedido que abriu o fluxo é a própria fala deste turno, ele já passa pelo condutor
 * (sem fila: a abertura nunca fica em silêncio, a ficha vem na hora). Senão (o "1" da
 * escolha, a natureza dita depois) o v2 abre e convida o corretor a mandar os dados.
 */
export async function abrirV2(
  natureza: "venda" | "locacao",
  pedido: string | undefined,
  agora: number,
  deps: DepsDoFluxo,
  ctx: ContextoDoTurno
): Promise<Extract<Passo, { reply: string }> | null> {
  if (!ctx.orgId || !deps.janelaDoTurno || !deps.extrairComJanela) return null;
  const options = await consultarOptions(deps, { tipo: natureza });
  if (!options) return null;
  if (escolherVersao({ orgId: ctx.orgId, options }) !== 2) return null;
  // P4: a intenção é lida aqui (o servidor já disse `fluxoV2`). Um pedido de CORREÇÃO ("corrige a
  // proposta da Maria") não abre formulário novo nem entra no extrator como dado de proposta:
  // pergunta pelo alvo. Pergunta ("corrige?"), negação ("não corrige") e particípio não são pedido.
  if (pedido && toleranteNaOrg(ctx.orgId, { fluxoV2: (options as OptionsV2).fluxoV2 })) {
    const intencao = lerIntencaoDeFormulario(pedido);
    if (intencao && (intencao.tipo === "corrigir_dado" || intencao.tipo === "corrigir_redacao")) {
      return { reply: TEXTO_CORRECAO_SEM_ALVO, fluxo: null, evento: "formulario_correcao" };
    }
  }
  const modalidades = (options as OptionsV2).modalidades ?? [];
  if (modalidades.length > 0 && !modalidades.some((m) => m.esteira === natureza && m.modeloDisponivel)) {
    return { reply: textoSemModelo(natureza), fluxo: null, evento: "proposta_sem_modelo" };
  }
  const f0 = novoFluxoV2({ esteira: natureza, agora });
  if (pedido && pedido === ctx.texto) {
    const passo = await conduzirV2(f0, { ...ctx, agora, subjectKey: undefined }, deps);
    if (!passo.liberar && passo.reply) return passo;
  }
  return {
    reply: textoAberturaV2(natureza),
    fluxo: { ...f0, ultimaEntradaEm: agora, atualizadoEm: agora },
    evento: "formulario_aberto",
  };
}

const TEXTO_CORRECAO_SEM_ALVO =
  "Isso parece a correção de algo que já existe, e eu ainda não corrijo por aqui. Para começar uma proposta nova, diga *nova proposta*.";

function textoAberturaV2(natureza: "venda" | "locacao"): string {
  const oque = natureza === "locacao" ? "locação" : "compra e venda";
  return `Certo, vamos montar a proposta de ${oque}. Pode mandar os dados do jeito que preferir: texto, áudio ou foto dos documentos. Quando terminar, é só dizer *ficha* e eu mostro o que entendi.`;
}

export async function conduzirV2(f0: FluxoFormularioV2, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<Passo> {
  const thread = ctx.thread ?? "";
  const cancelar = async (): Promise<void> => {
    if (ctx.subjectKey && deps.pausa) await cancelarFicha(deps.pausa, ctx.subjectKey);
  };
  /** O turno foi do fluxo: conta a entrada e carimba o instante (base da próxima pausa). */
  const fecha = (f: FluxoFormularioV2): FluxoFormularioV2 => ({ ...contarEntradaDoFluxo(f), ultimaEntradaEm: ctx.agora, atualizadoEm: ctx.agora });

  // 0. cancelar
  if (querCancelar(ctx.texto)) {
    await cancelar();
    return { reply: textoCancelado(f0), fluxo: null, evento: "fluxo_cancelado" };
  }

  // 1. fail-closed
  if (!deps.janelaDoTurno || !deps.extrairComJanela) {
    await cancelar();
    return { liberar: true, fluxo: null, evento: "fluxo_v2_desligado" };
  }
  const pendentes0 = lidosDoCofre(f0, thread);
  const temPendencia = pendentes0.length > 0 || f0.lidosPendentes.length > 0;
  const conf = lerConfirmacao(ctx.texto);

  const consulta = await consultarOptionsDetalhado(deps, f0.proposalId ? { alvo: { proposalId: f0.proposalId } } : { tipo: f0.esteira, schemaType: f0.schemaType });
  if (!consulta.ok) {
    if (consulta.motivo === "indisponivel") {
      // C2: falta de resposta é TRANSITÓRIA. Nunca derruba o fluxo, e só vira "sistema fora do ar"
      // quando a fala era do fluxo (SIM/NÃO ao que está pendente, pedido da ficha, escrita em aberto);
      // o resto do atendimento segue sem essa mensagem à toa. O turno conta como do fluxo (I4) para
      // a janela de extração não perder o passo.
      if (f0.chave) {
        return { reply: conf === "sim" ? TEXTO_SEM_SISTEMA : TEXTO_RESOLVER_ANTES, fluxo: contarEntradaDoFluxo(f0), evento: "formulario_sem_sistema" };
      }
      const doFluxo = ((conf === "sim" || conf === "nao") && temPendencia) || pediuAFicha(ctx.texto);
      if (doFluxo) return { reply: TEXTO_SEM_SISTEMA, fluxo: contarEntradaDoFluxo(f0), evento: "formulario_sem_sistema" };
      return { liberar: true, fluxo: contarEntradaDoFluxo(f0), evento: "formulario_sem_sistema" };
    }
    // 400 (o servidor não conhece o alvo/esteira) e 403 `fluxo_desligado` são DEFINITIVOS: o v2 não
    // tem como continuar. Libera o turno; com rascunho o v1 retoma.
    await cancelar();
    return { liberar: true, fluxo: f0.proposalId ? rebaixarParaV1(f0, {}) : null, evento: "fluxo_v2_desligado" };
  }
  const bruto = consulta.options;
  if (bruto.fluxoV2 !== true) {
    await cancelar();
    return { liberar: true, fluxo: f0.proposalId ? rebaixarParaV1(f0, {}) : null, evento: "fluxo_v2_desligado" };
  }
  const options: OptionsV2 = bruto;
  const obrigatorios: CampoObrigatorio[] = options.obrigatorios ?? [];
  const faltandoDoServidor: Pendencia[] = faltandoV2(options) ?? pendenciasIniciais(obrigatorios);

  // 1b. o envio para assinatura (PR-D, T13/T14): testemunhas, tipo, preflight, resumo e o "sim" que
  // manda. Roda antes do passo 2 porque a `chave` de um envio sem resposta é dele. `null` = a fala não é
  // do envio (o resto do condutor segue: extração, ficha).
  if (f0.assinatura || (pedeEnvio(ctx.texto) && f0.proposalId)) {
    const envio = await conduzirAssinatura({ f0, options, obrigatorios, ctx, deps, cancelar, temPendencia });
    if (envio) return envio;
  }

  // 2. escrita sem resposta: só o SIM resolve (outra chave geraria um segundo rascunho)
  if (f0.chave && conf !== "sim") {
    return { reply: TEXTO_RESOLVER_ANTES, fluxo: f0, evento: "escrita_em_aberto" };
  }

  // C1: o corretor só "viu" a ficha se ela foi mostrada num turno (etapa `ficha`), se já há escrita em
  // curso, ou se a linha agendada no outbox foi de fato ENVIADA. Passar do horário não prova nada: o
  // cron atrasa, a linha pode ser cancelada ou falhar. Sem como confirmar, nunca vale como vista.
  let fichaVista = f0.etapa === "ficha" || !!f0.chave;
  if (!fichaVista && temPendencia && (conf === "sim" || conf === "nao") && f0.fichaAgendadaEm !== undefined && ctx.subjectKey && deps.pausa) {
    const entradaDaFicha = f0.fichaAgendadaEm - PAUSA_DA_FICHA_MS;
    fichaVista = await fichaFoiEntregue(deps.pausa, ctx.subjectKey, entradaDaFicha);
  }

  // 2b. qual o modelo (locação residencial × comercial), perguntado na hora de gravar
  if (f0.aguardaCampo?.path === "schemaType" && !f0.schemaType) {
    const escolhido = lerFinalidade(options, f0.esteira, ctx.texto);
    if (escolhido) {
      const f = { ...f0, schemaType: escolhido, aguardaCampo: undefined, etapa: "ficha" as const };
      return mostrarFicha({ f, pendentes: pendentes0, options, obrigatorios, faltandoDoServidor, ctx, deps, cancelar, fecha, thread, comPergunta: false });
    }
  }

  // 3. conflito de parte já gravada (N1): a resposta decide
  if (f0.conflito && temPendencia) {
    const r = lerConflito(ctx.texto);
    if (r === "novo" || r === "mesmo") {
      const extra: Partial<OpcoesDaGravacao> = r === "novo" ? { comoNovaParte: f0.conflito } : { substituir: f0.conflito };
      return gravar({ f: { ...f0, conflito: undefined }, options, obrigatorios, ctx, deps, cancelar, fecha, thread, extra });
    }
    if (r === "nao") return descartar(f0, ctx, cancelar, fecha);
    if (ctx.texto.trim().split(/\s+/).length <= 6) {
      const nome = partesDe(options)[f0.conflito.grupo][f0.conflito.posicao];
      return { reply: perguntaDoConflito(f0.conflito.grupo, f0.conflito.posicao, nome), fluxo: fecha(f0), evento: "formulario_conflito" };
    }
  }

  // 4. SIM / NÃO ao cartão (só depois de o corretor ter visto o que vai ser gravado)
  if (temPendencia && fichaVista) {
    if (conf === "sim") return gravar({ f: f0, options, obrigatorios, ctx, deps, cancelar, fecha, thread, extra: {} });
    if (conf === "nao") return descartar(f0, ctx, cancelar, fecha);
  }

  // 4b. a revisão (T11/T12): pedido, resposta do Flow, correção numerada, "sim" sem mudança
  const revisao = await conduzirRevisao({ f0, options, obrigatorios, faltandoDoServidor, ctx, deps, cancelar, fecha, thread, conf, temPendencia, pendentes0 });
  if (revisao) return revisao;

  // 5. o que o corretor disse neste turno: resposta ao campo ou extração da janela
  let novos: CampoLido[] = [];
  let respondeuCampo = false;
  if (conf === "nenhum" || !temPendencia) {
    const resp = lerRespostaAoCampo(f0, ctx.texto, obrigatorios);
    if (resp.tipo === "invalida") return { reply: resp.reply, fluxo: fecha(f0), evento: "formulario_resposta_invalida" };
    if (resp.tipo === "preenche") {
      novos = camposDoPatch(resp.patch);
      respondeuCampo = novos.length > 0;
    }
  }
  const pediu = pediuAFicha(ctx.texto);
  if (!respondeuCampo && conf === "nenhum" && !pediu) {
    try {
      // I3: só as mensagens depois do último SIM/NÃO (o que veio antes já foi gravado ou descartado).
      const janela = deps.janelaDoTurno(Math.max(0, (f0.mensagensDoFluxo ?? 0) - (f0.janelaDesde ?? 0)));
      const args = await deps.extrairComJanela(janela, TOOL_PATCH_V2);
      if (args) novos = camposDoPatchExtraido(args, [janela.atual, ...janela.anteriores, ...janela.lidos.map((l) => l.texto)].join("\n"));
    } catch {
      novos = [];
    }
  }

  let f = f0;
  if (novos.length > 0) {
    const r = registrarLidos(f, { ref: `txt:${ctx.messageId}`, campos: novos }, thread);
    if (!r.ok) return { reply: TEXTO_SEM_COFRE, fluxo: fecha(f0), evento: "formulario_sem_cofre" };
    f = { ...r.fluxo, etapa: "compor", conflito: undefined };
  }
  const pendentes = lidosDoCofre(f, thread);

  // "sim"/"ok" sem a ficha ter sido vista: mostra a ficha em vez de gravar às cegas
  const midiaDoTurno = f.lidosPendentes.some((l) => l.ref === ctx.messageId);
  // Em revisão a correção em frase ("o CPF dela é…") mostra o cartão já, como a numerada e a do Flow.
  const forcarFicha = pediu || midiaDoTurno || ((conf === "sim" || conf === "vago") && pendentes.length > 0) || (!!f0.revisao && novos.length > 0);
  if (novos.length === 0 && !forcarFicha) {
    // Não era do fluxo. O turno segue o atendimento normal; o rascunho (se houver) fica.
    const manter = pendentes.length > 0 || !!f0.proposalId;
    if (!manter) return { liberar: true, fluxo: null, evento: "formulario_assunto_fora" };
    // C1: a ficha agendada sairia no meio de outro assunto, e um "sim" a outra pergunta a confirmaria.
    // Cancela a linha e limpa o agendamento: o próximo "sim" mostra a ficha antes de gravar.
    if (f0.fichaAgendadaEm !== undefined) await cancelar();
    // I4: a mensagem entrou no histórico do corretor; conta para a janela de extração não desalinhar.
    return { liberar: true, fluxo: contarEntradaDoFluxo({ ...f0, fichaAgendadaEm: undefined }), evento: "formulario_assunto_fora" };
  }

  // 6. ficha agora, ou silêncio e ficha agendada
  const restante = faltandoDepoisDosLidos(faltandoDoServidor, pendentes);
  const temMidiaLida = midiaDoTurno;
  const semFila = !deps.pausa || !ctx.subjectKey;
  const mostrar =
    forcarFicha ||
    semFila ||
    deveMostrarFicha(f0, ctx.agora, ctx.texto, { completo: restante.length === 0 && pendentes.length > 0, temMidiaLida });

  if (mostrar) {
    return mostrarFicha({ f: { ...f, etapa: "ficha" }, pendentes, options, obrigatorios, faltandoDoServidor, ctx, deps, cancelar, fecha, thread, comPergunta: true });
  }

  const texto = renderizarFicha({
    rascunho: montarResumo({ obrigatorios, faltando: faltandoDoServidor }),
    faltando: restante,
    lidos: pendentes,
    obrigatorios,
  });
  const proximo = fecha({ ...f, etapa: "compor", aguardaCampo: undefined });
  const agendou = ctx.subjectKey && deps.pausa ? await agendarFicha(deps.pausa, { subjectKey: ctx.subjectKey, ultimaEntradaEm: proximo.ultimaEntradaEm, texto }) : false;
  if (!agendou) {
    // A fila falhou: não deixa o corretor sem resposta.
    return mostrarFicha({ f: { ...f, etapa: "ficha" }, pendentes, options, obrigatorios, faltandoDoServidor, ctx, deps, cancelar, fecha, thread, comPergunta: true });
  }
  return {
    reply: "",
    silencioso: true,
    fluxo: { ...proximo, fichaAgendadaEm: proximo.ultimaEntradaEm + PAUSA_DA_FICHA_MS },
    evento: "formulario_coletando",
  };
}

// ─── Revisão (T11/T12) ──────────────────────────────────────────────────────

const TEXTO_FLOW_ILEGIVEL =
  "Não consegui ler o formulário, então não anotei nada. Confira os campos e envie de novo, ou me diga em texto o que mudar.";
const TEXTO_REVISAO_ENCERRADA = "Certo, parei a revisão. O rascunho segue salvo, sem envio.";
const TEXTO_FLOW_ANTIGO =
  "Esse formulário é de uma revisão anterior e não vale mais, então não anotei nada. Use o formulário da revisão atual, ou me diga em texto o que mudar.";
const TEXTO_FLOW_DIGITADO =
  "Isso tem cara de resposta de formulário, mas não veio do formulário da revisão, então não anotei nada. Toque em *Revisar* ou me diga em texto o que mudar.";
const TEXTO_FLOW_SEM_MUDANCA = "Não vi nenhuma mudança no formulário, então não anotei nada. Se está tudo certo, responda *SIM* para seguir.";
const PROXIMO_PASSO: Record<PassoDeRevisao, PassoDeRevisao | null> = { partes: "imovel_valor", imovel_valor: null, assinatura: null };

/**
 * O que o Flow leva pré-preenchido (caminho canônico → valor). VAZIO de propósito: o `options` só
 * traz `signatarios` (quem assina), não as partes do rascunho por posição, e pré-preencher
 * `compradores[0].nome` com o nome do 2º comprador faria o "sim" gravar o nome trocado. Quando o
 * contrato trouxer as partes por posição (PR em par), esta é a única função a mudar; a leitura da
 * resposta já descarta o campo devolvido igual ao que saiu preenchido.
 */
function valoresDoFlow(options: OptionsV2): Record<string, string> {
  void options;
  return {};
}

/**
 * Abre (ou reabre) a revisão num passo. Max com Flow disponível: o Flow do passo sai junto, com a
 * ficha numerada de corpo e de reserva, com um `nonce` novo (o token do envio). Senão (Newton, sem
 * `MAX_FLOW_ID_*`, `MAX_INTERACTIVE=off`): só a ficha numerada, que o Max entende em frase ("2 Maria
 * Souza"). `via` nasce `texto`: o Flow só conta como entregue quando uma resposta dele, com o token
 * certo, chega (`conduzirRevisao`); o condutor decide ANTES do envio e não sabe se a Meta o aceitou.
 */
function abrirRevisao(a: {
  f: FluxoFormularioV2;
  options: OptionsV2;
  faltando: Pendencia[] | null;
  ctx: ContextoDoTurno;
  fecha: (f: FluxoFormularioV2) => FluxoFormularioV2;
  passo: PassoDeRevisao;
  prefixo?: string;
  /** Texto numerado mesmo com Flow disponível (a revisão já está em texto). */
  soTexto?: boolean;
  recomecarJanela?: boolean;
}): Extract<Passo, { reply: string }> {
  const itens = itensDaRevisao(a.options);
  const comFlow = !a.soTexto && a.passo !== "assinatura" && flowDisponivel(a.passo) !== null;
  const reply = textoDaRevisao({ options: a.options, itens, faltando: a.faltando, prefixo: a.prefixo, comFlow });
  const nonce = comFlow ? novoNonceDoFlow() : null;
  const flow = nonce ? montarEnvioDoFlow(a.passo, a.options, valoresDoFlow(a.options), reply, nonce) : null;
  if (flow) registrarFlowDoTurno(a.ctx.messageId, flow, a.ctx.agora);
  const fluxo: FluxoFormularioV2 = a.fecha({
    ...a.f,
    etapa: "revisar",
    aguardaCampo: undefined,
    fichaAgendadaEm: undefined,
    revisao: { passo: a.passo, via: "texto", itens, ...(flow && nonce ? { nonce } : {}) },
  });
  return { reply, fluxo: a.recomecarJanela ? recomecaJanela(fluxo) : fluxo, evento: "formulario_revisao" };
}

/** A revisão acabou: completo = fecha como o C1; faltando = segue perguntando. */
function concluirRevisao(a: {
  f: FluxoFormularioV2;
  faltando: Pendencia[] | null;
  obrigatorios: CampoObrigatorio[];
  ctx: ContextoDoTurno;
  fecha: (f: FluxoFormularioV2) => FluxoFormularioV2;
  codigo?: string;
}): Extract<Passo, { reply: string }> {
  const base: FluxoFormularioV2 = { ...a.f, etapa: "compor", revisao: undefined, aguardaCampo: undefined, fichaAgendadaEm: undefined, conflito: undefined };
  if (a.faltando && a.faltando.length === 0) {
    return { reply: textoDeCompleto(a.codigo), fluxo: null, evento: "formulario_completo" };
  }
  const p = a.faltando ? proximaPergunta(a.faltando, new Set(base.perguntados), a.obrigatorios) : null;
  const fluxo = p ? registrarPergunta(base, p, a.ctx.agora) : base;
  return { reply: `Revisão concluída.${p ? `\n${p.pergunta}` : "\nO que mais você tem?"}`, fluxo: a.fecha(fluxo), evento: "formulario_salvo" };
}

export function textoDeCompleto(codigo?: string): string {
  return `Rascunho${codigo ? ` ${codigo}` : ""} completo. Para enviar para assinatura, peça "enviar${codigo ? ` ${codigo}` : ""} para assinatura".`;
}

/** A correção vira campo lido pendente e a ficha mostra o cartão; o "sim" grava. Nunca grava aqui. */
async function corrigirComCartao(a: {
  f0: FluxoFormularioV2;
  options: OptionsV2;
  obrigatorios: CampoObrigatorio[];
  faltandoDoServidor: Pendencia[];
  ctx: ContextoDoTurno;
  deps: DepsDoFluxo;
  cancelar: () => Promise<void>;
  fecha: (f: FluxoFormularioV2) => FluxoFormularioV2;
  thread: string;
  campos: CampoLido[];
  /** Estado novo da revisão (o Flow provou a entrega); ausente = o mesmo. */
  revisao?: RevisaoEmCurso;
}): Promise<Passo> {
  const { f0, ctx, thread, fecha } = a;
  const r = registrarLidos(f0, { ref: `txt:${ctx.messageId}`, campos: a.campos }, thread);
  if (!r.ok) return { reply: TEXTO_SEM_COFRE, fluxo: fecha(f0), evento: "formulario_sem_cofre" };
  const f = { ...r.fluxo, etapa: "ficha" as const, conflito: undefined, ...(a.revisao ? { revisao: a.revisao } : {}) };
  return mostrarFicha({
    f,
    pendentes: lidosDoCofre(f, thread),
    options: a.options,
    obrigatorios: a.obrigatorios,
    faltandoDoServidor: a.faltandoDoServidor,
    ctx,
    deps: a.deps,
    cancelar: a.cancelar,
    fecha,
    thread,
    comPergunta: false,
  });
}

/**
 * O turno da revisão. `null` = não é da revisão, o condutor segue (extração, ficha). A correção
 * (Flow ou "2 Maria Souza") NUNCA grava: vira campo lido, ficha com cartão e o "sim".
 */
async function conduzirRevisao(a: {
  f0: FluxoFormularioV2;
  options: OptionsV2;
  obrigatorios: CampoObrigatorio[];
  faltandoDoServidor: Pendencia[];
  ctx: ContextoDoTurno;
  deps: DepsDoFluxo;
  cancelar: () => Promise<void>;
  fecha: (f: FluxoFormularioV2) => FluxoFormularioV2;
  thread: string;
  conf: ReturnType<typeof lerConfirmacao>;
  temPendencia: boolean;
  pendentes0: CampoLido[];
}): Promise<Passo | null> {
  const { f0, options, obrigatorios, faltandoDoServidor, ctx, cancelar, fecha, thread, conf, temPendencia } = a;
  const rev = f0.revisao;
  const token = tokenDoBotao(ctx.botao);

  // Resposta de Flow: DADO, e só do ÚLTIMO envio. O token (`fv2:<passo>:<nonce>`, `button_payload`) precisa
  // ser o da revisão em curso: Flow antigo, de outra proposta, de outro passo, forjado ou sem revisão =
  // nada é lido nem anotado. O mesmo vale para texto digitado com cara de Flow ("campo: valor").
  const brutoDoFlow = flowDoTexto(ctx.texto);
  // O texto "campo: valor" sem token só é tratado como Flow falso quando este perfil PODE mandar Flow
  // (Max, flag e id do passo); no Newton, ou sem Flow configurado, é texto comum, como no C1.
  const textoComCaraDeFlow = rev !== undefined && brutoDoFlow !== null && flowDisponivel(rev.passo) !== null;
  if (token !== null || textoComCaraDeFlow) {
    if (!rev || !rev.nonce || token === null) {
      return rev && token === null
        ? { reply: TEXTO_FLOW_DIGITADO, fluxo: fecha(f0), evento: "formulario_flow_sem_token" }
        : { reply: TEXTO_FLOW_ANTIGO, fluxo: fecha(f0), evento: "formulario_flow_antigo" };
    }
    if (token !== tokenDoFlow(rev.passo, rev.nonce)) return { reply: TEXTO_FLOW_ANTIGO, fluxo: fecha(f0), evento: "formulario_flow_antigo" };
    if (!brutoDoFlow || rev.passo === "assinatura") return { reply: TEXTO_FLOW_ILEGIVEL, fluxo: fecha(f0), evento: "formulario_flow_invalido" };
    const r = lerRespostaDoFlow(brutoDoFlow, rev.passo, obrigatorios, valoresDoFlow(options));
    if ("erro" in r) return { reply: TEXTO_FLOW_ILEGIVEL, fluxo: fecha(f0), evento: "formulario_flow_invalido" };
    // O Flow chegou: prova de entrega, e só a partir daqui o "sim" avança para o próximo passo.
    const viaFlow = { ...rev, via: "flow" as const };
    if ("semMudanca" in r) return { reply: TEXTO_FLOW_SEM_MUDANCA, fluxo: fecha({ ...f0, revisao: viaFlow }), evento: "formulario_flow_sem_mudanca" };
    return corrigirComCartao({ ...a, campos: camposDoPatch(r), revisao: viaFlow });
  }

  // Pedido explícito, com rascunho salvo: o que está pendente de "sim" vem antes (a revisão lê o servidor).
  if (pedeRevisao(ctx.texto) && f0.proposalId && !f0.chave) {
    if (temPendencia) {
      return mostrarFicha({ f: { ...f0, etapa: "ficha" }, pendentes: a.pendentes0, options, obrigatorios, faltandoDoServidor, ctx, deps: a.deps, cancelar, fecha, thread, comPergunta: false });
    }
    await cancelar();
    return abrirRevisao({ f: f0, options, faltando: faltandoDoServidor, ctx, fecha, passo: "partes" });
  }
  if (!rev) return null;

  const corrigir = (campos: CampoLido[]): Promise<Passo> => corrigirComCartao({ ...a, campos });

  if (conf === "nenhum") {
    const c = lerCorrecaoNumerada(ctx.texto, rev.itens, obrigatorios);
    if (c.tipo === "item") {
      if (c.leitura.tipo === "invalida") return { reply: c.leitura.reply, fluxo: fecha(f0), evento: "formulario_resposta_invalida" };
      if (c.leitura.tipo === "preenche") {
        const campos = camposDoPatch(c.leitura.patch);
        if (campos.length > 0) return corrigir(campos);
      }
    }
    return null;
  }

  // Sem nada pendente: "sim" segue para o próximo passo (ou conclui), "não" sai. "ok"/"blz" são `vago`: nada.
  if (!temPendencia) {
    if (conf === "sim") {
      const proximo = rev.via === "flow" ? PROXIMO_PASSO[rev.passo] : null;
      if (proximo) {
        await cancelar();
        return abrirRevisao({ f: f0, options, faltando: faltandoDoServidor, ctx, fecha, passo: proximo });
      }
      await cancelar();
      return concluirRevisao({ f: f0, faltando: faltandoDoServidor, obrigatorios, ctx, fecha });
    }
    if (conf === "nao") {
      await cancelar();
      return { reply: TEXTO_REVISAO_ENCERRADA, fluxo: fecha({ ...f0, revisao: undefined, etapa: "compor" }), evento: "formulario_revisao_encerrada" };
    }
  }
  return null;
}

// ─── Ficha ──────────────────────────────────────────────────────────────────

async function mostrarFicha(a: {
  f: FluxoFormularioV2;
  pendentes: CampoLido[];
  options: OptionsV2;
  obrigatorios: CampoObrigatorio[];
  faltandoDoServidor: Pendencia[];
  ctx: ContextoDoTurno;
  deps: DepsDoFluxo;
  cancelar: () => Promise<void>;
  fecha: (f: FluxoFormularioV2) => FluxoFormularioV2;
  thread: string;
  comPergunta: boolean;
}): Promise<Passo> {
  await a.cancelar();
  const restante = faltandoDepoisDosLidos(a.faltandoDoServidor, a.pendentes);
  let reply = renderizarFicha({
    rascunho: montarResumo({ obrigatorios: a.obrigatorios, faltando: a.faltandoDoServidor }),
    faltando: restante,
    lidos: a.pendentes,
    obrigatorios: a.obrigatorios,
  });
  let fluxo: FluxoFormularioV2 = { ...a.f, etapa: "ficha", fichaAgendadaEm: undefined, aguardaCampo: undefined };
  // Com algo esperando o SIM a única pergunta é "está certo?"; senão pergunta o próximo campo.
  if (a.comPergunta && a.pendentes.length === 0) {
    const p = proximaPergunta(restante, new Set(fluxo.perguntados), a.obrigatorios);
    if (p) {
      reply = `${reply}\n\n${p.pergunta}`;
      fluxo = registrarPergunta(fluxo, p, a.ctx.agora);
    }
  }
  return { reply, fluxo: a.fecha(fluxo), evento: "formulario_ficha" };
}

async function descartar(
  f: FluxoFormularioV2,
  ctx: ContextoDoTurno,
  cancelar: () => Promise<void>,
  fecha: (f: FluxoFormularioV2) => FluxoFormularioV2
): Promise<Passo> {
  await cancelar();
  const limpo = { ...limparLidos(f), etapa: "compor" as const, fichaAgendadaEm: undefined, aguardaCampo: undefined, conflito: undefined };
  void ctx;
  return { reply: TEXTO_DESCARTADO, fluxo: recomecaJanela(fecha(limpo)), evento: "formulario_descartado" };
}

// ─── Gravação (o SIM) ───────────────────────────────────────────────────────

async function gravar(a: {
  f: FluxoFormularioV2;
  options: OptionsV2;
  obrigatorios: CampoObrigatorio[];
  ctx: ContextoDoTurno;
  deps: DepsDoFluxo;
  cancelar: () => Promise<void>;
  fecha: (f: FluxoFormularioV2) => FluxoFormularioV2;
  thread: string;
  extra: Partial<OpcoesDaGravacao>;
}): Promise<Passo> {
  const { f, options, obrigatorios, ctx, deps, cancelar, fecha, thread } = a;

  if (ctx.podeEscrever === false) {
    await cancelar();
    const texto = textoDoParcial({ ok: false, erro: "sem_permissao", fluxo: null }, {});
    return { reply: texto, fluxo: fecha(limparLidos(f)), evento: "formulario_sem_permissao" };
  }

  // O modelo da proposta: só no primeiro write. Vários candidatos = perguntar.
  let alvo = f;
  if (!alvo.proposalId && !alvo.schemaType) {
    const schema = derivarSchema(options, alvo.esteira);
    if (!schema) {
      const opcoes = (options.modalidades ?? []).filter((m) => m.esteira === alvo.esteira && m.modeloDisponivel);
      if (opcoes.length === 0) {
        return { reply: "Sua imobiliária não tem modelo ativo para esse tipo de proposta. Peça a ativação no sistema.", fluxo: fecha(f), evento: "formulario_sem_modelo" };
      }
      return {
        reply: "É uma proposta *residencial* ou *comercial*?",
        fluxo: fecha({ ...f, aguardaCampo: { parteRef: "modalidade", path: "schemaType" } }),
        evento: "formulario_pergunta_modelo",
      };
    }
    alvo = { ...alvo, schemaType: schema };
  }

  const g = await gravarLidos(deps, alvo, thread, { messageIdDoSim: ctx.messageId, partes: partesDe(options), ...a.extra });
  await cancelar();

  if (g.ok) {
    const r = g.resultado;
    // O `options` de DEPOIS da gravação: uma consulta só, usada por `faltando` e pela revisão.
    let depois: OptionsV1 | OptionsV2 | null | undefined;
    const reler = async (): Promise<OptionsV1 | OptionsV2 | null> => {
      if (depois === undefined) depois = await consultarOptions(deps, { alvo: { proposalId: r.proposalId } });
      return depois;
    };
    let faltando = r.faltando;
    if (faltando === null) {
      const o2 = await reler();
      faltando = o2 ? faltandoV2(o2) : null;
    }
    const partes = [textoDoParcial(r, {})];
    if (g.descartados.length > 0) partes.push(textoDosDescartados(g.descartados));
    let base: FluxoFormularioV2 = {
      ...g.fluxo,
      etapa: "compor",
      aguardaCampo: undefined,
      fichaAgendadaEm: undefined,
      conflito: undefined,
    };
    const completo = !!faltando && faltando.length === 0;

    // PR-D: o celular do assinante (Aceite) foi gravado: segue para o preflight. Qualquer outra gravação
    // durante o envio deixa o resumo velho: derruba o passo (o corretor pede o envio de novo).
    if (base.assinatura) {
      if (base.assinatura.passo === "celular") {
        const o2 = await reler();
        if (o2 && o2.fluxoV2 === true) {
          return retomarAposCelular({ f: base, options: o2, obrigatorios, ctx, deps, prefixo: partes.join("\n") });
        }
      }
      base = { ...base, assinatura: undefined };
    }

    // T11/T12: revisão em curso (a gravação foi uma correção dela) ou rascunho completo no Max COM Flow.
    // Sem Flow disponível o completo é o do C1, byte a byte (`fluxo: null`).
    const emRevisao = base.revisao;
    if (emRevisao || (completo && flowDisponivel("partes"))) {
      const o2 = await reler();
      const agora: OptionsV2 | null = o2 && o2.fluxoV2 === true ? o2 : null;
      if (agora) {
        const falta = faltandoV2(agora) ?? faltando;
        const prefixo = partes.join("\n");
        if (emRevisao) {
          // `via: "flow"` (o Flow do passo foi respondido): gravou a correção, segue para o próximo; no último, conclui.
          // `via: "texto"`: a lista numerada de novo, só em texto.
          const proximo = emRevisao.via === "flow" ? PROXIMO_PASSO[emRevisao.passo] : null;
          if (proximo) return abrirRevisao({ f: base, options: agora, faltando: falta, ctx, fecha, passo: proximo, prefixo, recomecarJanela: true });
          if (emRevisao.via === "texto") {
            return abrirRevisao({ f: base, options: agora, faltando: falta, ctx, fecha, passo: emRevisao.passo, prefixo, soTexto: true, recomecarJanela: true });
          }
          const fim = concluirRevisao({ f: base, faltando: falta, obrigatorios, ctx, fecha, codigo: r.codigo });
          return { ...fim, reply: [prefixo, fim.reply].join("\n") };
        }
        return abrirRevisao({ f: base, options: agora, faltando: falta, ctx, fecha, passo: "partes", prefixo: `${prefixo}\nRascunho${r.codigo ? ` ${r.codigo}` : ""} completo.`, recomecarJanela: true });
      }
      // Sem `options` de depois (consulta falhou ou o v2 desligou): segue como o C1, sem revisão pendurada no estado.
      base = { ...base, revisao: undefined };
    }
    if (faltando && faltando.length === 0) {
      partes.push(textoDeCompleto(r.codigo));
      return { reply: partes.join("\n"), fluxo: null, evento: "formulario_completo" };
    }
    let fluxo = base;
    if (faltando && faltando.length > 0) {
      const p = proximaPergunta(faltando, new Set(base.perguntados), obrigatorios);
      if (p) {
        partes.push(p.pergunta);
        fluxo = registrarPergunta(base, p, ctx.agora);
      }
    } else {
      partes.push("O que mais você tem?");
    }
    return { reply: partes.join("\n"), fluxo: recomecaJanela(fecha(fluxo)), evento: "formulario_salvo" };
  }

  // Falhas. `g.fluxo` já traz a chave quando a escrita ficou incerta.
  const encerrou = g.resultado && g.resultado.ok === false && g.resultado.fluxo === null;
  switch (g.erro) {
    case "conflito_de_parte": {
      const c = g.conflito!;
      const nome = partesDe(options)[c.grupo][c.posicao];
      return {
        reply: perguntaDoConflito(c.grupo, c.posicao, nome),
        fluxo: fecha({ ...g.fluxo, conflito: { grupo: c.grupo, posicao: c.posicao }, etapa: "ficha" }),
        evento: "formulario_conflito",
      };
    }
    case "fluxo_desligado": {
      const v1 = g.resultado && g.resultado.ok === false ? g.resultado.fluxo : null;
      return {
        reply: f.proposalId
          ? "Mudei o modo de coleta no meio do caminho, mas seu rascunho segue salvo. Me diga o que falta que eu continuo."
          : "Mudei o modo de coleta no meio do caminho. Me mande de novo os dados da proposta que eu continuo.",
        fluxo: v1,
        evento: "fluxo_v2_desligado",
      };
    }
    case "documento_proprio":
      // O servidor recusou por causa do documento editado à mão. Um novo "sim" só repetiria o 409,
      // então o fluxo termina: o texto explica, dá o link e diz que o que veio NÃO foi anotado.
      return { reply: g.resultado ? textoDoParcial(g.resultado, {}) : "Não anotei o que você mandou.", fluxo: null, evento: "formulario_documento_proprio" };
    case "incerta":
      return { reply: TEXTO_ESCRITA_INCERTA, fluxo: fecha(g.fluxo), evento: "formulario_escrita_incerta" };
    case "cofre_ilegivel":
      return {
        reply: "Não consegui reabrir o que eu tinha lido (a guarda segura expirou). Me mande de novo o que quer anotar.",
        fluxo: fecha(g.fluxo),
        evento: "formulario_cofre_ilegivel",
      };
    case "nada_a_gravar":
      return {
        reply: g.descartados.length ? `${textoDosDescartados(g.descartados)} Não tenho mais nada a anotar.` : "Não tenho nada novo para anotar.",
        fluxo: fecha({ ...g.fluxo, etapa: "compor" }),
        evento: "formulario_nada_a_gravar",
      };
    case "papel_indefinido":
      return {
        reply: "Esses dados vieram de um documento e não sei de quem são. Me diga se é do comprador ou do vendedor e eu anoto.",
        fluxo: fecha(g.fluxo),
        evento: "formulario_papel_indefinido",
      };
    default: {
      const texto = g.resultado ? textoDoParcial(g.resultado, {}) : "Não consegui anotar agora. Tenta de novo em instantes.";
      if (encerrou) return { reply: texto, fluxo: null, evento: `formulario_${g.erro}` };
      return { reply: texto, fluxo: fecha(g.fluxo), evento: `formulario_${g.erro}` };
    }
  }
}
