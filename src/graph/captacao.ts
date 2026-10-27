import { nomeDoAgente } from "@/lib/deploy-profile";
import type { ContextoDoTurno, DepsDoFluxo, PassoDoFluxo } from "./fluxos";
import { lerConfirmacao, normalizar } from "./tools";
import { brl, cpfValido, nomeValido, valoresNoTexto } from "./credito";
import { captacaoAutorizacaoLigada, captacaoEnvioLigado, captacaoLigada } from "./captacao-flags";
import { imobproBase } from "@/lib/http";
import { RE_CNPJ, RE_CPF, redigir } from "@/lib/pii";
import { normalizeBrPhone } from "@/lib/phone";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Fluxo `captacao` (P9, par do P8 do ImobPro — `docs/max.md` §18.12): o Max
 * cria o rascunho de uma captação (contrato de captação), completa, confere o
 * que falta e, com a confirmação da pessoa, envia para assinatura.
 *
 * Desenho (molde: `credito.ts`):
 *  - intercepto determinístico (`pedeCaptacao`) antes da consulta/criação;
 *  - flags `MAX_CAPTACAO` (fluxo) e `MAX_CAPTACAO_ENVIO` (envio), DESLIGADAS por
 *    padrão: a capability nasce fail-closed (regra 3 da governança);
 *  - gate: usuário + política concede a capability do verbo (o servidor ainda
 *    confere a RBAC do sujeito);
 *  - o rascunho MORA NO IMOBPRO: assim que há nome + imóvel/condições, o fluxo
 *    cria (`captacao.create`) e cada proprietário entra por `captacao.create
 *    {captacaoId, version}`. O checkpoint guarda só referência (id, versão, nomes
 *    dos proprietários) — nunca CPF, e-mail ou telefone;
 *  - a extração por LLM só preenche (nome, endereço) e o que ela devolve é
 *    conferido contra o texto da pessoa; valores, documentos e contatos são lidos
 *    em CÓDIGO. Toda extração reporta custo (`AIUsage`, regra 6) pelo
 *    `extrair` do grafo;
 *  - R7: nenhum envio do Max ao proprietário. O envio é do ImobPro, para os
 *    assinantes do documento, e só depois do "enviar" explícito da pessoa.
 */

// ─── Flags ───────────────────────────────────────────────────────────────

/** `MAX_CAPTACAO`, `MAX_CAPTACAO_ENVIO` e `MAX_CAPTACAO_AUTORIZACAO`, todas desligadas por padrão (ver `captacao-flags.ts`). */
export { captacaoLigada, captacaoEnvioLigado, captacaoAutorizacaoLigada };

// ─── Estado ──────────────────────────────────────────────────────────────

export type TipoDeCaptacao = "venda" | "locacao";

/**
 * `exclusiva` (opcional, ainda NÃO mandado pelo servidor em 26/10): se o
 * modelo é de captação com ou sem exclusividade. Lido para o aviso de
 * conflito com o que a pessoa disse nas condições.
 */
export interface ModeloDeCaptacao { id: string; nome: string; resumo?: string; padrao?: boolean; exclusiva?: boolean }
const exclusivaDoModelo = (m?: ModeloDeCaptacao): Partial<FluxoCaptacao> =>
  typeof m?.exclusiva === "boolean" ? { modeloExclusiva: m.exclusiva } : {};
export interface OpcaoDeCampo { valor: string; label: string }
/**
 * v2/PR5 (`docs/max.md` §18.12, aditivo): cada faltante pode trazer `tipo` e
 * `nivel` (do catálogo da org), `lista:"proprietarios"` quando é por pessoa e
 * `opcoes` quando o tipo é `lista_opcoes`. Tudo opcional: resposta antiga (sem
 * estes campos) continua lida igual.
 */
export interface FaltanteDeCaptacao {
  path: string; rotulo: string; etapa?: string; proprietarioId?: string;
  tipo?: string; nivel?: string; lista?: string; opcoes?: OpcaoDeCampo[];
}
export interface DadosDeCaptacao {
  imovel?: Record<string, unknown>;
  condicoes?: Record<string, unknown>;
  locacao?: Record<string, unknown>;
  proprietarios?: Record<string, unknown>[];
  assinantes?: Record<string, unknown>;
}

export type CanalDeEnvio = "email" | "whatsapp" | "aceite";

export interface FluxoCaptacao {
  kind: "captacao";
  etapa:
    | "natureza" | "nome" | "modelo" | "imovel" | "condicoes" | "exclusividade" | "proprietarios" | "estado_civil"
    | "extras" | "verificar" | "faltantes" | "selecao" | "revisao" | "enviando"
    // Confirmação única (26/10): estas etapas não são mais escritas. Só existem
    // para ler um checkpoint antigo (de antes da troca) — `conduzirEtapaLegada`
    // as converte na etapa nova no primeiro turno.
    | EtapaLegada
    // v2/PR7 (autorização pelo Max, par do contractmaker#1863): oferta ao corretor (pedir) e
    // fila do gerente (listar/aprovar/negar).
    | "autorizacao_oferta" | "autorizacao_fila" | "autorizacao_motivo" | "autorizacao_confirmar";
  tipo?: TipoDeCaptacao;
  /** O que a pessoa disse, verbatim (regra #80): nunca sintético. */
  nome?: string;
  /**
   * O 1º pedido ("cria uma captação... Rua X, 88... sem exclusividade, aceite
   * por WhatsApp"), pra aproveitar endereço/condições/canal dali antes de
   * perguntar de novo (achados 22/23/28). NUNCA verbatim (achado 1 da revisão
   * opus): CPF/CNPJ/e-mail/telefone já vêm REDIGIDOS antes de entrar aqui —
   * nenhum deles é usado nesta etapa (endereço, condições e canal não
   * dependem de documento/contato), e redigir ANTES de guardar é o que evita
   * tanto o checkpoint em claro quanto o envio cru ao extrator (LLM) em
   * `aproveitarPedidoOriginal`. Limpo (achado 1) assim que consumido, pra não
   * sobreviver no checkpoint depois de ter servido. */
  pedidoOriginal?: string;
  /** Canal já dito pela pessoa (ou escolhido na pergunta de canal). Aplicado aos proprietários ao gravar. */
  canalDito?: CanalDeEnvio;
  modelos?: ModeloDeCaptacao[];
  modeloId?: string;
  /** Imóvel e condições já colhidos, aguardando a criação (ou o replay dela). */
  criacao?: { chave: string; dados: DadosDeCaptacao };
  /**
   * O que já foi GRAVADO de imóvel/condições/locação, só para o resumo final
   * (o servidor não devolve valores). Nenhum dado de pessoa: endereço e
   * valores do imóvel, nunca CPF/e-mail/telefone.
   */
  dadosDoResumo?: Pick<DadosDeCaptacao, "imovel" | "condicoes" | "locacao">;
  /** Exclusividade do modelo, quando o servidor diz (`modelo.exclusiva`); hoje ele não diz. */
  modeloExclusiva?: boolean;
  /** O conflito de exclusividade (modelo × o que a pessoa disse) já foi avisado: nunca de novo. */
  exclusividadeAvisada?: boolean;
  /** O proprietário (id) cujo estado civil está sendo perguntado agora. */
  estadoCivilDe?: string;
  /** Proprietários (id) para os quais a pessoa disse PULAR no estado civil: não pergunta de novo. */
  estadoCivilPulado?: string[];
  /** Versão que o PRÓPRIO Max deixou no último create/complemento (para saber se a tela mexeu depois). */
  versaoGravada?: number;
  /** A tela mudou a captação durante a conversa (409 versao_desatualizada ou versão do preflight ≠ `versaoGravada`):
   *  o `dadosDoResumo` local pode estar velho, e o resumo não o mostra como se fosse o rascunho. */
  telaMudou?: boolean;
  /** O canal que já foi gravado em TODOS os proprietários (com a pessoa); outro canal exige gravar de novo no envio. */
  canalAplicado?: CanalDeEnvio;
  /** Marca (paths e códigos, sem valor) das pendências só-da-tela já ditas: dita uma vez, nunca reimpressa. */
  pendenciasDitas?: string;
  captacaoId?: string;
  codigo?: string;
  version?: number;
  /** Só id e nome (e PJ): os documentos e contatos vão direto ao ImobPro. */
  proprietarios?: { id: string; nome: string; pj?: boolean }[];
  /** Testemunhas/avulsos já GRAVADOS nesta conversa — só id e nome (sem contato). */
  extras?: { id: string; nome: string; testemunha: boolean }[];
  /** Legado (checkpoint de antes da confirmação única): extras que ficaram no `cofre`. */
  extrasPendentes?: { id: string; nome: string; testemunha: boolean }[];
  /**
   * Legado (checkpoint de antes da confirmação única): CPF, e-mail e telefone
   * lidos e ainda não gravados, CIFRADOS. O fluxo novo grava cada dado no
   * turno em que chega e nunca mais escreve aqui; `conduzirEtapaLegada` só
   * esvazia (grava) o que um checkpoint antigo deixou. Ver `cifrarCofreCaptacao`.
   */
  cofre?: string;
  faltantes?: FaltanteDeCaptacao[];
  /** Rascunhos candidatos ao envio pedido por nome ("envia a captação da Maria"). */
  candidatos?: { ref: number; id: string; codigo: string; nome: string }[];
  /** O envio em curso: `valor` é a `messageId` do "enviar" (`x-idempotency-key`). */
  chave?: { verbo: string; valor: string; em?: number; version: number; confirmarBrancos?: boolean };
  /** Quantos campos vão em branco, dito no resumo final (o "sim" dele já manda `confirmarBrancos`). */
  emBranco?: number;
  /**
   * v2/PR7: a oferta de pedir autorização em curso (corretor). `ref`/`tipo` são
   * exatamente o `ref`/`tipo` do bloqueio do preflight — nenhum dado da pessoa.
   */
  autorizacaoPedido?: { tipo: "proprietario" | "imovel"; ref: string; justificativa?: string };
  /**
   * v2/PR7: os `ref` de bloqueio para os quais o corretor já recebeu 201/200 de
   * `captacao.autorizacao.pedir` nesta conversa — para oferecer o PRÓXIMO
   * bloqueio ainda não pedido (achado de review 19/10; sem isto, com 2
   * proprietários bloqueados o segundo nunca era oferecido).
   */
  autorizacaoPedidosFeitos?: string[];
  /**
   * v2/PR7 (achado de review 19/10, item 3): os `ref` para os quais a pessoa
   * respondeu "não" à oferta NESTA conversa — nunca mais reoferecidos (nem
   * `*_aguarda_autorizacao` nem `*_autorizacao_negada`); a fala cai no
   * bloqueio genérico. Sem isto, o próximo "sim" refaz o preflight e reoferece
   * o MESMO ref que a pessoa já recusou, em loop.
   */
  autorizacaoPedidosRecusados?: string[];
  /**
   * v2/PR7 (achado de review 19/10, item 2): a chave de idempotência e os args
   * da ÚLTIMA tentativa de `captacao.autorizacao.pedir`/`.decidir` SEM
   * resposta do servidor — como `chave` faz para `captacao.send`: a MESMA
   * confirmação ("sim") repete a MESMA chave e os MESMOS args, nunca uma chave
   * nova (o servidor devolve o resultado gravado, não cria um segundo pedido).
   */
  autorizacaoChave?: { valor: string; args: Record<string, unknown> };
  /**
   * v2/PR7: a fila de autorização do gerente. `codigo`/`solicitante` e
   * `documento` ou `imovel` identificam o pedido na confirmação (achado de
   * review 19/10: "Autorizar o pedido 1?" não dizia quem nem o quê).
   */
  autorizacaoFila?: {
    itens: { ref: number; id: string; tipo: string; codigo: string; solicitante: string; documento?: string; imovel?: string }[];
  };
  /** v2/PR7: a decisão em curso do gerente (depois de "aprovar N"/"negar N"). */
  autorizacaoDecisao?: {
    autorizacaoId: string; tipo: string; decisao: "aprovar" | "negar"; motivo?: string;
    codigo: string; solicitante: string; documento?: string; imovel?: string;
  };
  tentativas: number;
  pausado?: boolean;
  atualizadoEm: number;
}

/** Etapas do fluxo de antes da confirmação única (só lidas de checkpoint antigo). */
export type EtapaLegada = "confirmar_criacao" | "confirmar_pessoas" | "confirmar_faltantes" | "canal" | "brancos";

type Resposta = Extract<PassoDoFluxo, { reply: string }>;
const resposta = (fluxo: FluxoCaptacao | null, reply: string, evento: string): Resposta => ({ fluxo, reply, evento });

// ─── Textos fixos ────────────────────────────────────────────────────────

export const textoCaptacaoSemPolitica = (): string => `Captação pelo ${nomeDoAgente()} não está liberada para você nesta imobiliária.`;
const TEXTO_POLITICA_INDISPONIVEL = "Não consegui validar sua permissão agora. Nada foi feito; tente de novo em instantes.";
const TEXTO_SEM_RESPOSTA = "Não consegui falar com o sistema agora. Tente de novo em instantes.";
const TEXTO_DESLIGADA = "A captação não está ligada para a sua imobiliária. Fale com o administrador.";
const TEXTO_TENTATIVAS = "Não estou conseguindo entender. Deixei o rascunho salvo; complete pela tela:";

const link = (caminho: string) => new URL(caminho, imobproBase()).toString();
const linkDe = (id?: string) => link(id ? `/imoveis/captacoes/${id}` : "/imoveis/captacoes");

export const NOME_DA_ESTEIRA: Record<TipoDeCaptacao, string> = { venda: "venda", locacao: "locação" };

// ─── Texto por código do envio (mapa FECHADO — paridade com o ImobPro) ───

/** A lista literal de `CODIGOS_DE_ERRO_DO_ENVIO` do ImobPro (`captacao-vectors.ts`), na mesma ordem. */
export const CODIGOS_DO_ENVIO = [
  "pendencias", "confirmar_brancos", "clicksign_nao_conectada", "aceite_desabilitado", "contato_invalido",
  "ninguem_assina", "arquivada", "ja_enviando", "ja_cancelando", "versao_desatualizada", "limite_do_plano",
  "google_reconectar", "previa", "bloco_repetivel", "whatsapp_indisponivel", "falha_envio", "cota_diaria",
  "muitas_tentativas",
] as const;
export type CodigoDoEnvio = (typeof CODIGOS_DO_ENVIO)[number];

interface ParamsDoTexto { link: string; emBranco?: number; limite?: number }

/**
 * Um texto por código — nenhum `message` humano do servidor atravessa (pode
 * trazer nome de proprietário). `Record` exaustivo: código novo no tipo não
 * compila sem texto.
 */
export const TEXTO_POR_CODIGO: Record<CodigoDoEnvio, (p: ParamsDoTexto) => string> = {
  pendencias: (p) => `Ainda faltam dados obrigatórios para enviar. Complete pela tela: ${p.link}`,
  confirmar_brancos: (p) =>
    `${p.emBranco ?? 0} campo(s) vão em branco no contrato. Envio assim mesmo? Responda *enviar assim mesmo* (ou CANCELAR).`,
  clicksign_nao_conectada: () =>
    "A assinatura digital (ClickSign) não está conectada nesta imobiliária. Um administrador conecta em Configurações › Integrações.",
  aceite_desabilitado: (p) => `O aceite por WhatsApp não está habilitado para esta captação. Troque o canal na tela: ${p.link}`,
  contato_invalido: (p) => `Um dos contatos de assinatura não é válido (e-mail ou celular). Corrija na tela: ${p.link}`,
  ninguem_assina: (p) => `Nenhuma pessoa está marcada para assinar. Escolha quem assina na tela: ${p.link}`,
  arquivada: (p) => `Esta captação está arquivada. Resgate na tela antes de enviar: ${p.link}`,
  ja_enviando: (p) => `Esta captação já está sendo enviada. Confira em instantes: ${p.link}`,
  ja_cancelando: (p) => `Esta captação está sendo cancelada. Aguarde e confira na tela: ${p.link}`,
  versao_desatualizada: () => "Alguém mudou a captação na tela; vou conferir de novo.",
  limite_do_plano: () => "A conta de assinatura (ClickSign) atingiu o limite do plano. Fale com o administrador.",
  google_reconectar: () =>
    "O Google da imobiliária precisa ser reconectado em Configurações › Integrações. Depois é só pedir o envio de novo.",
  previa: (p) => `Não consegui preparar o documento para envio. Veja na tela: ${p.link}`,
  bloco_repetivel: () => "Há um bloco repetível com problema no modelo. Peça a um administrador para revisar o modelo.",
  whatsapp_indisponivel: (p) => `O canal de WhatsApp não está disponível para esta assinatura. Troque o canal na tela: ${p.link}`,
  falha_envio: (p) =>
    `O envio não foi concluído. A captação ficou como "Falha no envio" e pode ser reenviada pela tela: ${p.link}`,
  cota_diaria: (p) =>
    `Você atingiu o limite de envios de captação pelo ${nomeDoAgente()} por hoje${p.limite ? ` (${p.limite})` : ""}. O resto é pela tela: ${p.link}`,
  muitas_tentativas: () => "Muitos envios em pouco tempo. Espere um minuto e tente de novo.",
};

/** Código desconhecido (servidor mais novo que este lado) vira texto neutro mais o link — nunca o `message` cru. */
export function textoDoCodigoDeEnvio(codigo: string, p: ParamsDoTexto): string {
  const f = (TEXTO_POR_CODIGO as Record<string, ((x: ParamsDoTexto) => string) | undefined>)[codigo];
  return f ? f(p) : `O sistema não aceitou o envio. Veja a captação na tela: ${p.link}`;
}

// ─── Leitura da resposta do servidor (só o que o Max usa) ────────────────

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface ItemDaCaptacao {
  ref: number | null;
  id: string;
  codigo: string;
  nome: string;
  esteira: string | null;
  estado: string | null;
  tom: string | null;
  endereco: string | null;
  atualizadoEm: string | null;
  link: string | null;
  proprietarios: string[] | null;
}

/**
 * Um item de `captacao.list`. Só as chaves conhecidas entram: o que o servidor
 * acrescentar (ou vazar) não chega ao texto. Sem `id`/`codigo`/`nome` o item
 * não é utilizável e cai.
 */
export function lerItemDaCaptacao(raw: unknown): ItemDaCaptacao | null {
  const o = obj(raw);
  const id = str(o.id);
  const codigo = str(o.codigo);
  const nome = str(o.nome);
  if (!id || !codigo || !nome) return null;
  const donos = Array.isArray(o.proprietarios) ? o.proprietarios.filter((x): x is string => typeof x === "string" && !!x.trim()) : null;
  return {
    ref: typeof o.ref === "number" && Number.isInteger(o.ref) ? o.ref : null,
    id, codigo, nome,
    esteira: str(o.esteira), estado: str(o.estado), tom: str(o.tom), endereco: str(o.endereco),
    atualizadoEm: str(o.atualizadoEm), link: str(o.link),
    proprietarios: donos && donos.length ? donos : null,
  };
}

const dataBr = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
};
const MARCA_DO_TOM: Record<string, string> = { warning: " ⚠️", danger: " ⛔" };

/** Uma linha por captação, com o número (`ref`) que a pessoa pode citar. */
export function textoDoItemDaCaptacao(i: ItemDaCaptacao): string {
  const esteira = i.esteira === "venda" || i.esteira === "locacao" ? ` (${NOME_DA_ESTEIRA[i.esteira]})` : "";
  const estado = i.estado ? ` · ${i.estado}${i.tom ? (MARCA_DO_TOM[i.tom] ?? "") : ""}` : "";
  const quando = dataBr(i.atualizadoEm);
  const partes = [
    `${i.ref ?? "•"}. ${i.codigo} — ${i.nome}${esteira}${estado}`,
    i.endereco ? `   ${i.endereco}` : "",
    i.proprietarios ? `   Proprietários: ${i.proprietarios.join(", ")}` : "",
    quando ? `   Atualizada em ${quando}` : "",
    i.link ? `   ${link(i.link)}` : "",
  ];
  return partes.filter(Boolean).join("\n");
}

export function textoDaLista(raw: unknown, total: number | null, busca?: string): string {
  const itens = lista(raw).map(lerItemDaCaptacao).filter((x): x is ItemDaCaptacao => !!x);
  if (!itens.length) return busca ? `Não achei captação para "${busca}".` : "Você não tem captações por aqui.";
  const cab = `${total && total > itens.length ? `Mostrando ${itens.length} de ${total}` : `${itens.length} captação(ões)`}${busca ? ` para "${busca}"` : ""}:`;
  return `${cab}\n\n${itens.map(textoDoItemDaCaptacao).join("\n\n")}`;
}

export interface PreflightLido {
  pronto: boolean;
  faltantes: FaltanteDeCaptacao[];
  /**
   * v2/PR5 (aditivo): mesmo formato de `faltantes`, `nivel:"ficha"`. Só
   * informativo — nunca bloqueia o envio nem muda `pronto` (o `pronto` vem
   * direto do servidor). Ainda não roteado para texto nesta preparação.
   */
  pendentesFicha: FaltanteDeCaptacao[];
  bloqueios: { codigo: string; ref?: string }[];
  emBranco: number;
  version: number | null;
}

function lerOpcoesDoCampo(v: unknown): OpcaoDeCampo[] | undefined {
  const opcoes = lista(v).flatMap((x): OpcaoDeCampo[] => {
    const o = obj(x);
    const valor = str(o.valor);
    const label = str(o.label);
    return valor && label ? [{ valor, label }] : [];
  });
  return opcoes.length ? opcoes : undefined;
}

/** Um item de `faltantes[]`/`pendentesFicha[]`. `tipo`/`nivel`/`lista`/`opcoes` são opcionais (v2/PR5). */
function lerFaltanteBruto(x: unknown): FaltanteDeCaptacao[] {
  const f = obj(x);
  const path = str(f.path);
  const rotulo = str(f.rotulo);
  if (!path || !rotulo) return [];
  const etapa = str(f.etapa);
  const dono = str(f.proprietarioId);
  const tipo = str(f.tipo);
  const nivel = str(f.nivel);
  const listaCampo = str(f.lista);
  const opcoes = lerOpcoesDoCampo(f.opcoes);
  return [{
    path, rotulo,
    ...(etapa ? { etapa } : {}), ...(dono ? { proprietarioId: dono } : {}),
    ...(tipo ? { tipo } : {}), ...(nivel ? { nivel } : {}),
    ...(listaCampo ? { lista: listaCampo } : {}), ...(opcoes ? { opcoes } : {}),
  }];
}

/** `captacao.preflight`: boolean `pronto` obrigatório; o resto tem padrão vazio. */
export function lerPreflight(raw: unknown): PreflightLido | null {
  const o = obj(raw);
  if (typeof o.pronto !== "boolean") return null;
  const faltantes = lista(o.faltantes).flatMap(lerFaltanteBruto);
  const pendentesFicha = lista(o.pendentesFicha).flatMap(lerFaltanteBruto);
  const bloqueios = lista(o.bloqueios).flatMap((x) => {
    const b = obj(x);
    const codigo = str(b.codigo);
    const ref = str(b.ref);
    return codigo ? [{ codigo, ...(ref ? { ref } : {}) }] : [];
  });
  return {
    pronto: o.pronto, faltantes, pendentesFicha, bloqueios,
    emBranco: typeof o.emBranco === "number" && o.emBranco > 0 ? Math.floor(o.emBranco) : 0,
    version: typeof o.version === "number" ? o.version : null,
  };
}

export interface CampoDeOpcoes {
  path: string; rotulo: string; tipo: string; nivel: string; lista?: string; opcoes?: OpcaoDeCampo[];
}

/**
 * Um item de `campos[]` de `captacao.options` (v2/PR5, preparação: ainda não
 * lido em nenhum fluxo — só descrição do campo, nunca valor).
 */
export function lerCampoDeOpcoes(raw: unknown): CampoDeOpcoes | null {
  const o = obj(raw);
  const path = str(o.path);
  const rotulo = str(o.rotulo);
  const tipo = str(o.tipo);
  const nivel = str(o.nivel);
  if (!path || !rotulo || !tipo || !nivel) return null;
  const listaCampo = str(o.lista);
  const opcoes = lerOpcoesDoCampo(o.opcoes);
  return { path, rotulo, tipo, nivel, ...(listaCampo ? { lista: listaCampo } : {}), ...(opcoes ? { opcoes } : {}) };
}

const CANAIS_VALIDOS = new Set(["email", "whatsapp", "aceite"]);

/**
 * `canalPadrao` de `captacao.options` (v2/PR5, preparação: ainda não lido em
 * nenhum fluxo — não muda qual canal o Max usa nem pergunta mais cedo).
 */
export function lerCanalPadrao(raw: unknown): "email" | "whatsapp" | "aceite" | null {
  const c = str(obj(raw).canalPadrao);
  return c && CANAIS_VALIDOS.has(c) ? (c as "email" | "whatsapp" | "aceite") : null;
}

