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
 * Fora do escopo deste PR (T11/T12): revisão final, escolha do canal de assinatura,
 * envio e correção pós-envio.
 */

import {
  TEXTO_ESCRITA_INCERTA,
  TEXTO_FLUXO_CANCELADO,
  querCancelar,
  type ContextoDoTurno,
  type DepsDoFluxo,
  type PassoDoFluxo,
} from "../fluxos";
import { lerConfirmacao, normalizar } from "../tools";
import type { CampoObrigatorio, OptionsV2, Pendencia } from "./contrato";
import { contarEntradaDoFluxo, type FluxoFormularioV2 } from "./estado";
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
import { agendarFicha, cancelarFicha, PAUSA_DA_FICHA_MS } from "./pausa";
import {
  caminhoCanonico,
  consultarOptions,
  faltandoV2,
  lerRespostaAoCampo,
  pendenciasIniciais,
  proximaPergunta,
  registrarPergunta,
  textoDoParcial,
} from "./proposta-v2";
import { rebaixarParaV1 } from "./selecao";

const TEXTO_SEM_SISTEMA = "Não consegui falar com o sistema agora. Tenta de novo em instantes.";
const TEXTO_SEM_COFRE =
  "Não consigo guardar isso com segurança agora, então não anotei nada. Mande de novo daqui a pouco ou preencha pelo sistema.";
const TEXTO_RESOLVER_ANTES =
  "Antes de mudar qualquer coisa, preciso conferir o pedido anterior: responda *SIM* (não duplica) ou CANCELAR.";
const TEXTO_DESCARTADO = "Descartei. Nada foi anotado.";

type Passo = PassoDoFluxo;

// ─── Partes que o servidor já tem ───────────────────────────────────────────

const PAPEL_COMPRADOR = new Set(["comprador", "locatario", "proponente", "inquilino"]);
const PAPEL_VENDEDOR = new Set(["vendedor", "locador", "proprietario", "contraparte"]);

/** Nome por posição de quem já está no rascunho (de `options.signatarios`). Só vive no turno. */
export function partesDe(options: OptionsV2): PartesGravadas {
  const partes: PartesGravadas = { compradores: [], vendedores: [] };
  for (const s of options.signatarios ?? []) {
    const papel = normalizar(s.papel ?? "");
    if (PAPEL_COMPRADOR.has(papel)) partes.compradores.push(s.nome);
    else if (PAPEL_VENDEDOR.has(papel)) partes.vendedores.push(s.nome);
  }
  return partes;
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
    `O rascunho já tem ${quem}, e o que você mandou é de outro nome. ` +
    `Responda *é um novo* (entra mais um ${papel}) ou *é o mesmo, troca* (substitui o que está no rascunho).`
  );
}

type RespostaDoConflito = "novo" | "mesmo" | "nao" | null;

function lerConflito(texto: string): RespostaDoConflito {
  const t = normalizar(texto);
  if (/\bnao\b.*\bmesm[oa]\b/.test(t)) return "novo";
  if (/\b(novo|nova|outro|outra|diferente|mais um|mais uma)\b/.test(t)) return "novo";
  if (/\b(mesmo|mesma|troca|trocar|substitui|substituir|corrige|corrigir)\b/.test(t)) return "mesmo";
  if (lerConfirmacao(texto) === "nao") return "nao";
  return null;
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
    if (prefixo) out.push({ path: prefixo, valor: String(v), confianca: 1 });
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

function textoDosDescartados(descartados: string[]): string {
  return descartados.length === 1
    ? "Um dado não cabe na proposta e ficou de fora."
    : `${descartados.length} dados não cabem na proposta e ficaram de fora.`;
}

// ─── O turno ────────────────────────────────────────────────────────────────

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
  const bruto = await consultarOptions(deps, f0.proposalId ? { alvo: { proposalId: f0.proposalId } } : { tipo: f0.esteira, schemaType: f0.schemaType });
  if (!bruto) return { reply: TEXTO_SEM_SISTEMA, fluxo: f0, evento: "formulario_sem_sistema" };
  if (bruto.fluxoV2 !== true) {
    await cancelar();
    return { liberar: true, fluxo: f0.proposalId ? rebaixarParaV1(f0, {}) : null, evento: "fluxo_v2_desligado" };
  }
  const options: OptionsV2 = bruto;
  const obrigatorios: CampoObrigatorio[] = options.obrigatorios ?? [];
  const faltandoDoServidor: Pendencia[] = faltandoV2(options) ?? pendenciasIniciais(obrigatorios);

  const pendentes0 = lidosDoCofre(f0, thread);
  const temPendencia = pendentes0.length > 0 || f0.lidosPendentes.length > 0;
  const conf = lerConfirmacao(ctx.texto);

  // 2. escrita sem resposta: só o SIM resolve (outra chave geraria um segundo rascunho)
  if (f0.chave && conf !== "sim") {
    return { reply: TEXTO_RESOLVER_ANTES, fluxo: f0, evento: "escrita_em_aberto" };
  }

  const fichaVista = f0.etapa === "ficha" || !!f0.chave || (f0.fichaAgendadaEm !== undefined && ctx.agora >= f0.fichaAgendadaEm);

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
      const janela = deps.janelaDoTurno(f0.mensagensDoFluxo ?? 0);
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
  const forcarFicha = pediu || midiaDoTurno || ((conf === "sim" || conf === "vago") && pendentes.length > 0);
  if (novos.length === 0 && !forcarFicha) {
    // Não era do fluxo. O turno segue o atendimento normal; o rascunho (se houver) fica.
    const manter = pendentes.length > 0 || !!f0.proposalId;
    return { liberar: true, fluxo: manter ? f0 : null, evento: "formulario_assunto_fora" };
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
  return { reply: TEXTO_DESCARTADO, fluxo: fecha(limpo), evento: "formulario_descartado" };
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
    let faltando = r.faltando;
    if (faltando === null) {
      const o2 = await consultarOptions(deps, { alvo: { proposalId: r.proposalId } });
      faltando = o2 ? faltandoV2(o2) : null;
    }
    const partes = [textoDoParcial(r, {})];
    if (g.descartados.length > 0) partes.push(textoDosDescartados(g.descartados));
    if (r.bloqueio) partes.push(r.bloqueio.mensagem ?? "O sistema avisou que há uma pendência que impede o envio desta proposta.");
    const base: FluxoFormularioV2 = {
      ...g.fluxo,
      etapa: "compor",
      aguardaCampo: undefined,
      fichaAgendadaEm: undefined,
      conflito: undefined,
    };
    if (faltando && faltando.length === 0) {
      const codigo = r.codigo ?? "";
      partes.push(`Rascunho${codigo ? ` ${codigo}` : ""} completo. Para enviar para assinatura, peça "enviar${codigo ? ` ${codigo}` : ""} para assinatura".`);
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
    return { reply: partes.join("\n"), fluxo: fecha(fluxo), evento: "formulario_salvo" };
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
