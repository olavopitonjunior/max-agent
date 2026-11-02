import { nomeDoAgente } from "@/lib/deploy-profile";
import type { ContextoDoTurno, DepsDoFluxo, Fluxo, PassoDoFluxo } from "./fluxos";
import { lerConfirmacao } from "./tools";

/**
 * Atividades pelo WhatsApp (Atividades v2 / M1, par do contractmaker PR11).
 *
 * Criar, comentar, concluir e recusar atividade INTERNA da imobiliária. Mesmo
 * desenho da gestão de proposta (`gestao.ts`): o modelo (ou o botão `atv:`)
 * só PEDE; quem conduz é este fluxo determinístico — resumo → SIM → o verbo do
 * servidor, com a `messageId` do SIM como `x-idempotency-key` e a chave
 * guardada enquanto o resultado é incerto.
 *
 * ── O que este módulo NÃO faz ──────────────────────────────────────────────
 *
 *  - Não fala com parte nem cliente: atividade é coisa da equipe. Nenhum texto
 *    daqui cita, cobra ou contata terceiro.
 *  - Não decide autorização: a capability `activity.write` (fora do padrão,
 *    fail-closed) é conferida de novo a cada turn, e o servidor refaz política,
 *    papel e visibilidade. Aqui só se traduz o código de recusa em frase.
 *  - Não chama modelo: o resumo é template, o texto do comentário é o que a
 *    pessoa escreveu.
 */

export type OperacaoDeAtividade = "criar" | "comentar" | "concluir" | "recusar";

export const TIPOS_DE_ATIVIDADE = ["ligacao", "visita", "reuniao", "documento", "pendencia", "outro", "vistoria", "assinatura", "contato", "prazo_documental"] as const;
export type TipoDeAtividade = (typeof TIPOS_DE_ATIVIDADE)[number];

const ROTULO_DO_TIPO: Record<TipoDeAtividade, string> = {
  ligacao: "ligação",
  visita: "visita",
  reuniao: "reunião",
  documento: "documento",
  pendencia: "pendência",
  outro: "outro",
  vistoria: "vistoria",
  assinatura: "assinatura",
  contato: "contato",
  prazo_documental: "prazo documental",
};

/** Limites do servidor (`scope-action-atividade.ts`): validar aqui evita ida e volta, mas o servidor reconfere. */
const LIMITES = { titulo: 140, notas: 2000, texto: 4000, motivoMin: 3, motivo: 500 } as const;

export const VERBO_DE_ATIVIDADE: Record<OperacaoDeAtividade, string> = {
  criar: "activity.create",
  comentar: "activity.comment",
  concluir: "activity.complete",
  recusar: "activity.refuse",
};

export interface DadosDeAtividade {
  tipo?: TipoDeAtividade;
  titulo?: string;
  /** `AAAA-MM-DD` (dia inteiro) ou ISO completo com fuso. Já validado. */
  vencimento?: string;
  notas?: string;
  texto?: string;
  motivo?: string;
}

export interface FluxoAtividade {
  kind: "atividade";
  operacao: OperacaoDeAtividade;
  /** `texto`: esperando o comentário/motivo. `resumo`: o próximo SIM só reapresenta. `confirmacao`: o SIM escreve. */
  etapa: "texto" | "resumo" | "confirmacao";
  /** Criar: o negócio. Os demais: a atividade. O `id` nunca vai ao modelo nem à resposta. */
  alvo: { id: string; rotulo: string };
  dados: DadosDeAtividade;
  chave?: { verbo: string; valor: string };
  atualizadoEm: number;
}

type Resposta = Extract<PassoDoFluxo, { reply: string }>;

function resposta(f: Fluxo | null, reply: string, evento: string): Resposta {
  return { fluxo: f, reply, evento };
}

// ─── Textos fixos ─────────────────────────────────────────────────────────

export const textoAtividadeNaoLiberada = (): string =>
  `Gerenciar atividades pelo ${nomeDoAgente()} não está liberado para você. Nada foi alterado; faça pela tela de atividades do sistema.`;
export const TEXTO_ATIVIDADE_SEM_VERIFICAR =
  "Não consegui validar sua permissão agora. Nada foi alterado; tente de novo em instantes.";
/** A resposta neutra: a mesma para id malformado, outra org e inexistente. Não revela existência. */
export const TEXTO_ATIVIDADE_INDISPONIVEL = "Essa atividade não está mais disponível.";