const ETAPA_DA_TELA: Record<string, string> = {
  imovel: "imóvel", proprietarios: "proprietários", condicoes: "condições", locacao: "locação", assinantes: "assinantes",
};
/** Bloqueios do preflight (código do checklist, não do envio) que o Max sabe dizer em português. */
const TEXTO_DO_BLOQUEIO: Record<string, string> = {
  soma_percentuais: "a soma dos percentuais dos proprietários não fecha 100%",
  // v2/PR4/PR7: sem nome nem CPF — o `ref` do bloqueio é id, nunca dado da pessoa.
  proprietario_aguarda_autorizacao: "este proprietário aguarda autorização do gerente para ser reaproveitado",
  imovel_aguarda_autorizacao: "este imóvel aguarda autorização do gerente para ser reaproveitado",
  proprietario_autorizacao_negada: "a autorização para reaproveitar este proprietário foi negada pelo gerente",
  imovel_autorizacao_negada: "a autorização para reaproveitar este imóvel foi negada pelo gerente",
};
/**
 * Os 4 códigos novos (v2/PR7) só têm texto amigável quando a org tem a
 * capability `captacao.autorizacao.pedir` — sem ela o Max nunca oferece o
 * pedido (achado de review 19/10, item 7), e o texto PRECISA continuar
 * EXATAMENTE o de antes desta mudança: o fallback genérico por código,
 * byte a byte. `soma_percentuais` (pré-existente) nunca passa por este gate.
 */
const CODIGOS_BLOQUEIO_SO_COM_CAPACIDADE = new Set([
  "proprietario_aguarda_autorizacao", "imovel_aguarda_autorizacao",
  "proprietario_autorizacao_negada", "imovel_autorizacao_negada",
]);
const bloqueioEmTexto = (codigo: string, podeAutorizar: boolean) => {
  if (CODIGOS_BLOQUEIO_SO_COM_CAPACIDADE.has(codigo) && !podeAutorizar) return `pendência "${codigo.replace(/_/g, " ")}"`;
  return TEXTO_DO_BLOQUEIO[codigo] ?? `pendência "${codigo.replace(/_/g, " ")}"`;
};

// ─── v2/PR7: autorização de reaproveitamento pelo Max ────────────────────

/** Tipo do bloqueio pelo prefixo do código — nunca pelo `ref` (que é id, sem dado). */
function tipoDoBloqueioDeAutorizacao(codigo: string): "proprietario" | "imovel" | null {
  if (codigo.startsWith("proprietario_")) return "proprietario";
  if (codigo.startsWith("imovel_")) return "imovel";
  return null;
}
const CODIGOS_BLOQUEIO_AGUARDA = new Set(["proprietario_aguarda_autorizacao", "imovel_aguarda_autorizacao"]);
const CODIGOS_BLOQUEIO_NEGADA = new Set(["proprietario_autorizacao_negada", "imovel_autorizacao_negada"]);

interface BloqueioDeAutorizacao { codigo: string; ref: string; tipo: "proprietario" | "imovel"; negada: boolean }

/**
 * O próximo bloqueio de autorização do preflight AINDA NÃO pedido, se houver —
 * para oferecer o pedido. `jaPedidos` são os `ref` para os quais o corretor já
 * recebeu 201/200 de `captacao.autorizacao.pedir` nesta conversa: como
 * `*_aguarda_autorizacao` vale tanto para "nunca pedido" quanto para "pedido
 * pendente", sem este filtro o preflight sempre devolve o MESMO primeiro
 * bloqueio e um segundo proprietário bloqueado nunca chega a ser oferecido
 * (achado de review 19/10). `*_autorizacao_negada` nunca é pulado: é sempre
 * uma nova decisão a oferecer, mesmo que o `ref` já tenha sido pedido antes.
 */
function bloqueioDeAutorizacao(
  bloqueios: { codigo: string; ref?: string }[],
  jaPedidos: ReadonlySet<string> = new Set(),
  recusados: ReadonlySet<string> = new Set(),
): BloqueioDeAutorizacao | null {
  for (const b of bloqueios) {
    if (!b.ref) continue;
    // Achado de review 19/10 (item 3): "não" na oferta NESTA conversa — nunca reoferece o
    // MESMO ref (nem `aguarda`, nem `negada`); sem isto, o próximo "sim" refaz o preflight e
    // reoferece o que a pessoa já recusou, em loop. A fala cai no bloqueio genérico.
    if (recusados.has(b.ref)) continue;
    const aguarda = CODIGOS_BLOQUEIO_AGUARDA.has(b.codigo);
    const negada = CODIGOS_BLOQUEIO_NEGADA.has(b.codigo);
    if (!aguarda && !negada) continue;
    if (aguarda && jaPedidos.has(b.ref)) continue;
    const tipo = tipoDoBloqueioDeAutorizacao(b.codigo);
    if (tipo) return { codigo: b.codigo, ref: b.ref, tipo, negada };
  }
  return null;
}

/**
 * A lista literal de `CODIGOS_DE_ERRO_DA_AUTORIZACAO` do ImobPro
 * (`captacao-vectors.ts`, `CODIGOS_DA_AUTORIZACAO_LITERAL`), na mesma ordem.
 * Cobre os erros de `captacao.autorizacao.pedir` e `.decidir` juntos.
 */
export const CODIGOS_DA_AUTORIZACAO = [
  "tipo_invalido", "ref_obrigatorio", "captacao_id_obrigatorio", "justificativa_grande", "nao_e_rascunho",
  "nao_precisa_autorizacao", "documento_invalido", "pedido_invalido", "autorizacao_id_obrigatorio",
  "decisao_invalida", "motivo_obrigatorio", "nao_pendente", "solicitante_nao_decide",
  "motivo_grande",
] as const;
export type CodigoDeAutorizacao = (typeof CODIGOS_DA_AUTORIZACAO)[number];

interface ParamsTextoAutorizacao { link: string }

/** Um texto por código — `Record` exaustivo: código novo no tipo não compila sem texto. */
export const TEXTO_POR_CODIGO_AUTORIZACAO: Record<CodigoDeAutorizacao, (p: ParamsTextoAutorizacao) => string> = {
  tipo_invalido: (p) => `Não consegui identificar o que pedir. Ajuste pela tela: ${p.link}`,
  ref_obrigatorio: (p) => `Não consegui identificar o alvo do pedido. Ajuste pela tela: ${p.link}`,
  captacao_id_obrigatorio: (p) => `Não consegui registrar o pedido agora. Tente pela tela: ${p.link}`,
  justificativa_grande: () => "Essa justificativa ficou grande demais (até 300 caracteres). Pode resumir?",
  nao_e_rascunho: (p) => `Esta captação não está mais em rascunho. Veja na tela: ${p.link}`,
  nao_precisa_autorizacao: () => "Não é mais necessário pedir: já foi liberado ou o bloqueio sumiu. Vou conferir de novo.",
  documento_invalido: (p) => `O cadastro dessa pessoa não tem um documento válido para autorizar. Ajuste pela tela: ${p.link}`,
  pedido_invalido: (p) => `Não consegui registrar o pedido. Tente pela tela: ${p.link}`,
  autorizacao_id_obrigatorio: () => "Não consegui identificar o pedido. Tente de novo.",
  decisao_invalida: () => "Não entendi a decisão. Responda *aprovar* ou *negar*.",
  motivo_obrigatorio: () => "Para negar, preciso de um motivo (até 500 caracteres).",
  nao_pendente: () => "Esse pedido já foi decidido.",
  solicitante_nao_decide: () => "Quem pediu não pode decidir o próprio pedido.",
  motivo_grande: () => "Esse motivo ficou grande demais (até 500 caracteres). Pode resumir?",
};

/** Código desconhecido (servidor mais novo que este lado) vira texto neutro mais o link. */
export function textoDoCodigoDeAutorizacao(codigo: string, p: ParamsTextoAutorizacao): string {
  const f = (TEXTO_POR_CODIGO_AUTORIZACAO as Record<string, ((x: ParamsTextoAutorizacao) => string) | undefined>)[codigo];
  return f ? f(p) : `Não consegui processar o pedido. Veja na tela: ${p.link}`;
}

export interface AutorizacaoPedidoLida { id: string; status: string; tipo: string; ref: string }

/** `captacao.autorizacao.pedir`: `{autorizacao:{id,status},tipo,ref}` — sem nome, sem CPF, sem motivo. */
export function lerAutorizacaoPedido(raw: unknown): AutorizacaoPedidoLida | null {
  const o = obj(raw);
  const aut = obj(o.autorizacao);
  const id = str(aut.id);
  const status = str(aut.status);
  const tipo = str(o.tipo);
  const ref = str(o.ref);
  return id && status && tipo && ref ? { id, status, tipo, ref } : null;
}

export interface ItemDaFilaDeAutorizacao {
  ref: number; id: string; tipo: string; codigo: string; solicitante: string;
  documento?: string; imovel?: string; criadoEm: string; justificativa?: string;
}

/**
 * Segunda camada de máscara (achado defensivo): o servidor já manda
 * `documento` mascarado (`***.456.789-**`), mas se algum dia vier em claro
 * (11 ou 14 dígitos — CPF/CNPJ sem máscara), este lado mascara ANTES de
 * guardar/exibir ao gerente — nunca confia só no servidor para um dado que
 * vai para a tela de outra pessoa. Já mascarado (poucos dígitos, o resto é
 * `*`/pontuação) não bate 11 nem 14 dígitos e passa intacto, byte a byte.
 */
function mascararDocumentoLocal(doc: string): string {
  const digitos = doc.replace(/\D/g, "");
  if (digitos.length === 11) return `***.${digitos.slice(3, 6)}.${digitos.slice(6, 9)}-**`;
  if (digitos.length === 14) return `**.${digitos.slice(2, 5)}.${digitos.slice(5, 8)}/${digitos.slice(8, 12)}-**`;
  return doc;
}

/** Um item de `captacao.autorizacao.listar`: documento mascarado pelo servidor; `mascararDocumentoLocal` é a segunda camada. */
export function lerItemDaFilaDeAutorizacao(raw: unknown): ItemDaFilaDeAutorizacao | null {
  const o = obj(raw);
  const id = str(o.id);
  const tipo = str(o.tipo);
  const codigo = str(o.codigo);
  const solicitante = str(o.solicitante);
  const criadoEm = str(o.criadoEm);
  // `ref` é o número que a pessoa digita ("aprovar N"): sem um inteiro ≥ 1 válido, o item é
  // DESCARTADO (fail-closed), nunca numerado como 0 — "aprovar 0" nunca bateria em nada, mas
  // um 0 fabricado colidiria silenciosamente com qualquer filtro que teste `!ref` (achado de
  // review 19/10).
  const ref = typeof o.ref === "number" && Number.isInteger(o.ref) && o.ref >= 1 ? o.ref : null;
  if (!id || !tipo || !codigo || !solicitante || !criadoEm || ref === null) return null;
  const documento = str(o.documento);
  const imovel = str(o.imovel);
  const justificativa = str(o.justificativa);
  return {
    ref,
    id, tipo, codigo, solicitante, criadoEm,
    ...(documento ? { documento: mascararDocumentoLocal(documento) } : {}), ...(imovel ? { imovel } : {}), ...(justificativa ? { justificativa } : {}),
  };
}

export function lerFilaDeAutorizacoes(raw: unknown): { items: ItemDaFilaDeAutorizacao[]; total: number } {
  const o = obj(raw);
  const items = lista(o.items).map(lerItemDaFilaDeAutorizacao).filter((x): x is ItemDaFilaDeAutorizacao => !!x);
  return { items, total: typeof o.total === "number" ? o.total : items.length };
}

/** "o proprietário ***.456.789-**" / "o imóvel Rua Augusta, 1250" — nunca CPF/CNPJ inteiro nem nome do dono. */
function alvoDaAutorizacao(i: { tipo: string; documento?: string; imovel?: string }): string {
  return i.tipo === "proprietario"
    ? `o proprietário${i.documento ? ` ${i.documento}` : ""}`
    : `o imóvel${i.imovel ? ` ${i.imovel}` : ""}`;
}

/**
 * A justificativa é texto livre de OUTRA pessoa (o corretor que pediu),
 * exibida ao gerente (ou ecoada de volta ao próprio corretor) — nunca passa
 * sem redação. `redigir()` devolve o token fixo `⟨CPF⟩` (bom para log, mas
 * ilegível numa fala de WhatsApp); troca pelo `[dado]` que `destokenizarResposta`
 * já usa como convenção de exibição — nunca o token cru, nunca o valor.
 */
function justificativaSegura(justificativa: string): string {
  // Só documento e e-mail (review 19/10): valor/telefone/CEP fazem parte do argumento
  // ("fechou por R$ 500 mil") e o código CAP precisa sobreviver. Depois, rede local sem
  // checar DV: um CPF pontuado com DV inválido ("123.456.789-00") passaria inteiro.
  return redigir(justificativa, ["CPF", "CNPJ", "EMAIL"])
    .replace(/⟨[A-Z]+⟩/g, "[dado]")
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "[dado]")
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{11}\b/g, "[dado]");
}

/** Uma linha por pedido pendente — nunca CPF/CNPJ inteiro (o `documento` já chega mascarado) nem nome do dono da carteira. */
export function textoDoItemDaFila(i: ItemDaFilaDeAutorizacao): string {
  const partes = [
    `${i.ref}. ${i.codigo} · ${i.solicitante} pede ${alvoDaAutorizacao(i)}`,
    i.justificativa ? `   "${justificativaSegura(i.justificativa)}"` : "",
  ];
  return partes.filter(Boolean).join("\n");
}

export function textoDaFilaDeAutorizacoes(raw: unknown): string {
  const { items } = lerFilaDeAutorizacoes(raw);
  if (!items.length) return "Nenhum pedido aguardando você.";
  return items.map(textoDoItemDaFila).join("\n\n");
}

export interface AutorizacaoDecisaoLida { id: string; status: string }

/** `captacao.autorizacao.decidir`: `{autorizacao:{id,status}}`. */
export function lerAutorizacaoDecisao(raw: unknown): AutorizacaoDecisaoLida | null {
  const aut = obj(obj(raw).autorizacao);
  const id = str(aut.id);
  const status = str(aut.status);
  return id && status ? { id, status } : null;
}

/** "Tem pedido de autorização?", "pedidos pendentes" — gatilho determinístico da fila do gerente. */
const PEDE_FILA_DE_AUTORIZACAO =
  /\b(tem\s+pedidos?\s+(?:de\s+)?autorizac\w*|pedidos?\s+(?:de\s+autorizac\w*\s+)?pendentes?|autorizac(?:oes|ao)?\s+pendentes?|fila\s+(?:de\s+)?autorizac\w*|pedidos?\s+(?:de\s+)?autorizac\w*\s+(?:aguardando|esperando))\b/;

export function pedeFilaDeAutorizacao(texto: string): boolean {
  const t = normalizar(texto).replace(/^max\b[\s,:-]*/, "").trim();
  return PEDE_FILA_DE_AUTORIZACAO.test(t);
}

/**
 * O que a conferência diz, em frase. `nomes` liga `proprietarioId` ao nome que
 * o fluxo guardou — o preflight não traz nome (nem valor) de propósito.
 */
export function textoDoPreflight(raw: unknown, nomes: Record<string, string> = {}, podeAutorizar = false): string {
  const pf = lerPreflight(raw);
  if (!pf) return "Não consegui ler a conferência da captação.";
  const linhas: string[] = [];
  if (pf.faltantes.length) {
    const itens = pf.faltantes.map((f) => {
      const dono = f.proprietarioId ? nomes[f.proprietarioId] : undefined;
      const onde = f.etapa ? ` (${ETAPA_DA_TELA[f.etapa] ?? f.etapa})` : "";
      return `${f.rotulo}${dono ? ` de ${dono}` : ""}${onde}`;
    });
    linhas.push(`Para enviar ainda falta: ${itens.join("; ")}.`);
  }
  if (pf.bloqueios.length) linhas.push(`Antes de enviar: ${pf.bloqueios.map((b) => bloqueioEmTexto(b.codigo, podeAutorizar)).join("; ")}.`);
  if (pf.emBranco > 0) linhas.push(`${pf.emBranco} campo(s) vão em branco no contrato.`);
  if (pf.pronto && !pf.emBranco) linhas.push("Tudo preenchido para o envio.");
  return linhas.join("\n") || "Conferência sem pendências.";
}

// ─── Intercepto ──────────────────────────────────────────────────────────

const CAPTACAO = /\bcaptac(?:ao|oes)\b/;
/** "Captação de clientes/leads/recursos": outro sentido da palavra. */
const OUTRO_SENTIDO = /\bcaptac\w+\s+(?:de\s+|dos\s+|das\s+)?(?:clientes?|leads?|recursos?|agua|dados|compradores?|inquilinos?|investidores?)\b/;
const NEGACAO = /\b(nao|nunca|jamais)\b/;
const PROCESSO = /^(como (?:funciona|faz|e|fazer|criar|cria|se faz)|o que (?:e|significa)|qual (?:a )?diferenca|por que|porque|pra que|para que)\b/;
const ENVIA = /\b(envi\w*|mand\w*|dispar\w*)\b\s+(?:a\s+|o\s+|essa\s+|esta\s+|minha\s+|aquela\s+)?(?:captacao|contrato de captacao)\b|\b(captacao|contrato de captacao)\b[^?]*\b(?:para|pra)\s+(?:a\s+)?assinatura\b/;
const LISTA = /\b(list\w*|mostr\w*|quais|minhas|meus|ver|veja|procur\w*|busc\w*|achar|status|situacao|andamento|como (?:esta|estao|anda|ficou|ta|vai)|ja (?:foi|assinou|saiu|assinaram))\b/;
const CRIA = /\b(cri\w+|faz\w*|fa[cz]a\w*|abr\w+|inici\w+|comec\w+|ger[ae]\w*|nov[ao]|quero|preciso|mont\w+|prepar\w+|cadastr\w+|registr\w+|elabor\w+|redij\w+|redig\w+|vamos)\b/;

/**
 * O pedido é de captação? `abrir` (rascunho novo), `enviar` (rascunho existente
 * → assinatura), `listar` (consulta/status) ou `null` — negação, pergunta de
 * processo ("como funciona a captação?") e o outro sentido da palavra
 * ("captação de clientes") seguem para o atendimento normal.
 */
export function pedeCaptacao(texto: string): "abrir" | "enviar" | "listar" | null {
  const t = normalizar(texto).replace(/^max\b[\s,:-]*/, "").trim();
  if (!CAPTACAO.test(t) || OUTRO_SENTIDO.test(t)) return null;
  if (NEGACAO.test(t) || PROCESSO.test(t)) return null;
  if (ENVIA.test(t)) return "enviar";
  if (LISTA.test(t)) return "listar";
  if (CRIA.test(t)) return "abrir";
  return null;
}

const NAO_E_NOME = new Set(["venda", "locacao", "aluguel", "imovel", "apartamento", "apto", "casa", "contrato", "nova", "novo", "captacao"]);
const DETERMINANTES = new Set(["um", "uma", "o", "a", "os", "as", "meu", "minha", "nosso", "nossa", "esse", "essa", "este", "esta", "novo", "nova"]);

/** O nome dito no pedido ("captação do Apto da Dona Maria", "...da Rua Augusta 1250"), verbatim. */
export function nomeDaCaptacao(texto: string): string | null {
  const m = /capta[cç](?:ao|ão|oes|ões)\s+(?:de\s+(?:venda|loca[cç][aã]o)\s+)?(?:d[oa]s?|de|pra|para|pro)\s+([^\n,.;!?]+)/iu.exec(texto);
  if (!m) return null;
  const palavras = m[1]!.trim().split(/\s+/);
  while (palavras.length && DETERMINANTES.has(normalizar(palavras[0]!))) palavras.shift();
  const nome = palavras.join(" ").replace(/\s+(?:(?:que|com|e)\s+.*|(?:para|pra)\s+(?:a\s+)?(?:assinatura|assinar|enviar)\b.*|por favor.*)$/i, "").trim().slice(0, 120);
  const n = normalizar(nome);
  if (!nome || n.length < 3 || NAO_E_NOME.has(n)) return null;
  return nome;
}

export function tipoDito(texto: string): TipoDeCaptacao | null {
  const t = normalizar(texto);
  const locacao = /\b(locacao|aluguel|alugar|locar)\b/.test(t);
  const venda = /\b(venda|vender|vendo)\b/.test(t);
  if (locacao && !venda) return "locacao";
  if (venda && !locacao) return "venda";
  return null;
}

const RE_ACEITE_WHATSAPP = /\baceite\b[^.?!\n]{0,30}\bwhatsapp\b|\bwhatsapp\b[^.?!\n]{0,30}\baceite\b/;
const RE_WHATSAPP_CANAL = /\bwhatsapp\b|\bzap\b/;
const RE_EMAIL_CANAL = /\be-?mail\b/;

/** O canal que a pessoa já disse ("por e-mail", "aceite por WhatsApp"): achados 23/28. */
export function canalDoTexto(texto: string): CanalDeEnvio | null {
  const t = normalizar(texto);
  if (RE_ACEITE_WHATSAPP.test(t)) return "aceite";
  if (RE_WHATSAPP_CANAL.test(t)) return "whatsapp";
  if (RE_EMAIL_CANAL.test(t)) return "email";
  return null;
}

// ─── Leitura de dados (em CÓDIGO) ────────────────────────────────────────

const so = (x: string) => x.replace(/\D/g, "");

export function cnpjValido(raw: string): boolean {
  const c = so(raw);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const dv = (n: number) => {
    let soma = 0;
    let peso = n - 7;
    for (let i = 0; i < n; i++) {
      soma += Number(c[i]) * peso--;
      if (peso < 2) peso = 9;
    }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
}

const RE_EMAIL_LOCAL = /[^\s@:;,<>()]+@[^\s@:;,<>()]+\.[a-z]{2,}/gi;
const RE_TEL_LOCAL = /(?<!\d)(?:\+?55[\s.-]*)?\(?\d{2}\)?[\s.-]*9?\d{4}[\s.-]?\d{4}(?!\d)/g;
const ROTULO_TEL = /(tel|cel|whats|fone|zap|contato)\w*\W*$/;
const global = (re: RegExp) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);

export interface NumerosLidos { cpfs: string[]; cnpjs: string[]; telefones: string[]; invalido?: "cpf" | "cnpj"; restante: string }

/** CPF, CNPJ e telefone do texto. `restante` é o texto sem eles (para achar o nome). */
export function lerNumeros(texto: string): NumerosLidos {
  const cpfs: string[] = [];
  const cnpjs: string[] = [];
  const telefones: string[] = [];
  let invalido: "cpf" | "cnpj" | undefined;
  let restante = texto;
  for (const m of texto.matchAll(global(RE_CNPJ))) {
    const d = so(m[0]);
    if (cnpjValido(d)) cnpjs.push(d); else invalido = "cnpj";
    restante = restante.replace(m[0], " ".repeat(m[0].length));
  }
  for (const m of restante.matchAll(global(RE_CPF))) {
    const d = so(m[0]);
    const antes = normalizar(restante.slice(Math.max(0, (m.index ?? 0) - 14), m.index ?? 0));
    const rotuloTel = ROTULO_TEL.test(antes);
    if (!rotuloTel && cpfValido(d)) cpfs.push(d);
    else if (rotuloTel || d[2] === "9") telefones.push(d);
    else invalido = "cpf";
    restante = restante.replace(m[0], " ".repeat(m[0].length));
  }
  for (const m of restante.matchAll(global(RE_TEL_LOCAL))) {
    let d = so(m[0]);
    if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
    if ((d.length === 10 || d.length === 11) && !telefones.includes(d)) telefones.push(d);
    restante = restante.replace(m[0], " ".repeat(m[0].length));
  }
  return { cpfs, cnpjs, telefones, ...(invalido ? { invalido } : {}), restante };
}

export function lerEmails(texto: string): string[] {
  return [...new Set((texto.match(global(RE_EMAIL_LOCAL)) ?? []).map((e) => e.toLowerCase()))];
}

const ESTADO_CIVIL = /\b(solteir[oa]|casad[oa]|divorciad[oa]|viuv[oa]|separad[oa]|uniao estavel)\b/;
// Achado 18: "propriet[aá]ri[oa]s?"/"don[oa]s?" com acento (a pessoa escreve "proprietário:") também contam como rótulo.
const ROTULOS_SOLTOS = /\b(cpf|cnpj|rg|tel\w*|cel\w*|whats\w*|fone|zap|e-?mail|email|nome|propriet[aá]ri[oa]s?|don[oa]s?|pj|pessoa juridica|pessoa fisica|percentual|casad[oa]|solteir[oa]|divorciad[oa]|viuv[oa]|separad[oa]|uniao estavel|razao social|empresa)\b/gi;

/** O texto citado está de fato na mensagem? (mesmo teste do `credito`) */
function noTexto(trecho: string, texto: string): boolean {
  const a = normalizar(trecho).replace(/[^a-z0-9]+/g, " ").trim();
  const b = normalizar(texto).replace(/[^a-z0-9]+/g, " ");
  return !!a && ` ${b} `.includes(` ${a} `);
}

