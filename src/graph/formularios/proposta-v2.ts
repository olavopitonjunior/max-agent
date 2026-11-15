/**
 * Proposta v2: checklist pelo `options` e gravação parcial (T5).
 *
 * No v2 o servidor é a autoridade do "o que falta" (`faltando`, §18.13.2): a
 * lista vem do `proposal.options` com alvo, do `proposal.create` e do
 * `proposal.update`. Este módulo NUNCA recalcula pendência localmente (o v1 tem
 * sua conta própria, que não vale aqui: ela ignora o obrigatório da org e do
 * modelo).
 *
 * Duas regras que moram aqui:
 *  - "anotei" só depois do 201/200. Recusa (422), falta de resposta e qualquer
 *    outro desfecho nunca afirmam que gravou (`textoDoParcial`);
 *  - o `proposal.create` do v2 vai sem `canal` (D4): o rascunho nasce sem canal
 *    e o canal é escolhido na etapa de assinatura (`tipo_assinatura`).
 *
 * Os desfechos viram dado (`ResultadoParcial`) com o PRÓXIMO fluxo já calculado
 * (`fluxo`): quem chama só persiste. O texto ao corretor é função pura do
 * desfecho. Sem PII aqui: o patch segue para o servidor e não é guardado.
 */

import { nomeDoAgente } from "@/lib/deploy-profile";
import { RE_CNPJ, RE_CPF } from "@/lib/pii";
import { cnpjValido, lerItemDaCaptacao } from "../captacao";
import { cpfValido, valoresNoTexto } from "../credito";
import { TEXTO_ESCRITA_INCERTA, type DadosDaProposta, type DepsDoFluxo, type Fluxo, type RespostaDoServidor } from "../fluxos";
import { normalizar } from "../tools";
import type { CampoObrigatorio, OptionsV1, OptionsV2, PatchV2, Pendencia, TipoDeCampo } from "./contrato";
import type { CampoAguardado, FluxoFormularioV2 } from "./estado";
import { ehFluxoDesligado, rebaixarParaV1 } from "./selecao";

type DepsAcao = Pick<DepsDoFluxo, "acao">;

/**
 * O `faltando` do servidor: a resposta da gravação vence o do `options`. Nenhum dos
 * dois traz = `null` (DESCONHECIDO: a flag da esteira pode estar desligada ou o
 * servidor ser antigo), nunca `[]`: lista vazia só vale quando o servidor a mandou.
 * Quem recebe `null` consulta `proposal.options` com alvo / o preflight.
 */
export function faltandoV2(options: OptionsV1 | OptionsV2, resposta?: { faltando?: Pendencia[] } | null): Pendencia[] | null {
  if (resposta && Array.isArray(resposta.faltando)) return resposta.faltando;
  const doOptions = "faltando" in options ? options.faltando : undefined;
  return Array.isArray(doOptions) ? doOptions : null;
}

/**
 * `proposal.options` (§18.13.3). Sem alvo a esteira vem de `tipo`/`schemaType`;
 * com alvo (`proposalId` ou `codigo`) a resposta traz o `faltando` da proposta.
 * `null` = sem resposta utilizável: o chamador não inventa um `options`.
 */
export async function consultarOptions(
  deps: DepsAcao,
  args: { tipo?: "venda" | "locacao"; schemaType?: string; alvo?: { proposalId?: string; codigo?: string } }
): Promise<OptionsV1 | OptionsV2 | null> {
  const r = await consultarOptionsDetalhado(deps, args);
  return r.ok ? r.options : null;
}

/**
 * Por que o `proposal.options` não serviu (C2). A distinção importa ao condutor:
 *  - `fluxo_desligado` (403) e `sem_alvo` (400: o servidor não conhece o alvo/esteira) são
 *    DEFINITIVOS: o fluxo v2 não tem como continuar, o turno é liberado e o v1/atendimento assume;
 *  - `indisponivel` (sem resposta, 5xx, corpo estranho) é TRANSITÓRIO: nunca derruba o fluxo nem
 *    vira "sistema fora do ar" para uma fala que não era do fluxo.
 */
export type MotivoSemOptions = "fluxo_desligado" | "sem_alvo" | "indisponivel";

export async function consultarOptionsDetalhado(
  deps: DepsAcao,
  args: { tipo?: "venda" | "locacao"; schemaType?: string; alvo?: { proposalId?: string; codigo?: string } }
): Promise<{ ok: true; options: OptionsV1 | OptionsV2 } | { ok: false; motivo: MotivoSemOptions }> {
  const corpo: Record<string, unknown> = {};
  if (args.tipo) corpo.tipo = args.tipo;
  if (args.schemaType) corpo.schemaType = args.schemaType;
  if (args.alvo?.proposalId) corpo.proposta_id = args.alvo.proposalId;
  else if (args.alvo?.codigo) corpo.codigo = args.alvo.codigo;
  const r = await deps.acao("proposal.options", corpo);
  if (!r) return { ok: false, motivo: "indisponivel" };
  if (ehFluxoDesligado(r)) return { ok: false, motivo: "fluxo_desligado" };
  if (r.status === 400) return { ok: false, motivo: "sem_alvo" };
  if (r.status !== 200 || !Array.isArray(r.body?.metodos)) return { ok: false, motivo: "indisponivel" };
  return { ok: true, options: r.body as unknown as OptionsV1 | OptionsV2 };
}

