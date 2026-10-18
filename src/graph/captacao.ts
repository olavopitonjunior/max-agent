import type { ContextoDoTurno, DepsDoFluxo, PassoDoFluxo } from "./fluxos";
import { lerConfirmacao, normalizar } from "./tools";
import { brl, cpfValido, nomeValido, valoresNoTexto } from "./credito";
import { captacaoEnvioLigado, captacaoLigada } from "./captacao-flags";
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

/** `MAX_CAPTACAO` e `MAX_CAPTACAO_ENVIO`, ambas desligadas por padrão (ver `captacao-flags.ts`). */
export { captacaoLigada, captacaoEnvioLigado };

// ─── Estado ──────────────────────────────────────────────────────────────

export type TipoDeCaptacao = "venda" | "locacao";

export interface ModeloDeCaptacao { id: string; nome: string; resumo?: string }
export interface FaltanteDeCaptacao { path: string; rotulo: string; etapa?: string; proprietarioId?: string }
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
    | "natureza" | "nome" | "modelo" | "imovel" | "condicoes" | "confirmar_criacao" | "proprietarios" | "extras"
    | "confirmar_pessoas" | "verificar" | "faltantes" | "confirmar_faltantes" | "canal" | "selecao" | "revisao"
    | "brancos" | "enviando";
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
  captacaoId?: string;
  codigo?: string;
  version?: number;
  /** Só id e nome (e PJ): os documentos e contatos vão direto ao ImobPro. */
  proprietarios?: { id: string; nome: string; pj?: boolean }[];
  /** Testemunhas/avulsos lidos mas ainda não gravados — só nome aqui (sem contato); o resto vai no `cofre`. */
  extrasPendentes?: { id: string; nome: string; testemunha: boolean }[];
  /**
   * CPF, e-mail e telefone dos proprietários/extras lidos mas AINDA NÃO
   * gravados (achado 17: só vão ao servidor depois do "sim") ficam aqui,
   * CIFRADOS — nunca em claro no checkpoint (regra de topo do arquivo: nenhum
   * dado pessoal de proprietário no estado). Ver `cifrarCofreCaptacao`.
   */
  cofre?: string;
  /** Chave de idempotência do lote de `confirmar_pessoas` em curso — guardada
   *  entre turnos pra um "sim" incerto/retentado nunca gerar um segundo lote
   *  (nit da revisão opus). Limpa junto do `cofre` quando o lote é gravado. */
  gravarPessoasChave?: string;
  faltantes?: FaltanteDeCaptacao[];
  /**
   * Nit 1 (revisão opus, round 3): rótulos (sem valor) dos faltantes já
   * respondidos nesta rodada, ainda no cofre — pra `pedirConfirmacaoDeFaltantes`
   * listar TODOS, não só o último. Sobrevive a um PULAR no meio (os já
   * respondidos antes continuam no resumo); limpa junto do `cofre` quando o
   * lote é gravado (ou quando a confirmação é cancelada/encerrada).
   */
  faltantesAcumulados?: { path: string; rotulo: string }[];
  /** Rascunhos candidatos ao envio pedido por nome ("envia a captação da Maria"). */
  candidatos?: { ref: number; id: string; codigo: string; nome: string }[];
  /** O envio em curso: `valor` é a `messageId` do "enviar" (`x-idempotency-key`). */
  chave?: { verbo: string; valor: string; em?: number; version: number; confirmarBrancos?: boolean };
  /** Quantos campos vão em branco, dito no `confirmar_brancos`. */
  emBranco?: number;
  tentativas: number;
  pausado?: boolean;
  atualizadoEm: number;
}

type Resposta = Extract<PassoDoFluxo, { reply: string }>;
const resposta = (fluxo: FluxoCaptacao | null, reply: string, evento: string): Resposta => ({ fluxo, reply, evento });

// ─── Textos fixos ────────────────────────────────────────────────────────

export const TEXTO_CAPTACAO_SEM_POLITICA = "Captação pelo Max não está liberada para você nesta imobiliária.";
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
    `Você atingiu o limite de envios de captação pelo Max por hoje${p.limite ? ` (${p.limite})` : ""}. O resto é pela tela: ${p.link}`,
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
  bloqueios: { codigo: string }[];
  emBranco: number;
  version: number | null;
}

/** `captacao.preflight`: boolean `pronto` obrigatório; o resto tem padrão vazio. */
export function lerPreflight(raw: unknown): PreflightLido | null {
  const o = obj(raw);
  if (typeof o.pronto !== "boolean") return null;
  const faltantes = lista(o.faltantes).flatMap((x): FaltanteDeCaptacao[] => {
    const f = obj(x);
    const path = str(f.path);
    const rotulo = str(f.rotulo);
    if (!path || !rotulo) return [];
    const etapa = str(f.etapa);
    const dono = str(f.proprietarioId);
    return [{ path, rotulo, ...(etapa ? { etapa } : {}), ...(dono ? { proprietarioId: dono } : {}) }];
  });
  const bloqueios = lista(o.bloqueios).flatMap((x) => {
    const codigo = str(obj(x).codigo);
    return codigo ? [{ codigo }] : [];
  });
  return {
    pronto: o.pronto, faltantes, bloqueios,
    emBranco: typeof o.emBranco === "number" && o.emBranco > 0 ? Math.floor(o.emBranco) : 0,
    version: typeof o.version === "number" ? o.version : null,
  };
}

const ETAPA_DA_TELA: Record<string, string> = {
  imovel: "imóvel", proprietarios: "proprietários", condicoes: "condições", locacao: "locação", assinantes: "assinantes",
};
/** Bloqueios do preflight (código do checklist, não do envio) que o Max sabe dizer em português. */
const TEXTO_DO_BLOQUEIO: Record<string, string> = {
  soma_percentuais: "a soma dos percentuais dos proprietários não fecha 100%",
};
const bloqueioEmTexto = (codigo: string) => TEXTO_DO_BLOQUEIO[codigo] ?? `pendência "${codigo.replace(/_/g, " ")}"`;