/** O extrator (LLM, tool forçada) de uma seção. `null` = falhou. */
export type SecaoDeExtracao = "imovel" | "endereco" | "pessoa";
export type ExtratorDeSecao = (texto: string, secao: SecaoDeExtracao) => Promise<Record<string, unknown> | null>;

export interface PessoaLida {
  nome?: string;
  pj?: boolean;
  cpf?: string;
  cnpj?: string;
  email?: string;
  telefone?: string;
  estadoCivil?: string;
  percentual?: number;
  erro?: string;
}

function percentualNoTexto(texto: string): number | undefined {
  const m = /(\d{1,3}(?:[.,]\d+)?)\s*(?:%|por cento)/i.exec(texto);
  if (!m) return undefined;
  const v = Number(m[1]!.replace(",", "."));
  return v >= 0 && v <= 100 ? v : undefined;
}

/**
 * Uma pessoa (proprietário, testemunha, assinante) numa mensagem: documentos,
 * contatos e estado civil em código; o nome em código quando é óbvio e pelo
 * extrator (conferido contra o texto) quando não é.
 */
export async function lerPessoa(texto: string, extrair: ExtratorDeSecao): Promise<PessoaLida> {
  const n = lerNumeros(texto);
  const out: PessoaLida = {};
  if (n.invalido === "cpf") return { erro: "Esse CPF não confere (dígito verificador)." };
  if (n.invalido === "cnpj") return { erro: "Esse CNPJ não confere (dígito verificador)." };
  if (n.cpfs.length > 1 || n.cnpjs.length > 1 || (n.cpfs.length && n.cnpjs.length)) {
    return { erro: "Vi mais de um documento aqui. Mande uma pessoa por vez." };
  }
  if (n.cpfs[0]) out.cpf = n.cpfs[0];
  if (n.cnpjs[0]) { out.cnpj = n.cnpjs[0]; out.pj = true; }
  if (n.telefones[0]) out.telefone = n.telefones[0];
  const email = lerEmails(texto)[0];
  if (email) out.email = email;
  const civil = ESTADO_CIVIL.exec(normalizar(texto))?.[1];
  if (civil) out.estadoCivil = civil;
  const pct = percentualNoTexto(texto);
  if (pct !== undefined) out.percentual = pct;

  const semContatos = n.restante.replace(global(RE_EMAIL_LOCAL), " ").replace(/\d+(?:[.,]\d+)?\s*(?:%|por cento)/gi, " ");
  const segmentos = semContatos.replace(ROTULOS_SOLTOS, " ").split(/[,;\n]/).map((s) => s.replace(/^[\s:–-]+|[\s:–-]+$/g, "").replace(/\s+/g, " ")).filter(Boolean);
  if (out.pj) {
    const razao = segmentos.find((s) => s.length >= 3 && s.length <= 120 && !/\d/.test(s));
    if (razao) out.nome = razao;
  } else {
    const direto = segmentos.find((s) => nomeValido(s));
    if (direto) out.nome = direto;
  }
  if (!out.nome) {
    const r = await extrair(texto, "pessoa");
    const nome = str(r?.nome);
    if (nome && noTexto(nome, texto) && (out.pj ? !/\d/.test(nome) && nome.length <= 120 : nomeValido(nome))) out.nome = nome;
  }
  if (!out.nome) return { ...out, erro: "Não achei o nome completo. Mande o nome e sobrenome." };
  return out;
}

const TIPOS_DE_IMOVEL = ["apartamento", "casa", "terreno", "sala", "loja", "galpao", "cobertura", "sobrado", "chacara", "sitio", "fazenda", "kitnet", "studio", "flat"];

export interface ImovelLido { dados: Record<string, unknown>; erro?: string }

/** "apto 42", "bloco B", "fundos", "casa 2"… — um complemento de verdade tem número ou uma destas palavras. */
const PALAVRA_DE_COMPLEMENTO = /\b(ap(?:to|artamento)?|bloco|bl|casa|fundos|sala|loja|cobertura|andar|quadra|lote|torre|conjunto|conj|sobrado|km)\b/i;
const pareceComplemento = (c: string) => /\d/.test(c) || PALAVRA_DE_COMPLEMENTO.test(c);

/** Endereço pelo extrator (conferido contra o texto); matrícula, área, vagas e tipo em código. */
export async function lerImovel(texto: string, extrair: ExtratorDeSecao): Promise<ImovelLido> {
  const dados: Record<string, unknown> = {};
  const t = normalizar(texto);
  const cep = lerCep(texto);
  if (cep) dados.cep = cep;
  const matricula = /matricula\s*(?:n[ºo°.]*\s*)?:?\s*([\d][\d.\-/]*)/.exec(t);
  if (matricula) dados.matricula = matricula[1]!.replace(/[.\-/]+$/, "");
  const area = /(\d+(?:[.,]\d+)?)\s*(?:m2|m²|metros quadrados|metros)\b/.exec(t);
  if (area) dados.area = `${area[1]} m²`;
  const vagas = /(\d+)\s*vagas?/.exec(t);
  if (vagas) dados.vagas = vagas[1];
  const tipo = TIPOS_DE_IMOVEL.find((x) => new RegExp(String.raw`\b${x}s?\b`).test(t));
  if (tipo) dados.kind = tipo;

  const r = await extrair(texto, "imovel");
  for (const campo of ["rua", "numero", "complemento", "bairro", "cidade"] as const) {
    const v = str(r?.[campo]);
    if (v && v.length <= 160 && noTexto(v, texto)) dados[campo] = v;
  }
  // Achado 26: "Rua TESTE Max Aceite, 88" às vezes volta rua="Rua TESTE" +
  // complemento="Max Aceite" — o extrator corta o fim do logradouro como se
  // fosse complemento. Sem número nem palavra de complemento, é parte da rua.
  if (typeof dados.rua === "string" && typeof dados.complemento === "string" && !pareceComplemento(dados.complemento)) {
    const juntos = `${dados.rua} ${dados.complemento}`.trim();
    if (noTexto(juntos, texto)) {
      dados.rua = juntos;
      delete dados.complemento;
    }
  }
  const uf = str(r?.uf)?.toUpperCase();
  if (uf && /^[A-Z]{2}$/.test(uf) && new RegExp(String.raw`(?<![\p{L}])${uf}(?![\p{L}])`, "iu").test(texto)) dados.uf = uf;
  if (!dados.rua) return { dados, erro: "Não achei o endereço. Mande a rua e o número (e bairro e cidade, se puder)." };
  return { dados };
}

const CAMPOS_DO_ENDERECO = ["rua", "numero", "complemento", "bairro", "cidade", "uf"] as const;

/** Endereço de um proprietário, pelo mesmo caminho do imóvel (rua → `endereco`). */
export async function lerEnderecoDePessoa(texto: string, extrair: ExtratorDeSecao): Promise<{ dados: Record<string, unknown>; erro?: string }> {
  const r = await lerImovel(texto, extrair);
  if (r.erro) return { dados: {}, erro: r.erro };
  const d = r.dados;
  const dados: Record<string, unknown> = {};
  for (const c of CAMPOS_DO_ENDERECO) {
    if (d[c] !== undefined) dados[c === "rua" ? "endereco" : c] = d[c];
  }
  if (d.cep) dados.cep = d.cep;
  return { dados };
}

// ─── Condições (valor, comissão, prazo, exclusividade) ───────────────────

export interface CondicoesLidas { condicoes: Record<string, unknown>; locacao: Record<string, unknown> }

const MARCAS: [RegExp, string][] = [
  [/\b(?:valor|preco|pretend\w*|pedind\w*|pedido)\b/g, "valor"],
  [/\bcomiss\w*/g, "comissao"],
  [/\b(?:prazo|vigencia|validade)\b/g, "prazo"],
  [/\bexclusiv\w*/g, "exclusiva"],
  [/\balugue[lu]\b/g, "aluguel"],
  [/\bcondominio\b/g, "condominio"],
  [/\biptu\b/g, "iptu"],
  [/\b(?:taxa(?: de)? admin\w*|administracao|taxa)\b/g, "taxa"],
];

const semPercentualEPrazo = (s: string) =>
  s.replace(/\d+(?:[.,]\d+)?\s*(?:%|por cento)/g, " ").replace(/\d+\s*(?:dias?|meses|mes)\b/g, " ");

function prazoEmDias(segmento: string): number | null {
  const d = /(\d{1,5})\s*dias?\b/.exec(segmento);
  if (d) return Number(d[1]);
  const m = /(\d{1,3})\s*(?:meses|mes)\b/.exec(segmento);
  return m ? Number(m[1]) * 30 : null;
}

/**
 * Condições ditas em frase ("valor 850 mil, comissão 6%, prazo 180 dias, com
 * exclusividade"). Cada número é ligado ao rótulo que o precede; um valor sem
 * rótulo é o valor de venda (ou o aluguel, na locação). Nada de LLM: o que não
 * aparece no texto não é preenchido.
 */
export function lerCondicoes(texto: string, tipo: TipoDeCaptacao): CondicoesLidas {
  const t = normalizar(texto);
  const condicoes: Record<string, unknown> = {};
  const locacao: Record<string, unknown> = {};
  const achadas = MARCAS.flatMap(([re, campo]) => {
    const out: { campo: string; ini: number; fim: number }[] = [];
    for (const m of t.matchAll(re)) out.push({ campo, ini: m.index ?? 0, fim: (m.index ?? 0) + m[0].length });
    return out;
  }).sort((a, b) => a.ini - b.ini);

  const setMoeda = (campo: string, v: number | undefined) => {
    if (v === undefined || v < 0 || v > 1e12) return;
    if (campo === "valor") { if (tipo === "venda") condicoes.valor = v; else locacao.aluguel = v; }
    if (campo === "aluguel") locacao.aluguel = v;
    if (campo === "condominio") locacao.condominio = v;
    if (campo === "iptu") locacao.iptu = v;
  };

  const usadas = new Set<number>();
  achadas.forEach((m, i) => {
    const segmento = t.slice(m.fim, achadas[i + 1]?.ini ?? t.length);
    if (m.campo === "comissao") {
      const p = percentualNoTexto(segmento) ?? percentualNoTexto(t.slice(Math.max(0, m.ini - 12), m.ini + 40));
      if (p !== undefined) condicoes.comissao_percent = p;
    } else if (m.campo === "taxa") {
      const p = percentualNoTexto(segmento);
      if (p !== undefined && tipo === "locacao") locacao.taxa_administracao = p;
    } else if (m.campo === "prazo") {
      const d = prazoEmDias(segmento);
      if (d !== null && d <= 36500) condicoes.prazo_dias = d;
    } else if (m.campo === "exclusiva") {
      const antes = t.slice(Math.max(0, m.ini - 12), m.ini);
      condicoes.exclusiva = !/\b(sem|nao|nenhuma)\s*$/.test(antes);
    } else {
      const v = valoresNoTexto(semPercentualEPrazo(segmento))[0];
      if (v !== undefined) { setMoeda(m.campo, v); usadas.add(i); }
    }
  });

  // Sem rótulo: um único valor solto é o valor principal da esteira.
  const principal = tipo === "venda" ? condicoes.valor : locacao.aluguel;
  if (principal === undefined) {
    const primeiraMarca = achadas[0]?.ini ?? t.length;
    const solto = valoresNoTexto(semPercentualEPrazo(t.slice(0, primeiraMarca)));
    if (solto.length === 1) setMoeda("valor", solto[0]);
    else if (!achadas.length) {
      const todos = valoresNoTexto(semPercentualEPrazo(t));
      if (todos.length === 1) setMoeda("valor", todos[0]);
    }
  }
  // Sem rótulo: "180 dias" é o prazo; um único "%" solto é a comissão.
  if (condicoes.prazo_dias === undefined) {
    const d = prazoEmDias(t);
    if (d !== null && d <= 36500) condicoes.prazo_dias = d;
  }
  if (condicoes.comissao_percent === undefined && locacao.taxa_administracao === undefined) {
    const todos = [...t.matchAll(/(\d{1,3}(?:[.,]\d+)?)\s*(?:%|por cento)/g)];
    if (todos.length === 1) {
      const p = percentualNoTexto(t);
      if (p !== undefined) condicoes.comissao_percent = p;
    }
  }
  return { condicoes, locacao };
}

const brValor = (v: number) => brl(v);

function ecoDasCondicoes(c: CondicoesLidas): string {
  const p: string[] = [];
  if (typeof c.condicoes.valor === "number") p.push(`valor ${brValor(c.condicoes.valor)}`);
  if (typeof c.locacao.aluguel === "number") p.push(`aluguel ${brValor(c.locacao.aluguel)}`);
  if (typeof c.locacao.condominio === "number") p.push(`condomínio ${brValor(c.locacao.condominio)}`);
  if (typeof c.locacao.iptu === "number") p.push(`IPTU ${brValor(c.locacao.iptu)}`);
  if (typeof c.locacao.taxa_administracao === "number") p.push(`taxa de administração ${c.locacao.taxa_administracao}%`);
  if (typeof c.condicoes.comissao_percent === "number") p.push(`comissão ${c.condicoes.comissao_percent}%`);
  if (typeof c.condicoes.prazo_dias === "number") p.push(`prazo de ${c.condicoes.prazo_dias} dias`);
  if (typeof c.condicoes.exclusiva === "boolean") p.push(c.condicoes.exclusiva ? "com exclusividade" : "sem exclusividade");
  return p.join(", ");
}

const vazioDeCondicoes = (c: CondicoesLidas) => !Object.keys(c.condicoes).length && !Object.keys(c.locacao).length;

/** Eco de "Rua X, 100, Bairro, Cidade/UF (casa, CEP 01310-100)" a partir do `dados.imovel` já lido. */
function ecoDoImovel(imovel: Record<string, unknown> | undefined): string {
  if (!imovel) return "";
  const cidadeUf = [imovel.cidade, imovel.uf].filter(Boolean).join("/");
  const endereco = [imovel.rua, imovel.numero, imovel.bairro, cidadeUf].filter(Boolean).join(", ");
  const extra = [typeof imovel.kind === "string" ? imovel.kind : "", typeof imovel.cep === "string" ? `CEP ${imovel.cep}` : ""].filter(Boolean).join(", ");
  if (!endereco) return extra;
  return extra ? `${endereco} (${extra})` : endereco;
}


const temCondicoesEm = (d: DadosDeCaptacao) =>
  !!(d.condicoes && Object.keys(d.condicoes).length) || !!(d.locacao && Object.keys(d.locacao).length);

// ─── Ferramenta do extrator ──────────────────────────────────────────────

/** Tool forçada de UMA seção. Sempre TRECHOS copiados do texto — o código confere. */
export function toolExtrairCaptacao(secao: SecaoDeExtracao) {
  const campos = secao === "pessoa"
    ? { nome: "o nome completo da pessoa (ou a razão social)" }
    : {
      rua: "o logradouro (rua, avenida…), sem o número", numero: "o número", complemento: "o complemento (apto, bloco…)",
      bairro: "o bairro", cidade: "a cidade", uf: "a sigla do estado (2 letras)",
    };
  const alvo = secao === "pessoa" ? "a pessoa" : secao === "endereco" ? "o endereço da pessoa" : "o endereço do imóvel";
  return {
    name: "preencher_captacao",
    description:
      `Registra ${alvo} que a pessoa informou NESTA mensagem. Nunca invente nem deduza: ` +
      "copie o trecho como está na mensagem; sem o dado, deixe o campo de fora.",
    parameters: {
      type: "object",
      properties: Object.fromEntries(Object.entries(campos).map(([k, d]) => [k, { type: "string", description: d }])),
      additionalProperties: false,
    },
  };
}

// ─── Faltantes do servidor → pergunta, leitura e patch ───────────────────

type TipoDeCampo =
  | "endereco_imovel" | "tipo_imovel" | "endereco_pessoa" | "texto" | "texto_longo" | "doc" | "email" | "telefone"
  | "data" | "moeda" | "percentual" | "inteiro" | "booleano" | "estado_civil" | "nome" | "cep";

/** Os campos de nível `envio`/`ficha` que o Max sabe preencher. Path desconhecido vai para a tela. */
const TIPO_DO_PATH: Record<string, TipoDeCampo> = {
  "imovel.endereco": "endereco_imovel", "imovel.tipo": "tipo_imovel", "imovel.cep": "cep", "imovel.matricula": "texto", "imovel.cartorio": "texto",
  "imovel.inscricao_iptu": "texto", "imovel.descricao": "texto_longo", "imovel.area": "texto", "imovel.vagas": "texto",
  "imovel.condominio_nome": "texto",
  "proprietarios[].nome": "nome", "proprietarios[].cpf": "doc", "proprietarios[].rg": "texto",
  "proprietarios[].nacionalidade": "texto", "proprietarios[].estado_civil": "estado_civil", "proprietarios[].profissao": "texto",
  "proprietarios[].endereco_completo": "endereco_pessoa", "proprietarios[].email": "email", "proprietarios[].telefone1": "telefone",
  "proprietarios[].telefone2": "telefone", "proprietarios[].data_nascimento": "data", "proprietarios[].percentual": "percentual",
  "proprietarios[].banco": "texto", "proprietarios[].agencia": "texto", "proprietarios[].conta": "texto", "proprietarios[].pix_chave": "texto",
  "condicoes.valor": "moeda", "condicoes.comissao_percent": "percentual", "condicoes.prazo_dias": "inteiro",
  "condicoes.prazo_cura_dias": "inteiro", "condicoes.exclusiva": "booleano", "condicoes.foro": "texto", "condicoes.observacoes": "texto_longo",
  "locacao.aluguel": "moeda", "locacao.condominio": "moeda", "locacao.iptu": "moeda", "locacao.taxa_administracao": "percentual",
};

/**
 * O tipo de UM faltante: SEMPRE `TIPO_DO_PATH[fa.path]`, igual a antes do
 * v2/PR5. O `tipo` que o servidor manda (CM) é só parseado e mantido em
 * `fa.tipo` (ver `lerFaltanteBruto`) — nunca decide aqui.
 *
 * Por quê: o catálogo do CM (`field-catalog.ts`) manda `tipo:"texto"` genérico
 * para paths que o Max trata de forma especializada aqui — `imovel.endereco`
 * (endereco_imovel), `imovel.tipo` (tipo_imovel, escreve `imovel.kind`),
 * `proprietarios[].nome` (nome), `estado_civil`, `endereco_completo`
 * (endereco_pessoa). Deixar o `tipo` do servidor mandar sobrescreveria esses
 * tipos especializados pelo genérico "texto" (B1) e, pior, faria QUALQUER
 * path novo/desconhecido do servidor virar perguntável via
 * `TIPO_DO_CATALOGO[fa.tipo]` mesmo sem o Max saber validar/escrever aquele
 * campo (B2) — o preflight do CM entraria em loop. `TIPO_DO_PATH` continua
 * sendo a allowlist E o decisor; path fora dela é SEMPRE da tela, com
 * qualquer `tipo` que o servidor mande.
 */
export function tipoDoFaltante(fa: FaltanteDeCaptacao): TipoDeCampo | undefined {
  return TIPO_DO_PATH[fa.path];
}

/** O que a pergunta de cada faltante diz como exemplo. */
const DICA: Partial<Record<TipoDeCampo, string>> = {
  endereco_imovel: " (rua, número, bairro, cidade/UF)",
  endereco_pessoa: " (rua, número, bairro, cidade/UF)",
  doc: " (CPF, ou CNPJ se for empresa)",
  data: " (dd/mm/aaaa)",
  moeda: " (ex.: 850 mil)",
  percentual: " (ex.: 6%)",
  inteiro: " (em dias)",
  booleano: " (com ou sem exclusividade?)",
  tipo_imovel: " (apartamento, casa, terreno…)",
  cep: " (00000-000)",
};

const PERGUNTA_FORA = /\?\s*$|^(como|quando|onde|por que|porque|o que|qual|quais|quanto|quem|me (fala|diz|explica)|tem como)\b/;

function nomeDoDono(f: FluxoCaptacao, id?: string): string | undefined {
  return id ? f.proprietarios?.find((p) => p.id === id)?.nome : undefined;
}

function perguntaDoFaltante(f: FluxoCaptacao, fa: FaltanteDeCaptacao): string {
  const tipo = tipoDoFaltante(fa);
  const dono = nomeDoDono(f, fa.proprietarioId);
  // "Endereço do imóvel do imóvel?": o rótulo do servidor às vezes já diz "do imóvel".
  const rotuloJaDiz = /\bimovel\b/.test(normalizar(fa.rotulo));
  const de = fa.path.startsWith("proprietarios[]")
    ? (dono ? ` de ${dono}` : " do proprietário")
    : fa.path.startsWith("imovel.") && fa.path !== "imovel.endereco" && !rotuloJaDiz ? " do imóvel" : "";
  const dica = tipo ? (DICA[tipo] ?? "") : "";
  if (fa.path === "imovel.endereco") return `Qual o endereço do imóvel${dica}?`;
  return `${fa.rotulo}${de}${dica}?`;
}

const dataValida = (s: string) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) return false;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return d.getFullYear() === Number(m[3]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[1]) && d.getTime() < Date.now();
};

const SENSIVEL = new Set([
  "proprietarios[].rg", "proprietarios[].banco", "proprietarios[].agencia", "proprietarios[].conta", "proprietarios[].pix_chave",
]);

type Leitura = { dados: DadosDeCaptacao; eco: string } | { erro: string } | "vazio";

const semAcento = (c: string) => c.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/**
 * "matrícula 12345" respondendo à pergunta da matrícula é o valor 12345, não o
 * texto inteiro. Tira o rótulo do campo (inteiro ou só a 1ª palavra) do começo.
 */
export function semRotulo(texto: string, rotulo: string): string {
  const t = texto.trim();
  for (const alvo of [normalizar(rotulo), normalizar(rotulo.split(/\s+/)[0] ?? "")].filter(Boolean)) {
    let acc = "";
    let i = 0;
    while (i < t.length && acc.length < alvo.length) { acc += semAcento(t[i]!); i += 1; }
    const resto = t.slice(i);
    if (acc === alvo && (resto === "" || /^[\s:=\-–é]/.test(resto) || /^eh\b/i.test(resto))) {
      const valor = resto.replace(/^\s*(?:[:=\-–]|é\b|eh\b)?\s*(?:n[º°]\s*|numero\s+)?/i, "").trim();
      if (valor) return valor;
    }
  }
  return t;
}

/** CEP: 8 dígitos, com ou sem hífen (e o ponto de "01.310-100"); sempre gravado como 00000-000. */
export function lerCep(texto: string): string | null {
  const m = /(?<!\d)(\d{2})\.?(\d{3})-?(\d{3})(?!\d)/.exec(texto);
  return m ? `${m[1]}${m[2]}-${m[3]}` : null;
}

