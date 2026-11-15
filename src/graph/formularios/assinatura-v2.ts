/**
 * O passo da assinatura (PR-D, T13): testemunhas e tipo de assinatura. A parte pura e a ÚNICA
 * escrita deste arquivo (`definirTestemunhas`).
 *
 * Contrato (CONTRATO max.md §18.13.3 e §18.13.12):
 *  - o catálogo de testemunhas é `options.testemunhas.padrao`, POR ESCOPO da organização. Não existe
 *    padrão por corretor e "salvar como padrão" não é verbo do Max: a resposta é o link das
 *    Configurações (`linkConfiguracoes`) e NADA é gravado (D5);
 *  - `proposal.witnesses.set` grava o conjunto FINAL (0..4). Quem decide o teto, a quantidade mínima
 *    e as obrigatórias é o servidor (422 `teto_testemunhas`, `testemunha_obrigatoria`): o Max não
 *    recalcula, só traduz a recusa em frase;
 *  - `tiposDeAssinatura` é uma ESTIMATIVA (o preflight é a autoridade). O que não está
 *    `disponivel` não aparece, com UMA exceção: o Aceite que só falta o celular de quem assina
 *    (`assinante_sem_celular`), porque o celular se pergunta ANTES do preflight (envio-v2).
 *
 * Nenhum texto daqui leva CPF, e-mail ou celular (o contrato também não os manda). Nada vai ao
 * checkpoint: ids opacos (`idPadrao`) e escolhas.
 */

import type { DepsDoFluxo } from "../fluxos";
import { normalizar } from "../tools";
import type { OpcaoDeAssinatura, OptionsV2, Pendencia, RegraDeTestemunhas, TipoDeAssinatura } from "./contrato";
import { ehFluxoDesligado } from "./selecao";

type DepsAcao = Pick<DepsDoFluxo, "acao">;

// ─── A escrita: proposal.witnesses.set ──────────────────────────────────────

export type ErroDeTestemunhas =
  | "teto_testemunhas"
  | "testemunha_obrigatoria"
  | "nao_editavel"
  /** 409 `envio_em_andamento`: há um Aceite em emissão numa testemunha atual. Não é "saiu do rascunho". */
  | "envio_em_andamento"
  | "ja_enviada"
  /** 403 `fluxo_desligado`: a flag da esteira desligou; quem chama rebaixa para o v1 sem mensagem de erro. */
  | "fluxo_desligado"
  | "sem_permissao"
  | "nao_encontrada"
  | "dados_invalidos"
  | "signatarios_duplicados"
  /** Sem resposta, ou 409 de operação em curso: o resultado é DESCONHECIDO. A mesma chave repete. */
  | "incerta"
  | "indisponivel"
  /** Chamada sem `x-idempotency-key`: nunca chega ao servidor. */
  | "sem_chave";

export type ResultadoDeTestemunhas =
  | { ok: true; testemunhas: Array<{ nome: string; obrigatoria: boolean; canal?: string }>; faltando: Pendencia[] | null }
  | { ok: false; erro: ErroDeTestemunhas; maximo?: number; estado?: string };

/**
 * Grava o conjunto FINAL de testemunhas da proposta (`escolha` = `idPadrao` do cadastro). A linha do
 * corretor-testemunha não é tocada pelo servidor. `chave` é a `messageId` do PRIMEIRO "sim" do
 * cartão (obrigatória: escrita sem chave nunca sai).
 */
