import type { ContextoDoTurno, DepsDoFluxo, Fluxo, PassoDoFluxo } from "./fluxos";
import { lerConfirmacao, normalizar } from "./tools";
import {
  ALIAS_DE_TIPO_DE_AVISO,
  type CanaisDoAviso,
  type PrefsPatch,
  type PrefsPatchResult,
  type PrefsView,
} from "./preferencias-contract";

/**
 * Preferências de aviso pela conversa (Pendências e avisos / M3, par da rota
 * `notification-preferences` do ImobPro).
 *
 * A pessoa vê e muda os PRÓPRIOS avisos (o relatório da manhã, o lembrete antes
 * do vencimento, a conclusão de atividade) falando com o Max ou o Newton. Mesmo
 * desenho do fluxo de atividades (`atividades.ts`): o modelo só PEDE; quem
 * conduz é este fluxo determinístico — valida contra as opções do servidor,
 * mostra o resumo, espera o SIM e só então faz o PATCH.
 *
 * ── O que este módulo NÃO faz ──────────────────────────────────────────────
 *
 *  - Não aponta para outra pessoa: nenhuma entrada, aqui ou na rota, aceita
 *    usuário. A rota resolve a pessoa pelo telefone de quem escreve.
 *  - Não chama modelo: o resumo é template.
 *  - Não adivinha valor: horário ou antecedência fora das opções do servidor
 *    viram uma resposta com as opções e NENHUM PATCH. "Manda às 6h" com o
 *    primeiro horário às 7h é pergunta, não escrita.
 *  - Não liga WhatsApp sem a pessoa dizer o canal: ligar WhatsApp registra o
 *    aceite (opt-in) dela no servidor.
 *  - Não decide autorização: a capability `prefs.self` é conferida a cada turn,
 *    e o servidor refaz o vínculo telefone→pessoa.
 *
 * Idempotência: o PATCH leva valores ABSOLUTOS (ligado/desligado, horário
 * fixo), então repeti-lo depois de uma falha incerta dá o mesmo estado. Não há
 * chave de idempotência, e o SIM seguinte a uma resposta incerta apenas tenta
 * de novo.
 */

export interface FluxoPreferencias {
  kind: "preferencias";
  /** `resumo`: o próximo SIM só reapresenta. `confirmacao`: o SIM escreve. */
  etapa: "resumo" | "confirmacao";
  patch: PrefsPatch;
  /** Nome legível dos tipos do patch (veio do GET): o resumo e o texto final não dependem de nova leitura. */
  rotulos: Record<string, string>;
  atualizadoEm: number;
}

type Resposta = Extract<PassoDoFluxo, { reply: string }>;

function resposta(f: Fluxo | null, reply: string, evento: string): Resposta {
  return { fluxo: f, reply, evento };
}

// ─── Textos fixos ─────────────────────────────────────────────────────────

export const TEXTO_PREFS_NAO_LIBERADO =
  "Ajustar seus avisos por aqui não está liberado para você. Nada foi alterado; faça pelas preferências de notificação do sistema.";
export const TEXTO_PREFS_SEM_VERIFICAR =
  "Não consegui validar sua permissão agora. Nada foi alterado; tente de novo em instantes.";
export const TEXTO_PREFS_SEM_LEITURA =
  "Não consegui ver suas preferências de aviso agora. Nada foi alterado; tente de novo em instantes.";
const TEXTO_INCERTO =
  "Ainda não confirmei o resultado. Responda SIM para eu tentar de novo: os valores são os mesmos, então não duplica nada.";
const SIM_OU_NAO = "\n\nResponda SIM para confirmar ou NÃO para parar.";

const CANCELAR = /^(cancelar|cancela|pare|parar|desistir|esquece|deixa pra la)[.!]?$/i;

// ─── Formatação ───────────────────────────────────────────────────────────

function listaEmPortugues(itens: string[]): string {
  if (itens.length <= 1) return itens.join("");
  return `${itens.slice(0, -1).join(", ")} ou ${itens[itens.length - 1]}`;
}