/** Lê a resposta a UM faltante e devolve o patch (só aquele campo) ou o erro. */
async function lerFaltante(f: FluxoCaptacao, fa: FaltanteDeCaptacao, texto: string, extrair: ExtratorDeSecao): Promise<Leitura> {
  const tipo = tipoDoFaltante(fa);
  if (!tipo) return { erro: "campo_desconhecido" };
  const [grupo, campo] = fa.path.replace("[]", "").split(".") as [string, string];
  const dono = fa.proprietarioId ? f.proprietarios?.find((p) => p.id === fa.proprietarioId) : undefined;
  const patchP = (extra: Record<string, unknown>): DadosDeCaptacao => ({
    proprietarios: [{ id: fa.proprietarioId, papel: "proprietario", tipo_pessoa: dono?.pj ? "juridica" : "fisica", ...extra }],
  });
  const colocar = (valor: unknown): DadosDeCaptacao =>
    grupo === "proprietarios" ? patchP({ [campo]: valor }) : ({ [grupo]: { [campo]: valor } } as DadosDeCaptacao);
  const limpo = texto.trim();
  if (!limpo) return "vazio";
  switch (tipo) {
    case "texto": case "texto_longo": {
      const valor = semRotulo(limpo, fa.rotulo).replace(/[.!]+$/, "");
      if (valor.length > (tipo === "texto" ? 200 : 1000) || valor.includes("\n")) return { erro: "Mande só o dado, em uma linha." };
      // PII: RG, banco/PIX e afins não voltam no eco (nem vão para o estado).
      if (SENSIVEL.has(fa.path)) return { dados: colocar(valor), eco: `${fa.rotulo} anotado` };
      return { dados: colocar(valor), eco: `${fa.rotulo}: ${valor}` };
    }
    case "nome": {
      if (!nomeValido(limpo)) return { erro: "Preciso do nome completo, com sobrenome." };
      return { dados: colocar(limpo), eco: `${fa.rotulo}: ${limpo}` };
    }
    case "doc": {
      const n = lerNumeros(texto);
      if (n.invalido) return { erro: n.invalido === "cpf" ? "Esse CPF não confere (dígito verificador)." : "Esse CNPJ não confere (dígito verificador)." };
      if (n.cpfs.length === 1 && !dono?.pj) return { dados: patchP({ cpf: n.cpfs[0] }), eco: "documento anotado" };
      if (n.cnpjs.length === 1) return { dados: patchP({ cnpj: n.cnpjs[0], tipo_pessoa: "juridica" }), eco: "documento anotado" };
      return { erro: "Mande só o CPF (ou o CNPJ, se for empresa)." };
    }
    case "email": {
      const e = lerEmails(texto);
      return e.length === 1 ? { dados: colocar(e[0]), eco: "e-mail anotado" } : { erro: "Mande um e-mail válido." };
    }
    case "telefone": {
      const n = lerNumeros(texto);
      const tel = n.telefones[0] ?? (so(texto).length === 10 || so(texto).length === 11 ? so(texto) : undefined);
      // Achado 27: grava em E.164 (+55…), não os dígitos crus.
      return tel ? { dados: colocar(normalizeBrPhone(tel) ?? tel), eco: "telefone anotado" } : { erro: "Mande o telefone com DDD." };
    }
    case "data":
      return dataValida(limpo) ? { dados: colocar(limpo), eco: `${fa.rotulo}: ${limpo}` } : { erro: "Mande a data como dd/mm/aaaa." };
    case "moeda": {
      const v = valoresNoTexto(texto);
      return v.length === 1 && v[0]! >= 0 ? { dados: colocar(v[0]), eco: `${fa.rotulo}: ${brValor(v[0]!)}` } : { erro: "Mande só o valor, por exemplo: 850 mil." };
    }
    case "percentual": {
      const p = percentualNoTexto(texto) ?? (/^\d{1,3}(?:[.,]\d+)?$/.test(limpo) ? Number(limpo.replace(",", ".")) : undefined);
      return p !== undefined && p >= 0 && p <= 100 ? { dados: colocar(p), eco: `${fa.rotulo}: ${p}%` } : { erro: "Mande o percentual, por exemplo: 6%." };
    }
    case "inteiro": {
      const d = prazoEmDias(normalizar(texto)) ?? (/^\d{1,5}$/.test(limpo) ? Number(limpo) : null);
      return d !== null && d >= 0 && d <= 36500 ? { dados: colocar(d), eco: `${fa.rotulo}: ${d} dias` } : { erro: "Mande o prazo em dias, por exemplo: 180." };
    }
    case "booleano": {
      const t = normalizar(texto);
      const sem = /\b(sem exclusiv\w*|nao)\b/.test(t);
      const com = /\b(com exclusiv\w*|exclusiv\w*|sim)\b/.test(t) && !sem;
      if (!sem && !com) return { erro: "Responda COM ou SEM exclusividade." };
      return { dados: colocar(com), eco: com ? "com exclusividade" : "sem exclusividade" };
    }
    case "estado_civil": {
      const c = ESTADO_CIVIL.exec(normalizar(texto))?.[1];
      return c ? { dados: colocar(c), eco: `estado civil: ${c}` } : { erro: "Diga o estado civil (solteiro, casado, divorciado, viúvo ou união estável)." };
    }
    case "cep": {
      const c = lerCep(texto);
      return c ? { dados: { imovel: { cep: c } }, eco: `CEP ${c}` } : { erro: "Mande o CEP com 8 dígitos (ex.: 01310-100)." };
    }
    case "tipo_imovel": {
      const k = TIPOS_DE_IMOVEL.find((x) => new RegExp(String.raw`\b${x}s?\b`).test(normalizar(texto)));
      return k ? { dados: { imovel: { kind: k } }, eco: `tipo: ${k}` } : { erro: "Diga o tipo: apartamento, casa, terreno…" };
    }
    case "endereco_imovel": {
      const r = await lerImovel(texto, extrair);
      return r.erro ? { erro: r.erro } : { dados: { imovel: r.dados }, eco: "endereço anotado" };
    }
    case "endereco_pessoa": {
      const r = await lerEnderecoDePessoa(texto, extrair);
      return r.erro ? { erro: r.erro } : { dados: patchP(r.dados), eco: "endereço anotado" };
    }
  }
}

// ─── Gate e escrita ──────────────────────────────────────────────────────

type CapacidadeDoFluxo =
  | "captacao.create" | "captacao.send" | "captacao.list"
  | "captacao.autorizacao.pedir" | "captacao.autorizacao.decidir";

/** "Não está ligada" da fila de autorização do gerente (`MAX_CAPTACAO_AUTORIZACAO` desligada). */
const textoAutorizacaoDesligada = (): string => `A fila de autorização pelo ${nomeDoAgente()} não está ligada para a sua imobiliária. Fale com o administrador.`;
/** Sem fila para decidir (403 do `captacao.autorizacao.listar`). */
const TEXTO_SEM_FILA = "Você não tem pedidos de autorização para decidir.";

function gatePolitica(ctx: ContextoDoTurno, podeEscrever: boolean, cap: CapacidadeDoFluxo): Resposta | null {
  if (!podeEscrever) return resposta(null, textoCaptacaoSemPolitica(), "captacao_sem_usuario");
  if (ctx.politicaIndisponivel) return resposta(null, TEXTO_POLITICA_INDISPONIVEL, "captacao_politica_indisponivel");
  if (!ctx.policy.includes(cap)) return resposta(null, textoCaptacaoSemPolitica(), "captacao_sem_politica");
  return null;
}

/** 403 de política/RBAC/esteira no servidor: o texto certo para cada `error`. */
function textoDeNegado(r: { status: number; body: Record<string, unknown> }): { reply: string; evento: string } {
  const erro = str(r.body.error);
  if (erro === "captacao_desligada") return { reply: TEXTO_DESLIGADA, evento: "captacao_desligada" };
  return { reply: textoCaptacaoSemPolitica(), evento: `captacao_403_${erro ?? "rbac"}` };
}

const lembrete = (f: FluxoCaptacao) => (f.codigo ? ` ${f.codigo}` : "");

function g(f: FluxoCaptacao, ctx: ContextoDoTurno, patch: Partial<FluxoCaptacao> = {}): FluxoCaptacao {
  return { ...f, ...patch, atualizadoEm: ctx.agora };
}

// ─── Início ──────────────────────────────────────────────────────────────

const TEXTO_NATUREZA = "A captação é de *venda* ou de *locação*?";
const TEXTO_NOME = "Que nome dou a essa captação? (por exemplo, o nome do proprietário ou o endereço)";
const TEXTO_IMOVEL =
  "Qual o imóvel? Mande o endereço (rua, número, bairro, cidade/UF) e, se já souber, matrícula, área e tipo (apartamento, casa…). " +
  "Se preferir, diga PULAR e completo depois.";

function textoDasCondicoes(tipo: TipoDeCaptacao): string {
  return tipo === "venda"
    ? "Condições da captação: valor pretendido, comissão (%), prazo (dias) e se é com ou sem exclusividade. Pode mandar tudo junto, ou PULAR."
    : "Condições da captação: aluguel pretendido (e condomínio, IPTU, taxa de administração, se tiver), comissão (%), prazo (dias) e se é com ou sem exclusividade. Pode mandar tudo junto, ou PULAR.";
}

const TEXTO_PROPRIETARIOS =
  "Agora os proprietários, um por mensagem: nome completo, CPF (ou CNPJ), telefone, e-mail e estado civil. " +
  "Quando acabar, diga FIM.";

/** "Cria uma captação de venda para o Apto da Dona Maria": gate → natureza → modelo → imóvel. */
export async function iniciarCaptacao(ctx: ContextoDoTurno, deps: DepsDoFluxo, podeEscrever: boolean): Promise<Resposta> {
  const barrado = gatePolitica(ctx, podeEscrever, "captacao.create");
  if (barrado) return barrado;
  const nome = nomeDaCaptacao(ctx.texto) ?? undefined;
  const tipo = tipoDito(ctx.texto) ?? undefined;
  const canalDito = canalDoTexto(ctx.texto) ?? undefined;
  // Achado 1 (revisão opus): nunca o texto verbatim — CPF/CNPJ/e-mail/telefone
  // saem redigidos ANTES de entrar no estado (que o LangGraph GRAVA a cada
  // super-step) e antes de qualquer chance de ir ao extrator por LLM.
  const pedidoOriginal = redigir(ctx.texto, ["CPF", "CNPJ", "EMAIL", "TEL"]);
  const f: FluxoCaptacao = {
    kind: "captacao", etapa: "natureza", tentativas: 0, atualizadoEm: ctx.agora, pedidoOriginal,
    ...(nome ? { nome } : {}), ...(tipo ? { tipo } : {}), ...(canalDito ? { canalDito } : {}),
  };
  if (!tipo) return resposta(f, TEXTO_NATUREZA, "captacao_natureza");
  return depoisDaNatureza(f, ctx, deps, "");
}

/** `captacao.options{tipo}`: modelos (e canais) da esteira. */
async function depoisDaNatureza(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, prefixo: string): Promise<Resposta> {
  const r = await deps.acao("captacao.options", { tipo: f.tipo });
  if (!r) return resposta(g(f, ctx), `${TEXTO_SEM_RESPOSTA} Diga a natureza de novo para eu tentar outra vez.`, "captacao_options_sem_resposta");
  if (r.status === 403) { const n = textoDeNegado(r); return resposta(null, n.reply, n.evento); }
  if (r.status !== 200) return resposta(null, TEXTO_SEM_RESPOSTA, `captacao_options_${r.status}`);
  const modelos = lista(r.body.modelos).flatMap((x): ModeloDeCaptacao[] => {
    const m = obj(x);
    const id = str(m.id);
    const nome = str(m.nome);
    // `padrao` (v2/PR5) é só lido aqui; a escolha ainda pergunta sempre que há mais de um modelo.
    return id && nome
      ? [{
        id, nome, ...(str(m.resumo) ? { resumo: str(m.resumo)! } : {}), ...(typeof m.padrao === "boolean" ? { padrao: m.padrao } : {}),
        ...(typeof m.exclusiva === "boolean" ? { exclusiva: m.exclusiva } : {}),
      }]
      : [];
  });
  if (!modelos.length) {
    return resposta(null, `Sua imobiliária não tem um modelo de captação de ${NOME_DA_ESTEIRA[f.tipo!]} ativo. Um administrador ativa em Modelos, no sistema; depois é só me pedir de novo.`, "captacao_sem_modelo");
  }
  const aviso = r.body.assinaturaConfigurada === false
    ? "Atenção: a assinatura digital (ClickSign) não está conectada; dá para preparar o rascunho, mas o envio não vai funcionar até um administrador conectar.\n\n"
    : "";
  if (modelos.length > 1) {
    const linhas = modelos.map((m, i) => `${i + 1}. ${m.nome}${m.resumo ? ` — ${m.resumo}` : ""}`).join("\n");
    return resposta(g(f, ctx, { etapa: "modelo", modelos }), `${prefixo}${aviso}Qual modelo uso?\n${linhas}\n\nResponda com o número.`, "captacao_modelo");
  }
  return seguirParaNomeOuImovel(g(f, ctx, { modeloId: modelos[0]!.id, modelos: undefined, ...exclusivaDoModelo(modelos[0]) }), ctx, deps, `${prefixo}${aviso}`);
}

async function seguirParaNomeOuImovel(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, prefixo: string): Promise<Resposta> {
  if (!f.nome) return resposta(g(f, ctx, { etapa: "nome" }), `${prefixo}${TEXTO_NOME}`, "captacao_nome");
  return aproveitarPedidoOriginal(f, ctx, deps, prefixo);
}

// Sem "apto" solto: "Apto da Dona Maria" é NOME da captação, não endereço — só
// dispara a extração (que custa um LLM) com sinal forte de rua/CEP de verdade.
const PARECE_ENDERECO = /\brua\b|\bavenida\b|\bav\.?\s|\bendere[çc]o\b|\d{5}-?\d{3}\b|\bn[uú]mero\s*\d|\balameda\b|\btravessa\b|\brodovia\b/i;

/**
 * O 1º pedido já tinha endereço, condições ou canal ("…Rua X, 88, sem
 * exclusividade, aceite por WhatsApp")? Aproveita o que der e só pergunta o
 * que falta (achados 22/28) — nunca pede de novo o que a pessoa já disse.
 */
async function aproveitarPedidoOriginal(fOriginal: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, prefixo: string): Promise<Resposta> {
  const pedido = fOriginal.pedidoOriginal;
  // Achado 1 (revisão opus): consumido uma vez só — não sobrevive no estado
  // depois desta chamada, em NENHUM dos desfechos abaixo.
  const f = g(fOriginal, ctx, { pedidoOriginal: undefined });
  const lidas = pedido ? lerCondicoes(pedido, f.tipo ?? "venda") : { condicoes: {}, locacao: {} };
  const dados: DadosDeCaptacao = {};
  if (Object.keys(lidas.condicoes).length) dados.condicoes = lidas.condicoes;
  if (Object.keys(lidas.locacao).length) dados.locacao = lidas.locacao;

  let imovel: Record<string, unknown> | undefined;
  if (pedido && PARECE_ENDERECO.test(pedido)) {
    const extrair: ExtratorDeSecao = async (texto, secao) => (deps.extrairCaptacao ? deps.extrairCaptacao(texto, secao) : null);
    const r = await lerImovel(pedido, extrair);
    if (!r.erro) imovel = r.dados;
  }
  if (imovel) dados.imovel = imovel;

  if (imovel && temCondicoesEm(dados)) {
    const eco = `Já anotei do seu pedido: imóvel ${ecoDoImovel(imovel)}; ${ecoDasCondicoes(lidas)}.\n`;
    // Confirmação única (26/10): com imóvel e condições, cria direto — o único "sim" do fluxo é o do resumo final.
    return criar(g(f, ctx, { criacao: { chave: "", dados } }), ctx, deps, dados, `${prefixo}${eco}`);
  }
  if (imovel) {
    const eco = `Já anotei o imóvel do seu pedido: ${ecoDoImovel(imovel)}.\n`;
    return resposta(g(f, ctx, { etapa: "condicoes", criacao: { chave: "", dados } }), `${prefixo}${eco}${textoDasCondicoes(f.tipo ?? "venda")}`, "captacao_condicoes");
  }
  if (temCondicoesEm(dados)) {
    const eco = `Já anotei do seu pedido: ${ecoDasCondicoes(lidas)}.\n`;
    return resposta(g(f, ctx, { etapa: "imovel", criacao: { chave: "", dados } }), `${prefixo}${eco}${TEXTO_IMOVEL}`, "captacao_imovel");
  }
  return resposta(g(f, ctx, { etapa: "imovel" }), `${prefixo}${TEXTO_IMOVEL}`, "captacao_imovel");
}

// ─── Consulta (listar / status) ──────────────────────────────────────────

function situacaoPedida(t: string): "rascunho" | "em_assinatura" | "assinada" | "todas" | undefined {
  if (/\b(todas|arquivad\w*)\b/.test(t)) return "todas";
  if (/\bem assinatura\b|\baguardando assinatura\b/.test(t)) return "em_assinatura";
  if (/\bassinadas?\b/.test(t)) return "assinada";
  if (/\brascunhos?\b/.test(t)) return "rascunho";
  return undefined;
}

function buscaDoPedido(texto: string): string | undefined {
  const nome = nomeDaCaptacao(texto);
  if (nome) return nome.slice(0, 80);
  const codigo = /\bCAP-\d{4}-\d+\b/i.exec(texto)?.[0];
  return codigo?.toUpperCase();
}

/** "Como está a captação da Maria?" / "minhas captações" → `captacao.list`, resposta do sistema. */
export async function responderListaDeCaptacao(ctx: ContextoDoTurno, deps: DepsDoFluxo, podeEscrever: boolean): Promise<Resposta> {
  const barrado = gatePolitica(ctx, podeEscrever, "captacao.list");
  if (barrado) return barrado;
  const busca = buscaDoPedido(ctx.texto);
  const situacao = situacaoPedida(normalizar(ctx.texto));
  const r = await deps.acao("captacao.list", { ...(busca ? { busca } : {}), ...(situacao ? { situacao } : {}) });
  if (!r) return resposta(null, TEXTO_SEM_RESPOSTA, "captacao_list_sem_resposta");
  if (r.status === 403) { const n = textoDeNegado(r); return resposta(null, n.reply, n.evento); }
  if (r.status === 400) return resposta(null, "Essa busca ficou grande demais. Diga só o nome ou o código.", "captacao_list_busca");
  if (r.status !== 200) return resposta(null, TEXTO_SEM_RESPOSTA, `captacao_list_${r.status}`);
  const total = typeof r.body.total === "number" ? r.body.total : null;
  return resposta(null, textoDaLista(r.body.items, total, busca), "captacao_list");
}

// ─── Envio de um rascunho existente ("envia a captação da Maria") ────────

export async function iniciarEnvioDeCaptacao(ctx: ContextoDoTurno, deps: DepsDoFluxo, podeEscrever: boolean): Promise<Resposta> {
  const barrado = gatePolitica(ctx, podeEscrever, "captacao.send");
  if (barrado) return barrado;
  if (!captacaoEnvioLigado()) return resposta(null, `O envio de captação pelo ${nomeDoAgente()} ainda não está ligado. Envie pela tela do sistema.`, "captacao_envio_desligado");
  const busca = buscaDoPedido(ctx.texto);
  const r = await deps.acao("captacao.list", { ...(busca ? { busca } : {}), situacao: "rascunho" });
  if (!r) return resposta(null, TEXTO_SEM_RESPOSTA, "captacao_envio_list_sem_resposta");
  if (r.status === 403) { const n = textoDeNegado(r); return resposta(null, n.reply, n.evento); }
  if (r.status !== 200) return resposta(null, TEXTO_SEM_RESPOSTA, `captacao_envio_list_${r.status}`);
  const itens = lista(r.body.items).map(lerItemDaCaptacao).filter((x): x is ItemDaCaptacao => !!x);
  if (!itens.length) {
    return resposta(null, busca ? `Não achei rascunho de captação para "${busca}".` : "Você não tem rascunhos de captação para enviar.", "captacao_envio_sem_rascunho");
  }
  // Achado 23/28: "...para mandar por aceite no WhatsApp" já dispensa a pergunta do canal.
  const canalDito = canalDoTexto(ctx.texto) ?? undefined;
  const base: FluxoCaptacao = { kind: "captacao", etapa: "verificar", tentativas: 0, atualizadoEm: ctx.agora, ...(canalDito ? { canalDito } : {}) };
  if (itens.length === 1) {
    const i = itens[0]!;
    return verificar({ ...base, captacaoId: i.id, codigo: i.codigo, nome: i.nome }, ctx, deps, `Captação ${i.codigo} (${i.nome}). `);
  }
  const candidatos = itens.slice(0, 10).map((i, n) => ({ ref: i.ref ?? n + 1, id: i.id, codigo: i.codigo, nome: i.nome }));
  const linhas = candidatos.map((c) => `${c.ref}. ${c.codigo} — ${c.nome}`).join("\n");
  return resposta({ ...base, etapa: "selecao", candidatos }, `Achei mais de um rascunho:\n${linhas}\n\nQual envio? Responda com o número.`, "captacao_envio_selecao");
}

// ─── v2/PR7: fila de autorização do gerente ──────────────────────────────

/**
 * "Tem pedido de autorização?", "pedidos pendentes": gatilho determinístico,
 * atrás de `MAX_CAPTACAO_AUTORIZACAO` (desligada por padrão) E da capability
 * `captacao.autorizacao.decidir`. Sem a capability, nem a flag chegam a
 * importar: o gate (política) responde primeiro — o mesmo texto de sempre,
 * sem dizer que a fila existe.
 */
export async function iniciarFilaDeAutorizacao(ctx: ContextoDoTurno, deps: DepsDoFluxo, podeEscrever: boolean): Promise<Resposta> {
  const barrado = gatePolitica(ctx, podeEscrever, "captacao.autorizacao.decidir");
  if (barrado) return barrado;
  if (!captacaoAutorizacaoLigada()) return resposta(null, textoAutorizacaoDesligada(), "captacao_autorizacao_fila_desligada");
  return listarFilaDeAutorizacao(ctx, deps);
}