export async function definirTestemunhas(
  deps: DepsAcao,
  proposalId: string,
  escolha: string[],
  chave?: string
): Promise<ResultadoDeTestemunhas> {
  if (!chave) return { ok: false, erro: "sem_chave" };
  const r = await deps.acao("proposal.witnesses.set", { proposta_id: proposalId, testemunhas: escolha.map((idPadrao) => ({ idPadrao })) }, chave);
  if (!r) return { ok: false, erro: "incerta" };
  if (r.status === 200) {
    const lista = Array.isArray(r.body.testemunhas) ? (r.body.testemunhas as Array<Record<string, unknown>>) : [];
    return {
      ok: true,
      testemunhas: lista
        .filter((t) => typeof t.nome === "string")
        .map((t) => ({ nome: t.nome as string, obrigatoria: t.obrigatoria === true, ...(typeof t.canal === "string" ? { canal: t.canal } : {}) })),
      faltando: Array.isArray(r.body.faltando) ? (r.body.faltando as Pendencia[]) : null,
    };
  }
  if (ehFluxoDesligado(r)) return { ok: false, erro: "fluxo_desligado" };
  const erro = typeof r.body.error === "string" ? r.body.error : "";
  if (r.status === 403) return { ok: false, erro: "sem_permissao" };
  if (r.status === 404) return { ok: false, erro: "nao_encontrada" };
  if (r.status === 409) {
    if (erro === "ja_enviada") return { ok: false, erro: "ja_enviada", ...(typeof r.body.estado === "string" ? { estado: r.body.estado } : {}) };
    if (erro === "nao_editavel") return { ok: false, erro: "nao_editavel" };
    if (erro === "envio_em_andamento") return { ok: false, erro: "envio_em_andamento" };
    if (erro === "signatarios_duplicados") return { ok: false, erro: "signatarios_duplicados" };
    // `ja_enviando` / `em_andamento`: a mesma chave ainda está em voo no servidor.
    if (erro === "ja_enviando" || erro === "em_andamento") return { ok: false, erro: "incerta" };
    return { ok: false, erro: "indisponivel" };
  }
  if (r.status === 422) {
    if (erro === "teto_testemunhas") return { ok: false, erro: "teto_testemunhas", ...(typeof r.body.maximo === "number" ? { maximo: r.body.maximo } : {}) };
    if (erro === "testemunha_obrigatoria") return { ok: false, erro: "testemunha_obrigatoria" };
    return { ok: false, erro: "dados_invalidos" };
  }
  if (r.status === 400) return { ok: false, erro: "dados_invalidos" };
  return { ok: false, erro: "indisponivel" };
}

/** O que o corretor lê quando a escrita das testemunhas não fecha. Nunca afirma que gravou. */
export function textoDoErroDeTestemunhas(erro: ErroDeTestemunhas, extra: { maximo?: number } = {}): string {
  switch (erro) {
    case "teto_testemunhas":
      return `Não gravei: o máximo é de ${extra.maximo ?? 4} testemunhas na proposta (a do corretor, se houver, conta). Me diga quais ficam.`;
    case "testemunha_obrigatoria":
      return "Não gravei: há testemunha obrigatória do cadastro que não pode ficar de fora. Me diga de novo quais ficam, mantendo as obrigatórias.";
    case "nao_editavel":
      return "Não gravei: essa proposta não está mais em rascunho, então as testemunhas não mudam por aqui.";
    case "envio_em_andamento":
      return "Não gravei: o envio desta proposta já está em andamento (há um Aceite sendo emitido para uma testemunha), então as testemunhas não mudam agora. Aguarde o resultado do envio e me peça de novo.";
    case "ja_enviada":
      return "Essa proposta já foi enviada para assinatura, então as testemunhas não mudam mais.";
    case "sem_permissao":
      return "Você não tem permissão para mudar as testemunhas dessa proposta por aqui. Peça a quem pode, ou faça pelo sistema.";
    case "nao_encontrada":
      return "Não encontrei essa proposta para você no sistema.";
    case "signatarios_duplicados":
      return "Não gravei: há assinantes repetidos (mesmo CPF ou contato) na proposta. Corrija na tela de propostas.";
    case "dados_invalidos":
      return "Não gravei: o sistema não aceitou essa lista de testemunhas. Me diga de novo quais ficam.";
    case "sem_chave":
    case "incerta":
    case "indisponivel":
    case "fluxo_desligado":
      return "Não consegui falar com o sistema agora, então não gravei as testemunhas. Tenta de novo em instantes.";
  }
}

// ─── O catálogo de testemunhas (do cadastro, por escopo) ────────────────────

export interface TestemunhaDoCatalogo {
  id: string;
  nome: string;
  obrigatoria: boolean;
}