export type ErroDoParcial =
  | "dados_invalidos"
  | "sem_confirmacao"
  | "documento_proprio"
  | "edicao_pela_tela"
  | "fluxo_desligado"
  | "incerta"
  | "sem_permissao"
  | "nao_encontrada"
  | "nao_editavel"
  | "envio_em_andamento"
  | "signatarios_duplicados"
  | "indisponivel";

export type ResultadoParcial =
  | {
      ok: true;
      criou: boolean;
      proposalId: string;
      codigo?: string;
      /** Do servidor, depois da gravação; `null` = o servidor não disse (consultar o options). */
      faltando: Pendencia[] | null;
      testemunhasSemeadas?: number;
      pdfIndisponivel?: string;
      documento?: { descartado: boolean; link?: string };
      /** O fluxo já apontando para o rascunho e sem chave presa. */
      fluxo: FluxoFormularioV2;
    }
  | {
      ok: false;
      erro: ErroDoParcial;
      /** `documento_proprio` (do servidor) ou `edicao_pela_tela` (só se o servidor mandar um). */
      link?: string;
      /** Campos recusados (`dados_invalidos`). */
      campos?: string[];
      /** Frase do servidor (422), nunca o código. */
      mensagem?: string;
      /** O próximo estado: `null` encerra; v1 quando o servidor desligou o v2. */
      fluxo: Fluxo | null;
    };

function frase(body: Record<string, unknown>): string | undefined {
  const m = [body.message, body.motivo].find((x): x is string => typeof x === "string" && x.trim().length > 0);
  return m ? m.replace(/\s+/g, " ").trim().slice(0, 300) : undefined;
}