/** Escrita incerta pendente: a chave fica, e só um SIM (ou a conferência na tela) fecha o assunto. */
export const TEXTO_ATIVIDADE_CONFERIR =
  "Responda SIM para eu conferir o pedido anterior antes de começar outro. Ele pode já ter sido registrado; não vou repetir a escrita.";

const SIM_OU_NAO = "\n\nResponda SIM para confirmar ou NÃO para parar.";

/** Cita um texto da pessoa/servidor sem deixar quebra de linha ou aspas soltas bagunçarem o resumo. */
function citar(t: string, max = 200): string {
  const limpo = t.replace(/\s+/g, " ").trim();
  return `"${limpo.length > max ? `${limpo.slice(0, max - 1)}…` : limpo}"`;
}

function dataLegivel(v: string): string {
  const dia = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  const base = dia ? `${dia[3]}/${dia[2]}/${dia[1]}` : v;
  const hora = /T(\d{2}):(\d{2})/.exec(v);
  return hora ? `${base} às ${hora[1]}:${hora[2]}` : base;
}

// ─── Validação do vencimento ──────────────────────────────────────────────

const SO_DATA = /^\d{4}-\d{2}-\d{2}$/;
const DATA_E_HORA = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * `vencimento` aceito pelo servidor: `AAAA-MM-DD` ou ISO COM fuso. Data e hora
 * sem fuso é recusada — o servidor também a recusa, e chutar o fuso moveria o
 * compromisso de horário sem ninguém ver. Sem segundos, completa `:00` (o
 * validador do servidor exige).
 */
export function lerVencimento(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (SO_DATA.test(t)) return Number.isNaN(Date.parse(`${t}T12:00:00Z`)) || !dataExiste(t) ? null : t;
  const m = DATA_E_HORA.exec(t);
  if (!m) return null;
  if (!dataExiste(m[1]!)) return null;
  const normal = `${m[1]}T${m[2]}${m[3] ?? ":00"}${m[4]}`;
  return Number.isNaN(Date.parse(normal)) ? null : normal;
}