export function regraDeTestemunhas(options: OptionsV2): RegraDeTestemunhas | null {
  const r = options.testemunhas;
  return r && Array.isArray(r.padrao) ? r : null;
}

export function catalogoDeTestemunhas(options: OptionsV2): TestemunhaDoCatalogo[] {
  return (regraDeTestemunhas(options)?.padrao ?? []).map((t) => ({ id: t.idPadrao, nome: t.nome, obrigatoria: t.obrigatoria === true }));
}

/** O par que o servidor semeia na criação (`semearItens`: obrigatórias, depois o padrão até completar o par). */
const TAMANHO_DO_PAR = 2;

/**
 * O padrão POR ESCOPO, como o servidor o semeia (§18.13.12.3): as obrigatórias do cadastro e, depois,
 * o padrão na ordem do cadastro até completar o par, sem passar do `maximo`. NÃO é "o cadastro inteiro":
 * com 4 no cadastro e a testemunha-corretor (que o Max não vê e conta no teto), marcar tudo dava 422
 * `teto_testemunhas` em laço. Não existe padrão por corretor (D5): a função só lê o `options`.
 */
export function marcadasPorPadrao(options: OptionsV2): string[] {
  const cat = catalogoDeTestemunhas(options);
  const maximo = regraDeTestemunhas(options)?.maximo ?? 4;
  const obrigatorias = cat.filter((t) => t.obrigatoria).length;
  let vagas = Math.max(0, Math.min(TAMANHO_DO_PAR, maximo) - obrigatorias);
  return cat
    .filter((t) => {
      if (t.obrigatoria) return true;
      if (vagas <= 0) return false;
      vagas -= 1;
      return true;
    })
    .map((t) => t.id);
}

/** A escolha mais as obrigatórias (que nunca saem), na ordem do cadastro e sem repetir. */
export function comObrigatorias(options: OptionsV2, ids: string[]): string[] {
  const escolhidas = new Set(ids);
  return catalogoDeTestemunhas(options)
    .filter((t) => t.obrigatoria || escolhidas.has(t.id))
    .map((t) => t.id);
}

/** Este passo faz sentido? Sem testemunha no cadastro e sem mínimo, não há o que perguntar. */
export function precisaDePassoDeTestemunhas(options: OptionsV2): boolean {
  const r = regraDeTestemunhas(options);
  return !!r && (r.padrao.length > 0 || r.minimo > 0);
}

export function textoDeTestemunhas(options: OptionsV2, marcadas: string[]): string {
  const r = regraDeTestemunhas(options);
  const cat = catalogoDeTestemunhas(options);
  const faixa = r ? (r.minimo > 0 ? ` (de ${r.minimo} a ${r.maximo})` : ` (até ${r.maximo})`) : "";
  const linhas = cat.map((t, i) => `${i + 1}. ${marcadas.includes(t.id) ? "✅" : "⬜"} ${t.nome}${t.obrigatoria ? " (obrigatória)" : ""}`);
  if (cat.length === 0) {
    return (
      `Esta proposta pede pelo menos ${r?.minimo ?? 0} testemunha${(r?.minimo ?? 0) === 1 ? "" : "s"} e o cadastro da imobiliária não tem nenhuma. ` +
      `Cadastre em Configurações${r?.linkConfiguracoes ? `: ${r.linkConfiguracoes}` : ""} e me peça o envio de novo.`
    );
  }
  return [
    `Testemunhas desta proposta${faixa}:`,
    ...linhas,
    "Responda os números das que ficam (ex.: *1 2*), *manter* para deixar assim ou *nenhuma* para tirar as que não são obrigatórias.",
    ...(r?.linkConfiguracoes ? [`O cadastro padrão se muda em Configurações: ${r.linkConfiguracoes}`] : []),
  ].join("\n");
}