/** `captacao.autorizacao.listar{}`: até 10 pendentes, numerados — vazio é frase própria, nunca lista vazia muda. */
async function listarFilaDeAutorizacao(ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<Resposta> {
  const r = await deps.acao("captacao.autorizacao.listar", {});
  if (!r) return resposta(null, TEXTO_SEM_RESPOSTA, "captacao_autorizacao_listar_sem_resposta");
  if (r.status === 403) return resposta(null, TEXTO_SEM_FILA, "captacao_autorizacao_listar_403");
  if (r.status !== 200) return resposta(null, TEXTO_SEM_RESPOSTA, `captacao_autorizacao_listar_${r.status}`);
  const { items } = lerFilaDeAutorizacoes(r.body);
  const texto = textoDaFilaDeAutorizacoes(r.body);
  if (!items.length) return resposta(null, texto, "captacao_autorizacao_fila_vazia");
  const f: FluxoCaptacao = {
    kind: "captacao", etapa: "autorizacao_fila", tentativas: 0, atualizadoEm: ctx.agora,
    autorizacaoFila: {
      itens: items.map((i) => ({
        ref: i.ref, id: i.id, tipo: i.tipo, codigo: i.codigo, solicitante: i.solicitante,
        ...(i.documento ? { documento: i.documento } : {}), ...(i.imovel ? { imovel: i.imovel } : {}),
      })),
    },
  };
  return resposta(f, `${texto}\n\nResponda "aprovar N" ou "negar N" (o número da lista).`, "captacao_autorizacao_fila");
}

// ─── Condução ────────────────────────────────────────────────────────────

const CANCELA = /^(cancela|cancelar|desisto|desistir|para|parar|pare)$/;
/**
 * Achado de review 19/10 (item 5): dentro de `autorizacao_motivo` o texto
 * INTEIRO é o motivo da negativa — só "cancelar"/"cancela" EXATOS cancelam;
 * frases que contêm "desisto"/"não quero mais" no MEIO (a própria razão do
 * gerente negar) são motivo, nunca cancelamento.
 */
const CANCELA_MOTIVO = /^(cancela|cancelar)$/;
const FIM = /^(fim|fim\.?|terminei|acabou|pronto|so isso|e so isso|so esse|so esses|nao tem mais|sem mais|nenhum|nenhuma|nao|n|ja deu|chega)$/;
const PULAR = /^(pular|pula|depois|deixa|deixa pra depois|completo depois|completo na tela|pulei|nao sei)$/;
// Confirmação única (26/10): o "sim" do RESUMO FINAL é a única confirmação do
// fluxo e é ele que envia. "enviar" (e as formas abaixo) continuam valendo ali.
const ENVIAR = /^(enviar|envia|enviar sim|sim,? enviar|sim,? envia|pode enviar|pode enviar sim|enviar agora|confirmo o envio|manda enviar)$/;
// "enviar assim mesmo" era a resposta da etapa antiga `brancos`; agora só vale como "sim" do resumo.
const ENVIAR_BRANCOS = /^(enviar assim mesmo|envia assim mesmo|enviar mesmo assim|envia mesmo assim|pode enviar assim mesmo|sim,? enviar assim mesmo|sim,? assim mesmo|assim mesmo)$/;
/** Depois de pendências só-da-tela: "pronto"/"ajustei" pede a conferência de novo. */
const QUER_CONFERIR = /^(pronto|feito|fiz|ja fiz|ajustei|ja ajustei|corrigi|ja corrigi|resolvi|ja resolvi|terminei|confere|confira|pode conferir|confere ai|ta pronto|esta pronto)$/;

export function confirmaEnvio(texto: string): boolean {
  return ENVIAR.test(normalizar(texto));
}

const RE_CANAL_NA_FRASE = /\b(?:(?:por|pelo|pela|via|no|na|com)\s+)?(?:aceite\s+(?:por|pelo|no|via)\s+whatsapp|whatsapp\s+(?:com|por)\s+aceite|aceite|whatsapp|zap|e-?mail)\b/g;

/**
 * A resposta ao resumo final: "sim", "enviar", "sim, por WhatsApp", "manda
 * por e-mail". `canal` é o canal dito NA MESMA resposta (ou null); `sim` só é
 * verdade quando, tirado o canal, sobra uma confirmação de verdade.
 */
export function lerRespostaDoResumo(texto: string): { sim: boolean; nao: boolean; canal: CanalDeEnvio | null } {
  const canal = canalDoTexto(texto);
  const t = normalizar(texto);
  const resto = t.replace(RE_CANAL_NA_FRASE, " ").replace(/[,;.!:\s-]+/g, " ").trim();
  const sim = !!resto && (lerConfirmacao(resto) === "sim" || ENVIAR.test(resto) || ENVIAR_BRANCOS.test(resto));
  const nao = !canal && lerConfirmacao(t) === "nao";
  return { sim, nao, canal };
}

function perguntaDoEstadoCivil(nome?: string): string {
  return `Qual o estado civil ${nome ? `de ${nome}` : "do proprietário"}? (solteiro, casado, divorciado, viúvo ou união estável — ou PULAR)`;
}

/** O "Continuando…" que volta depois de uma pergunta fora do assunto. */
export function continuacaoCaptacao(f: FluxoCaptacao): string {
  const cab = `Continuando a captação${lembrete(f)}: `;
  switch (f.etapa) {
    case "natureza": return `${cab}${TEXTO_NATUREZA}`;
    case "nome": return `${cab}${TEXTO_NOME}`;
    case "modelo": return `${cab}qual modelo uso? Responda com o número.`;
    case "imovel": return `${cab}${TEXTO_IMOVEL}`;
    case "condicoes": return `${cab}${textoDasCondicoes(f.tipo ?? "venda")}`;
    case "exclusividade": return `${cab}responda *COM* ou *SEM* exclusividade.`;
    case "proprietarios": return `${cab}mande o próximo proprietário, ou FIM.`;
    case "estado_civil": return `${cab}${perguntaDoEstadoCivil(nomeDoDono(f, f.estadoCivilDe))}`;
    case "extras": return `${cab}tem testemunha ou outra pessoa para assinar? Mande nome e e-mail/telefone, ou diga NÃO.`;
    case "faltantes": {
      const fa = f.faltantes?.[0];
      return fa ? `${cab}${perguntaDoFaltante(f, fa)}` : `${cab}mande CANCELAR para parar.`;
    }
    case "verificar": return f.pendenciasDitas ? `${cab}quando ajustar na tela, me diga *pronto* que eu confiro.` : `${cab}mande CANCELAR para parar.`;
    case "selecao": return `${cab}qual rascunho envio? Responda com o número.`;
    case "revisao": return `${cab}responda *sim* para enviar, ou CANCELAR.`;
    case "enviando": return `Sobre o envio da captação${lembrete(f)}: ainda estou conferindo; me pergunte "como está a captação" que eu confiro.`;
    case "autorizacao_oferta": return `${cab}quer que eu peça a autorização ao gerente? Responda sim ou não.`;
    case "autorizacao_fila": return `Sobre os pedidos de autorização: responda "aprovar N" ou "negar N".`;
    case "autorizacao_motivo": return "Sobre a negativa do pedido de autorização: qual o motivo? (até 500 caracteres)";
    case "autorizacao_confirmar": return "Confirma a decisão do pedido de autorização? Responda sim ou não.";
    default: return `${cab}mande CANCELAR para parar.`;
  }
}
function cancelar(f: FluxoCaptacao): Resposta {
  // Review 19/10 (3ª rodada): pedir/decidir sem resposta também é escrita incerta.
  if (f.autorizacaoChave) return respostaDeAutorizacaoIncerta("captacao_cancelado_autorizacao_incerta");
  if (f.chave) {
    return resposta(null, `Parei. Se o envio chegou ao sistema, o estado aparece na tela: ${linkDe(f.captacaoId)}`, "captacao_cancelado_envio_incerto");
  }
  return f.captacaoId
    ? resposta(null, `Parei. O rascunho${lembrete(f)} fica salvo na tela: ${linkDe(f.captacaoId)}`, "captacao_cancelado")
    : resposta(null, "Parei. Nada foi criado.", "captacao_cancelado");
}

/** Parar depois de um pedir/decidir SEM resposta: a escrita pode ter chegado — nunca dizer "nada aconteceu". */
function respostaDeAutorizacaoIncerta(evento: string): Resposta {
  return resposta(null, `Parei. A última tentativa não teve resposta, então ela pode ter chegado ao sistema — confira na tela: ${linkDe()}`, evento);
}

function pausar(f: FluxoCaptacao): PassoDoFluxo {
  return { liberar: true, fluxo: { ...f, pausado: true }, evento: "captacao_pausado" };
}

function falhou(f: FluxoCaptacao, motivo: string, ctx: ContextoDoTurno): Resposta {
  const tentativas = f.tentativas + 1;
  if (tentativas >= 3) {
    return resposta(null, f.captacaoId ? `${TEXTO_TENTATIVAS} ${linkDe(f.captacaoId)}` : "Não estou conseguindo entender. Nada foi criado; tente de novo quando quiser.", "captacao_tentativas");
  }
  return resposta(g(f, ctx, { tentativas }), `${motivo} ${continuacaoCaptacao({ ...f, etapa: f.etapa }).replace(/^Continuando a captação[^:]*: /, "")}`, "captacao_invalido");
}

/** A capability que ESTA etapa exige — usada pelo gate e pelo aviso de "send-only" (achado 21). */
function capacidadeDaEtapa(etapa: FluxoCaptacao["etapa"]): CapacidadeDoFluxo {
  // `revisao` é o resumo final (o "sim" que envia, e o canal dito junto dele).
  // `canal`/`brancos` são etapas legadas (checkpoint de antes da confirmação
  // única), também do caminho de ENVIO. O complemento que o canal dispara (se
  // houver `proprietarios` conhecidos) ainda passa pela RBAC real do servidor.
  if (etapa === "revisao" || etapa === "brancos" || etapa === "selecao" || etapa === "canal") return "captacao.send";
  if (etapa === "enviando") return "captacao.list";
  // Achado 2 (revisão opus): "verificar" só LÊ (`captacao.preflight`) — nunca
  // deveria exigir `captacao.create`. Quem foi REBAIXADO de canal/revisão/
  // brancos (`rebaixarFluxo`, interrupção no meio do envio) ou ficou sem
  // resposta do preflight (`verificar`, abaixo) continua só com send/list;
  // exigir create aqui travava esse usuário pra sempre, sem conseguir nem
  // retomar o próprio envio.
  if (etapa === "verificar") return "captacao.list";
  // v2/PR7: a oferta ao corretor pede autorização; a fila do gerente lista/decide.
  if (etapa === "autorizacao_oferta") return "captacao.autorizacao.pedir";
  if (etapa === "autorizacao_fila" || etapa === "autorizacao_motivo" || etapa === "autorizacao_confirmar") return "captacao.autorizacao.decidir";
  return "captacao.create";
}

export async function conduzirCaptacao(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, podeEscrever: boolean): Promise<PassoDoFluxo> {
  const t = normalizar(ctx.texto);
  // `autorizacao_motivo` (achado de review 19/10, item 5): o texto inteiro É o motivo da
  // negativa — pode conter "cancela"/"desisto"/"não quero mais"/"captação" NO MEIO de uma
  // frase legítima ("o cliente desistiu, não quero mais correr esse risco"). Nem este
  // intercepto global de cancelamento nem o de `pedeCaptacao` (abaixo) podem roubar essa
  // mensagem — só o `CANCELA_MOTIVO` exato, dentro de `conduzirAutorizacaoMotivo`, cancela ali.
  if (f.etapa !== "autorizacao_motivo" && (CANCELA.test(t) || /\b(cancela a captacao|desisto|nao quero mais)\b/.test(t))) {
    return cancelar(f);
  }

  const ETAPAS_DA_FILA = new Set(["autorizacao_fila", "autorizacao_motivo", "autorizacao_confirmar"]);
  const capNecessaria = capacidadeDaEtapa(f.etapa);
  // Achado 21: quem só tem `captacao.send` consegue terminar o ENVIO de um rascunho
  // já existente; completar dado que falta exige `captacao.create` — e, faltando
  // só essa, a mensagem é clara (não "captação não liberada", que ela TEM).
  if (
    podeEscrever && !ctx.politicaIndisponivel && capNecessaria === "captacao.create" &&
    !ctx.policy.includes("captacao.create") && ctx.policy.includes("captacao.send") && f.captacaoId
  ) {
    return resposta(null, `Você pode enviar esta captação, mas completar o que falta exige outra permissão. Peça a alguém com acesso, ou complete pela tela: ${linkDe(f.captacaoId)}`, "captacao_sem_permissao_de_completar");
  }
  const barrado = gatePolitica(ctx, podeEscrever, capNecessaria);
  if (barrado) return { ...barrado, fluxo: ctx.politicaIndisponivel ? { ...f, atualizadoEm: ctx.agora } : null };
  // Flag desligada no meio da fila (achado defensivo: o kill-switch de `graph.ts` já cobre a
  // maioria dos casos, mas uma checagem aqui também não deixa a fila seguir sem a flag).
  if (ETAPAS_DA_FILA.has(f.etapa) && !captacaoAutorizacaoLigada()) {
    return { reply: textoAutorizacaoDesligada(), fluxo: null, evento: "captacao_autorizacao_fila_desligada_no_fluxo" };
  }

  // Consulta no meio do fluxo: resposta fixa, e o fluxo continua. (Não em `autorizacao_motivo`:
  // o texto é o motivo, nunca um pedido de listagem — ver comentário acima, item 5.)
  const outro = f.etapa === "autorizacao_motivo" ? null : pedeCaptacao(ctx.texto);
  if (outro === "listar" && f.etapa !== "enviando") {
    const r = await responderListaDeCaptacao(ctx, deps, podeEscrever);
    const gg = g(f, ctx);
    return resposta(gg, `${r.reply}\n\n${continuacaoCaptacao(gg)}`, `${r.evento}_no_fluxo`);
  }

  // Checkpoint de antes da confirmação única: um "não" à confirmação antiga
  // (criar/gravar) para sem gravar nada — o que estava no cofre não vai.
  if ((f.etapa === "confirmar_criacao" || f.etapa === "confirmar_pessoas" || f.etapa === "confirmar_faltantes") && lerConfirmacao(ctx.texto) === "nao") {
    return cancelar(f);
  }
  // Checkpoint antigo com dados ainda no cofre: grava primeiro (chave própria
  // `:legado`) e só então segue a etapa — o fluxo novo nunca escreve no cofre.
  if (f.cofre) {
    const d = await drenarCofreLegado(f, ctx, deps);
    if (!d.ok) return d.r;
    f = d.f;
  }

  switch (f.etapa) {
    case "natureza": return conduzirNatureza(f, t, ctx, deps);
    case "nome": return conduzirNome(f, ctx, deps);
    case "modelo": return conduzirModelo(f, t, ctx, deps);
    case "imovel": return conduzirImovel(f, t, ctx, deps);
    case "condicoes": return conduzirCondicoes(f, t, ctx, deps);
    case "exclusividade": return conduzirExclusividade(f, t, ctx, deps);
    case "proprietarios": return conduzirProprietarios(f, t, ctx, deps);
    case "estado_civil": return conduzirEstadoCivil(f, t, ctx, deps);
    case "extras": return conduzirExtras(f, t, ctx, deps);
    case "verificar": return conduzirVerificar(f, t, ctx, deps);
    case "faltantes": return conduzirFaltantes(f, t, ctx, deps);
    case "selecao": return conduzirSelecao(f, t, ctx, deps);
    case "revisao": return conduzirRevisao(f, ctx, deps);
    case "enviando": return conferirEnvio(f, ctx, deps);
    case "confirmar_criacao": case "confirmar_pessoas": case "confirmar_faltantes": case "canal": case "brancos":
      return conduzirEtapaLegada(f, t, ctx, deps);
    case "autorizacao_oferta": return conduzirAutorizacaoOferta(f, t, ctx, deps);
    case "autorizacao_fila": return conduzirAutorizacaoFila(f, t, ctx, deps);
    case "autorizacao_motivo": return conduzirAutorizacaoMotivo(f, ctx);
    case "autorizacao_confirmar": return conduzirAutorizacaoConfirmar(f, ctx, deps);
  }
}

// ── natureza, nome, modelo ──

async function conduzirNatureza(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const tipo = tipoDito(ctx.texto) ?? (f.tipo && /^(sim|isso|ok|tenta|de novo|novamente)$/.test(t) ? f.tipo : null);
  if (!tipo) {
    if (PERGUNTA_FORA.test(t)) return pausar(f);
    return falhou(f, "Não entendi.", ctx);
  }
  return depoisDaNatureza(g(f, ctx, { tipo, tentativas: 0 }), ctx, deps, "");
}

async function conduzirNome(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const nome = ctx.texto.trim().replace(/[.!]+$/, "");
  if (PERGUNTA_FORA.test(normalizar(ctx.texto))) return pausar(f);
  if (nome.length < 2 || nome.length > 120 || nome.includes("\n")) return falhou(f, "O nome precisa ter até 120 caracteres.", ctx);
  return aproveitarPedidoOriginal(g(f, ctx, { nome, tentativas: 0 }), ctx, deps, `Certo, "${nome}". `);
}

async function conduzirModelo(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const n = /^(?:opcao\s*|numero\s*|n\s*)?(\d{1,2})$/.exec(t);
  const m = n ? f.modelos?.[Number(n[1]) - 1] : undefined;
  if (!m) {
    if (PERGUNTA_FORA.test(t)) return pausar(f);
    return falhou(f, "Responda com o número do modelo.", ctx);
  }
  const g1 = g(f, ctx, { modeloId: m.id, modelos: undefined, tentativas: 0, ...exclusivaDoModelo(m) });
  // 409 `escolher_modelo` no meio da criação: os dados já colhidos seguem e a criação é refeita.
  if (f.criacao) return criar(g1, ctx, deps, f.criacao.dados, `Modelo: ${m.nome}. `);
  return seguirParaNomeOuImovel(g1, ctx, deps, `Modelo: ${m.nome}. `);
}

// ── imóvel e condições → cria o rascunho (sem confirmação intermediária) ──

async function conduzirImovel(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  if (PULAR.test(t)) {
    const dados: DadosDeCaptacao = { ...(f.criacao?.dados ?? {}) };
    if (temCondicoesEm(dados)) return criar(g(f, ctx, { criacao: { chave: "", dados } }), ctx, deps, dados, "Sem imóvel por ora. ");
    return resposta(g(f, ctx, { etapa: "condicoes", tentativas: 0, criacao: { chave: "", dados } }), `Sem imóvel por ora. ${textoDasCondicoes(f.tipo ?? "venda")}`, "captacao_condicoes");
  }
  if (PERGUNTA_FORA.test(t)) return pausar(f);
  const extrair: ExtratorDeSecao = async (texto, secao) => (deps.extrairCaptacao ? deps.extrairCaptacao(texto, secao) : null);
  const r = await lerImovel(ctx.texto, extrair);
  if (r.erro) return falhou(f, r.erro, ctx);
  const dados: DadosDeCaptacao = { ...(f.criacao?.dados ?? {}), imovel: r.dados };
  const eco = `Anotei o imóvel: ${ecoDoImovel(r.dados)}.\n`;
  if (temCondicoesEm(dados)) return criar(g(f, ctx, { criacao: { chave: "", dados } }), ctx, deps, dados, eco);
  return resposta(g(f, ctx, { etapa: "condicoes", tentativas: 0, criacao: { chave: "", dados } }), `${eco}${textoDasCondicoes(f.tipo ?? "venda")}`, "captacao_condicoes");
}

async function conduzirCondicoes(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  // Criação sem resposta (chave guardada): o "sim" REPETE a mesma chave e os mesmos dados — não duplica.
  if (f.criacao?.chave) {
    if (lerConfirmacao(ctx.texto) === "sim") return criar(f, ctx, deps, f.criacao.dados, "");
    if (PERGUNTA_FORA.test(t)) return pausar(f);
    return resposta(g(f, ctx), "Ainda não sei se o rascunho foi criado. Responda *sim* para eu conferir — não duplica — ou CANCELAR.", "captacao_create_aguardando");
  }
  const dados: DadosDeCaptacao = { ...(f.criacao?.dados ?? {}) };
  let eco = "";
  if (!PULAR.test(t)) {
    if (PERGUNTA_FORA.test(t)) return pausar(f);
    const c = lerCondicoes(ctx.texto, f.tipo ?? "venda");
    if (vazioDeCondicoes(c)) return falhou(f, "Não achei valores aí.", ctx);
    if (Object.keys(c.condicoes).length) dados.condicoes = c.condicoes;
    if (Object.keys(c.locacao).length) dados.locacao = c.locacao;
    eco = `Anotei: ${ecoDasCondicoes(c)}.\n`;
  }
  // Confirmação única (26/10): nome + imóvel/condições bastam — cria já, com a messageId desta mensagem como chave.
  return criar(g(f, ctx, { tentativas: 0, criacao: { chave: "", dados } }), ctx, deps, dados, eco);
}

function nomeDaEsteira(f: FluxoCaptacao) { return NOME_DA_ESTEIRA[f.tipo ?? "venda"]; }

/** Soma imóvel/condições/locação gravados ao que o resumo final mostra (sem dado de pessoa). */
function comResumo(f: FluxoCaptacao, dados: DadosDeCaptacao): Partial<FluxoCaptacao> {
  const a = f.dadosDoResumo ?? {};
  const out: NonNullable<FluxoCaptacao["dadosDoResumo"]> = { ...a };
  if (dados.imovel) out.imovel = { ...(a.imovel ?? {}), ...dados.imovel };
  if (dados.condicoes) out.condicoes = { ...(a.condicoes ?? {}), ...dados.condicoes };
  if (dados.locacao) out.locacao = { ...(a.locacao ?? {}), ...dados.locacao };
  return Object.keys(out).length ? { dadosDoResumo: out } : {};
}

/**
 * Exclusividade do modelo, se o servidor disser (`modelo.exclusiva` ou
 * `modeloExclusiva` na resposta do create). Em 26/10 o CM não manda nenhum
 * dos dois — o aviso de conflito fica pronto e só dispara quando mandar.
 */
function exclusivaDoServidor(body: Record<string, unknown>): boolean | undefined {
  const m = obj(body.modelo).exclusiva;
  if (typeof m === "boolean") return m;
  return typeof body.modeloExclusiva === "boolean" ? body.modeloExclusiva : undefined;
}

const comOuSem = (b: boolean) => (b ? "com" : "sem");

/** `captacao.create` (rascunho novo). A chave é a `messageId` desta mensagem e fica guardada até a resposta. */
async function criar(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, dados: DadosDeCaptacao, prefixo: string): Promise<Resposta> {
  const chave = f.criacao?.chave || ctx.messageId;
  const guardado: FluxoCaptacao = g(f, ctx, { etapa: "condicoes", criacao: { chave, dados } });
  const args: Record<string, unknown> = {
    tipo: f.tipo, nome: f.nome, ...(f.modeloId ? { modeloId: f.modeloId } : {}),
    ...(Object.keys(dados).length ? { dados } : {}),
  };
  const r = await deps.acao("captacao.create", args, chave);
  if (!r) {
    return resposta(guardado, `${prefixo}Não consegui confirmar a criação agora e não sei se deu certo. Responda *sim* de novo para conferir — não duplica.`, "captacao_create_incerto");
  }
  if (r.status === 201 || r.status === 200) {
    const c = obj(r.body.captacao);
    const id = str(c.id);
    if (!id) return resposta(guardado, `${prefixo}${TEXTO_SEM_RESPOSTA}`, "captacao_create_sem_id");
    const criado: FluxoCaptacao = g(f, ctx, {
      etapa: "proprietarios", captacaoId: id, codigo: str(c.codigo) ?? undefined, version: typeof c.version === "number" ? c.version : 0,
      versaoGravada: typeof c.version === "number" ? c.version : 0,
      criacao: undefined, proprietarios: [], tentativas: 0, ...comResumo(f, dados),
    });
    const texto = `${prefixo}Criei o rascunho${lembrete(criado)} ("${f.nome}", ${nomeDaEsteira(f)}).`;
    // Item 6: o modelo diz uma exclusividade e a pessoa disse outra — avisa UMA vez e pergunta qual vale.
    const doModelo = exclusivaDoServidor(r.body) ?? f.modeloExclusiva;
    const disse = dados.condicoes?.exclusiva;
    if (typeof doModelo === "boolean" && typeof disse === "boolean" && doModelo !== disse && !f.exclusividadeAvisada) {
      return resposta(
        g(criado, ctx, { etapa: "exclusividade", modeloExclusiva: doModelo, exclusividadeAvisada: true }),
        `${texto}\nAtenção: o modelo escolhido é ${comOuSem(doModelo)} exclusividade, mas você disse ${comOuSem(disse)}. Qual vale? Responda *COM* ou *SEM* exclusividade.`,
        "captacao_exclusividade_conflito"
      );
    }
    return resposta(criado, `${texto} ${TEXTO_PROPRIETARIOS}`, "captacao_criada");
  }
  const erro = str(r.body.error);
  if (r.status === 409 && erro === "escolher_modelo") {
    const modelos = lista(r.body.modelos).flatMap((x): ModeloDeCaptacao[] => {
      const m = obj(x);
      return str(m.id) && str(m.nome) ? [{ id: str(m.id)!, nome: str(m.nome)!, ...(typeof m.exclusiva === "boolean" ? { exclusiva: m.exclusiva } : {}) }] : [];
    });
    if (modelos.length > 1) {
      const linhas = modelos.map((m, i) => `${i + 1}. ${m.nome}`).join("\n");
      return resposta(g(f, ctx, { etapa: "modelo", modelos, criacao: { chave: "", dados } }), `${prefixo}Qual modelo uso?\n${linhas}\n\nResponda com o número.`, "captacao_modelo");
    }
  }
  if (r.status === 409 && erro === "em_andamento") {
    return resposta(guardado, `${prefixo}Estou terminando de criar; responda *sim* em instantes para conferir.`, "captacao_create_em_andamento");
  }
  if (r.status === 422 && erro === "sem_modelo") {
    return resposta(null, `Sua imobiliária não tem um modelo de captação de ${nomeDaEsteira(f)} ativo. Um administrador ativa em Modelos; depois é só me pedir de novo.`, "captacao_sem_modelo");
  }
  if (r.status === 422 && erro === "dados_invalidos") {
    const campos = lista(r.body.campos).filter((x): x is string => typeof x === "string").slice(0, 6).join(", ");
    return resposta(g(f, ctx, { etapa: "imovel", criacao: undefined }), `O sistema não aceitou estes campos${campos ? ` (${campos})` : ""}. Mande o imóvel de novo, conferindo os dados.`, "captacao_dados_invalidos");
  }
  if (r.status === 403) { const n = textoDeNegado(r); return resposta(null, n.reply, n.evento); }
  return resposta(null, `${prefixo}O sistema não aceitou criar a captação agora. Nada foi criado.`, `captacao_create_${r.status}`);
}

/**
 * Item 6: conflito de exclusividade, avisado uma vez. Escolher o valor do
 * MODELO grava `condicoes.exclusiva` (o complemento); manter o que a pessoa
 * disse não muda nada aqui — o texto do contrato vem do modelo, então avisa
 * que troca de modelo é na tela.
 */
async function conduzirExclusividade(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const sem = /\bsem\b/.test(t);
  const com = !sem && /\b(com|exclusiv\w*)\b/.test(t);
  if (!sem && !com) {
    if (PERGUNTA_FORA.test(t)) return pausar(f);
    return falhou(f, "Responda COM ou SEM exclusividade.", ctx);
  }
  const escolha = com;
  const disse = f.dadosDoResumo?.condicoes?.exclusiva;
  const doModelo = f.modeloExclusiva;
  if (escolha === disse) {
    const aviso = typeof doModelo === "boolean" && doModelo !== escolha
      ? ` O texto do modelo é ${comOuSem(doModelo)} exclusividade; para o contrato sair ${comOuSem(escolha)}, troque o modelo na tela: ${linkDe(f.captacaoId)}`
      : "";
    return resposta(g(f, ctx, { etapa: "proprietarios", tentativas: 0 }), `Certo, fica ${comOuSem(escolha)} exclusividade.${aviso}\n${TEXTO_PROPRIETARIOS}`, "captacao_exclusividade_mantida");
  }
  const patch: DadosDeCaptacao = { condicoes: { exclusiva: escolha } };
  const r = await complementar(f, ctx, deps, patch);
  if (!r.ok) return r.r;
  return resposta(
    g(r.f, ctx, { etapa: "proprietarios", tentativas: 0, ...comResumo(f, patch) }),
    `${r.prefixo}Certo: ${comOuSem(escolha)} exclusividade, como no modelo. ${TEXTO_PROPRIETARIOS}`,
    "captacao_exclusividade_do_modelo"
  );
}
// ── complemento (proprietários, extras, faltantes) ──

type ResultadoComplemento =
  | { ok: true; f: FluxoCaptacao; prefixo: string }
  | { ok: false; r: Resposta }
  /**
   * Item 1 (revisão opus, round 3): só aparece quando `opcoes.semRetentativaDeVersao`
   * é passado. Quem chama assim está prestes a mandar algo que o usuário NUNCA
   * viu (o canal escolhido, aplicado só na hora do "enviar") — então a versão
   * desatualizada não pode ser corrigida sozinha e reenviada por baixo do pano;
   * o chamador tem que voltar pro resumo, não pro `r.r` genérico.
   */
  | { ok: false; versaoDesatualizada: true };

/**
 * `captacao.create{captacaoId, version, dados}`. Versão desatualizada: por
 * padrão, o Max diz que alguém mexeu na tela, confere de novo (preflight) e
 * refaz UMA vez com a versão nova — o merge do servidor nunca apaga o que a
 * tela digitou. Com `opcoes.semRetentativaDeVersao`, NÃO refaz sozinho: um
 * 409 vira `{ok:false, versaoDesatualizada:true}` pro chamador decidir (hoje,
 * só `confirmarEEnviar` usa isso — aplicar o canal escolhido não pode virar
 * um reenvio silencioso de conteúdo que o resumo mostrado nunca refletiu).
 *
 * Duas assinaturas (achado nit, revisão opus round 3): sem `opcoes`, o
 * retorno NUNCA inclui `versaoDesatualizada` — os chamadores antigos
 * (`if (!r.ok) return r.r`) continuam type-checando sem precisar saber da
 * variante nova, que só existe para quem pede `semRetentativaDeVersao: true`.
 */
function complementar(
  f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, dados: DadosDeCaptacao,
  chaveBase?: string,
): Promise<{ ok: true; f: FluxoCaptacao; prefixo: string } | { ok: false; r: Resposta }>;
function complementar(
  f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, dados: DadosDeCaptacao,
  chaveBase: string, opcoes: { semRetentativaDeVersao: true },
): Promise<ResultadoComplemento>;
async function complementar(
  f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, dados: DadosDeCaptacao,
  /** Base da chave de idempotência; por padrão a `messageId` desta mensagem.
   *  Um chamador com retry ENTRE turnos (ex.: o esvaziamento do cofre de um
   *  checkpoint antigo, `${messageId}:legado`) passa uma chave própria —
   *  senão uma resposta incerta seguida de outra mensagem gera DUAS chaves e
   *  um possível lote em dobro. */
  chaveBase: string = ctx.messageId,
  opcoes: { semRetentativaDeVersao?: boolean } = {},
): Promise<ResultadoComplemento> {
  let atual = f;
  let prefixo = "";
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const r = await deps.acao("captacao.create", { captacaoId: atual.captacaoId, version: atual.version, dados }, `${chaveBase}${tentativa ? ":r" : ""}`);
    if (!r) return { ok: false, r: resposta(g(f, ctx), `${TEXTO_SEM_RESPOSTA} Mande de novo em instantes.`, "captacao_complemento_sem_resposta") };
    if (r.status === 200 || r.status === 201) {
      const v = obj(r.body.captacao).version;
      const gravada = typeof v === "number" ? v : (atual.version ?? 0) + 1;
      return { ok: true, f: g(atual, ctx, { version: gravada, versaoGravada: gravada, ...(prefixo ? { telaMudou: true } : {}) }), prefixo };
    }
    const erro = str(r.body.error);
    if (r.status === 409 && erro === "versao_desatualizada" && opcoes.semRetentativaDeVersao) {
      return { ok: false, versaoDesatualizada: true };
    }
    if (r.status === 409 && erro === "versao_desatualizada" && tentativa === 0) {
      const pf = await deps.acao("captacao.preflight", { captacaoId: atual.captacaoId });
      const lido = pf?.status === 200 ? lerPreflight(pf.body) : null;
      const nova = pf?.status === 200 && typeof pf.body.version === "number" ? pf.body.version : lido?.version ?? null;
      if (nova === null) return { ok: false, r: resposta(g(f, ctx), `${textoDoCodigoDeEnvio("versao_desatualizada", { link: "" })} Mande de novo em instantes.`, "captacao_versao_sem_conferencia") };
      atual = g(atual, ctx, { version: nova });
      prefixo = `${textoDoCodigoDeEnvio("versao_desatualizada", { link: "" })}\n`;
      continue;
    }
    if (r.status === 409 && erro === "nao_e_rascunho") {
      return { ok: false, r: resposta(null, `Esta captação não é mais um rascunho (já foi enviada ou arquivada), então não altero por aqui: ${linkDe(f.captacaoId)}`, "captacao_nao_e_rascunho") };
    }
    if (r.status === 409 && erro === "versao_desatualizada") {
      return { ok: false, r: resposta(g(f, ctx), "Alguém mexeu na captação de novo. Mande o dado outra vez, por favor.", "captacao_versao_de_novo") };
    }
    if (r.status === 422 && erro === "dados_invalidos") {
      // Contrato do CM (26/10): o rascunho mesclado não passou no schema (ex.: mais de 4
      // testemunhas). NADA foi gravado. Sem retentativa — a etapa fica aberta para a correção.
      const camposLidos = lista(r.body.campos).filter((x): x is string => typeof x === "string");
      const campos = camposLidos.slice(0, 6).join(", ");
      const falaDeTestemunha = camposLidos.some((c) => /testemunha/i.test(c)) || /testemunha/i.test(str(r.body.message) ?? "");
      const mandouTestemunha = lista(obj(dados.assinantes).testemunhas).length > 0;
      const link = linkDe(f.captacaoId);
      const texto = falaDeTestemunha
        ? `Não gravei: a captação aceita no máximo 4 testemunhas. Para trocar alguma, ajuste pela tela: ${link}`
        : mandouTestemunha
          ? `Não gravei esta testemunha: o rascunho não aceitou (a captação aceita no máximo 4 testemunhas). Confira na tela: ${link}`
          : `Não gravei: algo não coube no rascunho${campos ? ` (${campos})` : ""}. Confira e mande de novo, ou corrija pela tela: ${link}`;
      const segue = continuacaoCaptacao(f).replace(/^Continuando a captação[^:]*: /, "");
      return { ok: false, r: resposta(g(f, ctx), `${texto}\n${segue}`, falaDeTestemunha || mandouTestemunha ? "captacao_complemento_testemunhas" : "captacao_complemento_invalido") };
    }
    if (r.status === 404) return { ok: false, r: resposta(null, `Não achei mais essa captação. Veja na tela: ${linkDe()}`, "captacao_complemento_404") };
    if (r.status === 403) { const n = textoDeNegado(r); return { ok: false, r: resposta(null, n.reply, n.evento) }; }
    return { ok: false, r: resposta(g(f, ctx), `O sistema não aceitou esse dado agora. Tente de novo.`, `captacao_complemento_${r.status}`) };
  }
  return { ok: false, r: resposta(g(f, ctx), "Não consegui gravar agora. Mande de novo em instantes.", "captacao_complemento_falhou") };
}