/** 30 → "30 minutos"; 60 → "1 hora"; 240 → "4 horas"; 1440 → "1 dia". */
export function descreverAntecedencia(min: number): string {
  if (min % 1440 === 0) return min === 1440 ? "1 dia" : `${min / 1440} dias`;
  if (min >= 60 && min % 60 === 0) return min === 60 ? "1 hora" : `${min / 60} horas`;
  return `${min} minutos`;
}

function emMinutos(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** ["07:00",…,"21:30"] de meia em meia hora → "de 07:00 a 21:30, de 30 em 30 minutos". Senão, a lista. */
function descreverHorarios(opcoes: readonly string[]): string {
  const mins = opcoes.map(emMinutos);
  const regular =
    opcoes.length >= 3 &&
    mins.every((v, i) => v !== null && (i === 0 || v - (mins[i - 1] as number) === 30));
  return regular
    ? `de ${opcoes[0]} a ${opcoes[opcoes.length - 1]}, de 30 em 30 minutos`
    : listaEmPortugues([...opcoes]);
}

function descreverCanais(c: CanaisDoAviso): string {
  if (c.email === false && c.whatsapp === false) return "desligado (sem e-mail e sem WhatsApp)";
  const partes: string[] = [];
  if (c.email !== undefined) partes.push(`e-mail ${c.email ? "ligado" : "desligado"}`);
  if (c.whatsapp !== undefined) partes.push(`WhatsApp ${c.whatsapp ? "ligado" : "desligado"}`);
  return partes.join(" e ");
}

function rotuloDe(rotulos: Record<string, string>, tipo: string): string {
  return rotulos[tipo] ?? tipo;
}

/** As linhas do que o PATCH muda — o mesmo texto serve ao resumo e ao "pronto". */
function linhasDoPatch(patch: PrefsPatch, rotulos: Record<string, string>): string[] {
  const linhas: string[] = [];
  for (const [tipo, canais] of Object.entries(patch.types ?? {})) {
    linhas.push(`• ${rotuloDe(rotulos, tipo)}: ${descreverCanais(canais)}`);
  }
  if (patch.schedule?.morningReportAt) linhas.push(`• Relatório da manhã às ${patch.schedule.morningReportAt}`);
  if (patch.schedule?.dueSoonLeadMin !== undefined) {
    linhas.push(`• Lembrete ${descreverAntecedencia(patch.schedule.dueSoonLeadMin)} antes do vencimento`);
  }
  return linhas;
}

function ligaWhatsapp(patch: PrefsPatch): boolean {
  return Object.values(patch.types ?? {}).some((c) => c.whatsapp === true);
}

/** O que a pessoa tem hoje, em linhas — para a resposta de "o que posso mudar?". */
export function linhasDoEstado(view: PrefsView): string[] {
  const linhas = view.tipos.map((t) => {
    const c = view.prefs.types?.[t.type];
    const estado = c && (c.email !== undefined || c.whatsapp !== undefined) ? descreverCanais(c) : "no padrão do sistema";
    return `• ${t.label}: ${estado}`;
  });
  const hora = view.prefs.schedule?.morningReportAt ?? view.defaults.morningReportAt;
  const lead = view.prefs.schedule?.dueSoonLeadMin ?? view.defaults.dueSoonLeadMin;
  linhas.push(`• Horário do relatório da manhã: ${hora}`);
  linhas.push(`• Lembrete: ${descreverAntecedencia(lead)} antes do vencimento`);
  return linhas;
}

/**
 * O que o modelo vê de `minhas_notificacoes`: sem ids internos, com o nome
 * legível, o estado gravado (ou "no padrão") e as opções que o servidor aceita.
 */
export function projetarParaOModelo(view: PrefsView): Record<string, unknown> {
  return {
    avisos: view.tipos.map((t) => {
      const c = view.prefs.types?.[t.type];
      const gravado = !!c && (c.email !== undefined || c.whatsapp !== undefined);
      return {
        tipo: t.type,
        nome: t.label,
        no_padrao: !gravado,
        ...(gravado ? { email: c?.email ?? null, whatsapp: c?.whatsapp ?? null } : {}),
      };
    }),
    horario_relatorio: view.prefs.schedule?.morningReportAt ?? view.defaults.morningReportAt,
    antecedencia_lembrete_min: view.prefs.schedule?.dueSoonLeadMin ?? view.defaults.dueSoonLeadMin,
    opcoes_horario: view.options.morningReport,
    opcoes_antecedencia_min: view.options.dueSoon,
  };
}

// ─── Leitura do pedido ────────────────────────────────────────────────────

/** "6h", "6:30", "06h30", "18" → "HH:MM"; o que não parece horário → `null`. */
export function lerHorario(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase().replace(/\s+/g, "").replace(/hs?$/, "");
  const m = /^(\d{1,2})(?:[:h](\d{2}))?$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function lerInteiro(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^\d{1,6}$/.test(v.trim())) return Number(v.trim());
  return null;
}

function presente(v: unknown): boolean {
  return v !== undefined && v !== null && !(typeof v === "string" && !v.trim());
}

/** O tipo do servidor a que o texto do modelo se refere: apelido, tipo cru ou nome legível. */
function resolverTipo(valor: unknown, tipos: PrefsView["tipos"]): { type: string; label: string } | null {
  if (typeof valor !== "string" || !valor.trim()) return null;
  const bruto = valor.trim();
  const id = Object.hasOwn(ALIAS_DE_TIPO_DE_AVISO, bruto) ? (ALIAS_DE_TIPO_DE_AVISO[bruto] as string) : bruto;
  const direto = tipos.find((t) => t.type === id);
  if (direto) return direto;
  const n = normalizar(bruto);
  const exato = tipos.filter((t) => normalizar(t.label) === n);
  if (exato.length === 1) return exato[0] as { type: string; label: string };
  if (n.length >= 4) {
    const parcial = tipos.filter((t) => normalizar(t.label).includes(n));
    if (parcial.length === 1) return parcial[0] as { type: string; label: string };
  }
  return null;
}

/** Os canais pedidos. `ativo:false` é atalho para desligar os dois; `ativo:true` sozinho NÃO escolhe canal. */
function canaisDoPedido(item: Record<string, unknown>): CanaisDoAviso | null {
  const email = typeof item.email === "boolean" ? item.email : undefined;
  const whatsapp = typeof item.whatsapp === "boolean" ? item.whatsapp : undefined;
  if (email !== undefined || whatsapp !== undefined) {
    return { ...(email !== undefined ? { email } : {}), ...(whatsapp !== undefined ? { whatsapp } : {}) };
  }
  if (item.ativo === false) return { email: false, whatsapp: false };
  return null;
}

export interface PedidoDePreferencias {
  avisos?: unknown;
  horario_relatorio?: unknown;
  antecedencia_lembrete_min?: unknown;
}

type Montagem =
  | { ok: true; patch: PrefsPatch; rotulos: Record<string, string> }
  | { ok: false; reply: string; evento: string };

const TEXTO_NADA_ALTERADO = "Nada foi alterado.";

function textoDosHorarios(opcoes: readonly string[]): string {
  return `Os horários possíveis para o relatório da manhã são ${descreverHorarios(opcoes)}.`;
}

function textoDasAntecedencias(opcoes: readonly number[]): string {
  return `Posso avisar ${listaEmPortugues(opcoes.map(descreverAntecedencia))} antes do vencimento.`;
}

/** O pedido do modelo → o PATCH, validado contra as opções do servidor. Dado que não serve vira pergunta. */
function montarPatch(pedido: PedidoDePreferencias, view: PrefsView): Montagem {
  const types: Record<string, CanaisDoAviso> = {};
  const rotulos: Record<string, string> = {};
  const itens = Array.isArray(pedido.avisos) ? pedido.avisos : [];

  for (const bruto of itens) {
    const item = bruto && typeof bruto === "object" && !Array.isArray(bruto) ? (bruto as Record<string, unknown>) : {};
    const tipo = resolverTipo(item.tipo, view.tipos);
    if (!tipo) {
      const nomes = view.tipos.map((t) => t.label);
      return {
        ok: false,
        evento: "prefs_tipo_desconhecido",
        reply: `Não achei esse aviso. Posso ajustar: ${listaEmPortugues(nomes)}. ${TEXTO_NADA_ALTERADO}`,
      };
    }
    const canais = canaisDoPedido(item);
    if (!canais) {
      return {
        ok: false,
        evento: "prefs_pede_canal",
        reply: `Como você quer receber "${tipo.label}": por e-mail, por WhatsApp, pelos dois ou nenhum? ${TEXTO_NADA_ALTERADO}`,
      };
    }
    types[tipo.type] = { ...types[tipo.type], ...canais };
    rotulos[tipo.type] = tipo.label;
  }

  const schedule: NonNullable<PrefsPatch["schedule"]> = {};
  if (presente(pedido.horario_relatorio)) {
    const h = lerHorario(pedido.horario_relatorio);
    if (!h || !view.options.morningReport.includes(h)) {
      const pedido_ = h ?? String(pedido.horario_relatorio).trim();
      return {
        ok: false,
        evento: "prefs_horario_fora_das_opcoes",
        reply: `Não consigo mandar o relatório da manhã às ${pedido_}. ${textoDosHorarios(view.options.morningReport)} Qual você prefere? ${TEXTO_NADA_ALTERADO}`,
      };
    }
    schedule.morningReportAt = h;
  }
  if (presente(pedido.antecedencia_lembrete_min)) {
    const n = lerInteiro(pedido.antecedencia_lembrete_min);
    if (n === null || !view.options.dueSoon.includes(n)) {
      return {
        ok: false,
        evento: "prefs_antecedencia_fora_das_opcoes",
        reply: `Não consigo avisar com essa antecedência. ${textoDasAntecedencias(view.options.dueSoon)} Qual você prefere? ${TEXTO_NADA_ALTERADO}`,
      };
    }
    schedule.dueSoonLeadMin = n;
  }

  const patch: PrefsPatch = {
    ...(Object.keys(types).length ? { types } : {}),
    ...(Object.keys(schedule).length ? { schedule } : {}),
  };
  if (!patch.types && !patch.schedule) {
    return {
      ok: false,
      evento: "prefs_pedido_vazio",
      reply:
        `O que você quer mudar nos seus avisos? Hoje está assim:\n${linhasDoEstado(view).join("\n")}\n\n` +
        `Por exemplo: "não quero mais o relatório da manhã" ou "me avisa 1 hora antes". ${TEXTO_NADA_ALTERADO}`,
    };
  }
  return { ok: true, patch, rotulos };
}

// ─── Capability ───────────────────────────────────────────────────────────

/** A política deste turn concede ajustar os próprios avisos? Fail-closed: política indisponível = não. */
export function preferenciasPermitidas(ctx: Pick<ContextoDoTurno, "policy" | "politicaIndisponivel">): boolean {
  return !ctx.politicaIndisponivel && ctx.policy.includes("prefs.self");
}

function recusaDePermissao(ctx: Pick<ContextoDoTurno, "politicaIndisponivel">): Resposta {
  return resposta(
    null,
    ctx.politicaIndisponivel ? TEXTO_PREFS_SEM_VERIFICAR : TEXTO_PREFS_NAO_LIBERADO,
    ctx.politicaIndisponivel ? "prefs_politica_indisponivel" : "prefs_sem_politica"
  );
}

// ─── Entrada: o pedido vira resumo (ou pergunta) ──────────────────────────

/**
 * O pedido do modelo → o primeiro passo. Lê o estado atual (as opções do
 * servidor), valida e só então abre o fluxo com o resumo. Sem `prefs.self`
 * nada é lido nem chamado.
 */
export async function iniciarPreferencias(
  pedido: PedidoDePreferencias,
  ctx: ContextoDoTurno,
  deps: DepsDoFluxo
): Promise<Resposta> {
  if (!preferenciasPermitidas(ctx)) return recusaDePermissao(ctx);
  const view = deps.preferencias ? await deps.preferencias.ler() : null;
  if (!view) return resposta(null, TEXTO_PREFS_SEM_LEITURA, "prefs_sem_leitura");

  const m = montarPatch(pedido, view);
  if (!m.ok) return resposta(null, m.reply, m.evento);
  return resumo({ kind: "preferencias", etapa: "confirmacao", patch: m.patch, rotulos: m.rotulos, atualizadoEm: ctx.agora });
}

function resumo(f: FluxoPreferencias): Resposta {
  const whats = ligaWhatsapp(f.patch)
    ? "\n\nAo ligar o WhatsApp, você autoriza receber esses avisos por lá."
    : "";
  return resposta(
    { ...f, etapa: "confirmacao" },
    `Vou ajustar os seus avisos:\n${linhasDoPatch(f.patch, f.rotulos).join("\n")}${whats}\n\nConfirma?${SIM_OU_NAO}`,
    "prefs_resumo"
  );
}

// ─── Erros do servidor → frase legível ────────────────────────────────────

export function textoDaRecusa(r: Extract<PrefsPatchResult, { ok: false }>): string {
  switch (r.code) {
    case "valor_invalido": {
      const permitidos = r.allowed ?? [];
      if (permitidos.length && permitidos.every((v) => typeof v === "string")) {
        return `O sistema não aceitou esse horário. ${textoDosHorarios(permitidos as string[])} ${TEXTO_NADA_ALTERADO}`;
      }
      if (permitidos.length && permitidos.every((v) => typeof v === "number")) {
        return `O sistema não aceitou essa antecedência. ${textoDasAntecedencias(permitidos as number[])} ${TEXTO_NADA_ALTERADO}`;
      }
      return `O sistema não aceitou um dos valores. ${TEXTO_NADA_ALTERADO}`;
    }
    case "tipo_desconhecido":
      return `O sistema não reconheceu esse tipo de aviso. ${TEXTO_NADA_ALTERADO}`;
    case "sem_telefone":
      return `Não achei um telefone seu cadastrado no sistema, então não dá para ligar o aviso por WhatsApp. ${TEXTO_NADA_ALTERADO}`;
    case "email_nao_configuravel":
      return `Esse aviso não pode ser enviado por e-mail. ${TEXTO_NADA_ALTERADO}`;
  }
}

function textoDeSucesso(f: FluxoPreferencias, optIn: "set" | "cleared" | "unchanged"): string {
  const nota =
    optIn === "set"
      ? "\nSeu aceite para receber avisos por WhatsApp ficou registrado."
      : optIn === "cleared"
        ? "\nComo você não recebe mais nenhum aviso por WhatsApp, o aceite desse canal foi removido."
        : "";
  return `Pronto, ajustei os seus avisos:\n${linhasDoPatch(f.patch, f.rotulos).join("\n")}${nota}`;
}

// ─── Condução ─────────────────────────────────────────────────────────────

export async function conduzirPreferencias(f: FluxoPreferencias, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const confirmacao = lerConfirmacao(ctx.texto);

  if (confirmacao === "nao" || CANCELAR.test(ctx.texto.trim())) {
    return resposta(null, `Parei por aqui. ${TEXTO_NADA_ALTERADO}`, "prefs_cancelada");
  }

  // A política é reconferida a cada turn: entre o resumo e o SIM ela pode ter mudado.
  if (!preferenciasPermitidas(ctx)) {
    if (ctx.politicaIndisponivel) {
      return resposta({ ...f, etapa: "resumo" }, TEXTO_PREFS_SEM_VERIFICAR, "prefs_politica_indisponivel");
    }
    return resposta(null, TEXTO_PREFS_NAO_LIBERADO, "prefs_sem_politica");
  }

  // Outro assunto libera o turno; o fluxo fica como está.
  if (confirmacao === "nenhum") return { liberar: true, fluxo: f, evento: "prefs_outro_assunto" };
  // `resumo` (rebaixado por interrupção): o SIM só reapresenta, nunca escreve.
  if (f.etapa === "resumo" || confirmacao !== "sim") return resumo({ ...f, atualizadoEm: ctx.agora });

  const r = deps.preferencias ? await deps.preferencias.atualizar(f.patch) : null;
  // Sem resposta (rede/5xx/timeout): incerto. Os valores são absolutos, então o próximo SIM repete o mesmo PATCH.
  if (!r) return resposta({ ...f, etapa: "confirmacao", atualizadoEm: ctx.agora }, TEXTO_INCERTO, "prefs_incerta");
  if (r.ok) return resposta(null, textoDeSucesso(f, r.whatsappOptIn), "prefs_atualizada");
  return resposta(null, textoDaRecusa(r), `prefs_recusada_${r.code}`);
}

/** Interrupção do turn: o SIM seguinte não pode escrever sem o resumo ser mostrado de novo. */
export function rebaixarPreferencias(f: FluxoPreferencias): FluxoPreferencias {
  return { ...f, etapa: "resumo" };
}