/** "Salvar como padrão" não grava nada: o padrão é da imobiliária e se muda nas Configurações (D5). */
export function textoSalvarComoPadrao(options: OptionsV2): string {
  const link = regraDeTestemunhas(options)?.linkConfiguracoes;
  return (
    "Eu não guardo testemunha padrão por aqui: o padrão é da imobiliária e se muda nas Configurações" +
    `${link ? `: ${link}` : ""}. Nada foi gravado. Para esta proposta, me diga quais testemunhas ficam.`
  );
}

export type EscolhaDeTestemunhas =
  | { tipo: "escolha"; ids: string[] }
  | { tipo: "salvar_padrao" }
  | { tipo: "invalida"; motivo: "numero_fora" }
  | { tipo: "nenhuma_leitura" };

const SALVAR_PADRAO = /\bsalv\w*\b.*\bpadrao\b|\bpadrao\b.*\bsalv\w*\b|\b(?:tornar?|definir|deixar?|virar?)\b.*\bpadrao\b/;
const SO_NUMEROS = /^[\d\s,;e]+$/;

/**
 * A resposta à lista de testemunhas. `ids` já traz as obrigatórias. Nunca grava: vira o cartão.
 * Só reconhece o que é resposta; o resto é `nenhuma_leitura` e o chamador pergunta de novo.
 */
export function lerEscolhaDeTestemunhas(texto: string, options: OptionsV2): EscolhaDeTestemunhas {
  const t = normalizar(texto);
  if (SALVAR_PADRAO.test(t)) return { tipo: "salvar_padrao" };
  const cat = catalogoDeTestemunhas(options);
  if (/^(manter|mantem|mantenho|deixa assim|deixar assim|padrao|o padrao|igual|igual ao padrao)$/.test(t)) {
    return { tipo: "escolha", ids: comObrigatorias(options, marcadasPorPadrao(options)) };
  }
  if (/^(nenhuma|nenhum|sem testemunhas?|nenhuma testemunha|sem nenhuma)$/.test(t)) {
    return { tipo: "escolha", ids: comObrigatorias(options, []) };
  }
  if (t !== "" && SO_NUMEROS.test(t) && /\d/.test(t)) {
    const numeros = [...new Set((t.match(/\d+/g) ?? []).map(Number))];
    if (numeros.some((n) => n < 1 || n > cat.length)) return { tipo: "invalida", motivo: "numero_fora" };
    return { tipo: "escolha", ids: comObrigatorias(options, numeros.map((n) => cat[n - 1]!.id)) };
  }
  return { tipo: "nenhuma_leitura" };
}

/**
 * O cartão das testemunhas: o "sim" grava. Só nomes do cadastro (sem CPF, e-mail ou celular). A
 * regravação SUBSTITUI o conjunto da proposta (o servidor apaga as comuns e cria as pedidas): o que foi
 * adicionado ou tirado na tela se perde, e o cartão diz isso antes do "sim" (I2). A do corretor não muda.
 */
export function textoDoCartaoDeTestemunhas(options: OptionsV2, ids: string[], codigo?: string): string {
  const nomes = catalogoDeTestemunhas(options)
    .filter((t) => ids.includes(t.id))
    .map((t) => t.nome);
  const quais = nomes.length > 0 ? `estas testemunhas: ${nomes.join(", ")}` : "a proposta sem testemunhas";
  return (
    `Vou deixar ${quais}${codigo ? ` na proposta ${codigo}` : ""}.\n` +
    "Isso substitui as testemunhas atuais da proposta, inclusive as adicionadas na tela (a testemunha do corretor, se houver, não muda).\n\n" +
    "Confirma? Responda *SIM* para gravar."
  );
}

// ─── Os tipos de assinatura ─────────────────────────────────────────────────

const ROTULO_DO_TIPO: Record<TipoDeAssinatura, string> = { email: "Por e-mail", whatsapp: "Por WhatsApp", aceite: "Aceite no celular" };

/** Papéis cujo celular o Max sabe gravar por posição (`compradores[]`, `vendedores[]`). Testemunha e cônjuge ficam de fora. */
const GRUPO_DO_PAPEL: Record<string, "compradores" | "vendedores"> = {
  proponente: "compradores",
  comprador: "compradores",
  locatario: "compradores",
  inquilino: "compradores",
  vendedor: "vendedores",
  proprietario: "vendedores",
  locador: "vendedores",
  contraparte: "vendedores",
};