/** "nome:"/"proprietário:" explícito, ou documento — senão não é declaração de pessoa (achado 18). */
const ROTULO_DE_PESSOA = /\b(propriet[aá]ri[oa]s?|don[oa]s?|nome)\s*[:\-–]/i;
function pareceProprietario(texto: string, p: PessoaLida): boolean {
  return !!(p.cpf || p.cnpj || ROTULO_DE_PESSOA.test(texto));
}

// ─── Cofre LEGADO (checkpoint de antes da confirmação única) ─────────────
//
// Até 26/10, proprietário/extra/faltante só era gravado depois de um "sim"
// intermediário e, até lá, o CPF/e-mail/telefone ficava aqui, cifrado. O
// fluxo novo grava cada dado no turno em que chega e NUNCA escreve no cofre;
// este código só abre (e grava, via `drenarCofreLegado`) o que um checkpoint
// antigo deixou. Mesmo desenho do cofre do crédito, com subchave e AAD
// próprios: um cofre não abre o do outro fluxo.
interface PendentesDeCaptacao {
  proprietarios: Record<string, unknown>[];
  testemunhas: Record<string, unknown>[];
  avulsos: Record<string, unknown>[];
  /**
   * Item B (revisão opus, round 2): respostas de `faltantes` (CPF, telefone,
   * matrícula…) ainda não gravadas. Mesma regra do resto do cofre — só vão ao
   * servidor depois do "sim" de `confirmar_faltantes`, nunca no mesmo turno
   * em que a pessoa respondeu.
   */
  faltantes?: DadosDeCaptacao;
}
const PENDENTES_VAZIOS: PendentesDeCaptacao = { proprietarios: [], testemunhas: [], avulsos: [] };

/**
 * Mescla dois patches de `DadosDeCaptacao` (item B): acumula várias respostas
 * de faltante no cofre antes do "sim" que grava tudo junto. Proprietário
 * mescla por `id` — nunca manda dois objetos do mesmo id na mesma chamada
 * (o merge por id do servidor é só pra patches de CHAMADAS diferentes).
 */
function mesclarDadosDeCaptacao(a: DadosDeCaptacao, b: DadosDeCaptacao): DadosDeCaptacao {
  const out: DadosDeCaptacao = { ...a };
  if (b.imovel) out.imovel = { ...(out.imovel ?? {}), ...b.imovel };
  if (b.condicoes) out.condicoes = { ...(out.condicoes ?? {}), ...b.condicoes };
  if (b.locacao) out.locacao = { ...(out.locacao ?? {}), ...b.locacao };
  if (b.assinantes) out.assinantes = { ...(out.assinantes ?? {}), ...b.assinantes };
  if (b.proprietarios) {
    const merged = [...(out.proprietarios ?? [])];
    for (const p of b.proprietarios) {
      const i = merged.findIndex((x) => x.id === p.id);
      if (i >= 0) merged[i] = { ...merged[i], ...p };
      else merged.push(p);
    }
    out.proprietarios = merged;
  }
  return out;
}
/** GCM padrão: 16 bytes — explícito (achado da revisão opus) pra `setAuthTag`
 *  nunca aceitar uma tag truncada/alongada por adulteração do payload. */
const TAMANHO_DA_TAG = 16;

function chaveDoCofreCaptacao(): Buffer {
  const raw = process.env.MAX_ENCRYPTION_KEY;
  if (!raw) throw new Error("MAX_ENCRYPTION_KEY não configurada");
  const mestra = Buffer.from(raw, "base64");
  if (mestra.length !== 32) throw new Error("MAX_ENCRYPTION_KEY deve ser 32 bytes em base64");
  return Buffer.from(hkdfSync("sha256", mestra, Buffer.alloc(0), "max-captacao-cofre", 32));
}
/** Exportado só para teste direto (roundtrip/adulteração/chave ausente). */
export function cifrarCofreCaptacao(texto: string, thread: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chaveDoCofreCaptacao(), iv, { authTagLength: TAMANHO_DA_TAG });
  c.setAAD(Buffer.from(thread, "utf8"));
  const enc = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
export function decifrarCofreCaptacao(payload: string, thread: string): string {
  const [iv, tag, dado] = payload.split(".");
  if (!iv || !tag || !dado) throw new Error("cofre malformado");
  const tagBuf = Buffer.from(tag, "base64");
  // Achado (nit da revisão opus): valida o tamanho da tag ANTES de abrir —
  // uma tag curta/longa (payload truncado ou remendado) tem que falhar aqui,
  // nunca ser aceita por engano por `setAuthTag`.
  if (tagBuf.length !== TAMANHO_DA_TAG) throw new Error("cofre malformado: tag de autenticação com tamanho inválido");
  const d = createDecipheriv("aes-256-gcm", chaveDoCofreCaptacao(), Buffer.from(iv, "base64"), { authTagLength: TAMANHO_DA_TAG });
  d.setAAD(Buffer.from(thread, "utf8"));
  d.setAuthTag(tagBuf);
  return Buffer.concat([d.update(Buffer.from(dado, "base64")), d.final()]).toString("utf8");
}
const threadDaCaptacao = (ctx: ContextoDoTurno) => ctx.thread ?? "sem-thread";

/**
 * `{ok:true}` com os pendentes (vazios quando não há cofre ainda), ou
 * `{ok:false}` quando HAVIA cofre e não abriu — chave ausente/rotacionada,
 * thread trocada, payload adulterado. Achado 5 (revisão opus): a versão
 * antiga devolvia vazio nos dois casos, e aquele segundo caso é PERDA DE
 * DADO silenciosa (o resumo antigo seguia mostrando a Maria como pendente com o cofre
 * já ilegível) — nunca lança (chave ausente lançava sem try/catch no
 * chamador) e nunca finge que não havia nada pendente.
 */
type AberturaDoCofreCaptacao = { ok: true; pendentes: PendentesDeCaptacao } | { ok: false };
function abrirCofreCaptacao(f: FluxoCaptacao, ctx: ContextoDoTurno): AberturaDoCofreCaptacao {
  if (!f.cofre) return { ok: true, pendentes: PENDENTES_VAZIOS };
  try {
    const pendentes = { ...PENDENTES_VAZIOS, ...(JSON.parse(decifrarCofreCaptacao(f.cofre, threadDaCaptacao(ctx))) as Partial<PendentesDeCaptacao>) };
    return { ok: true, pendentes };
  } catch {
    return { ok: false };
  }
}
/** `null` quando a chave falta/é inválida (nunca lança) — mesmo motivo do `abrirCofreCaptacao`. */
function fecharCofreCaptacao(p: PendentesDeCaptacao, ctx: ContextoDoTurno): string | null {
  try {
    return cifrarCofreCaptacao(JSON.stringify(p), threadDaCaptacao(ctx));
  } catch {
    return null;
  }
}
/** Resposta fixa pra qualquer falha do cofre (abrir OU fechar): nunca escreve, sempre avisa. */
function cofrePerdido(f: FluxoCaptacao): Resposta {
  const msg = "Não consegui ler os dados ainda não gravados desta captação (proprietário/testemunha mandados nesta conversa). Nada foi perdido do que já está salvo; mande essas pessoas de novo, por favor.";
  return f.captacaoId
    ? resposta(null, `${msg} O que já está salvo continua na tela: ${linkDe(f.captacaoId)}`, "captacao_cofre_perdido")
    : resposta(null, msg, "captacao_cofre_perdido");
}