/**
 * O que a conferência diz, em frase. `nomes` liga `proprietarioId` ao nome que
 * o fluxo guardou — o preflight não traz nome (nem valor) de propósito.
 */
export function textoDoPreflight(raw: unknown, nomes: Record<string, string> = {}): string {
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
  if (pf.bloqueios.length) linhas.push(`Antes de enviar: ${pf.bloqueios.map((b) => bloqueioEmTexto(b.codigo)).join("; ")}.`);
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
  const cep = /(?<!\d)(\d{5})-?(\d{3})(?!\d)/.exec(texto);
  if (cep) dados.cep = `${cep[1]}-${cep[2]}`;
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

/** Eco de "Rua X, 100, Bairro, Cidade/UF" a partir do `dados.imovel` já lido. */
function ecoDoImovel(imovel: Record<string, unknown> | undefined): string {
  if (!imovel) return "";
  const cidadeUf = [imovel.cidade, imovel.uf].filter(Boolean).join("/");
  return [imovel.rua, imovel.numero, imovel.bairro, cidadeUf].filter(Boolean).join(", ");
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
  | "data" | "moeda" | "percentual" | "inteiro" | "booleano" | "estado_civil" | "nome";

/** Os campos de nível `envio`/`ficha` que o Max sabe preencher. Path desconhecido vai para a tela. */
const TIPO_DO_PATH: Record<string, TipoDeCampo> = {
  "imovel.endereco": "endereco_imovel", "imovel.tipo": "tipo_imovel", "imovel.matricula": "texto", "imovel.cartorio": "texto",
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
};

const PERGUNTA_FORA = /\?\s*$|^(como|quando|onde|por que|porque|o que|qual|quais|quanto|quem|me (fala|diz|explica)|tem como)\b/;

function nomeDoDono(f: FluxoCaptacao, id?: string): string | undefined {
  return id ? f.proprietarios?.find((p) => p.id === id)?.nome : undefined;
}

function perguntaDoFaltante(f: FluxoCaptacao, fa: FaltanteDeCaptacao): string {
  const tipo = TIPO_DO_PATH[fa.path];
  const dono = nomeDoDono(f, fa.proprietarioId);
  const de = fa.path.startsWith("proprietarios[]") ? (dono ? ` de ${dono}` : " do proprietário") : fa.path.startsWith("imovel.") && fa.path !== "imovel.endereco" ? " do imóvel" : "";
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

/** Lê a resposta a UM faltante e devolve o patch (só aquele campo) ou o erro. */
async function lerFaltante(f: FluxoCaptacao, fa: FaltanteDeCaptacao, texto: string, extrair: ExtratorDeSecao): Promise<Leitura> {
  const tipo = TIPO_DO_PATH[fa.path];
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

type CapacidadeDoFluxo = "captacao.create" | "captacao.send" | "captacao.list";

function gatePolitica(ctx: ContextoDoTurno, podeEscrever: boolean, cap: CapacidadeDoFluxo): Resposta | null {
  if (!podeEscrever) return resposta(null, TEXTO_CAPTACAO_SEM_POLITICA, "captacao_sem_usuario");
  if (ctx.politicaIndisponivel) return resposta(null, TEXTO_POLITICA_INDISPONIVEL, "captacao_politica_indisponivel");
  if (!ctx.policy.includes(cap)) return resposta(null, TEXTO_CAPTACAO_SEM_POLITICA, "captacao_sem_politica");
  return null;
}

/** 403 de política/RBAC/esteira no servidor: o texto certo para cada `error`. */
function textoDeNegado(r: { status: number; body: Record<string, unknown> }): { reply: string; evento: string } {
  const erro = str(r.body.error);
  if (erro === "captacao_desligada") return { reply: TEXTO_DESLIGADA, evento: "captacao_desligada" };
  return { reply: TEXTO_CAPTACAO_SEM_POLITICA, evento: `captacao_403_${erro ?? "rbac"}` };
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
    return id && nome ? [{ id, nome, ...(str(m.resumo) ? { resumo: str(m.resumo)! } : {}) }] : [];
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
  return seguirParaNomeOuImovel(g(f, ctx, { modeloId: modelos[0]!.id, modelos: undefined }), ctx, deps, `${prefixo}${aviso}`);
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
    return pedirConfirmacaoDeCriacao(g(f, ctx, { criacao: { chave: "", dados } }), ctx, `${prefixo}${eco}`);
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

/** Resumo de imóvel + condições e o "sim" que de fato cria (achado 17: nunca grava sem confirmação). */
function pedirConfirmacaoDeCriacao(f: FluxoCaptacao, ctx: ContextoDoTurno, prefixo: string): Resposta {
  const dados = f.criacao?.dados ?? {};
  const linhas = [
    ecoDoImovel(dados.imovel) ? `Imóvel: ${ecoDoImovel(dados.imovel)}.` : "",
    temCondicoesEm(dados) ? `Condições: ${ecoDasCondicoes({ condicoes: dados.condicoes ?? {}, locacao: dados.locacao ?? {} })}.` : "",
  ].filter(Boolean);
  const titulo = f.nome ? ` ("${f.nome}")` : "";
  return resposta(
    g(f, ctx, { etapa: "confirmar_criacao", tentativas: 0 }),
    `${prefixo}${linhas.join("\n")}${linhas.length ? "\n" : ""}Posso criar o rascunho${titulo}? Responda *sim* (ou CANCELAR).`,
    "captacao_confirmar_criacao"
  );
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
  if (!captacaoEnvioLigado()) return resposta(null, "O envio de captação pelo Max ainda não está ligado. Envie pela tela do sistema.", "captacao_envio_desligado");
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

// ─── Condução ────────────────────────────────────────────────────────────

const CANCELA = /^(cancela|cancelar|desisto|desistir|para|parar|pare)$/;
const FIM = /^(fim|fim\.?|terminei|acabou|pronto|so isso|e so isso|so esse|so esses|nao tem mais|sem mais|nenhum|nenhuma|nao|n|ja deu|chega)$/;
const PULAR = /^(pular|pula|depois|deixa|deixa pra depois|completo depois|completo na tela|pulei)$/;
// "sim" solto NÃO envia: o resumo ensina a palavra, e um "sim" a outra pergunta do modelo não pode disparar o envio.
const ENVIAR = /^(enviar|envia|enviar sim|sim,? enviar|sim,? envia|pode enviar|pode enviar sim|enviar agora|confirmo o envio|manda enviar)$/;
const ENVIAR_BRANCOS = /^(enviar assim mesmo|envia assim mesmo|enviar mesmo assim|envia mesmo assim|pode enviar assim mesmo|sim,? enviar assim mesmo|sim,? assim mesmo|assim mesmo)$/;

export function confirmaEnvio(texto: string): boolean {
  return ENVIAR.test(normalizar(texto));
}
export function confirmaBrancos(texto: string): boolean {
  return ENVIAR_BRANCOS.test(normalizar(texto));
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
    case "confirmar_criacao": return `${cab}responda *sim* para criar o rascunho, ou CANCELAR.`;
    case "proprietarios": return `${cab}mande o próximo proprietário, ou FIM.`;
    case "extras": return `${cab}tem testemunha ou outra pessoa para assinar? Mande nome e e-mail/telefone, ou diga NÃO.`;
    case "confirmar_pessoas": return `${cab}responda *sim* para gravar os dados, ou CANCELAR.`;
    case "faltantes": {
      const fa = f.faltantes?.[0];
      return fa ? `${cab}${perguntaDoFaltante(f, fa)}` : `${cab}mande CANCELAR para parar.`;
    }
    case "confirmar_faltantes": return `${cab}responda *sim* para eu gravar estes dados, ou CANCELAR.`;
    case "canal": return `${cab}por qual canal envio: 1) e-mail 2) WhatsApp 3) aceite por WhatsApp?`;
    case "selecao": return `${cab}qual rascunho envio? Responda com o número.`;
    case "revisao": return `${cab}responda *enviar* para enviar, ou CANCELAR.`;
    case "brancos": return `${cab}responda *enviar assim mesmo*, ou CANCELAR.`;
    case "enviando": return `Sobre o envio da captação${lembrete(f)}: ainda estou conferindo; me pergunte "como está a captação" que eu confiro.`;
    default: return `${cab}mande CANCELAR para parar.`;
  }
}

function cancelar(f: FluxoCaptacao): Resposta {
  if (f.chave) {
    return resposta(null, `Parei. Se o envio chegou ao sistema, o estado aparece na tela: ${linkDe(f.captacaoId)}`, "captacao_cancelado_envio_incerto");
  }
  return f.captacaoId
    ? resposta(null, `Parei. O rascunho${lembrete(f)} fica salvo na tela: ${linkDe(f.captacaoId)}`, "captacao_cancelado")
    : resposta(null, "Parei. Nada foi criado.", "captacao_cancelado");
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
  // "canal" entra no caminho de ENVIO (escolhido antes do resumo): quem só tem
  // `captacao.send` precisa poder escolher o canal de um rascunho que já
  // existe. O complemento que ele dispara (se houver `proprietarios` conhecidos)
  // ainda passa pela RBAC real do servidor.
  if (etapa === "revisao" || etapa === "brancos" || etapa === "selecao" || etapa === "canal") return "captacao.send";
  if (etapa === "enviando") return "captacao.list";
  // Achado 2 (revisão opus): "verificar" só LÊ (`captacao.preflight`) — nunca
  // deveria exigir `captacao.create`. Quem foi REBAIXADO de canal/revisão/
  // brancos (`rebaixarFluxo`, interrupção no meio do envio) ou ficou sem
  // resposta do preflight (`verificar`, abaixo) continua só com send/list;
  // exigir create aqui travava esse usuário pra sempre, sem conseguir nem
  // retomar o próprio envio.
  if (etapa === "verificar") return "captacao.list";
  return "captacao.create";
}

export async function conduzirCaptacao(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, podeEscrever: boolean): Promise<PassoDoFluxo> {
  const t = normalizar(ctx.texto);
  if (CANCELA.test(t) || /\b(cancela a captacao|desisto|nao quero mais)\b/.test(t)) return cancelar(f);

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

  // Consulta no meio do fluxo: resposta fixa, e o fluxo continua.
  const outro = pedeCaptacao(ctx.texto);
  if (outro === "listar" && f.etapa !== "enviando") {
    const r = await responderListaDeCaptacao(ctx, deps, podeEscrever);
    const gg = g(f, ctx);
    return resposta(gg, `${r.reply}\n\n${continuacaoCaptacao(gg)}`, `${r.evento}_no_fluxo`);
  }

  switch (f.etapa) {
    case "natureza": return conduzirNatureza(f, t, ctx, deps);
    case "nome": return conduzirNome(f, ctx, deps);
    case "modelo": return conduzirModelo(f, t, ctx, deps);
    case "imovel": return conduzirImovel(f, t, ctx, deps);
    case "condicoes": return conduzirCondicoes(f, t, ctx, deps);
    case "confirmar_criacao": return conduzirConfirmarCriacao(f, t, ctx, deps);
    case "proprietarios": return conduzirProprietarios(f, t, ctx, deps);
    case "extras": return conduzirExtras(f, t, ctx, deps);
    case "confirmar_pessoas": return conduzirConfirmarPessoas(f, t, ctx, deps);
    case "verificar": return verificar(f, ctx, deps, "");
    case "faltantes": return conduzirFaltantes(f, t, ctx, deps);
    case "confirmar_faltantes": return conduzirConfirmarFaltantes(f, t, ctx, deps);
    case "canal": return conduzirCanal(f, t, ctx, deps);
    case "selecao": return conduzirSelecao(f, t, ctx, deps);
    case "revisao": return conduzirRevisao(f, ctx, deps);
    case "brancos": return conduzirBrancos(f, ctx, deps);
    case "enviando": return conferirEnvio(f, ctx, deps);
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
  const g1 = g(f, ctx, { modeloId: m.id, modelos: undefined, tentativas: 0 });
  // 409 `escolher_modelo` no meio da criação: os dados já colhidos seguem e a criação é refeita.
  if (f.criacao) return criar(g1, ctx, deps, f.criacao.dados, `Modelo: ${m.nome}. `);
  return seguirParaNomeOuImovel(g1, ctx, deps, `Modelo: ${m.nome}. `);
}

// ── imóvel e condições → confirmação → cria o rascunho ──

async function conduzirImovel(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  if (PULAR.test(t)) {
    const dados: DadosDeCaptacao = { ...(f.criacao?.dados ?? {}) };
    if (temCondicoesEm(dados)) return pedirConfirmacaoDeCriacao(g(f, ctx, { criacao: { chave: "", dados } }), ctx, "Sem imóvel por ora. ");
    return resposta(g(f, ctx, { etapa: "condicoes", tentativas: 0, criacao: { chave: "", dados } }), `Sem imóvel por ora. ${textoDasCondicoes(f.tipo ?? "venda")}`, "captacao_condicoes");
  }
  if (PERGUNTA_FORA.test(t)) return pausar(f);
  const extrair: ExtratorDeSecao = async (texto, secao) => (deps.extrairCaptacao ? deps.extrairCaptacao(texto, secao) : null);
  const r = await lerImovel(ctx.texto, extrair);
  if (r.erro) return falhou(f, r.erro, ctx);
  const dados: DadosDeCaptacao = { ...(f.criacao?.dados ?? {}), imovel: r.dados };
  const eco = `Anotei o imóvel: ${ecoDoImovel(r.dados)}.\n`;
  if (temCondicoesEm(dados)) return pedirConfirmacaoDeCriacao(g(f, ctx, { criacao: { chave: "", dados } }), ctx, eco);
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
  return pedirConfirmacaoDeCriacao(g(f, ctx, { tentativas: 0, criacao: { chave: "", dados } }), ctx, eco);
}

/** Achado 17: só grava quando a pessoa confirma — "sim" aqui usa a PRÓPRIA messageId como chave de idempotência. */
async function conduzirConfirmarCriacao(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  if (lerConfirmacao(ctx.texto) === "sim") return criar(f, ctx, deps, f.criacao?.dados ?? {}, "");
  if (lerConfirmacao(ctx.texto) === "nao") return cancelar(f);
  if (PERGUNTA_FORA.test(t)) return pausar(f);
  return falhou(f, "Responda *sim* para eu criar o rascunho, ou CANCELAR.", ctx);
}

function nomeDaEsteira(f: FluxoCaptacao) { return NOME_DA_ESTEIRA[f.tipo ?? "venda"]; }

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
      criacao: undefined, proprietarios: [], tentativas: 0,
    });
    return resposta(criado, `${prefixo}Criei o rascunho${lembrete(criado)} ("${f.nome}", ${nomeDaEsteira(f)}). ${TEXTO_PROPRIETARIOS}`, "captacao_criada");
  }
  const erro = str(r.body.error);
  if (r.status === 409 && erro === "escolher_modelo") {
    const modelos = lista(r.body.modelos).flatMap((x): ModeloDeCaptacao[] => {
      const m = obj(x);
      return str(m.id) && str(m.nome) ? [{ id: str(m.id)!, nome: str(m.nome)! }] : [];
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
   *  Um chamador com retry ENTRE turnos (achado nit da revisão opus:
   *  `conduzirConfirmarPessoas`) passa a chave GUARDADA do primeiro "sim" —
   *  senão um "sim" incerto seguido de outro "sim" gera DUAS chaves e um
   *  possível lote em dobro. */
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
      return { ok: true, f: g(atual, ctx, { version: typeof v === "number" ? v : (atual.version ?? 0) + 1 }), prefixo };
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
      const campos = lista(r.body.campos).filter((x): x is string => typeof x === "string").slice(0, 6).join(", ");
      return { ok: false, r: resposta(g(f, ctx), `O sistema não aceitou${campos ? ` (${campos})` : " esse dado"}. Confira e mande de novo.`, "captacao_complemento_invalido") };
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

// ─── Cofre de pendentes (CPF, e-mail, telefone de quem ainda não foi gravado) ─
//
// Achado 17: proprietário/extra só é gravado depois do "sim" do resumo. Até
// lá, o dado de contato não pode sentar em claro no checkpoint — a mesma
// regra que já vale pro resto do fluxo (topo do arquivo). Mesmo desenho do
// cofre do crédito (`cifrarCofre`/`decifrarCofre`), com subchave e AAD
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
 * DADO silenciosa (o resumo seguia mostrando "Vou gravar: Maria" com o cofre
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

async function conduzirProprietarios(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const donos = f.proprietarios ?? [];
  if (FIM.test(t)) {
    if (!donos.length) return resposta(g(f, ctx), `Preciso de pelo menos um proprietário. ${TEXTO_PROPRIETARIOS}`, "captacao_sem_proprietario");
    return resposta(g(f, ctx, { etapa: "extras", tentativas: 0 }), "Tem testemunha ou outra pessoa para assinar? Mande nome e e-mail/telefone (uma por mensagem, e diga \"testemunha\" se for o caso), ou diga NÃO.", "captacao_extras");
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
  // Achado 17: só escreve depois do "sim" — o item (com CPF/telefone/e-mail)
  // fica no cofre cifrado; só id+nome (sem PII) entra no estado em claro.
  // Achado 5: se o cofre JÁ TINHA gente pendente e não abre (chave rotacionada,
  // thread trocada, payload adulterado), NÃO soma este item a um cofre vazio
  // em silêncio — avisa e para, sem gravar nada.
  const abertura = abrirCofreCaptacao(f, ctx);
  if (!abertura.ok) return cofrePerdido(f);
  const cofre = fecharCofreCaptacao({ ...abertura.pendentes, proprietarios: [...abertura.pendentes.proprietarios, item] }, ctx);
  if (cofre === null) return cofrePerdido(f);
  const novo = g(f, ctx, {
    proprietarios: [...donos, { id, nome: p.nome!, ...(p.pj ? { pj: true } : {}) }],
    cofre,
    // Achado E (revisão opus, round 2): o cofre MUDOU — uma `gravarPessoasChave`
    // guardada de uma confirmação anterior (incerta/retentada) não pode
    // sobreviver a isto. Senão o PRÓXIMO "sim" reusa a chave velha pra um lote
    // MAIOR, e um servidor que faz replay por idempotency key (não por
    // conteúdo) devolve a resposta do lote de ANTES — quem acabou de ser
    // somado (este proprietário) nunca é gravado, sem erro nenhum.
    gravarPessoasChave: undefined,
    ...(canalDito ? { canalDito } : {}),
    tentativas: 0,
  });
  const guardou = [p.cpf ? "CPF" : p.cnpj ? "CNPJ" : "", p.telefone ? "telefone" : "", p.email ? "e-mail" : "", p.estadoCivil ? "estado civil" : ""].filter(Boolean);
  return resposta(novo, `Anotei ${p.nome}${guardou.length ? ` (${guardou.join(", ")})` : ""}. Mande o próximo proprietário, ou FIM.`, "captacao_proprietario");
}

async function conduzirExtras(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  if (FIM.test(t) || PULAR.test(t)) return pedirConfirmacaoDePessoas(f, ctx);
  // Achado 6 (mesmo caso do proprietário): "Carlos, carlos@ex.com, ele confirma?"
  // termina em "?" — um sinal barato de contato destrava antes de pausar (sem
  // ele, o e-mail/telefone ia cru pro atendimento normal).
  if (PERGUNTA_FORA.test(t)) {
    const semContato = !lerNumeros(ctx.texto).telefones.length && !lerEmails(ctx.texto).length;
    if (semContato) return pausar(f);
  }
  const extrair: ExtratorDeSecao = async (texto, secao) => (deps.extrairCaptacao ? deps.extrairCaptacao(texto, secao) : null);
  const p = await lerPessoa(ctx.texto, extrair);
  if (p.erro) return falhou(f, p.erro, ctx);
  if (!p.email && !p.telefone) return falhou(f, "Preciso do e-mail ou do telefone dessa pessoa.", ctx);
  const testemunha = /\btestemunha\b/.test(t);
  const id = `x${ctx.messageId.replace(/[^a-zA-Z0-9]/g, "").slice(-12) || ctx.agora}`;
  const pessoa = {
    id, nome: p.nome, ...(p.cpf ? { cpf: p.cpf } : {}), ...(p.email ? { email: p.email } : {}),
    ...(p.telefone ? { telefone: normalizeBrPhone(p.telefone) ?? p.telefone } : {}),
  };
  // Achado 17: também fica pendente (cifrada) até o "sim" do resumo de pessoas.
  // Achado 5: mesmo cuidado do proprietário — cofre que não abre não pode
  // virar "perdi o que já tinha" em silêncio.
  const abertura = abrirCofreCaptacao(f, ctx);
  if (!abertura.ok) return cofrePerdido(f);
  const chave = testemunha ? "testemunhas" : "avulsos";
  const cofre = fecharCofreCaptacao({ ...abertura.pendentes, [chave]: [...abertura.pendentes[chave], pessoa] }, ctx);
  if (cofre === null) return cofrePerdido(f);
  const novo = g(f, ctx, {
    extrasPendentes: [...(f.extrasPendentes ?? []), { id, nome: p.nome!, testemunha }],
    cofre,
    // Achado E: mesmo cuidado de `conduzirProprietarios` — o cofre mudou, a
    // chave velha de uma confirmação anterior não pode sobreviver.
    gravarPessoasChave: undefined,
    tentativas: 0,
  });
  return resposta(novo, `Anotei ${p.nome} como ${testemunha ? "testemunha" : "assinante"}. Mais alguém? Mande a próxima pessoa, ou diga NÃO.`, "captacao_extra");
}

/** Resumo de quem vai ser gravado (proprietários + testemunhas/avulsos pendentes) e o "sim" que grava. */
function pedirConfirmacaoDePessoas(f: FluxoCaptacao, ctx: ContextoDoTurno): Resposta {
  const nomes = [
    ...(f.proprietarios ?? []).map((p) => p.nome),
    ...(f.extrasPendentes ?? []).map((p) => p.nome),
  ];
  const resumoPessoas = nomes.length ? `Vou gravar: ${listaDeNomes(nomes)}.\n` : "";
  return resposta(g(f, ctx, { etapa: "confirmar_pessoas", tentativas: 0 }), `${resumoPessoas}Posso gravar estes dados na captação? Responda *sim* (ou CANCELAR).`, "captacao_confirmar_pessoas");
}

/** Achado 17: o "sim" aqui grava proprietários e extras pendentes NUM lote só, com a própria messageId como chave. */
async function conduzirConfirmarPessoas(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  if (lerConfirmacao(ctx.texto) === "sim") {
    const abertura = abrirCofreCaptacao(f, ctx);
    if (!abertura.ok) return cofrePerdido(f);
    const pendentes = abertura.pendentes;
    const dados: DadosDeCaptacao = {};
    if (pendentes.proprietarios.length) dados.proprietarios = pendentes.proprietarios;
    if (pendentes.testemunhas.length || pendentes.avulsos.length) {
      dados.assinantes = {
        ...(pendentes.testemunhas.length ? { testemunhas: pendentes.testemunhas } : {}),
        ...(pendentes.avulsos.length ? { avulsos: pendentes.avulsos } : {}),
      };
    }
    if (!Object.keys(dados).length) return verificar(g(f, ctx, { etapa: "verificar" }), ctx, deps, "");
    // Nit (revisão opus): a chave sobrevive a um "sim" incerto/falho — o
    // PRÓXIMO "sim" reusa a MESMA chave em vez de abrir uma nova gravação.
    const chave = f.gravarPessoasChave || ctx.messageId;
    const r = await complementar(g(f, ctx, { gravarPessoasChave: chave }), ctx, deps, dados, chave);
    if (!r.ok) return r.r;
    const limpo = g(r.f, ctx, { etapa: "verificar", tentativas: 0, cofre: undefined, extrasPendentes: undefined, gravarPessoasChave: undefined });
    return verificar(limpo, ctx, deps, `${r.prefixo}Gravado.\n`);
  }
  if (lerConfirmacao(ctx.texto) === "nao") return cancelar(f);
  if (PERGUNTA_FORA.test(t)) return pausar(f);
  return falhou(f, "Responda *sim* para eu gravar estes dados, ou CANCELAR.", ctx);
}

// ── conferência (preflight), faltantes e resumo ──

/** `captacao.preflight`: pergunta só os `faltantes`; sem eles, o resumo. */
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

  // Só pergunta o que o Max sabe preencher; o resto (campo personalizado…) é da tela.
  const perguntaveis = pf.faltantes.filter((x) => TIPO_DO_PATH[x.path]);
  const daTela = pf.faltantes.filter((x) => !TIPO_DO_PATH[x.path]);
  if (perguntaveis.length) {
    const cab = `${prefixo}${textoDoPreflight({ ...r.body, bloqueios: [], emBranco: 0 }, nomes)}\n`;
    const fa = perguntaveis[0]!;
    return resposta(g(base, ctx, { etapa: "faltantes", faltantes: perguntaveis }), `${cab}${perguntaDoFaltante(base, fa)}`, "captacao_faltantes");
  }
  if (daTela.length || pf.bloqueios.length) {
    return resposta(g(base, ctx, { etapa: "verificar" }), `${prefixo}${textoDoPreflight(r.body, nomes)}\nO rascunho${lembrete(f)} está salvo. Ajuste pela tela: ${linkDe(f.captacaoId)}`, "captacao_bloqueios");
  }
  return resumir(base, pf, ctx, deps, prefixo);
}

async function conduzirFaltantes(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const fa = f.faltantes?.[0];
  if (!fa) return verificar(f, ctx, deps, "");
  if (PULAR.test(t)) {
    // Item 2 (revisão opus, round 3): "pular" para de PERGUNTAR — mas não pode
    // jogar fora resposta que a pessoa já tinha dado nesta rodada (acumulada
    // no cofre, ainda não gravada), nem GRAVAR sozinho. Toda escrita exige
    // resumo + "sim" explícito (regra de topo do arquivo) — "pular" não é
    // exceção: se há algo pendente no cofre, mostra o resumo de novo e só
    // grava no próximo "sim" (com a messageId DESSE "sim" como chave).
    const abertura = abrirCofreCaptacao(f, ctx);
    if (!abertura.ok) return cofrePerdido(f);
    if (abertura.pendentes.faltantes && Object.keys(abertura.pendentes.faltantes).length) {
      return pedirConfirmacaoDeFaltantes(g(f, ctx, { faltantes: [] }), ctx, "Certo, paro de perguntar. ");
    }
    return resposta(null, `Certo. O rascunho${lembrete(f)} fica salvo; complete pela tela: ${linkDe(f.captacaoId)}`, "captacao_faltante_pulado");
  }
  if (PERGUNTA_FORA.test(t)) return pausar(f);
  const extrair: ExtratorDeSecao = async (texto, secao) => (deps.extrairCaptacao ? deps.extrairCaptacao(texto, secao) : null);
  const lido = await lerFaltante(f, fa, ctx.texto, extrair);
  if (lido === "vazio") return falhou(f, "Não entendi.", ctx);
  if ("erro" in lido) return falhou(f, lido.erro, ctx);
  // Item B (revisão opus, round 2 — regra de escrita): a resposta a um
  // faltante NUNCA grava direto. Acumula no cofre (mesma regra do resto do
  // fluxo — CPF/telefone/e-mail não sentam em claro no checkpoint) e só vai
  // ao servidor quando a pessoa confirmar explicitamente, com a messageId
  // DESSA confirmação como chave de idempotência.
  const abertura = abrirCofreCaptacao(f, ctx);
  if (!abertura.ok) return cofrePerdido(f);
  const acumulado = mesclarDadosDeCaptacao(abertura.pendentes.faltantes ?? {}, lido.dados);
  const cofre = fecharCofreCaptacao({ ...abertura.pendentes, faltantes: acumulado }, ctx);
  if (cofre === null) return cofrePerdido(f);
  const resto = (f.faltantes ?? []).slice(1);
  // Nit 1: acumula o rótulo (sem o valor) deste faltante — dedupe por path,
  // pra `pedirConfirmacaoDeFaltantes` conseguir listar TODOS os respondidos.
  const rotulosAcumulados = [...(f.faltantesAcumulados ?? []).filter((x) => x.path !== fa.path), { path: fa.path, rotulo: fa.rotulo }];
  const base = g(f, ctx, { faltantes: resto, cofre, faltantesAcumulados: rotulosAcumulados, tentativas: 0 });
  if (resto.length) {
    return resposta(base, `Anotei: ${lido.eco}.\n${perguntaDoFaltante(base, resto[0]!)}`, "captacao_faltantes");
  }
  return pedirConfirmacaoDeFaltantes(base, ctx, "");
}

/**
 * Resumo do que foi respondido (ainda no cofre) e o "sim" que de fato grava —
 * mesmo molde de `pedirConfirmacaoDePessoas`. Nit 1 (revisão opus, round 3):
 * lista TODOS os campos pendentes por RÓTULO (nunca o valor — mesma regra do
 * resto do cofre), incluindo os de uma rodada anterior (PULAR no meio).
 */
function pedirConfirmacaoDeFaltantes(f: FluxoCaptacao, ctx: ContextoDoTurno, prefixo: string): Resposta {
  const rotulos = (f.faltantesAcumulados ?? []).map((x) => x.rotulo);
  const resumoCampos = rotulos.length ? `Vou gravar: ${listaDeNomes(rotulos)}.\n` : "";
  return resposta(
    g(f, ctx, { etapa: "confirmar_faltantes", tentativas: 0 }),
    `${prefixo}${resumoCampos}Posso gravar estes dados na captação? Responda *sim* (ou CANCELAR).`,
    "captacao_confirmar_faltantes"
  );
}

/** Item B: o "sim" aqui grava o(s) faltante(s) pendente(s) no cofre, com a própria messageId como chave. */
async function conduzirConfirmarFaltantes(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  if (lerConfirmacao(ctx.texto) === "sim") {
    const abertura = abrirCofreCaptacao(f, ctx);
    if (!abertura.ok) return cofrePerdido(f);
    const dados = abertura.pendentes.faltantes;
    if (!dados || !Object.keys(dados).length) return verificar(g(f, ctx, { etapa: "verificar" }), ctx, deps, "");
    const r = await complementar(f, ctx, deps, dados, ctx.messageId);
    if (!r.ok) return r.r;
    // Nit 3 (revisão opus, round 3): a gravação JÁ aconteceu — os faltantes
    // pendentes têm que sumir do cofre de qualquer jeito. Se `fecharCofreCaptacao`
    // falhar (chave rotacionada etc.), manter o `f.cofre` ANTIGO intacto
    // deixava o que acabou de ser gravado lá dentro, pra um "sim"/PULAR
    // seguinte reenviar (e reexibir) de novo. Fail-closed: descarta o cofre
    // inteiro em vez de arriscar reenvio de dado já gravado.
    const cofre = fecharCofreCaptacao({ ...abertura.pendentes, faltantes: undefined }, ctx);
    const limpo = g(r.f, ctx, { etapa: "verificar", tentativas: 0, cofre: cofre ?? undefined, faltantesAcumulados: undefined });
    return verificar(limpo, ctx, deps, `${r.prefixo}Gravado.\n`);
  }
  if (lerConfirmacao(ctx.texto) === "nao") return cancelar(f);
  if (PERGUNTA_FORA.test(t)) return pausar(f);
  return falhou(f, "Responda *sim* para eu gravar estes dados, ou CANCELAR.", ctx);
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

async function resumir(f: FluxoCaptacao, pf: PreflightLido, ctx: ContextoDoTurno, deps: DepsDoFluxo, prefixo: string): Promise<Resposta> {
  const opc = await deps.acao("captacao.options", { captacaoId: f.captacaoId });
  const dados = opc?.status === 200 ? opc.body : null;
  const doResumo = [
    `${prefixo}Pronta a captação${lembrete(f)}${f.nome ? ` — ${f.nome}` : ""}.`,
    pf.emBranco > 0 ? `${pf.emBranco} campo(s) vão em branco no contrato (dá para completar na tela: ${linkDe(f.captacaoId)}).` : "",
  ].filter(Boolean);
  const semEnvio = !captacaoEnvioLigado() || !ctx.policy.includes("captacao.send");
  if (semEnvio) {
    return resposta(null, `${doResumo.join("\n")}\nO envio para assinatura é pela tela: ${linkDe(f.captacaoId)}`, "captacao_pronta_sem_envio");
  }
  if (dados && dados.assinaturaConfigurada === false) {
    return resposta(null, `${doResumo.join("\n")}\n${TEXTO_POR_CODIGO.clicksign_nao_conectada({ link: "" })}`, "captacao_pronta_sem_clicksign");
  }
  // Achado 3 (revisão opus): o canal dito/escolhido só é aplicado no servidor
  // quando há IDS locais de proprietário (`f.proprietarios`, só existe no
  // caminho de CRIAÇÃO). No caminho de ENVIO de um rascunho JÁ EXISTENTE
  // (`iniciarEnvioDeCaptacao`), `f.proprietarios` nunca é preenchido — o Max
  // não tem como saber o id de quem já está na captação, então não há como
  // mandar `captacao.create{proprietarios:[{id,canal}]}`. Antes, isso fazia
  // "por aceite no WhatsApp" ir por e-mail, em silêncio. Agora avisa — nunca
  // finge que aplicou.
  const semIdsLocais = !f.proprietarios?.length;
  // Achado 23/28: o canal só se pergunta se a pessoa nunca disse qual quer — e as
  // 3 opções aparecem ANTES do resumo de envio, não depois de propor e-mail sem perguntar.
  // Item C (revisão opus, round 2): SEM ids locais, não há como aplicar
  // NENHUMA resposta ao 1/2/3 (achado 3, acima) — perguntar só pra depois
  // avisar "não consigo trocar" é pergunta inútil. Só pergunta quando dá pra
  // valer a escolha; sem ids locais, segue direto pro resumo com o canal que
  // já está no servidor, e o aviso (abaixo) fica reservado pra quando a
  // pessoa MESMO ASSIM nomeou um canal (na mensagem, não pelo 1/2/3).
  if (!f.canalDito && !semIdsLocais) {
    return resposta(
      g(f, ctx, { etapa: "canal", emBranco: pf.emBranco }),
      `${doResumo.join("\n")}\nPor qual canal envio? Responda com o número:\n1. E-mail\n2. WhatsApp\n3. Aceite por WhatsApp`,
      "captacao_pergunta_canal"
    );
  }
  const avisoCanal = semIdsLocais && f.canalDito
    ? `Não consigo trocar o canal deste rascunho por aqui (sem acesso aos ids de proprietário já cadastrados); o envio usa o canal que já está na tela. Para mudar, ajuste em: ${linkDe(f.captacaoId)}\n`
    : "";
  // Nit 2: com ids locais, usa a prévia do servidor (que já traz testemunhas e
  // outros assinantes, não só os proprietários) e aplica o canal ESCOLHIDO
  // nesta conversa por cima — sem `dados`, cai no fallback só-proprietários
  // de antes (ainda correto, só não lista quem mais assina).
  const quem = !semIdsLocais
    ? dados
      ? frasesDoEnvio(comCanalLocalAplicado(dados.assinantes, f.proprietarios, f.canalDito))
      : `${listaDeNomes(f.proprietarios!.map((p) => p.nome))} por ${CANAL[f.canalDito!]}`
    : dados ? frasesDoEnvio(dados.assinantes) : null;
  const pergunta = quem
    ? `Envio para ${quem}? Responda *enviar* (ou CANCELAR).`
    : `Envio para as pessoas marcadas para assinar? Responda *enviar* (ou CANCELAR).`;
  return resposta(g(f, ctx, { etapa: "revisao", chave: f.chave, emBranco: pf.emBranco }), `${doResumo.join("\n")}\n${avisoCanal}${pergunta}`, "captacao_revisao");
}

/**
 * Achado 23/28: lê o canal escolhido. Item A (revisão opus, round 2 — regra
 * de escrita): escolher o canal NÃO é "sim"/"enviar" — só GUARDA a escolha.
 * O resumo (`resumir()`) já mostra o canal escolhido na frase ("Envio para
 * Maria por WhatsApp?"), e é o "enviar" explícito ali (`conduzirRevisao`) que
 * aplica a escolha no servidor, com a messageId DESSA confirmação como chave.
 */
async function conduzirCanal(f: FluxoCaptacao, t: string, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const POR_NUMERO: Record<string, CanalDeEnvio> = { "1": "email", "2": "whatsapp", "3": "aceite" };
  const n = /^(?:opcao\s*|numero\s*|n\s*)?([123])$/.exec(t);
  const canal = (n ? POR_NUMERO[n[1]!] : undefined) ?? canalDoTexto(ctx.texto);
  if (!canal) {
    if (PERGUNTA_FORA.test(t)) return pausar(f);
    return falhou(f, "Responda 1 para e-mail, 2 para WhatsApp ou 3 para aceite por WhatsApp.", ctx);
  }
  return verificar(g(f, ctx, { canalDito: canal, etapa: "verificar", tentativas: 0 }), ctx, deps, "");
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

async function conduzirRevisao(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  // Achado 25: o resumo já avisou os campos em branco — então o "enviar" aqui
  // já manda `confirmarBrancos`, numa confirmação só (não pede "enviar assim
  // mesmo" de novo por um branco que já tinha sido dito).
  if (confirmaEnvio(ctx.texto)) return confirmarEEnviar(f, ctx, deps, (f.emBranco ?? 0) > 0);
  if (lerConfirmacao(ctx.texto) === "nao") return cancelar(f);
  // Qualquer outra coisa NÃO envia: o resumo vale só para o "enviar" explícito.
  return pausar(f);
}

/**
 * Item A: o "enviar" É a confirmação — aplica o canal escolhido (quando há
 * ids locais pra aplicar, achado 3) com uma chave PRÓPRIA (`:canal`, nunca a
 * mesma do envio) e só então manda o `captacao.send`, com a versão que o
 * complemento devolveu. `!f.chave` é o que distingue a PRIMEIRA tentativa
 * deste "enviar" de um retry do MESMO envio (send sem resposta, 202 em
 * andamento…): reaplicar o canal a cada retry bumpa a versão à toa e troca a
 * chave de idempotência do `captacao.send` debaixo do pé do "não duplica".
 */
async function confirmarEEnviar(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, confirmarBrancos: boolean): Promise<PassoDoFluxo> {
  const precisaAplicarCanal = !f.chave && !!f.canalDito && !!f.proprietarios?.length;
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
    // mostrado e este "enviar" — reenviar sozinho com a versão nova mandaria
    // conteúdo que o usuário nunca viu. Volta pro resumo (novo preflight,
    // nova confirmação), a confirmação antiga não vale mais.
    if ("versaoDesatualizada" in r) {
      return verificar(g(f, ctx, { etapa: "verificar", chave: undefined }), ctx, deps, `${TEXTO_POR_CODIGO.versao_desatualizada({ link: linkDe(f.captacaoId) })}\n`);
    }
    return r.r;
  }
  return enviar(r.f, ctx, deps, confirmarBrancos);
}

async function conduzirBrancos(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  if (confirmaBrancos(ctx.texto)) return enviar(f, ctx, deps, true);
  if (lerConfirmacao(ctx.texto) === "nao") return cancelar(f);
  return pausar(f);
}

/**
 * `captacao.send{captacaoId, version, confirmarBrancos}`. A chave (a `messageId`
 * do "enviar") fica guardada; sem resposta, o "enviar" seguinte REPETE a mesma
 * chave e os mesmos args — o servidor devolve o resultado gravado, não envia de
 * novo. Depois de um 202 o fluxo só CONFERE (`captacao.list`), nunca reenvia.
 */
async function enviar(f: FluxoCaptacao, ctx: ContextoDoTurno, deps: DepsDoFluxo, confirmarBrancos: boolean): Promise<PassoDoFluxo> {
  if (!captacaoEnvioLigado() || !ctx.policy.includes("captacao.send")) {
    return resposta(null, `O envio pelo Max não está liberado. Envie pela tela: ${linkDe(f.captacaoId)}`, "captacao_envio_nao_liberado");
  }
  if (typeof f.version !== "number" || !f.captacaoId) return verificar(g(f, ctx, { etapa: "verificar" }), ctx, deps, "");
  const mesmo = f.chave && f.chave.version === f.version && !!f.chave.confirmarBrancos === confirmarBrancos;
  const chave = mesmo ? f.chave! : { verbo: "captacao.send", valor: ctx.messageId, em: ctx.agora, version: f.version, ...(confirmarBrancos ? { confirmarBrancos: true } : {}) };
  const emCurso = g(f, ctx, { etapa: "enviando", chave });
  const args: Record<string, unknown> = { captacaoId: f.captacaoId, version: f.version, ...(confirmarBrancos ? { confirmarBrancos: true } : {}) };
  const r = await deps.acao("captacao.send", args, chave.valor);
  if (!r) {
    return resposta({ ...emCurso, etapa: f.etapa === "brancos" ? "brancos" : "revisao" }, "Não consegui confirmar o envio agora. Responda *enviar* de novo para eu conferir — não duplica.", "captacao_envio_incerto");
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
    const emBranco = typeof r.body.emBranco === "number" ? r.body.emBranco : f.emBranco ?? 0;
    return resposta(g(f, ctx, { etapa: "brancos", chave: undefined, emBranco }), TEXTO_POR_CODIGO.confirmar_brancos({ link: url, emBranco }), "captacao_confirmar_brancos");
  }
  if (erro === "versao_desatualizada") {
    // Alguém mudou a captação: confere de novo e o resumo volta (a confirmação anterior não vale).
    return verificar(g(f, ctx, { etapa: "verificar", chave: undefined }), ctx, deps, `${TEXTO_POR_CODIGO.versao_desatualizada({ link: url })}\n`);
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