export type MotivoSemCaminho = "papel_nao_gravavel" | "varias_pessoas" | "nome_divergente" | "rascunho_indisponivel";

/**
 * As pessoas do RASCUNHO por grupo, na ordem do `dataJson` (`compradores[i]`, `vendedores[i]`): a mesma fonte
 * que o `proposal.update` indexa. Só o nome (nunca CPF, e-mail ou telefone).
 */
export interface RascunhoPorGrupo {
  compradores: ReadonlyArray<{ nome: string }>;
  vendedores: ReadonlyArray<{ nome: string }>;
}

/**
 * O rascunho por grupo que o agente tem neste ponto (R25): NENHUM. O `proposal.options` só traz `signatarios`
 * (= `signers.filter(included)`, só quem ASSINA) e `tiposDeAssinatura[].assinantesSemCelular` (o mesmo signer);
 * `proposal.detail` não traz partes; o estado do fluxo não guarda nomes (regra de PII do checkpoint). Contar
 * `signatarios` é o furo do R24: com um vendedor fora da assinatura o lado conta 1 e `vendedores[0]` pode ser o
 * OUTRO. Então: `null`, e o celular do Aceite vai sempre para a tela (fail-closed).
 * PENDÊNCIA: o CM expor no `options` os nomes do rascunho por grupo (PR em par) -> devolver aqui.
 */
export function rascunhoPorGrupo(_options: OptionsV2): RascunhoPorGrupo | null {
  return null;
}

/**
 * O caminho canônico do celular de quem assina (`vendedores[0].telefone`) (R25). Lado seguro:
 *
 * Só grava quando o grupo tem EXATAMENTE uma pessoa no RASCUNHO (`k` = 0) e o nome normalizado dela é igual ao
 * do destinatário. Rascunho desconhecido, duas ou mais pessoas no grupo, grupo vazio ou nome divergente: não
 * grava, o celular é preenchido na tela. `signatarios` nunca entra na conta (só lista quem assina), nem a
 * `posicao` do servidor (global, outra ordenação).
 */
export function resolverCelular(
  s: { papel: string; nome: string },
  rascunho: RascunhoPorGrupo | null | undefined
): { ok: true; path: string } | { ok: false; motivo: MotivoSemCaminho } {
  const grupo = GRUPO_DO_PAPEL[normalizar(s.papel)];
  if (!grupo) return { ok: false, motivo: "papel_nao_gravavel" };
  if (!rascunho || !Array.isArray(rascunho[grupo])) return { ok: false, motivo: "rascunho_indisponivel" };
  const doGrupo = rascunho[grupo];
  if (doGrupo.length > 1) return { ok: false, motivo: "varias_pessoas" };
  const alvo = normalizar(s.nome);
  const unico = doGrupo[0];
  if (!unico || alvo === "" || typeof unico.nome !== "string" || normalizar(unico.nome) !== alvo) return { ok: false, motivo: "nome_divergente" };
  return { ok: true, path: `${grupo}[0].telefone` };
}

export function caminhoDoCelular(s: { papel: string; nome: string; posicao?: number }, rascunho: RascunhoPorGrupo | null | undefined): string | null {
  const r = resolverCelular(s, rascunho);
  return r.ok ? r.path : null;
}

/** O Aceite que só espera o celular de quem assina é oferecido sempre: se não der para gravar, a ESCOLHA explica (nada some em silêncio). */
function celularSeraPerguntado(o: OpcaoDeAssinatura): boolean {
  return o.tipo === "aceite" && !o.disponivel && o.motivo === "assinante_sem_celular" && !!o.assinantesSemCelular?.length;
}

/**
 * O que se oferece ao corretor: só o que o `options` diz `disponivel` (conta sem Plus: o tipo
 * indisponível não aparece), mais o Aceite que só espera o celular de quem assina e que o Max sabe
 * perguntar. `assinaturaConfigurada:false` = nada. Ordem do servidor (email, whatsapp, aceite).
 */