/** Checkpoint antigo: grava o que ficou no cofre (chave `<messageId>:legado`) e limpa. */
async function drenarCofreLegado(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<{ ok: true; f: FluxoCaptacao } | { ok: false; r: Resposta }> {
  const abertura = abrirCofreCaptacao(f, ctx);
  if (!abertura.ok) return { ok: false, r: cofrePerdido(f) };
  const p = abertura.pendentes;
  let dados: DadosDeCaptacao = p.faltantes ?? {};
  if (p.proprietarios.length) dados = mesclarDadosDeCaptacao(dados, { proprietarios: p.proprietarios });
  if (p.testemunhas.length || p.avulsos.length) {
    dados = {
      ...dados,
      assinantes: {
        ...(dados.assinantes ?? {}),
        ...(p.testemunhas.length ? { testemunhas: p.testemunhas } : {}),
        ...(p.avulsos.length ? { avulsos: p.avulsos } : {}),
      },
    };
  }
  const extras = [...(f.extras ?? []), ...(f.extrasPendentes ?? [])];
  const limpo = (base: FluxoCaptacao) => g(base, ctx, { cofre: undefined, extrasPendentes: undefined, ...(extras.length ? { extras } : {}) });
  if (!Object.keys(dados).length || !f.captacaoId) return { ok: true, f: limpo(f) };
  const r = await complementar(f, ctx, deps, dados, `${ctx.messageId}:legado`);
  if (!r.ok) return r;
  return { ok: true, f: limpo(r.f) };
}

/** Etapas legadas (checkpoint antigo): viram a etapa nova no primeiro turno, sem pedir outro "sim". */
async function conduzirEtapaLegada(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  switch (f.etapa) {
    case "confirmar_criacao":
      // Checkpoint antigo parado no "Posso criar?": só cria com uma resposta que não é outro assunto.
      if (PERGUNTA_FORA.test(t)) return pausar(f);
      return criar(f, ctx, deps, f.criacao?.dados ?? {}, "");
    case "canal": {
      const POR_NUMERO: Record<string, CanalDeEnvio> = { "1": "email", "2": "whatsapp", "3": "aceite" };
      const n = /^(?:opcao\s*|numero\s*|n\s*)?([123])$/.exec(t);
      const canal = (n ? POR_NUMERO[n[1]!] : undefined) ?? canalDoTexto(ctx.texto);
      return verificar(g(f, ctx, { etapa: "verificar", tentativas: 0, ...(canal ? { canalDito: canal } : {}) }), ctx, deps, "");
    }
    case "brancos":
      return conduzirRevisao(g(f, ctx, { etapa: "revisao" }), ctx, deps);
    default:
      return verificar(g(f, ctx, { etapa: "verificar", tentativas: 0 }), ctx, deps, "");
  }
}

const TEXTO_EXTRAS =
  "Tem testemunha ou outra pessoa para assinar? Mande nome e e-mail/telefone (uma por mensagem, e diga \"testemunha\" se for o caso), ou diga NÃO.";
const TEXTO_PROXIMO_PROPRIETARIO = "Mande o próximo proprietário, ou FIM.";

function seguirParaExtras(f: FluxoCaptacao, ctx: ContextoDoTurno, prefixo: string): Resposta {
  return resposta(g(f, ctx, { etapa: "extras", tentativas: 0, estadoCivilDe: undefined }), `${prefixo}${TEXTO_EXTRAS}`, "captacao_extras");
}

/**
 * Confirmação única (26/10): cada proprietário é GRAVADO no turno em que
 * chega (`captacao.create{captacaoId, version}`, chave = messageId) — nada
 * de PII no checkpoint (só id e nome), nada de "sim" intermediário. PF sem
 * estado civil: pergunta uma vez (PULAR aceito).
 */
async function conduzirProprietarios(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const donos = f.proprietarios ?? [];
  if (FIM.test(t)) {
    if (!donos.length) return resposta(g(f, ctx), `Preciso de pelo menos um proprietário. ${TEXTO_PROPRIETARIOS}`, "captacao_sem_proprietario");
    return seguirParaExtras(f, ctx, "");
  }
  // Achado 6 (revisão opus): o teste de "pergunta fora do assunto" olha só a
  // pontuação ("?" no fim) — "Maria, CPF 111.444.777-35, casada?" bate nisso
  // ANTES de qualquer leitura, e `pausar` manda o texto CRU (com o CPF) pro
  // atendimento normal, que não redige nada do fluxo de captação. Um sinal
  // barato (regex, sem LLM) de documento/rótulo de proprietário destrava o
  // "?" antes de pausar — só então lê a pessoa de verdade.
  if (PERGUNTA_FORA.test(t)) {
    const n = lerNumeros(ctx.texto);
    if (!n.cpfs.length && !n.cnpjs.length && !ROTULO_DE_PESSOA.test(ctx.texto)) return pausar(f);
  }
  if (donos.length >= 20) return resposta(g(f, ctx), "Chegamos ao limite de 20 proprietários. Diga FIM para seguir.", "captacao_limite_proprietarios");
  const extrair: ExtratorDeSecao = async (texto, secao) => (deps.extrairCaptacao ? deps.extrairCaptacao(texto, secao) : null);
  const p = await lerPessoa(ctx.texto, extrair);
  if (p.erro) return falhou(f, p.erro, ctx);
  if (!pareceProprietario(ctx.texto, p)) {
    return falhou(f, "Preciso do CPF (ou CNPJ) do proprietário, ou escreva \"proprietário: nome\".", ctx);
  }
  const canalDito = canalDoTexto(ctx.texto) ?? f.canalDito;
  const id = `p${donos.length + 1}`;
  const item: Record<string, unknown> = {
    id, papel: "proprietario", tipo_pessoa: p.pj ? "juridica" : "fisica",
    ...(p.pj ? { razao_social: p.nome, cnpj: p.cnpj } : { nome: p.nome, cpf: p.cpf }),
    ...(p.email ? { email: p.email } : {}), ...(p.telefone ? { telefone1: normalizeBrPhone(p.telefone) ?? p.telefone } : {}),
    ...(p.estadoCivil ? { estado_civil: p.estadoCivil } : {}), ...(p.percentual !== undefined ? { percentual: p.percentual } : {}),
    ...(canalDito ? { canal: canalDito } : {}),
  };
  const r = await complementar(f, ctx, deps, { proprietarios: [item] });
  if (!r.ok) return r.r;
  // `canalAplicado`: o canal que TODOS os proprietários já têm gravado. Um
  // dono gravado sem canal (ou com outro) obriga o envio a regravar o canal.
  const canalAplicado = canalDito && (donos.length === 0 || f.canalAplicado === canalDito) ? canalDito : undefined;
  const novo = g(r.f, ctx, {
    proprietarios: [...donos, { id, nome: p.nome!, ...(p.pj ? { pj: true } : {}) }],
    ...(canalDito ? { canalDito } : {}),
    canalAplicado,
    tentativas: 0,
  });
  const guardou = [p.cpf ? "CPF" : p.cnpj ? "CNPJ" : "", p.telefone ? "telefone" : "", p.email ? "e-mail" : "", p.estadoCivil ? "estado civil" : ""].filter(Boolean);
  const anotei = `${r.prefixo}Anotei ${p.nome}${guardou.length ? ` (${guardou.join(", ")})` : ""}.`;
  if (!p.pj && !p.estadoCivil) {
    return resposta(g(novo, ctx, { etapa: "estado_civil", estadoCivilDe: id }), `${anotei} ${perguntaDoEstadoCivil(p.nome)}`, "captacao_estado_civil");
  }
  return resposta(novo, `${anotei} ${TEXTO_PROXIMO_PROPRIETARIO}`, "captacao_proprietario");
}

/** Item 7: o estado civil do PF que veio sem ele — perguntado UMA vez; PULAR deixa para a tela. */
async function conduzirEstadoCivil(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const id = f.estadoCivilDe;
  const dono = id ? f.proprietarios?.find((p) => p.id === id) : undefined;
  if (!id || !dono) return resposta(g(f, ctx, { etapa: "proprietarios", estadoCivilDe: undefined }), TEXTO_PROXIMO_PROPRIETARIO, "captacao_proprietario");
  const pulado: Partial<FluxoCaptacao> = { estadoCivilDe: undefined, estadoCivilPulado: [...(f.estadoCivilPulado ?? []).filter((x) => x !== id), id] };
  if (FIM.test(t) && t !== "nao" && t !== "n") return seguirParaExtras(g(f, ctx, pulado), ctx, `Certo, o estado civil de ${dono.nome} fica para a tela. `);
  if (PULAR.test(t) || t === "nao" || t === "n") {
    return resposta(g(f, ctx, { etapa: "proprietarios", tentativas: 0, ...pulado }), `Certo, o estado civil de ${dono.nome} fica para a tela. ${TEXTO_PROXIMO_PROPRIETARIO}`, "captacao_estado_civil_pulado");
  }
  // Já é o próximo proprietário (documento ou "proprietário:"): o estado civil deste fica para a tela.
  const n = lerNumeros(ctx.texto);
  if (n.cpfs.length || n.cnpjs.length || ROTULO_DE_PESSOA.test(ctx.texto)) {
    return conduzirProprietarios(g(f, ctx, { etapa: "proprietarios", ...pulado }), t, ctx, deps);
  }
  const c = ESTADO_CIVIL.exec(t)?.[1];
  if (!c) {
    if (PERGUNTA_FORA.test(t)) return pausar(f);
    return falhou(f, "Não entendi.", ctx);
  }
  const r = await complementar(f, ctx, deps, { proprietarios: [{ id, papel: "proprietario", tipo_pessoa: "fisica", estado_civil: c }] });
  if (!r.ok) return r.r;
  return resposta(g(r.f, ctx, { etapa: "proprietarios", estadoCivilDe: undefined, tentativas: 0 }), `${r.prefixo}Anotei: ${dono.nome}, ${c}. ${TEXTO_PROXIMO_PROPRIETARIO}`, "captacao_estado_civil_gravado");
}

/** Testemunhas e outros assinantes: gravados no turno em que chegam (chave = messageId). */
async function conduzirExtras(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  if (FIM.test(t) || PULAR.test(t)) return verificar(g(f, ctx, { etapa: "verificar", tentativas: 0 }), ctx, deps, "");
  // Achado 6 (mesmo caso do proprietário): "Carlos, carlos@ex.com, ele confirma?"
  // termina em "?" — um sinal barato de contato destrava antes de pausar (sem
  // ele, o e-mail/telefone ia cru pro atendimento normal).
  if (PERGUNTA_FORA.test(t)) {
    const semContato = !lerNumeros(ctx.texto).telefones.length && !lerEmails(ctx.texto).length;
    if (semContato) return pausar(f);
  }
  const extrair: ExtratorDeSecao = async (texto, secao) => (deps.extrairCaptacao ? deps.extrairCaptacao(texto, secao) : null);
  // "testemunha Carlos Pereira, ..." — o papel não é parte do nome (ia pro resumo como "testemunha Carlos").
  const semPapel = ctx.texto.replace(/^\s*(?:a\s+|o\s+)?testemunha\s*(?:[:,\-–]\s*|(?:é|e)\s+)?/i, "");
  const p = await lerPessoa(semPapel, extrair);
  if (p.erro) return falhou(f, p.erro, ctx);
  if (!p.email && !p.telefone) return falhou(f, "Preciso do e-mail ou do telefone dessa pessoa.", ctx);
  // "não é testemunha" / "nem testemunha" não é testemunha.
  const testemunha = /\btestemunha\b/.test(t) && !/\b(?:nao|nem)\s+(?:(?:e|eh|sera|vai ser|como)\s+)?(?:(?:a|o|um|uma)\s+)?testemunha\b/.test(t);
  // Id determinístico (como o do proprietário): uma reenvio depois de uma escrita sem resposta
  // não avança o estado, cai no MESMO id e o servidor mescla por id — nunca duplica a pessoa.
  const id = `x${(f.extras?.length ?? 0) + 1}`;
  const pessoa = {
    id, nome: p.nome, ...(p.cpf ? { cpf: p.cpf } : {}), ...(p.email ? { email: p.email } : {}),
    ...(p.telefone ? { telefone: normalizeBrPhone(p.telefone) ?? p.telefone } : {}),
  };
  const r = await complementar(f, ctx, deps, { assinantes: { [testemunha ? "testemunhas" : "avulsos"]: [pessoa] } });
  if (!r.ok) return r.r;
  const novo = g(r.f, ctx, { extras: [...(f.extras ?? []), { id, nome: p.nome!, testemunha }], tentativas: 0 });
  return resposta(novo, `${r.prefixo}Anotei ${p.nome} como ${testemunha ? "testemunha" : "assinante"}. Mais alguém? Mande a próxima pessoa, ou diga NÃO.`, "captacao_extra");
}

// ── conferência (preflight), faltantes e resumo ──

/** Etapa `verificar` com pendências só-da-tela já ditas: só "pronto"/"sim" confere de novo; o resto vai pro atendimento. */
async function conduzirVerificar(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  if (f.pendenciasDitas && !(QUER_CONFERIR.test(t) || lerConfirmacao(ctx.texto) === "sim" || confirmaEnvio(ctx.texto))) return pausar(f);
  return verificar(f, ctx, deps, "");
}

/**
 * `captacao.preflight`: pergunta só os `faltantes` que o Max sabe preencher;
 * o que só a tela resolve é dito UMA vez (com o link, sem pedir "sim"); sem
 * pendências, o resumo final.
 */
async function verificar(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, prefixo: string): Promise<Resposta> {
  const r = await deps.acao("captacao.preflight", { captacaoId: f.captacaoId });
  if (!r) return resposta(g(f, ctx, { etapa: "verificar" }), `${prefixo}${TEXTO_SEM_RESPOSTA} Responda *sim* para eu conferir de novo.`, "captacao_preflight_sem_resposta");
  if (r.status === 409) {
    const estado = str(r.body.estado);
    return resposta(null, `${prefixo}Esta captação não está mais em rascunho${estado ? ` (${estado})` : ""}. Veja na tela: ${linkDe(f.captacaoId)}`, "captacao_preflight_nao_e_rascunho");
  }
  if (r.status === 404) return resposta(null, `Não achei essa captação. Veja na tela: ${linkDe()}`, "captacao_preflight_404");
  if (r.status === 403) { const n = textoDeNegado(r); return resposta(null, n.reply, n.evento); }
  const pf = lerPreflight(r.body);
  if (r.status !== 200 || !pf) return resposta(null, TEXTO_SEM_RESPOSTA, `captacao_preflight_${r.status}`);
  const version = typeof r.body.version === "number" ? r.body.version : f.version;
  const nomes = Object.fromEntries((f.proprietarios ?? []).map((p) => [p.id, p.nome]));
  const base = g(f, ctx, { version, tentativas: 0 });

  // Só pergunta o que o Max sabe preencher; o resto (campo personalizado, lista fechada…) é da tela.
  // Estado civil que a pessoa já disse PULAR não é perguntado de novo (vira pendência da tela).
  const pulados = new Set(f.estadoCivilPulado ?? []);
  const perguntavel = (x: FaltanteDeCaptacao) =>
    !!tipoDoFaltante(x) && !(x.path === "proprietarios[].estado_civil" && !!x.proprietarioId && pulados.has(x.proprietarioId));
  const perguntaveis = pf.faltantes.filter(perguntavel);
  const daTela = pf.faltantes.filter((x) => !perguntavel(x));
  if (perguntaveis.length) {
    const cab = `${prefixo}${textoDoPreflight({ pronto: false, faltantes: perguntaveis, bloqueios: [], emBranco: 0 }, nomes)}\n`;
    const fa = perguntaveis[0]!;
    return resposta(g(base, ctx, { etapa: "faltantes", faltantes: perguntaveis }), `${cab}${perguntaDoFaltante(base, fa)}`, "captacao_faltantes");
  }
  // v2/PR7: bloqueio de autorização (dono ou imóvel fora da carteira). Sem a capability
  // `captacao.autorizacao.pedir`, o Max NÃO oferece — cai no aviso genérico de sempre,
  // que já não tem nome nem CPF (`bloqueioEmTexto`). Só impede o ENVIO, nunca o complemento:
  // esta checagem só acontece aqui, na conferência, nunca nas etapas de coleta.
  const bloqAut = bloqueioDeAutorizacao(pf.bloqueios, new Set(f.autorizacaoPedidosFeitos ?? []), new Set(f.autorizacaoPedidosRecusados ?? []));
  if (bloqAut && ctx.policy.includes("captacao.autorizacao.pedir")) {
    const alvo = bloqAut.tipo === "proprietario" ? "Esse proprietário" : "Esse imóvel";
    const texto = bloqAut.negada
      ? `${alvo} teve a autorização negada pelo gerente. Você pode tirar pela tela (${linkDe(f.captacaoId)}) ou pedir de novo. Quer que eu peça de novo? (Pode mandar uma justificativa curta, ou responda *sim*/*não*.)`
      : `${alvo} já está na carteira de outro corretor. Para seguir, seu gerente precisa autorizar. Quer que eu peça a autorização? (Pode mandar uma justificativa curta, ou responda *sim*/*não*.)`;
    return resposta(
      g(base, ctx, { etapa: "autorizacao_oferta", autorizacaoPedido: { tipo: bloqAut.tipo, ref: bloqAut.ref } }),
      `${prefixo}${texto}`,
      "captacao_autorizacao_oferta"
    );
  }
  // Item 4: o que só a tela resolve é dito UMA vez (a marca guarda paths e
  // códigos, nunca valor). Um "pronto" que não resolveu ganha resposta curta
  // e o fluxo termina — sem reimprimir a lista, sem loop.
  if (daTela.length || pf.bloqueios.length) {
    const marca = [
      ...daTela.map((x) => `${x.path}#${x.proprietarioId ?? ""}`),
      ...pf.bloqueios.map((b) => `${b.codigo}#${b.ref ?? ""}`),
    ].sort().join("|");
    const link = linkDe(f.captacaoId);
    if (f.pendenciasDitas === marca) {
      return resposta(null, `${prefixo}Continua pendente o que te disse, e isso só dá para ajustar pela tela: ${link}\nDepois é só me pedir o envio de novo.`, "captacao_pendencias_repetidas");
    }
    const podeAutorizar = ctx.policy.includes("captacao.autorizacao.pedir");
    return resposta(
      g(base, ctx, { etapa: "verificar", pendenciasDitas: marca }),
      `${prefixo}${textoDoPreflight({ ...r.body, faltantes: daTela }, nomes, podeAutorizar)}\nO rascunho${lembrete(f)} está salvo; isso só dá para ajustar pela tela: ${link}\nQuando terminar, me diga *pronto* que eu confiro.`,
      "captacao_bloqueios"
    );
  }
  return resumir(g(base, ctx, { pendenciasDitas: undefined }), pf, ctx, deps, prefixo);
}

/** Faltantes curtos que uma mesma resposta pode trazer juntos ("01310-100, Casa"). */
const COMBINAVEIS = new Set<TipoDeCampo>(["cep", "tipo_imovel", "estado_civil", "email"]);
const leu = (l: Leitura): l is { dados: DadosDeCaptacao; eco: string } => l !== "vazio" && !("erro" in l);

/**
 * Confirmação única: a resposta a um faltante é GRAVADA no mesmo turno (chave
 * = messageId). Resposta inválida (CPF que não confere, e-mail sem @…) é
 * perguntada de novo, sem gravar nada.
 */
async function conduzirFaltantes(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const fa = f.faltantes?.[0];
  if (!fa) return verificar(f, ctx, deps, "");
  if (PULAR.test(t)) {
    return resposta(null, `Certo. O rascunho${lembrete(f)} fica salvo; complete pela tela: ${linkDe(f.captacaoId)}`, "captacao_faltante_pulado");
  }
  if (PERGUNTA_FORA.test(t)) return pausar(f);
  const extrair: ExtratorDeSecao = async (texto, secao) => (deps.extrairCaptacao ? deps.extrairCaptacao(texto, secao) : null);
  const lido = await lerFaltante(f, fa, ctx.texto, extrair);
  // Item 5: quando a pergunta é de um campo curto, a mesma resposta preenche os
  // OUTROS campos curtos que trouxer — do imóvel, ou do MESMO proprietário.
  const juntos: { fa: FaltanteDeCaptacao; dados: DadosDeCaptacao; eco: string }[] = [];
  const tipoAtual = tipoDoFaltante(fa);
  if (tipoAtual && COMBINAVEIS.has(tipoAtual)) {
    for (const outro of (f.faltantes ?? []).slice(1)) {
      const tipo = tipoDoFaltante(outro);
      if (!tipo || !COMBINAVEIS.has(tipo) || tipo === tipoAtual) continue;
      if (outro.path.startsWith("proprietarios[]") !== fa.path.startsWith("proprietarios[]")) continue;
      if (outro.path.startsWith("proprietarios[]") && outro.proprietarioId !== fa.proprietarioId) continue;
      const l = await lerFaltante(f, outro, ctx.texto, extrair);
      if (leu(l)) juntos.push({ fa: outro, ...l });
    }
  }
  if (!leu(lido) && !juntos.length) return falhou(f, lido === "vazio" ? "Não entendi." : lido.erro, ctx);
  let dados: DadosDeCaptacao = {};
  const ecos: string[] = [];
  if (leu(lido)) { dados = mesclarDadosDeCaptacao(dados, lido.dados); ecos.push(lido.eco); }
  for (const x of juntos) { dados = mesclarDadosDeCaptacao(dados, x.dados); ecos.push(x.eco); }
  const r = await complementar(f, ctx, deps, dados);
  if (!r.ok) return r.r;
  const respondidos = new Set<FaltanteDeCaptacao>([...(leu(lido) ? [fa] : []), ...juntos.map((x) => x.fa)]);
  const resto = (f.faltantes ?? []).filter((x) => !respondidos.has(x));
  const base = g(r.f, ctx, { faltantes: resto, tentativas: leu(lido) ? 0 : f.tentativas, ...comResumo(f, dados) });
  const anotei = `${r.prefixo}Anotei: ${ecos.join(", ")}.\n`;
  if (!leu(lido)) return resposta(base, `${anotei}${lido === "vazio" ? "" : `${lido.erro} `}${perguntaDoFaltante(base, fa)}`, "captacao_faltantes");
  if (resto.length) return resposta(base, `${anotei}${perguntaDoFaltante(base, resto[0]!)}`, "captacao_faltantes");
  return verificar(g(base, ctx, { etapa: "verificar" }), ctx, deps, anotei);
}
const CANAL: Record<string, string> = { email: "e-mail", whatsapp: "WhatsApp", aceite: "aceite por WhatsApp" };

function listaDeNomes(nomes: string[]): string {
  if (nomes.length <= 1) return nomes.join("");
  return `${nomes.slice(0, -1).join(", ")} e ${nomes[nomes.length - 1]}`;
}

/**
 * Nit 2 (revisão opus, round 3): o canal escolhido nesta conversa só existe
 * localmente até o "enviar" aplicar de verdade — mas já pode ser mostrado no
 * resumo. Troca o `canal` dos assinantes do servidor que batem com um
 * proprietário LOCAL (por nome); quem não bate (testemunha, outro assinante)
 * mantém o canal que já está no servidor — nunca inventado.
 */
function comCanalLocalAplicado(raw: unknown, proprietarios: { nome: string }[] | undefined, canalDito: CanalDeEnvio | undefined): unknown {
  if (!canalDito || !proprietarios?.length) return raw;
  const nomes = new Set(proprietarios.map((p) => p.nome));
  return lista(raw).map((x) => {
    const a = obj(x);
    const nome = str(a.nome);
    return nome && nomes.has(nome) ? { ...a, canal: canalDito } : a;
  });
}

/** CPF/CNPJ (válido ou não), telefone, e-mail ou uma sequência longa de dígitos na mensagem. */
function trazDocumentoOuContato(texto: string): boolean {
  const n = lerNumeros(texto);
  return !!(n.cpfs.length || n.cnpjs.length || n.telefones.length || n.invalido || lerEmails(texto).length || /(?:\d[\s.\-/]?){8,}/.test(texto));
}

/** "Envio para Maria e João por e-mail?" — nomes e canais de `captacao.options{captacaoId}`. */
export function frasesDoEnvio(raw: unknown): string | null {
  const assinam = lista(raw).map(obj).filter((a) => a.assina !== false && str(a.nome));
  if (!assinam.length) return null;
  const canais = new Set(assinam.map((a) => str(a.canal) ?? ""));
  const nomes = assinam.map((a) => str(a.nome)!);
  if (canais.size === 1) {
    const c = [...canais][0]!;
    return `${listaDeNomes(nomes)}${c && CANAL[c] ? ` por ${CANAL[c]}` : ""}`;
  }
  return listaDeNomes(assinam.map((a) => `${str(a.nome)}${str(a.canal) && CANAL[str(a.canal)!] ? ` (${CANAL[str(a.canal)!]})` : ""}`));
}

/**
 * Item 3: o ÚNICO resumo do fluxo, respondido com um "sim" só — imóvel,
 * condições, nomes (nunca CPF), testemunhas, quem assina pela imobiliária,
 * canal e quantos campos vão em branco. O "sim" já manda `confirmarBrancos`;
 * o canal pode ser trocado na mesma resposta ("sim, por WhatsApp").
 */
async function resumir(f: FluxoCaptacao, pf: PreflightLido, ctx: ContextoDoTurno, deps: DepsDoFluxo, prefixo: string): Promise<Resposta> {
  const opc = await deps.acao("captacao.options", { captacaoId: f.captacaoId });
  const dados = opc?.status === 200 ? opc.body : null;
  const assinantes = dados ? lista(dados.assinantes).map(obj) : [];
  const nomesDoPapel = (papel: string) => assinantes.filter((a) => str(a.papel) === papel && str(a.nome)).map((a) => str(a.nome)!);
  // O servidor (preflight/options) não devolve os VALORES de imóvel/condições — só o Max sabe o que
  // ele mesmo gravou. Esses valores só entram no resumo quando a versão que o preflight conferiu
  // (e que o "sim" vai mandar no send) é a que o Max deixou; se a tela mexeu depois, o resumo não
  // mostra o que pode estar velho: aponta a tela.
  const versaoConferida = pf.version ?? f.version;
  const telaMexeu = !!f.telaMudou
    || (typeof f.versaoGravada === "number" && typeof versaoConferida === "number" && versaoConferida !== f.versaoGravada);
  const resumo = telaMexeu ? {} : (f.dadosDoResumo ?? {});
  const imovel = ecoDoImovel(resumo.imovel);
  const condicoes = ecoDasCondicoes({ condicoes: resumo.condicoes ?? {}, locacao: resumo.locacao ?? {} });
  const avisoTela = telaMexeu && f.dadosDoResumo
    ? `Imóvel e condições: a captação foi alterada na tela depois do que anotei — confira lá antes do *sim*: ${linkDe(f.captacaoId)}`
    : "";
  const donosServidor = nomesDoPapel("proprietario");
  const donos = donosServidor.length ? donosServidor : (f.proprietarios ?? []).map((p) => p.nome);
  const testemunhasServidor = nomesDoPapel("testemunha");
  const testemunhas = testemunhasServidor.length ? testemunhasServidor : (f.extras ?? []).filter((x) => x.testemunha).map((x) => x.nome);
  const daImobiliaria = nomesDoPapel("imobiliaria");
  const linhas = [
    `${prefixo}Pronta a captação${lembrete(f)}${f.nome ? ` — ${f.nome}` : ""}.`,
    imovel ? `Imóvel: ${imovel}.` : "",
    condicoes ? `Condições: ${condicoes}.` : "",
    avisoTela,
    donos.length ? `Proprietário${donos.length > 1 ? "s" : ""}: ${listaDeNomes(donos)}.` : "",
    testemunhas.length ? `Testemunha${testemunhas.length > 1 ? "s" : ""}: ${listaDeNomes(testemunhas)}.` : "",
    daImobiliaria.length ? `Pela imobiliária assina: ${listaDeNomes(daImobiliaria)}.` : "",
  ].filter(Boolean);
  const brancos = pf.emBranco > 0 ? `${pf.emBranco} campo(s) vão em branco no contrato (dá para completar na tela: ${linkDe(f.captacaoId)}).` : "";
  const semEnvio = !captacaoEnvioLigado() || !ctx.policy.includes("captacao.send");
  if (semEnvio) {
    return resposta(null, `${[...linhas, brancos].filter(Boolean).join("\n")}\nO envio para assinatura é pela tela: ${linkDe(f.captacaoId)}`, "captacao_pronta_sem_envio");
  }
  if (dados && dados.assinaturaConfigurada === false) {
    return resposta(null, `${[...linhas, brancos].filter(Boolean).join("\n")}\n${TEXTO_POR_CODIGO.clicksign_nao_conectada({ link: "" })}`, "captacao_pronta_sem_clicksign");
  }
  // Achado 3 (revisão opus): o canal dito só é aplicado no servidor quando há
  // IDS locais de proprietário (`f.proprietarios`, só existe no caminho de
  // CRIAÇÃO). No ENVIO de um rascunho JÁ EXISTENTE (`iniciarEnvioDeCaptacao`)
  // o Max não sabe o id de quem já está na captação — então avisa, nunca
  // finge que aplicou.
  const semIdsLocais = !f.proprietarios?.length;
  const avisoCanal = semIdsLocais && f.canalDito
    ? `Não consigo trocar o canal deste rascunho por aqui (sem acesso aos ids de proprietário já cadastrados); o envio usa o canal que já está na tela. Para mudar, ajuste em: ${linkDe(f.captacaoId)}`
    : "";
  // Quem assina pela imobiliária já tem linha própria; o envio lista as partes e o canal de cada uma.
  const paraEnvio = assinantes.filter((a) => str(a.papel) !== "imobiliaria");
  const quem = !semIdsLocais
    ? dados
      ? frasesDoEnvio(comCanalLocalAplicado(paraEnvio, f.proprietarios, f.canalDito))
      : `${listaDeNomes(f.proprietarios!.map((p) => p.nome))} por ${CANAL[f.canalDito ?? lerCanalPadrao(dados) ?? "email"]}`
    : dados ? frasesDoEnvio(paraEnvio) : null;
  const envio = quem ? `Envio: ${quem}.` : "Envio: para as pessoas marcadas para assinar.";
  const pergunta = semIdsLocais
    ? "Responda *sim* para enviar, ou CANCELAR."
    : `Responda *sim* para enviar (para trocar o canal: "sim, por WhatsApp"), ou CANCELAR.`;
  return resposta(
    g(f, ctx, { etapa: "revisao", chave: f.chave, emBranco: pf.emBranco }),
    [...linhas, envio, brancos, avisoCanal, pergunta].filter(Boolean).join("\n"),
    "captacao_revisao"
  );
}
async function conduzirSelecao(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const n = /^(?:opcao\s*|numero\s*|n\s*)?(\d{1,2})$/.exec(t);
  const c = n ? f.candidatos?.find((x) => x.ref === Number(n[1])) : undefined;
  if (!c) {
    if (PERGUNTA_FORA.test(t)) return pausar(f);
    return falhou(f, "Responda com o número do rascunho.", ctx);
  }
  return verificar(g(f, ctx, { etapa: "verificar", captacaoId: c.id, codigo: c.codigo, nome: c.nome, candidatos: undefined, tentativas: 0 }), ctx, deps, `Captação ${c.codigo} (${c.nome}). `);
}

// ── envio ──

/**
 * O "sim" do resumo final envia (com `confirmarBrancos` quando o resumo disse
 * que há campos em branco — o aviso já foi dado ali). Um canal dito junto
 * ("sim, por WhatsApp") vale para o envio; o canal sozinho refaz o resumo.
 * Qualquer outra coisa NÃO envia.
 */
async function conduzirRevisao(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  // "sim, mas troca o CPF 111…": correção de documento/contato no resumo NÃO envia e NÃO vai crua
  // pro atendimento normal (o número sairia do fluxo). Pede a correção pela tela, sem ecoar o valor.
  if (trazDocumentoOuContato(ctx.texto)) {
    return resposta(
      g(f, ctx),
      `Não enviei. Correção de documento ou contato no resumo é pela tela: ${linkDe(f.captacaoId)}\nDepois responda *sim* para enviar, ou CANCELAR.`,
      "captacao_resumo_correcao_pela_tela"
    );
  }
  const lida = lerRespostaDoResumo(ctx.texto);
  if (lida.nao) return cancelar(f);
  if (!lida.sim && !lida.canal) return pausar(f);
  const trocaCanal = !!lida.canal && lida.canal !== f.canalDito;
  if (trocaCanal && !f.proprietarios?.length) {
    return resposta(
      g(f, ctx),
      `Não consigo trocar o canal deste rascunho por aqui; o envio usa o canal que já está na tela (para mudar: ${linkDe(f.captacaoId)}). Responda *sim* para enviar assim, ou CANCELAR.`,
      "captacao_canal_sem_ids"
    );
  }
  if (trocaCanal && f.chave) {
    // O envio já foi pedido e ficou sem resposta: trocar o canal agora mudaria um envio que pode ter saído.
    return resposta(g(f, ctx), "O envio já foi pedido e ainda não sei se saiu, então não troco o canal agora. Responda *sim* para eu conferir — não duplica.", "captacao_canal_com_envio_incerto");
  }
  const comCanal = trocaCanal ? g(f, ctx, { canalDito: lida.canal! }) : f;
  if (!lida.sim) return verificar(g(comCanal, ctx, { etapa: "verificar", tentativas: 0 }), ctx, deps, `Certo, por ${CANAL[lida.canal!]}.\n`);
  return confirmarEEnviar(comCanal, ctx, deps, (f.emBranco ?? 0) > 0);
}

/**
 * O "sim" É a confirmação — regrava o canal nos proprietários (quando há ids
 * locais pra aplicar, achado 3, e o canal escolhido ainda não é o gravado)
 * com uma chave PRÓPRIA (`:canal`, nunca a mesma do envio) e só então manda o
 * `captacao.send`, com a versão que o complemento devolveu. `!f.chave` é o
 * que distingue a PRIMEIRA tentativa deste "sim" de um retry do MESMO envio
 * (send sem resposta, 202 em andamento…): reaplicar o canal a cada retry
 * bumpa a versão à toa e troca a chave de idempotência do `captacao.send`
 * debaixo do pé do "não duplica".
 */
async function confirmarEEnviar(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, confirmarBrancos: boolean): Promise<PassoDoFluxo> {
  const precisaAplicarCanal = !f.chave && !!f.canalDito && !!f.proprietarios?.length && f.canalDito !== f.canalAplicado;
  if (!precisaAplicarCanal) return enviar(f, ctx, deps, confirmarBrancos);
  // Achado 4 (revisão opus, mantido): a escrita do canal exige captacao.create
  // de verdade — a política é relida a cada turno e pode ter mudado.
  if (!ctx.policy.includes("captacao.create")) {
    return resposta(
      g(f, ctx, { etapa: "verificar", tentativas: 0 }),
      "Não consigo gravar o canal agora (sua permissão de criação mudou). Ajuste pela tela, ou responda de novo para eu tentar.",
      "captacao_canal_sem_permissao"
    );
  }
  const alvo = f.proprietarios!.map((p) => ({ id: p.id, canal: f.canalDito! }));
  const r = await complementar(f, ctx, deps, { proprietarios: alvo }, `${ctx.messageId}:canal`, { semRetentativaDeVersao: true });
  if (!r.ok) {
    // Item 1 (revisão opus, round 3): a tela pode ter mudado ENTRE o resumo
    // mostrado e este "sim" — reenviar sozinho com a versão nova mandaria
    // conteúdo que o usuário nunca viu. Volta pro resumo (novo preflight,
    // nova confirmação), a confirmação antiga não vale mais.
    if ("versaoDesatualizada" in r) {
      return verificar(g(f, ctx, { etapa: "verificar", chave: undefined, telaMudou: true }), ctx, deps, `${TEXTO_POR_CODIGO.versao_desatualizada({ link: linkDe(f.captacaoId) })}\n`);
    }
    return r.r;
  }
  return enviar(g(r.f, ctx, { canalAplicado: f.canalDito }), ctx, deps, confirmarBrancos);
}
/**
 * `captacao.send{captacaoId, version, confirmarBrancos}`. A chave (a `messageId`
 * do "enviar") fica guardada; sem resposta, o "enviar" seguinte REPETE a mesma
 * chave e os mesmos args — o servidor devolve o resultado gravado, não envia de
 * novo. Depois de um 202 o fluxo só CONFERE (`captacao.list`), nunca reenvia.
 */
async function enviar(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, confirmarBrancos: boolean): Promise<PassoDoFluxo> {
  if (!captacaoEnvioLigado() || !ctx.policy.includes("captacao.send")) {
    return resposta(null, `O envio pelo ${nomeDoAgente()} não está liberado. Envie pela tela: ${linkDe(f.captacaoId)}`, "captacao_envio_nao_liberado");
  }
  if (typeof f.version !== "number" || !f.captacaoId) return verificar(g(f, ctx, { etapa: "verificar" }), ctx, deps, "");
  const mesmo = f.chave && f.chave.version === f.version && !!f.chave.confirmarBrancos === confirmarBrancos;
  const chave = mesmo ? f.chave! : { verbo: "captacao.send", valor: ctx.messageId, em: ctx.agora, version: f.version, ...(confirmarBrancos ? { confirmarBrancos: true } : {}) };
  const emCurso = g(f, ctx, { etapa: "enviando", chave });
  const args: Record<string, unknown> = { captacaoId: f.captacaoId, version: f.version, ...(confirmarBrancos ? { confirmarBrancos: true } : {}) };
  const r = await deps.acao("captacao.send", args, chave.valor);
  if (!r) {
    return resposta({ ...emCurso, etapa: "revisao" }, "Não consegui confirmar o envio agora. Responda *sim* de novo para eu conferir — não duplica.", "captacao_envio_incerto");
  }
  return traduzirEnvio(f, emCurso, r, ctx, deps);
}

async function traduzirEnvio(
  f: FluxoCaptacao, emCurso: FluxoCaptacao, r: { status: number; body: Record<string, unknown> }, ctx: ContextoDoTurno, deps: DepsDoFluxo
): Promise<Resposta> {
  const url = linkDe(f.captacaoId);
  const erro = str(r.body.error);
  if (r.status === 200 && r.body.ok === true) {
    const estado = str(r.body.estado) ?? "Em assinatura";
    const pessoas = typeof r.body.pessoas === "number" ? ` para ${r.body.pessoas} pessoa(s)` : "";
    return resposta(null, `Enviado${pessoas}: ${estado}. Acompanhe na tela: ${url}`, "captacao_enviada");
  }
  if (r.status === 202) {
    // Não terminou em 20 s: confere, e NUNCA dispara outro send.
    const l = await deps.acao("captacao.list", { captacaoId: f.captacaoId });
    const item = l?.status === 200 ? lista(l.body.items).map(lerItemDaCaptacao).find((x) => x?.id === f.captacaoId) : null;
    const estado = item?.estado ?? str(r.body.estado) ?? "Enviando…";
    if (/enviando/i.test(estado)) {
      return resposta({ ...emCurso, etapa: "enviando" }, `O envio está em andamento (${estado}). Pergunte "como está a captação${f.nome ? ` ${f.nome}` : ""}" que eu confiro. ${url}`, "captacao_envio_202");
    }
    return resposta(null, `Envio concluído: ${estado}. ${url}`, "captacao_envio_202_concluido");
  }
  if (erro === "confirmar_brancos") {
    // Só acontece se a tela deixou campos em branco DEPOIS do resumo: o mesmo resumo, agora com os brancos, e o "sim" de novo.
    const emBranco = Math.max(1, typeof r.body.emBranco === "number" ? r.body.emBranco : f.emBranco ?? 0);
    return resposta(
      g(f, ctx, { etapa: "revisao", chave: undefined, emBranco }),
      `${emBranco} campo(s) vão em branco no contrato (dá para completar na tela: ${url}). Responda *sim* para enviar assim mesmo, ou CANCELAR.`,
      "captacao_confirmar_brancos"
    );
  }

  if (erro === "versao_desatualizada") {
    // Alguém mudou a captação: confere de novo e o resumo volta (a confirmação anterior não vale).
    return verificar(g(f, ctx, { etapa: "verificar", chave: undefined, telaMudou: true }), ctx, deps, `${TEXTO_POR_CODIGO.versao_desatualizada({ link: url })}\n`);
  }
  if (erro === "pendencias") {
    return verificar(g(f, ctx, { etapa: "verificar", chave: undefined }), ctx, deps, "");
  }
  if (erro === "ja_enviando" || erro === "em_andamento") {
    return resposta({ ...emCurso, etapa: "enviando" }, TEXTO_POR_CODIGO.ja_enviando({ link: url }), "captacao_ja_enviando");
  }
  if (erro) {
    const limite = typeof r.body.limite === "number" ? r.body.limite : undefined;
    return resposta(null, textoDoCodigoDeEnvio(erro, { link: url, ...(limite ? { limite } : {}) }), `captacao_envio_${erro}`);
  }
  if (r.status === 403) { const n = textoDeNegado(r); return resposta(null, n.reply, n.evento); }
  if (r.status === 404) return resposta(null, `Não achei essa captação. Veja na tela: ${linkDe()}`, "captacao_envio_404");
  return resposta(null, textoDoCodigoDeEnvio("", { link: url }), `captacao_envio_${r.status}`);
}

/** Depois do 202: SIM, "enviar" ou "como está" só CONSULTAM (`captacao.list`), nunca reenviam. */
async function conferirEnvio(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const t = normalizar(ctx.texto);
  const quer = lerConfirmacao(ctx.texto) === "sim" || confirmaEnvio(ctx.texto) || /\b(confer\w*|como (?:esta|anda|ficou|ta)|saiu|foi|status|andamento|ja)\b/.test(t);
  if (!quer) return { liberar: true, fluxo: { ...f, pausado: false }, evento: "captacao_envio_liberado" };
  const url = linkDe(f.captacaoId);
  const l = await deps.acao("captacao.list", { captacaoId: f.captacaoId });
  const item = l?.status === 200 ? lista(l.body.items).map(lerItemDaCaptacao).find((x) => x?.id === f.captacaoId) : null;
  if (!item?.estado) return resposta(g(f, ctx), `Ainda não consegui conferir. Veja na tela: ${url}`, "captacao_envio_sem_conferencia");
  if (/enviando/i.test(item.estado)) return resposta(g(f, ctx), `Ainda em andamento (${item.estado}). Veja na tela: ${url}`, "captacao_envio_andamento");
  return resposta(null, `Não reenviei. A captação${lembrete(f)} está como "${item.estado}": ${url}`, "captacao_envio_conferido");
}

// ─── v2/PR7: autorização de reaproveitamento — condução ──────────────────

/**
 * Oferta ao corretor (`verificar` disparou por um bloqueio de autorização).
 * "sim" direto pede sem justificativa; qualquer texto que não seja sim/não
 * (e não seja pergunta fora do assunto) é lido como justificativa curta — a
 * pessoa confirma antes do pedido valer (a chave de idempotência só nasce no
 * "sim" que de fato confirma, nunca antes).
 */
async function conduzirAutorizacaoOferta(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const pedido = f.autorizacaoPedido;
  if (!pedido) return verificar(g(f, ctx, { etapa: "verificar" }), ctx, deps, "");
  if (lerConfirmacao(ctx.texto) === "nao") {
    if (f.autorizacaoChave) return respostaDeAutorizacaoIncerta("captacao_autorizacao_recusada_incerta");
    // Achado de review 19/10 (item 3): guarda o `ref` recusado NESTA conversa — sem isto, o
    // próximo "sim" refaz o preflight e reoferece o MESMO ref, em loop (a fala passa a ser a
    // genérica do bloqueio quando a conferência roda de novo, ver `bloqueioEmTexto`).
    const recusados = Array.from(new Set([...(f.autorizacaoPedidosRecusados ?? []), pedido.ref]));
    return resposta(
      g(f, ctx, { etapa: "verificar", autorizacaoPedido: undefined, autorizacaoChave: undefined, autorizacaoPedidosRecusados: recusados }),
      `Tudo bem, não vou pedir agora. O rascunho${lembrete(f)} está salvo; ajuste pela tela: ${linkDe(f.captacaoId)}`,
      "captacao_autorizacao_recusada"
    );
  }
  if (lerConfirmacao(ctx.texto) === "sim") return pedirAutorizacao(f, ctx, deps, pedido);
  // "sim, <justificativa>" / "sim - <justificativa>" (achado de review 19/10, item 6): já
  // confirma, levando o texto depois da vírgula/hífen como justificativa — sem o passo extra de
  // "peço com essa justificativa?" (a pessoa já confirmou na MESMA mensagem). Roda ANTES do
  // `PERGUNTA_FORA`: essa justificativa pode legitimamente terminar em "?".
  const simComJustificativa = pedido.justificativa === undefined ? /^sim\s*[,\-–]\s*(.+)$/is.exec(ctx.texto.trim()) : null;
  if (simComJustificativa) {
    const justificativa = simComJustificativa[1]!.trim();
    if (justificativa.length > 300) {
      return falhou(f, "Essa justificativa ficou grande demais (até 300 caracteres). Pode resumir, ou responda *sim* para pedir sem justificativa.", ctx);
    }
    return pedirAutorizacao(f, ctx, deps, { ...pedido, justificativa });
  }
  // Uma justificativa em texto livre que termine em "?" (ex.: "ele pediu, posso?") é ambígua com
  // uma pergunta fora do assunto — fica a favor de PAUSAR, como já era (achado de review 19/10,
  // item 6: só o caso claro "sim, …" acima é tratado como justificativa).
  if (PERGUNTA_FORA.test(t)) return pausar(f);
  if (pedido.justificativa !== undefined) {
    // Já tinha pedido confirmação da justificativa: só sim/não valem aqui.
    return falhou(f, "Responda *sim* para eu pedir a autorização, ou *não* para deixar como está.", ctx);
  }
  const justificativa = ctx.texto.trim();
  if (justificativa.length > 300) {
    return falhou(f, "Essa justificativa ficou grande demais (até 300 caracteres). Pode resumir, ou responda *sim* para pedir sem justificativa.", ctx);
  }
  return resposta(
    // A fala ecoa REDIGIDA (`justificativaSegura`); o valor verbatim é o que vai pro servidor —
    // guardado sem redação em `autorizacaoPedido`, nunca o que aparece na tela.
    g(f, ctx, { autorizacaoPedido: { ...pedido, justificativa } }),
    `Peço a autorização com essa justificativa: "${justificativaSegura(justificativa)}"? Responda *sim* (ou *não* para desistir).`,
    "captacao_autorizacao_justificativa"
  );
}

/** Achado de review 19/10 (item 2): mesma comparação usada por `pedirAutorizacao`/`decidirAutorizacao` para saber se o retry é da MESMA tentativa (args idênticos) ou de uma intenção nova. */
const mesmosArgs = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `captacao.autorizacao.pedir{captacaoId,tipo,ref,justificativa?}`. A chave de
 * idempotência é a `messageId` do "sim" que confirmou. Achado de review 19/10
 * (item 2): quando o servidor não responde, a chave e os args ficam guardados
 * em `autorizacaoChave` (como `chave` faz para `captacao.send`) — o PRÓXIMO
 * "sim" com os MESMOS args repete a MESMA chave, nunca uma nova (que criaria
 * um segundo pedido). O Max nunca manda CPF: o `ref` já é só o id do preflight.
 */
async function pedirAutorizacao(
  f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo,
  pedido: { tipo: "proprietario" | "imovel"; ref: string; justificativa?: string }
): Promise<Resposta> {
  const args: Record<string, unknown> = {
    captacaoId: f.captacaoId, tipo: pedido.tipo, ref: pedido.ref,
    ...(pedido.justificativa ? { justificativa: pedido.justificativa } : {}),
  };
  const mesmo = f.autorizacaoChave && mesmosArgs(f.autorizacaoChave.args, args);
  const valor = mesmo ? f.autorizacaoChave!.valor : ctx.messageId;
  const r = await deps.acao("captacao.autorizacao.pedir", args, valor);
  const url = linkDe(f.captacaoId);
  if (!r) {
    return resposta(
      g(f, ctx, { etapa: "autorizacao_oferta", autorizacaoChave: { valor, args } }),
      `${TEXTO_SEM_RESPOSTA} Responda *sim* de novo para eu tentar outra vez — não duplica.`,
      "captacao_autorizacao_pedir_sem_resposta"
    );
  }
  if (r.status === 201 || r.status === 200) {
    const texto = r.status === 201
      ? "Pedido enviado ao seu gerente. Te aviso quando ele decidir; enquanto isso dá para continuar preenchendo."
      : "Já tem um pedido aguardando o gerente.";
    // 201 (criado) ou 200 (já pendente): os dois significam "há um pedido em
    // voo para este ref" — guarda para a próxima conferência oferecer o
    // PRÓXIMO bloqueio, não repetir este (achado de review 19/10).
    const pedidosFeitos = Array.from(new Set([...(f.autorizacaoPedidosFeitos ?? []), pedido.ref]));
    return resposta(
      g(f, ctx, { etapa: "verificar", autorizacaoPedido: undefined, autorizacaoPedidosFeitos: pedidosFeitos, autorizacaoChave: undefined }),
      texto,
      `captacao_autorizacao_pedido_${r.status}`
    );
  }
  const erro = str(r.body.error);
  if (erro === "nao_precisa_autorizacao") {
    return verificar(
      g(f, ctx, { etapa: "verificar", autorizacaoPedido: undefined, autorizacaoChave: undefined }), ctx, deps,
      `${TEXTO_POR_CODIGO_AUTORIZACAO.nao_precisa_autorizacao({ link: url })}\n`
    );
  }
  if (r.status === 403) { const n = textoDeNegado(r); return resposta(null, n.reply, n.evento); }
  if (r.status === 404) return resposta(null, `Não achei essa captação (ou o item). Veja na tela: ${linkDe()}`, "captacao_autorizacao_pedir_404");
  if (erro) {
    return resposta(
      g(f, ctx, { etapa: "autorizacao_oferta", autorizacaoChave: undefined }),
      textoDoCodigoDeAutorizacao(erro, { link: url }),
      `captacao_autorizacao_pedir_${erro}`
    );
  }
  return resposta(null, TEXTO_SEM_RESPOSTA, `captacao_autorizacao_pedir_${r.status}`);
}

const APROVAR_N = /^aprov(?:ar|a|o)\s+(?:o\s+|a\s+)?(\d{1,2})$/;
const NEGAR_N = /^neg(?:ar|a|o)\s+(?:o\s+|a\s+)?(\d{1,2})$/;

/** A fila (gerente): "aprovar N" → confirmação direta; "negar N" → pede o motivo primeiro. */
/** "Autorizar Ana Souza a captar com o proprietário ***.456.789-** na CAP-2026-0007?" (contrato do Max, §18.12). */
function textoDeConfirmarAutorizacao(i: { solicitante: string; codigo: string; tipo: string; documento?: string; imovel?: string }): string {
  return `Autorizar ${i.solicitante} a captar com ${alvoDaAutorizacao(i)} na ${i.codigo}?`;
}

/**
 * Achado do smoke em staging (19/10): repetir o gatilho da fila DENTRO da
 * fila ("tem pedido de autorização?" de novo, com o fluxo já em
 * `autorizacao_fila`) caía no `PERGUNTA_FORA` (o texto termina em "?") e
 * PAUSAVA — o modelo reescrevia a lista a partir do histórico, cortando o
 * código CAP e perdendo o documento mascarado. Refaz a listagem
 * DETERMINISTICAMENTE (nunca libera para o modelo) e descarta qualquer
 * decisão em curso. Mesma regex de `pedeFilaDeAutorizacao` (a que `graph.ts`
 * usa para abrir a fila). NUNCA chamar isto em `autorizacao_motivo`: ali o
 * texto INTEIRO é o motivo da negativa, nunca o gatilho.
 */
async function relistarSeGatilhoDaFila(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo | null> {
  if (!pedeFilaDeAutorizacao(ctx.texto)) return null;
  // Escrita incerta em voo (a `acao` anterior ficou sem resposta e guardou a
  // chave): não descarta sem avisar — mesmo tratamento de `cancelar()`.
  if (f.autorizacaoChave) return respostaDeAutorizacaoIncerta("captacao_autorizacao_relistar_incerta");
  return listarFilaDeAutorizacao(ctx, deps);
}

async function conduzirAutorizacaoFila(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const relist = await relistarSeGatilhoDaFila(f, ctx, deps);
  if (relist) return relist;
  const itens = f.autorizacaoFila?.itens ?? [];
  const mAprovar = APROVAR_N.exec(t);
  if (mAprovar) {
    const item = itens.find((i) => i.ref === Number(mAprovar[1]));
    if (!item) return falhou(f, "Não achei esse número na lista.", ctx);
    return resposta(
      g(f, ctx, {
        etapa: "autorizacao_confirmar",
        autorizacaoDecisao: {
          autorizacaoId: item.id, tipo: item.tipo, decisao: "aprovar",
          codigo: item.codigo, solicitante: item.solicitante,
          ...(item.documento ? { documento: item.documento } : {}), ...(item.imovel ? { imovel: item.imovel } : {}),
        },
      }),
      // Achado de review 19/10: "Autorizar o pedido N?" não dizia quem nem o quê — o contrato
      // pede o texto com `solicitante`/alvo/`codigo` (o `id` decidido continua o do item mostrado).
      `${textoDeConfirmarAutorizacao(item)} Responda *sim* (ou *não*).`,
      "captacao_autorizacao_confirmar_aprovar"
    );
  }
  const mNegar = NEGAR_N.exec(t);
  if (mNegar) {
    const item = itens.find((i) => i.ref === Number(mNegar[1]));
    if (!item) return falhou(f, "Não achei esse número na lista.", ctx);
    return resposta(
      g(f, ctx, {
        etapa: "autorizacao_motivo",
        autorizacaoDecisao: {
          autorizacaoId: item.id, tipo: item.tipo, decisao: "negar",
          codigo: item.codigo, solicitante: item.solicitante,
          ...(item.documento ? { documento: item.documento } : {}), ...(item.imovel ? { imovel: item.imovel } : {}),
        },
      }),
      "Qual o motivo da negativa? (até 500 caracteres)",
      "captacao_autorizacao_pede_motivo"
    );
  }
  if (/\b(atualiz\w*|de novo|novamente|recarreg\w*)\b/.test(t)) return listarFilaDeAutorizacao(ctx, deps);
  if (PERGUNTA_FORA.test(t)) return pausar(f);
  return falhou(f, 'Responda "aprovar N" ou "negar N" (o número da lista).', ctx);
}

/**
 * O motivo da negativa (obrigatório, ≤ 500 caracteres): NUNCA chama
 * `captacao.autorizacao.decidir` diretamente — só guarda o motivo e pede
 * confirmação verbatim. A escrita só acontece no "sim" de `autorizacao_confirmar`.
 */
async function conduzirAutorizacaoMotivo(f: FluxoCaptacao, ctx: ContextoDoTurno): Promise<PassoDoFluxo> {
  const decisao = f.autorizacaoDecisao;
  if (!decisao) return resposta(null, TEXTO_SEM_RESPOSTA, "captacao_autorizacao_motivo_sem_contexto");
  // Achado de review 19/10 (item 5): só "cancelar"/"cancela" EXATOS cancelam aqui — o texto
  // inteiro é o motivo, e frases com "desisto"/"não quero mais" no MEIO são a própria razão.
  if (CANCELA_MOTIVO.test(normalizar(ctx.texto))) {
    if (f.autorizacaoChave) return respostaDeAutorizacaoIncerta("captacao_autorizacao_cancelado_incerto");
    return resposta(null, "Tudo bem, não decidi nada.", "captacao_autorizacao_cancelado");
  }
  const motivo = ctx.texto.trim();
  if (!motivo) return falhou(f, "Preciso de um motivo para negar.", ctx);
  if (motivo.length > 500) return falhou(f, "Esse motivo ficou grande demais (até 500 caracteres). Pode resumir?", ctx);
  // Negar confirma com o MESMO identificador do aprovar, mais o motivo verbatim (achado de review 19/10).
  const alvo = alvoDaAutorizacao(decisao);
  return resposta(
    g(f, ctx, { etapa: "autorizacao_confirmar", autorizacaoDecisao: { ...decisao, motivo } }),
    `Negar ${decisao.solicitante} a captar com ${alvo} na ${decisao.codigo} com o motivo: "${motivo}"? Responda *sim* (ou *não*).`,
    "captacao_autorizacao_confirmar_negar"
  );
}

/** O "sim"/"não" final: só aqui `captacao.autorizacao.decidir` é chamado. */
async function conduzirAutorizacaoConfirmar(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const decisao = f.autorizacaoDecisao;
  if (!decisao) return resposta(null, TEXTO_SEM_RESPOSTA, "captacao_autorizacao_confirmar_sem_contexto");
  const relist = await relistarSeGatilhoDaFila(f, ctx, deps);
  if (relist) return relist;
  if (lerConfirmacao(ctx.texto) === "nao") {
    if (f.autorizacaoChave) return respostaDeAutorizacaoIncerta("captacao_autorizacao_decisao_cancelada_incerta");
    return resposta(null, "Tudo bem, não decidi nada.", "captacao_autorizacao_decisao_cancelada");
  }
  if (lerConfirmacao(ctx.texto) !== "sim") return pausar(f);
  return decidirAutorizacao(f, ctx, deps, decisao);
}

/**
 * `captacao.autorizacao.decidir{autorizacaoId,decisao,motivo?}`. A chave de
 * idempotência é a `messageId` do "sim" de confirmação. Achado de review
 * 19/10 (item 2): mesmo padrão de `pedirAutorizacao` — sem resposta do
 * servidor, a chave e os args ficam guardados em `autorizacaoChave`, e o
 * PRÓXIMO "sim" com os MESMOS args repete a MESMA chave.
 */
async function decidirAutorizacao(
  f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo,
  decisao: { autorizacaoId: string; tipo: string; decisao: "aprovar" | "negar"; motivo?: string }
): Promise<Resposta> {
  const args: Record<string, unknown> = {
    autorizacaoId: decisao.autorizacaoId, decisao: decisao.decisao, ...(decisao.motivo ? { motivo: decisao.motivo } : {}),
  };
  const mesmo = f.autorizacaoChave && mesmosArgs(f.autorizacaoChave.args, args);
  const valor = mesmo ? f.autorizacaoChave!.valor : ctx.messageId;
  const r = await deps.acao("captacao.autorizacao.decidir", args, valor);
  if (!r) {
    return resposta(
      g(f, ctx, { etapa: "autorizacao_confirmar", autorizacaoChave: { valor, args } }),
      `${TEXTO_SEM_RESPOSTA} Responda *sim* de novo — não duplica.`,
      "captacao_autorizacao_decidir_sem_resposta"
    );
  }
  if (r.status === 200) {
    const d = lerAutorizacaoDecisao(r.body);
    const status = d?.status === "aprovada" ? "aprovado" : d?.status === "negada" ? "negado" : "decidido";
    return resposta(null, `Pedido ${status}.`, `captacao_autorizacao_decidida_${status}`);
  }
  // Códigos ESPECÍFICOS (inclusive os que chegam com status 403/409, como
  // `solicitante_nao_decide`) vêm antes do 403/404 genéricos: senão o 403 de
  // política roubaria o texto certo de `solicitante_nao_decide` (achado do
  // teste — os dois usam o mesmo status HTTP). Mas só um código CONHECIDO
  // (`CODIGOS_DA_AUTORIZACAO`) pode entrar aqui: o 404/403 GENÉRICO do servidor
  // (`{error:"Not Found"}`/`{error:"Forbidden"}`) também tem `error` truthy e
  // NÃO é um código da autorização — tratá-lo como código fazia a fala cair no
  // "Não consegui processar o pedido" com link vazio (achado de review 19/10).
  // Achado de review 19/10 (item 1): o link destes códigos é o da LISTA de
  // captações — a decisão não carrega o `captacaoId` do pedido (só o
  // `autorizacaoId`), então não há um link específico; `linkDe()` sem id
  // continua uma URL válida, nunca vazia (`{ link: "" }` gerava "tela: " com
  // nada depois).
  const linkGenerico = linkDe();
  const erro = str(r.body.error);
  if (erro === "motivo_obrigatorio") {
    return resposta(
      g(f, ctx, { etapa: "autorizacao_motivo", autorizacaoChave: undefined }),
      TEXTO_POR_CODIGO_AUTORIZACAO.motivo_obrigatorio({ link: linkGenerico }),
      "captacao_autorizacao_decidir_motivo_obrigatorio"
    );
  }
  if (erro && (CODIGOS_DA_AUTORIZACAO as readonly string[]).includes(erro)) {
    return resposta(null, textoDoCodigoDeAutorizacao(erro, { link: linkGenerico }), `captacao_autorizacao_decidir_${erro}`);
  }
  if (r.status === 404) return resposta(null, "Esse pedido não está mais com você.", "captacao_autorizacao_decidir_404");
  if (r.status === 403) { const n = textoDeNegado(r); return resposta(null, n.reply, n.evento); }
  return resposta(null, TEXTO_SEM_RESPOSTA, `captacao_autorizacao_decidir_${r.status}`);
}