function textoOuUndefined(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function idDe(obj: unknown): { id?: string; codigo?: string } {
  if (!obj || typeof obj !== "object") return {};
  const o = obj as { id?: unknown; codigo?: unknown };
  return { id: textoOuUndefined(o.id), codigo: textoOuUndefined(o.codigo) };
}

/**
 * Grava o que o corretor disse. Sem `proposalId` no fluxo: `proposal.create`
 * (exige `schemaType`, sem `canal`). Com `proposalId`: `proposal.update`, PATCH
 * completo (partes por POSIÇÃO, a lista nunca encolhe; `substituir:true` só com
 * nome novo, R38).
 *
 * Escrita só com prova de confirmação (GC5): `confirmacao.messageIdDoSim` é a
 * messageId do PRIMEIRO "sim" do corretor ao cartão e vira a idempotencyKey
 * (um "sim" repetido não vira escrita nova). Sem ela a função recusa antes de
 * chamar o servidor. Uma chave já guardada no fluxo para o MESMO verbo vence
 * (a retentativa não duplica).
 */
export async function salvarParcial(
  deps: DepsAcao,
  f: FluxoFormularioV2,
  patch: PatchV2,
  opts: { confirmacao: { messageIdDoSim: string }; agora?: number; extraido?: DadosDaProposta }
): Promise<ResultadoParcial> {
  const messageIdDoSim = opts?.confirmacao?.messageIdDoSim;
  if (typeof messageIdDoSim !== "string" || messageIdDoSim.trim().length === 0) {
    return { ok: false, erro: "sem_confirmacao", fluxo: f };
  }
  const criando = !f.proposalId;
  const verbo = criando ? "proposal.create" : "proposal.update";
  const agora = opts.agora ?? Date.now();
  const semChave: FluxoFormularioV2 = { ...f, chave: undefined, atualizadoEm: agora };

  const corpo: Record<string, unknown> = { ...patch };
  delete corpo.canal; // D4: nunca no rascunho; o canal é da etapa de assinatura
  if (criando) {
    const schemaType = patch.schemaType ?? f.schemaType;
    if (!schemaType) {
      return { ok: false, erro: "dados_invalidos", campos: ["schemaType"], fluxo: semChave };
    }
    corpo.schemaType = schemaType;
    // Só do update: no create o servidor não as lê.
    delete corpo.tipo_assinatura;
    delete corpo.excecoes_canal;
    delete corpo.regerar_documento;
  } else {
    // `schemaType` e `tipo` nunca mudam depois do create.
    delete corpo.schemaType;
    delete corpo.tipo;
    corpo.proposta_id = f.proposalId;
  }

  const chave = f.chave?.verbo === verbo ? f.chave : { verbo, valor: messageIdDoSim };
  const r: RespostaDoServidor | null = await deps.acao(verbo, corpo, chave.valor);

  if (!r || (r.status === 409 && r.body?.error === "em_andamento")) {
    return { ok: false, erro: "incerta", fluxo: { ...f, chave, atualizadoEm: agora } };
  }
  if (ehFluxoDesligado(r)) {
    return { ok: false, erro: "fluxo_desligado", fluxo: rebaixarParaV1(f, opts.extraido ?? {}) };
  }
  if (r.status === 403) return { ok: false, erro: "sem_permissao", fluxo: null };
  if (r.status === 404) return { ok: false, erro: "nao_encontrada", fluxo: null };

  if (r.status === 409) {
    switch (r.body?.error) {
      case "edicao_pela_tela":
        return { ok: false, erro: "edicao_pela_tela", link: textoOuUndefined(r.body.link), fluxo: null };
      case "documento_proprio":
        return { ok: false, erro: "documento_proprio", link: textoOuUndefined(r.body.link), fluxo: semChave };
      case "envio_em_andamento":
        return { ok: false, erro: "envio_em_andamento", mensagem: frase(r.body), fluxo: semChave };
      case "signatarios_duplicados":
        return { ok: false, erro: "signatarios_duplicados", fluxo: semChave };
      case "nao_editavel":
        return { ok: false, erro: "nao_editavel", fluxo: null };
      default:
        // Código que o contrato (§18.13.5) não lista: não sabemos o que houve, então
        // não encerramos o fluxo nem afirmamos "saiu do rascunho". Mantém a chave.
        return { ok: false, erro: "indisponivel", fluxo: { ...f, chave, atualizadoEm: agora } };
    }
  }
  // 400 `invalid_body` é defeito do NOSSO corpo, não dado inválido do corretor.
  if (r.status === 400) return { ok: false, erro: "indisponivel", fluxo: semChave };
  if (r.status === 422) {
    const campos = Array.isArray(r.body?.campos) ? r.body.campos.filter((c): c is string => typeof c === "string") : undefined;
    return { ok: false, erro: "dados_invalidos", mensagem: frase(r.body), ...(campos?.length ? { campos } : {}), fluxo: semChave };
  }

  const esperado = criando ? 201 : 200;
  const gravada = criando ? idDe(r.body?.proposal) : idDe(r.body?.proposta);
  const proposalId = gravada.id ?? f.proposalId;
  if (r.status !== esperado || !proposalId) {
    // Pode ter gravado: mantém a chave para a retentativa não duplicar.
    return { ok: false, erro: "indisponivel", fluxo: { ...f, chave, atualizadoEm: agora } };
  }

  const doc = r.body?.documento as { descartado?: unknown; link?: unknown } | undefined;
  // Um campo `bloqueio` no 200 não existe no contrato (§18.13.5): é ignorado de propósito. Texto do
  // servidor nunca chega ao corretor por um campo que o contrato não declara.
  return {
    ok: true,
    criou: criando,
    proposalId,
    ...(gravada.codigo ? { codigo: gravada.codigo } : {}),
    faltando: faltandoV2({ metodos: [], signatarios: [], assinaturaConfigurada: true }, r.body as { faltando?: Pendencia[] }),
    ...(typeof r.body?.testemunhasSemeadas === "number" ? { testemunhasSemeadas: r.body.testemunhasSemeadas } : {}),
    ...(typeof r.body?.pdfIndisponivel === "string" ? { pdfIndisponivel: r.body.pdfIndisponivel } : {}),
    ...(doc && typeof doc.descartado === "boolean"
      ? { documento: { descartado: doc.descartado, ...(textoOuUndefined(doc.link) ? { link: textoOuUndefined(doc.link) } : {}) } }
      : {}),
    fluxo: { ...semChave, proposalId },
  };
}

/**
 * O que o Max diz depois de `salvarParcial`. "Anotei" só no `ok`. Vazio no
 * `fluxo_desligado`: o v1 assume no mesmo turno e fala por si, sem erro ao corretor.
 */
export function textoDoParcial(r: ResultadoParcial, ctx: { codigo?: string }): string {
  if (r.ok) return `Anotei e salvei no rascunho${r.codigo ?? ctx.codigo ? ` ${r.codigo ?? ctx.codigo}` : ""}.`;
  const codigo = ctx.codigo ? ` ${ctx.codigo}` : "";
  switch (r.erro) {
    case "dados_invalidos":
      return `${r.mensagem ?? "Algum dado não foi aceito pelo sistema."}\nMe mande e eu ajusto.`;
    case "fluxo_desligado":
      return "";
    case "sem_confirmacao":
      return "Antes de gravar preciso do seu SIM no resumo. Confirma pra eu salvar?";
    case "incerta":
      return TEXTO_ESCRITA_INCERTA;
    case "sem_permissao":
      return `Sua conta não tem permissão para isso pelo ${nomeDoAgente()}. Fale com o administrador da imobiliária.`;
    case "nao_encontrada":
      return "Não encontrei essa proposta para você no sistema.";
    case "nao_editavel":
      return "Essa proposta já saiu do rascunho e não pode mais ser ajustada por aqui.";
    case "edicao_pela_tela":
      return (
        `Essa proposta${codigo} foi editada pela tela (texto, mais de um comprador ou empresa), ` +
        "então o ajuste precisa ser feito por lá. O rascunho continua salvo." +
        (r.link ? `\n${r.link}` : "")
      );
    case "documento_proprio":
      // Sem oferecer "refaça (SIM)": o SIM só repetiria o mesmo 409 (a regeneração é pela tela).
      return (
        `Essa proposta${codigo} já tem um documento próprio, que pode ter sido editado à mão, ` +
        "então não anotei o que você mandou por aqui. O ajuste precisa ser feito pela tela, onde o documento é refeito. " +
        `Confira o documento atual:${r.link ? `\n${r.link}` : " ele está no sistema."}`
      );
    case "envio_em_andamento":
      return "Tem um envio para assinatura em andamento nessa proposta. Espere terminar para ajustar.";
    case "signatarios_duplicados":
      return "Esse contato já está em outro assinante da proposta. Me mande um telefone ou e-mail diferente.";
    case "indisponivel":
      return "Não consegui falar com o sistema agora. Tenta de novo em instantes.";
  }
}

// ─── aguardaCampo desde o primeiro turno e retomada de rascunho (T6) ─────

export interface PerguntaDeCampo {
  pergunta: string;
  aguarda: CampoAguardado;
  /** Identifica a pergunta para não repeti-la (`perguntados`). Só caminho e posição. */
  chave: string;
}

/** Posição + papel + campo: a mesma chave em duas pessoas são duas perguntas. */
export function chaveDaPergunta(p: Pendencia): string {
  return p.signatario ? `${p.signatario.papel}:${p.signatario.posicao}:${p.campo}` : p.campo;
}

/** Antes de existir rascunho o que falta é o que a org obriga (o `options` sem alvo não traz `faltando`). */
export function pendenciasIniciais(obrigatorios: CampoObrigatorio[]): Pendencia[] {
  return obrigatorios.map((o) => ({ signatario: null, campo: o.chave, motivo: "obrigatorio_da_org" }));
}

const SUJEITO: Record<string, string> = {
  proponente: "do proponente",
  contraparte: "da outra parte",
  imovel: "do imóvel",
  negociacao: "da negociação",
  corretor: "do corretor",
};
const O_QUE: Record<string, string> = {
  documento: "o CPF (ou CNPJ)",
  cpf: "o CPF",
  cnpj: "o CNPJ",
  email: "o e-mail",
  telefone: "o telefone com DDD",
  mobile_phone: "o celular com DDD",
  nome: "o nome completo",
  nascimento: "a data de nascimento",
  data_nascimento: "a data de nascimento",
  valor: "o valor",
  sinal: "o valor do sinal",
  modalidade: "a modalidade",
  prazo_meses: "o prazo em meses",
  data_entrada: "a data de entrada",
  endereco: "o endereço",
  tipo: "o tipo",
  matricula: "o número da matrícula",
  cartorio: "o cartório",
  creci: "o CRECI",
};

const primeiroSegmento = (campo: string): string => campo.split(/[.[]/)[0]!;
const ultimoSegmento = (campo: string): string => campo.split(".").pop()!.replace(/\[\d*\]/g, "");

const LISTA_DO_PAPEL: Record<string, string> = { proprietario: "proprietarios", conjuge: "conjuges", representante: "representantes" };
const CAMPO_CANONICO: Record<string, string> = { documento: "cpf", nascimento: "data_nascimento" };

/**
 * UMA forma de caminho para `aguardaCampo.path`: a do estado (`compradores[1].cpf`,
 * `proprietarios[0].cpf`, `negociacao.valor`). A chave do catálogo do servidor
 * (`proponente.documento`) e o caminho da captação (`proprietarios[].cpf`) mais a
 * `signatario.posicao` são convertidos aqui, na entrada: a posição nunca se perde
 * (a resposta do 2º comprador não cai no 1º). Idempotente. Nas listas da captação
 * o papel real do signatário escolhe a lista (conjuge, representante) e a posição
 * conta dentro do papel (§18.13.2).
 */
export function caminhoCanonico(campo: string, signatario: { posicao: number; papel: string } | null): string {
  const idx = signatario ? Math.max(0, signatario.posicao - 1) : 0;
  let m = /^(proponente|contraparte)\.([a-z_]+)$/.exec(campo);
  if (m) return `${m[1] === "proponente" ? "compradores" : "vendedores"}[${idx}].${CAMPO_CANONICO[m[2]!] ?? m[2]}`;
  m = /^([a-z]+)\[\]\.([a-z_0-9]+)$/.exec(campo);
  if (m) return `${(signatario && LISTA_DO_PAPEL[signatario.papel]) || m[1]}[${idx}].${CAMPO_CANONICO[m[2]!] ?? m[2]}`;
  m = /^(compradores|vendedores|proprietarios|conjuges|representantes)\[(\d+)\]\.([a-z_0-9]+)$/.exec(campo);
  if (m) return `${m[1]}[${m[2]}].${CAMPO_CANONICO[m[3]!] ?? m[3]}`;
  return campo;
}

const semIndice = (path: string): string => path.replace(/\[\d+\]/g, "[]");

/** `comprador:2` (a `parteRef` gravada) de volta a posição + papel; só para quem tem `parteRef` de pessoa. */
function signatarioDaParteRef(parteRef: string): { posicao: number; papel: string } | null {
  const m = /^([a-z_]+):(\d+)$/.exec(parteRef);
  return m ? { papel: m[1]!, posicao: Number(m[2]) } : null;
}

const rotuloDoPapel = (papel: string): string => (papel === "proprietario" ? "proprietário" : papel.replace(/_/g, " "));

function textoDaPergunta(p: Pendencia, obrigatorios?: CampoObrigatorio[]): string {
  const def = obrigatorios?.find((o) => o.chave === p.campo);
  const quem = p.signatario ? ` do ${rotuloDoPapel(p.signatario.papel)} ${p.signatario.posicao}` : "";
  if (def) {
    const opcoes = def.opcoes?.length ? ` Opções: ${def.opcoes.map((x) => x.rotulo).join(", ")}.` : "";
    return `Qual a informação "${def.rotulo}"${quem || (def.grupo ? ` (${def.grupo})` : "")}?${opcoes}`;
  }
  const o = O_QUE[ultimoSegmento(p.campo)] ?? `o campo ${ultimoSegmento(p.campo)}`;
  const sujeito = SUJEITO[primeiroSegmento(p.campo)];
  return `Qual ${o}${quem || (sujeito ? ` ${sujeito}` : "")}?`;
}

/**
 * A próxima (e única) pergunta: a primeira pendência que ainda não foi feita.
 * O mínimo de testemunhas não é campo, é da etapa de assinatura. `aguarda` diz
 * qual campo a resposta curta seguinte preenche.
 */
export function proximaPergunta(
  faltando: Pendencia[],
  jaPerguntado: ReadonlySet<string>,
  obrigatorios?: CampoObrigatorio[]
): PerguntaDeCampo | null {
  for (const p of faltando) {
    if (p.motivo === "minimo_de_testemunhas") continue;
    const chave = chaveDaPergunta(p);
    if (jaPerguntado.has(chave)) continue;
    const parteRef = p.signatario ? `${p.signatario.papel}:${p.signatario.posicao}` : primeiroSegmento(p.campo);
    const path = caminhoCanonico(p.campo, p.signatario);
    return { pergunta: textoDaPergunta(p, obrigatorios), aguarda: { parteRef, path }, chave };
  }
  return null;
}

/** Grava no fluxo QUAL campo a próxima resposta preenche e que a pergunta foi feita. Sem valor, sem PII. */
export function registrarPergunta(f: FluxoFormularioV2, p: PerguntaDeCampo, agora?: number): FluxoFormularioV2 {
  return {
    ...f,
    aguardaCampo: p.aguarda,
    perguntados: f.perguntados.includes(p.chave) ? f.perguntados : [...f.perguntados, p.chave],
    ...(agora !== undefined ? { atualizadoEm: agora } : {}),
  };
}

export type RespostaAoCampo =
  | { tipo: "preenche"; patch: PatchV2 | PatchDeCaptacao; campo: CampoAguardado }
  /** Parece resposta ao campo, mas o valor não vale: pede de novo, sem "anotei". */
  | { tipo: "invalida"; reply: string }
  /** Não é resposta ao campo: o turno segue o caminho normal (o fluxo não sequestra). */
  | { tipo: "liberar" };

const LIBERAR: RespostaAoCampo = { tipo: "liberar" };
const SO_DIGITOS = (s: string): string => s.replace(/\D/g, "");
const LETRAS_DE_SOBRA = 20;

function tipoDoCampo(path: string, def: CampoObrigatorio | undefined): TipoDeCampo {
  if (def) return def.tipoCampo;
  switch (ultimoSegmento(path)) {
    case "documento": case "cpf": case "cnpj": return "cpf_cnpj";
    case "email": return "email";
    case "telefone": case "telefone1": case "telefone2": case "mobile_phone": return "telefone";
    case "nascimento": case "data_nascimento": case "data_entrada": return "data";
    case "valor": case "sinal": return "moeda";
    case "prazo_meses": case "percentual": return "numero";
    case "modalidade": return "opcao";
    default: return "texto";
  }
}

type Destino =
  | { secao: "compradores" | "vendedores" | "proprietarios" | "conjuges" | "representantes"; indice: number; campo: string }
  | { secao: "imovel" | "negociacao" | "corretor"; campo: string }
  | { secao: "observacoes" };

/** A resposta da captação (listas por pessoa, na ordem do papel). Traduzir posição em `id` é do condutor. */
export interface PatchDeCaptacao {
  proprietarios?: Array<Record<string, unknown>>;
  conjuges?: Array<Record<string, unknown>>;
  representantes?: Array<Record<string, unknown>>;
  imovel?: Record<string, unknown>;
}

/** Só o caminho do estado (já canônico): `compradores[1].cpf`, `proprietarios[0].cpf`, `negociacao.valor`. */
function destinoDoCampo(path: string): Destino | null {
  if (path === "observacoes") return { secao: "observacoes" };
  let m = /^(compradores|vendedores|proprietarios|conjuges|representantes)\[(\d+)\]\.([a-z_0-9]+)$/.exec(path);
  if (m) return { secao: m[1] as "compradores", indice: Number(m[2]), campo: m[3]! };
  m = /^(imovel|negociacao|corretor)\.([a-z_]+)$/.exec(path);
  if (m) return { secao: m[1] as "imovel", campo: m[2]! };
  return null;
}

const CAMPOS_DA_PARTE: Record<string, string> = {
  nome: "nome", email: "email", telefone: "telefone", cpf: "cpf", cnpj: "cnpj", data_nascimento: "data_nascimento",
};
const CAMPOS_DA_NEGOCIACAO = new Set(["valor", "sinal", "modalidade", "prazo_meses", "data_entrada"]);
const CAMPOS_DO_CORRETOR = new Set(["nome", "creci", "mobile_phone", "email"]);

function patchDe(d: Destino, valor: string | number): PatchV2 | PatchDeCaptacao | null {
  switch (d.secao) {
    case "observacoes":
      return { observacoes: String(valor) };
    case "compradores":
    case "vendedores":
    case "proprietarios":
    case "conjuges":
    case "representantes": {
      const pessoa = d.secao === "compradores" || d.secao === "vendedores";
      // A captação tem mais campos por pessoa (rg, profissão...); o servidor valida.
      let k = pessoa ? CAMPOS_DA_PARTE[d.campo] : d.campo;
      if (!k) return null;
      if (k === "cpf" && SO_DIGITOS(String(valor)).length === 14) k = "cnpj";
      const lista: Array<Record<string, unknown>> = Array.from({ length: d.indice }, () => ({}));
      lista.push({ [k]: valor });
      return { [d.secao]: lista } as PatchV2 | PatchDeCaptacao;
    }
    case "imovel":
      return { imovel: { [d.campo]: valor } };
    case "negociacao":
      return CAMPOS_DA_NEGOCIACAO.has(d.campo) ? ({ negociacao: { [d.campo]: valor } } as PatchV2) : null;
    case "corretor":
      return CAMPOS_DO_CORRETOR.has(d.campo) ? ({ corretor: { [d.campo]: valor } } as PatchV2) : null;
  }
}

/**
 * Comando, verbo de fluxo, sim/não e saudação NUNCA são resposta de campo: "espera",
 * "manda o link", "cancela", "para". Casado no começo da fala, em palavra inteira
 * ("Pereira" e "Paraná" seguem valendo como nome e endereço).
 */
const RECUSA_DE_CAMPO =
  /^(oi|ola|bom dia|boa tarde|boa noite|obrigad[oa]|valeu|tchau|ok|certo|beleza|blz|claro|sim|nao|talvez|cancela|cancelar|cancele|pare|parar|espera|espere|aguarda|aguarde|um (?:segundo|minuto|momento)|manda|mande|envia|envie|deixa|deixe|volta|voltar|esquece|esqueca|desisto|chega|continua|continue|segue|siga|refaz|refaca|apaga|apague|exclui|exclua|mostra|mostre|abre|abra|cria|crie|pode|vai|vamos|me (?:manda|mande|envia|envie|mostra|mostre|diz|diga|fala|fale))\b/;

/**
 * "para" e "pera" (o verbo) são testados SEM normalizar: "Pará" (UF/cidade) tem acento
 * e não é o verbo. `(?![\p{L}\p{N}])` em vez de `\b`, que trata a letra acentuada como borda.
 */
const VERBO_SEM_ACENTO = /^(?:para|pera|perai|peraí)(?![\p{L}\p{N}])/u;

/** A recusa vale só para texto livre: em campo de opção "sim"/"não" É a resposta. */
function recusadoComoComando(texto: string): boolean {
  return RECUSA_DE_CAMPO.test(normalizar(texto)) || VERBO_SEM_ACENTO.test(texto.trim().toLowerCase());
}

const PARECE_DINHEIRO = /r\$|\d\.\d{3}|\d,\d{1,2}\b|\bmil\b|milhao|milhoes|\d\s?k\b|^\s*\d{4,}\s*$/;

type Leitura = { valor: string | number } | { invalido: string } | null;

function lerValor(tipo: TipoDeCampo, texto: string, def: CampoObrigatorio | undefined, folha: string): Leitura {
  const t = texto.trim();
  const letras = t.replace(/[\d\s.,/()+-]/g, "").length;
  switch (tipo) {
    case "cpf_cnpj": {
      if (SO_DIGITOS(t).length < 6 || letras > LETRAS_DE_SOBRA) return null;
      for (const m of t.match(new RegExp(RE_CNPJ.source, "g")) ?? []) if (cnpjValido(m)) return { valor: SO_DIGITOS(m) };
      for (const m of t.match(new RegExp(RE_CPF.source, "g")) ?? []) if (cpfValido(m)) return { valor: SO_DIGITOS(m) };
      return { invalido: "Esse CPF ou CNPJ não parece válido. Confira os números e me mande de novo?" };
    }
    case "telefone": {
      const d = SO_DIGITOS(t);
      if (d.length < 6 || letras > LETRAS_DE_SOBRA) return null;
      return d.length >= 10 && d.length <= 13 ? { valor: d } : { invalido: "Esse telefone não parece completo. Me manda com DDD?" };
    }
    case "email": {
      if (!t.includes("@")) return null;
      const m = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i.exec(t);
      return m ? { valor: m[0] } : { invalido: "Esse e-mail não parece válido. Me manda de novo?" };
    }
    case "moeda": {
      if (!/\d/.test(t) || t.length > 60 || t.includes("?")) return null;
      // Precisa PARECER dinheiro: "são 2 compradores" não é valor.
      if (!PARECE_DINHEIRO.test(normalizar(t))) return null;
      const v = valoresNoTexto(t);
      if (v.length === 1 && v[0]! > 0) return { valor: v[0]! };
      return t.length <= 30 ? { invalido: "Não entendi o valor. Me manda em reais, por exemplo 520 mil ou R$ 520.000,00?" } : null;
    }
    case "data": {
      if (!/\d/.test(t) || t.length > 30) return null;
      const m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(t);
      if (m) {
        const [d, mes, a] = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
        const dt = new Date(Date.UTC(a, mes - 1, d));
        if (dt.getUTCFullYear() === a && dt.getUTCMonth() === mes - 1 && dt.getUTCDate() === d) {
          return { valor: `${a}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
        }
      }
      return { invalido: "Não entendi a data. Me manda no formato dia/mês/ano, por exemplo 31/01/1990?" };
    }
    case "numero": {
      const nums = t.match(/\d+/g);
      if (!nums || nums.length !== 1 || t.length > 40 || t.includes("?")) return null;
      return { valor: Number(nums[0]) };
    }
    case "opcao": {
      const opcoes = def?.opcoes;
      if (!opcoes?.length) return null;
      const n = ` ${normalizar(t)} `;
      const casam = opcoes.filter((o) => {
        const cands = [o.id.replace(/_/g, " "), o.rotulo, o.rotulo.replace(/\s*\(.*?\)\s*/g, " ")]
          .map((c) => normalizar(c))
          .filter(Boolean);
        return cands.some((c) => n.includes(` ${c} `));
      });
      return casam.length === 1 ? { valor: casam[0]!.id } : null;
    }
    case "texto": {
      if (!t || t.length > 120 || t.includes("?")) return null;
      if (folha === "nome" && (/\d/.test(t) || t.split(/\s+/).length > 10)) return null;
      return { valor: t };
    }
  }
}

/**
 * A resposta curta ("123.456.789-09") vale para o campo que o Max acabou de
 * perguntar (`aguardaCampo`), mesmo antes de existir rascunho. Só se o texto
 * PARECE resposta (formato do campo); senão `liberar`: o fluxo nunca sequestra
 * a conversa (pergunta fora do assunto segue o caminho normal).
 */
export function lerRespostaAoCampo(f: FluxoFormularioV2, texto: string, obrigatorios?: CampoObrigatorio[]): RespostaAoCampo {
  const aguarda = f.aguardaCampo;
  if (!aguarda) return LIBERAR;
  return lerCampoPorCaminho(aguarda.path, aguarda.parteRef, texto, obrigatorios);
}

/**
 * A MESMA leitura da resposta ao campo, para um campo escolhido por caminho (T11/T12): o item
 * numerado da revisão ("2 Maria Souza") e cada campo de uma resposta de Flow passam por aqui, então
 * a validação (CPF/CNPJ com dígito, telefone, valor, data, opção do catálogo) é a do texto livre.
 */
export function lerCampoPorCaminho(path0: string, parteRef: string, texto: string, obrigatorios?: CampoObrigatorio[]): RespostaAoCampo {
  // Checkpoint antigo ou de outra origem: a chave do catálogo é convertida aqui, com a posição da `parteRef`.
  const path = caminhoCanonico(path0, signatarioDaParteRef(parteRef));
  const destino = destinoDoCampo(path);
  if (!destino) return LIBERAR;
  const def = obrigatorios?.find((o) => semIndice(caminhoCanonico(o.chave, null)) === semIndice(path));
  const tipo = tipoDoCampo(path, def);
  // N1: comando/sim/não só é recusado onde a resposta é texto livre; antes do tipo, "sim" nunca preencheria uma opção.
  if (tipo === "texto" && recusadoComoComando(texto)) return LIBERAR;
  const leitura = lerValor(tipo, texto, def, ultimoSegmento(path));
  if (!leitura) return LIBERAR;
  if ("invalido" in leitura) return { tipo: "invalida", reply: leitura.invalido };
  const patch = patchDe(destino, leitura.valor);
  return patch ? { tipo: "preenche", patch, campo: { parteRef, path } } : LIBERAR;
}

// ─── Retomada de rascunho ────────────────────────────────────────────────

export type MotivoDoCasamento = "cliente" | "imovel";

export interface RascunhoAberto {
  id: string;
  codigo?: string;
  resumo: string;
  casouPor: MotivoDoCasamento[];
}

export interface RascunhosAbertos {
  itens: RascunhoAberto[];
  /** O servidor cortou a lista: "só esse" não pode ser afirmado. */
  truncado: boolean;
  /** 403 `fluxo_desligado`: o chamador fica no v1. */
  desligado?: boolean;
}

const LIMITE_DA_PISTA = 80; // acima disso o servidor recusa (422)

const pistaLimpa = (s: string | undefined): string | undefined => {
  const t = s?.replace(/\s+/g, " ").trim().slice(0, LIMITE_DA_PISTA).trim();
  return t ? t : undefined;
};

function motivos(v: unknown): MotivoDoCasamento[] {
  return Array.isArray(v) ? v.filter((x): x is MotivoDoCasamento => x === "cliente" || x === "imovel") : [];
}

/**
 * Rascunhos abertos do MESMO cliente e/ou do MESMO imóvel (`proposal.list` /
 * `captacao.list` com os filtros do v2). Sem pista não consulta: a lista inteira
 * não é "o mesmo cliente". O servidor decide o casamento; o Max só lê `casouPor`.
 */
export async function rascunhoAberto(
  deps: DepsAcao,
  alvo: "proposta" | "captacao",
  pistas: { cliente?: string; imovel?: string }
): Promise<RascunhosAbertos> {
  const cliente = pistaLimpa(pistas.cliente);
  const imovel = pistaLimpa(pistas.imovel);
  if (!cliente && !imovel) return { itens: [], truncado: false };
  const args: Record<string, unknown> = {
    ...(cliente ? { cliente } : {}),
    ...(imovel ? { imovel } : {}),
    somente_abertas: true,
  };
  const r = await deps.acao(alvo === "proposta" ? "proposal.list" : "captacao.list", args);
  if (ehFluxoDesligado(r)) return { itens: [], truncado: false, desligado: true };
  if (!r || r.status !== 200) return { itens: [], truncado: false };
  const brutos: unknown[] = Array.isArray(r.body?.items) ? r.body.items : [];
  const itens: RascunhoAberto[] = [];
  for (const b of brutos) {
    if (alvo === "captacao") {
      const i = lerItemDaCaptacao(b);
      if (i) itens.push({ id: i.id, codigo: i.codigo, resumo: `${i.codigo} — ${i.nome}`, casouPor: i.casouPor ?? [] });
      continue;
    }
    const o = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
    const id = textoOuUndefined(o.id);
    if (!id) continue;
    const codigo = textoOuUndefined(o.codigo);
    const titulo = textoOuUndefined(o.titulo);
    itens.push({
      id,
      ...(codigo ? { codigo } : {}),
      resumo: [codigo, titulo].filter(Boolean).join(" — ") || "Proposta sem título",
      casouPor: motivos(o.casouPor),
    });
  }
  return { itens, truncado: r.body?.truncado === true };
}

const MAX_NA_OFERTA = 5;

function quemCasou(c: MotivoDoCasamento[]): string {
  if (c.includes("cliente") && c.includes("imovel")) return "do mesmo cliente e do mesmo imóvel";
  if (c.includes("cliente")) return "do mesmo cliente";
  if (c.includes("imovel")) return "do mesmo imóvel";
  return "em aberto";
}

/**
 * A oferta de continuar. Um rascunho: SIM/NÃO (vira botões). Vários: lista
 * numerada (vira lista) com NÃO para criar outro. O SIM/o número voltam como
 * texto e são lidos por quem conduz o fluxo.
 */
export function textoDaOferta(itens: RascunhoAberto[], opts: { truncado: boolean }): string {
  if (!itens.length) return "";
  const aviso = opts.truncado ? " Olhei só os rascunhos mais recentes." : "";
  if (itens.length === 1) {
    const i = itens[0]!;
    return (
      `Você já tem um rascunho ${quemCasou(i.casouPor)}: ${i.resumo}.${aviso} Quer continuar nele? ` +
      "Responda *SIM* para continuar ou *NÃO* para criar outro."
    );
  }
  const linhas = itens.slice(0, MAX_NA_OFERTA).map((i, n) => `${n + 1}) ${i.resumo} (${quemCasou(i.casouPor)})`);
  const restam = itens.length - MAX_NA_OFERTA;
  return (
    `Você já tem rascunhos em aberto que combinam:${aviso}\n${linhas.join("\n")}\n` +
    (restam > 0 ? `...e mais ${restam}. Se não for um destes, diga o cliente ou o imóvel.\n` : "") +
    "Responda com o número do que quer continuar, ou *NÃO* para criar outro."
  );
}