export function opcoesDeTipo(options: OptionsV2): OpcaoDeAssinatura[] {
  if (options.assinaturaConfigurada === false) return [];
  return (options.tiposDeAssinatura ?? []).filter((o) => (o.disponivel || celularSeraPerguntado(o)) && o.tipo in ROTULO_DO_TIPO);
}

/** `R$ 0,99` a partir de centavos inteiros. */
export function moeda(centavos: number): string {
  return `R$ ${(centavos / 100).toFixed(2).replace(".", ",")}`;
}

const MOTIVO_SEM_PLUS: Record<string, string> = {
  conta_nao_verificada: "porque a conta de WhatsApp da imobiliária ainda não foi verificada",
  plano_sem_plus: "porque o plano da imobiliária não tem o WhatsApp Plus",
};

function custoDoAceite(o: OpcaoDeAssinatura): string {
  const preco =
    o.custoPorDestinatario === true || o.custoCentavos === undefined
      ? "R$ 0,99 por destinatário"
      : `${moeda(o.custoCentavos)} no total`;
  return `${preco}${o.semLembrete ? ", sem lembrete" : ""}`;
}

function linhaDoTipo(o: OpcaoDeAssinatura, i: number): string {
  let extra = "";
  if (o.tipo === "aceite") {
    extra = ` — ${custoDoAceite(o)}`;
    if (o.assinantesSemCelular?.length) extra += `; falta o celular de ${o.assinantesSemCelular.map((s) => s.nome).join(", ")}`;
  } else if (o.tipo === "whatsapp" && o.saiComo === "aceite") {
    const porque = o.motivo ? MOTIVO_SEM_PLUS[o.motivo] : undefined;
    extra = ` — vai sair como *Aceite* (${custoDoAceite({ ...o, semLembrete: true, custoPorDestinatario: o.custoPorDestinatario ?? true })})${porque ? `, ${porque}` : ""}`;
  }
  return `${i + 1}. ${ROTULO_DO_TIPO[o.tipo]}${extra}`;
}

export function textoDeTipos(opcoes: OpcaoDeAssinatura[]): string {
  return ["Como enviar para assinatura?", ...opcoes.map(linhaDoTipo), "Responda o número ou o nome."].join("\n");
}

const PALAVRA_DO_TIPO: Array<[RegExp, TipoDeAssinatura]> = [
  [/\be[ -]?mail\b/, "email"],
  [/\b(?:whats|whatsapp|zap)\b/, "whatsapp"],
  [/\b(?:aceite|celular)\b/, "aceite"],
];

/** A palavra que nomeia um tipo (sem número). `null` = não nomeia nenhum. */
export function tipoPorPalavra(texto: string): TipoDeAssinatura | null {
  const t = normalizar(texto);
  const achados = PALAVRA_DO_TIPO.filter(([re]) => re.test(t)).map(([, tipo]) => tipo);
  return achados.length === 1 ? achados[0]! : null;
}

/** O número da lista ou o nome do tipo; só o que está na lista oferecida vale. */
export function lerTipoDeAssinatura(texto: string, opcoes: OpcaoDeAssinatura[]): { tipo: TipoDeAssinatura } | "indisponivel" | null {
  const t = normalizar(texto);
  const n = /^(\d)$/.exec(t);
  if (n) {
    const o = opcoes[Number(n[1]) - 1];
    return o ? { tipo: o.tipo } : null;
  }
  const palavra = tipoPorPalavra(t);
  if (!palavra) return null;
  return opcoes.some((o) => o.tipo === palavra) ? { tipo: palavra } : "indisponivel";
}

// ─── Regerar o documento ────────────────────────────────────────────────────

/**
 * O aviso de perda de edição. Vem ANTES do "sim" que autoriza o `regerar_documento:true`
 * (409 `documento_proprio` do `proposal.update`): refazer o documento apaga o que foi editado nele.
 */
export function avisoDeRegerar(): string {
  return "Isso refaz o documento e apaga as edições feitas nele. Confirma? SIM/NÃO";
}