/** 2026-02-31 passa no `Date.parse` de alguns motores; aqui não. */
function dataExiste(ymd: string): boolean {
  const [a, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function lerTipoDeAtividade(v: unknown): TipoDeAtividade | null {
  return typeof v === "string" && (TIPOS_DE_ATIVIDADE as readonly string[]).includes(v) ? (v as TipoDeAtividade) : null;
}

// ─── Capability ───────────────────────────────────────────────────────────

/** A política deste turn concede escrever atividade? Fail-closed: política indisponível = não. */
export function atividadePermitida(ctx: Pick<ContextoDoTurno, "policy" | "politicaIndisponivel">): boolean {
  return !ctx.politicaIndisponivel && ctx.policy.includes("activity.write");
}

function recusaDePermissao(ctx: Pick<ContextoDoTurno, "politicaIndisponivel">): Resposta {
  return resposta(
    null,
    ctx.politicaIndisponivel ? TEXTO_ATIVIDADE_SEM_VERIFICAR : textoAtividadeNaoLiberada(),
    ctx.politicaIndisponivel ? "atividade_politica_indisponivel" : "atividade_sem_politica"
  );
}

// ─── Entrada: o pedido vira resumo (ou pergunta) ──────────────────────────

export interface PedidoDeAtividade {
  operacao: OperacaoDeAtividade;
  alvo: { id: string; rotulo: string };
  tipo?: unknown;
  titulo?: unknown;
  vencimento?: unknown;
  notas?: unknown;
  texto?: unknown;
  motivo?: unknown;
}

function textoOpcional(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * O pedido (do modelo ou do botão) → o primeiro passo do fluxo.
 *
 * Sem `activity.write`, NADA acontece e nenhum verbo é chamado: resposta fixa,
 * sem fluxo. Dado inválido na criação também não abre fluxo (nem chama): a
 * resposta diz o que ajustar. Comentário/recusa sem texto abrem a pergunta.
 */
export function iniciarAtividade(pedido: PedidoDeAtividade, ctx: ContextoDoTurno): Resposta {
  if (!atividadePermitida(ctx)) return recusaDePermissao(ctx);

  const base: FluxoAtividade = {
    kind: "atividade",
    operacao: pedido.operacao,
    etapa: "texto",
    alvo: pedido.alvo,
    dados: {},
    atualizadoEm: ctx.agora,
  };

  if (pedido.operacao === "concluir") return resumo({ ...base, etapa: "confirmacao" });

  if (pedido.operacao === "criar") {
    const tipo = lerTipoDeAtividade(pedido.tipo);
    const titulo = textoOpcional(pedido.titulo);
    const vencimento = lerVencimento(pedido.vencimento);
    const notas = textoOpcional(pedido.notas);
    if (!tipo) return resposta(null, `Que tipo de atividade? Escolha entre ligação, visita, reunião, documento, pendência, vistoria, assinatura, contato, prazo documental ou outro. Nada foi criado.`, "atividade_dado_invalido");
    if (!titulo) return resposta(null, "Qual o título da atividade? Nada foi criado.", "atividade_dado_invalido");
    if (titulo.length > LIMITES.titulo) return resposta(null, `O título passou de ${LIMITES.titulo} caracteres. Encurte e peça de novo; nada foi criado.`, "atividade_dado_invalido");
    if (!vencimento) {
      return resposta(null, "Não entendi o vencimento. Diga a data (por exemplo, 25/10) ou data e hora; nada foi criado.", "atividade_dado_invalido");
    }
    if (notas && notas.length > LIMITES.notas) return resposta(null, `As notas passaram de ${LIMITES.notas} caracteres; nada foi criado.`, "atividade_dado_invalido");
    return resumo({ ...base, etapa: "confirmacao", dados: { tipo, titulo, vencimento, ...(notas ? { notas } : {}) } });
  }

  // comentar / recusar: precisam do texto. Se veio, valida; senão pergunta.
  const campo = pedido.operacao === "comentar" ? "texto" : "motivo";
  const dado = textoOpcional(campo === "texto" ? pedido.texto : pedido.motivo);
  if (!dado) return perguntarTexto(base);
  const erro = erroDoTexto(pedido.operacao, dado);
  if (erro) return resposta({ ...base, atualizadoEm: ctx.agora }, erro, "atividade_texto_invalido");
  return resumo({ ...base, etapa: "confirmacao", dados: { [campo]: dado } });
}

function perguntarTexto(f: FluxoAtividade): Resposta {
  const rotulo = citar(f.alvo.rotulo, 80);
  return resposta(
    { ...f, etapa: "texto" },
    f.operacao === "comentar"
      ? `O que você quer comentar na atividade ${rotulo}? Escreva o texto. Para parar, responda NÃO.`
      : `Qual o motivo para recusar a atividade ${rotulo}? Escreva em poucas palavras. Para parar, responda NÃO.`,
    "atividade_pede_texto"
  );
}

/** Mensagem de ajuste quando o texto não serve; `null` = serve. */
function erroDoTexto(op: OperacaoDeAtividade, texto: string): string | null {
  if (op === "comentar") {
    return texto.length > LIMITES.texto ? `O comentário passou de ${LIMITES.texto} caracteres. Encurte e mande de novo.` : null;
  }
  if (texto.length < LIMITES.motivoMin) return "O motivo precisa ter pelo menos 3 caracteres. Escreva o motivo da recusa.";
  return texto.length > LIMITES.motivo ? `O motivo passou de ${LIMITES.motivo} caracteres. Encurte e mande de novo.` : null;
}

// ─── Resumo (a proposta) ──────────────────────────────────────────────────

function resumo(f: FluxoAtividade): Resposta {
  const alvo = citar(f.alvo.rotulo, 80);
  let texto: string;
  switch (f.operacao) {
    case "criar": {
      const d = f.dados;
      texto =
        `Vou criar a atividade ${citar(d.titulo ?? "")} (${ROTULO_DO_TIPO[d.tipo ?? "outro"]}) no negócio ${alvo}, ` +
        `com vencimento em ${dataLegivel(d.vencimento ?? "")}. Você fica como responsável.` +
        (d.notas ? ` Notas: ${citar(d.notas, 120)}.` : "") +
        " Confirma?";
      break;
    }
    case "comentar":
      texto = `Vou comentar na atividade ${alvo}: ${citar(f.dados.texto ?? "", 300)}. Confirma?`;
      break;
    case "concluir":
      texto = `Vou marcar a atividade ${alvo} como concluída. Confirma?`;
      break;
    case "recusar":
      texto = `Vou recusar a atividade ${alvo} e devolvê-la a quem a passou, com o motivo ${citar(f.dados.motivo ?? "", 300)}. Confirma?`;
      break;
  }
  return resposta({ ...f, etapa: "confirmacao" }, `${texto}${SIM_OU_NAO}`, "atividade_resumo");
}

// ─── Argumentos do verbo ──────────────────────────────────────────────────

export function argsDoVerbo(f: FluxoAtividade): Record<string, unknown> {
  const d = f.dados;
  switch (f.operacao) {
    case "criar":
      return { negocio_id: f.alvo.id, tipo: d.tipo, titulo: d.titulo, vencimento: d.vencimento, ...(d.notas ? { notas: d.notas } : {}) };
    case "comentar":
      return { atividade_id: f.alvo.id, texto: d.texto };
    case "concluir":
      return { atividade_id: f.alvo.id };
    case "recusar":
      return { atividade_id: f.alvo.id, motivo: d.motivo };
  }
}

// ─── Erros do servidor → frase legível ────────────────────────────────────

/**
 * Recusas do servidor → frase fixa. Nada aqui afirma que a operação aconteceu,
 * e nenhuma frase confirma ou nega a existência de uma atividade que a pessoa
 * não pode ver (403 e 404 não se distinguem para quem não participa).
 */
export function textoDoErro(op: OperacaoDeAtividade, status: number, body: Record<string, unknown>): string {
  const erro = String(body.error ?? "");
  const razao = String(body.reason ?? "");
  const alvo = op === "criar" ? "o negócio" : "a atividade";
  if (status === 403) {
    if (razao === "politica_nao_concede" || erro === "Forbidden") return textoAtividadeNaoLiberada();
    return op === "criar"
      ? "Seu perfil no sistema não permite criar atividade nesse negócio. Nada foi criado."
      : `Seu perfil no sistema não permite essa ação na atividade. Nada foi alterado.`;
  }
  if (status === 404) {
    return op === "criar" ? "Não encontrei esse negócio entre os seus. Nada foi criado." : `${TEXTO_ATIVIDADE_INDISPONIVEL} Nada foi alterado.`;
  }
  if (status === 409) {
    if (erro === "ALREADY_DONE") return "Essa atividade já estava concluída. Nada foi alterado.";
    if (erro === "CANCELED") return "Essa atividade foi cancelada. Nada foi alterado.";
    if (erro === "NO_RETURN_TARGET") return "Não há para quem devolver essa atividade, então não dá para recusá-la. Nada foi alterado.";
    if (erro === "NEWTON_CLOSED") return "O pedido ao Newton dessa atividade já foi encerrado. Nada foi alterado.";
    return `O estado d${alvo} mudou agora há pouco. Confira no sistema e peça de novo se ainda quiser. Nada foi alterado.`;
  }
  if (status === 422) {
    if (erro === "REFUSE_SELF") return "Você não pode recusar uma atividade que você mesmo criou. Se não vale mais, conclua ou cancele pelo sistema.";
    if (erro === "SOURCE_LOCKED") return "Essa atividade vem de um processo automático e não pode ser alterada por aqui. Nada foi alterado.";
    if (erro === "NO_RETURN_TARGET") return "Não há para quem devolver essa atividade, então não dá para recusá-la. Nada foi alterado.";
    if (erro === "INVALID_ASSIGNEE") return "O sistema não aceitou o responsável da atividade. Nada foi criado.";
    if (erro === "INVALID_BODY") return "O sistema não aceitou o texto enviado. Confira e tente de novo; nada foi alterado.";
    return "O sistema não aceitou o pedido. Nada foi alterado.";
  }
  if (status === 400) {
    return razao === "vencimento_invalido"
      ? "O sistema não aceitou o vencimento. Diga a data de novo; nada foi criado."
      : "O sistema não aceitou os dados do pedido. Confira e tente de novo; nada foi alterado.";
  }
  // 5xx/timeout nunca chegam aqui: `acao.ts` os devolve como null (escrita incerta, tratada em `conduzirAtividade`).
  return `O sistema não confirmou ${op === "criar" ? "a criação" : "a alteração"}. Nada foi alterado pelo ${nomeDoAgente()}.`;
}

function textoDeSucesso(f: FluxoAtividade): string {
  const alvo = citar(f.alvo.rotulo, 80);
  switch (f.operacao) {
    case "criar":
      return `Atividade ${citar(f.dados.titulo ?? "", 80)} criada no negócio ${alvo}.`;
    case "comentar":
      return `Comentário registrado na atividade ${alvo}.`;
    case "concluir":
      return `Atividade ${alvo} concluída.`;
    case "recusar":
      return `Atividade ${alvo} recusada e devolvida.`;
  }
}

// ─── Condução ─────────────────────────────────────────────────────────────

const CANCELAR = /^(cancelar|cancela|pare|parar|desistir|esquece|deixa pra la)[.!]?$/i;

export async function conduzirAtividade(f: FluxoAtividade, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const confirmacao = lerConfirmacao(ctx.texto);

  if (confirmacao === "nao" || CANCELAR.test(ctx.texto.trim())) {
    // Com escrita incerta, a chave fica: o pedido pode já ter passado.
    return f.chave
      ? resposta({ ...f, etapa: "confirmacao", atualizadoEm: ctx.agora }, TEXTO_ATIVIDADE_CONFERIR, "atividade_cancelada")
      : resposta(null, "Parei por aqui. Nada foi alterado.", "atividade_cancelada");
  }

  // A política é reconferida a cada turn: entre o resumo e o SIM ela pode ter mudado.
  if (!atividadePermitida(ctx)) {
    if (ctx.politicaIndisponivel) {
      return resposta({ ...f, etapa: f.etapa === "texto" ? "texto" : "resumo" }, TEXTO_ATIVIDADE_SEM_VERIFICAR, "atividade_politica_indisponivel");
    }
    return resposta(null, textoAtividadeNaoLiberada(), "atividade_sem_politica");
  }

  if (f.etapa === "texto") {
    // "Sim" não é o texto: é a pessoa respondendo a uma pergunta que não fizemos.
    if (confirmacao === "sim") return perguntarTexto(f);
    const dado = ctx.texto.trim();
    const erro = erroDoTexto(f.operacao, dado);
    if (erro) return resposta({ ...f, atualizadoEm: ctx.agora }, erro, "atividade_texto_invalido");
    const campo = f.operacao === "comentar" ? "texto" : "motivo";
    return resumo({ ...f, dados: { ...f.dados, [campo]: dado }, atualizadoEm: ctx.agora });
  }

  // Outro assunto libera o turno; a chave (se houver) fica no fluxo para o próximo SIM.
  if (confirmacao === "nenhum") return { liberar: true, fluxo: f, evento: "atividade_outro_assunto" };
  // `resumo` (rebaixado por interrupção): o SIM só reapresenta, nunca escreve.
  // Com a chave em mãos (escrita incerta) o SIM SEMPRE reconcilia: mesma chave, o servidor devolve a resposta guardada.
  if ((f.etapa === "resumo" && !f.chave) || confirmacao !== "sim") return resumo({ ...f, atualizadoEm: ctx.agora });

  const chave = f.chave ?? { verbo: VERBO_DE_ATIVIDADE[f.operacao], valor: ctx.messageId };
  const emCurso: FluxoAtividade = { ...f, chave, atualizadoEm: ctx.agora };
  const r = await deps.acao(chave.verbo, argsDoVerbo(f), chave.valor);

  // Sem resposta (rede/5xx) ou "em andamento": incerto. A mesma chave é reusada no próximo SIM.
  if (!r || (r.status === 409 && r.body.error === "em_andamento")) {
    return resposta(emCurso, "Ainda não confirmei o resultado. Responda SIM para verificar o mesmo pedido, sem repeti-lo.", "atividade_incerta");
  }
  if (r.status === 200 || r.status === 201) return resposta(null, textoDeSucesso(f), `atividade_${f.operacao}`);
  return resposta(null, textoDoErro(f.operacao, r.status, r.body), `atividade_erro_${r.status}`);
}

/** Interrupção do turn: o SIM seguinte não pode escrever sem o resumo ser mostrado de novo. */
export function rebaixarAtividade(f: FluxoAtividade): FluxoAtividade {
  return f.chave ? f : { ...f, etapa: f.etapa === "confirmacao" ? "resumo" : f.etapa };
}

/** Texto de "já há um pedido em andamento": com escrita incerta guia para o SIM (cancelar não destrava). */
export function textoDeOcupado(fluxo: { kind: string; chave?: unknown } | null | undefined): string {
  return fluxo?.kind === "atividade" && fluxo.chave
    ? TEXTO_ATIVIDADE_CONFERIR
    : "Você já tem um pedido em andamento comigo. Continue por aqui, ou diga CANCELAR para começar outro.";
}
