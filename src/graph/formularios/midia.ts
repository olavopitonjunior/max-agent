/**
 * Entrada ÚNICA de mídia recebida (T7), do Max e do Newton.
 *
 * Áudio, foto e PDF chegam aqui e saem como uma de três coisas:
 *  - `texto`     — o áudio transcrito (ou, no fallback do T9, o texto de uma
 *                  foto), que segue para a janela de extração como mensagem;
 *  - `campos`    — o que o servidor LEU de um documento (`document.read`); NÃO
 *                  é rascunho, é leitura a confirmar (T8: `lidosPendentes`);
 *  - `nao_lido`  — com o MOTIVO, para a resposta honesta certa.
 *
 * Regras que este arquivo guarda:
 *  - nunca lança: qualquer erro vira `nao_lido:"falha"`;
 *  - a URL de mídia da Z-API (`zapi:<url>`) nunca vai a log, erro, checkpoint
 *    ou `last_error`; no máximo o host. Aqui nem o host é logado: não há log;
 *  - valor lido de documento nunca é logado;
 *  - o servidor só é chamado quando a mídia pode ser lida: sem a capability,
 *    sem formato aceito ou acima de 3 MB, a chamada nem acontece (custo).
 *
 * Puro de rede: baixar, transcrever e ler chegam por `deps` (montados em
 * `graph.ts`), o que mantém o teste sem mock de transporte.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { sniffMime } from "@/lib/transport/newton-media";
import { textoSemLeituraDeMidia } from "../prompt";
import type { DepsDoFluxo } from "../fluxos";
import type { ParteV2, PatchV2 } from "./contrato";
import type { FluxoFormularioV2 } from "./estado";
import { salvarParcial, type ErroDoParcial, type ResultadoParcial } from "./proposta-v2";

/** Mesmo teto do servidor (`midia_grande`, 3 MB decodificados). */
export const TETO_DA_MIDIA_BYTES = 3 * 1024 * 1024;

const ZAPI_PREFIXO = "zapi:";
const MIMES_LEGIVEIS = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

export interface MidiaRecebida {
  kind: "audio" | "image" | "document";
  /** `meta:<id>` ou `zapi:<url>` (a URL é segredo: não loga). */
  ref: string;
  mimeType?: string;
  legenda?: string;
}

/** Um campo lido do documento. `path` é o do servidor (§18.13.13). */
export interface CampoLido {
  path: string;
  chave?: string;
  valor: string;
  confianca: number;
}

export type MotivoNaoLido = "mime" | "heic" | "tamanho" | "ilegivel" | "sem_leitura" | "falha";

export type ResultadoDaMidia =
  | { tipo: "texto"; texto: string }
  | { tipo: "campos"; documentType: string; confianca: number; campos: CampoLido[]; ignorados: number }
  | { tipo: "nao_lido"; motivo: MotivoNaoLido };

/** O que `cm.lerDocumento` devolve; o mapeamento de status HTTP mora lá. */
export type LeituraDeDocumento =
  | { ok: true; documentType: string; confianca: number; campos: CampoLido[]; ignorados: number }
  | { ok: false; motivo: "politica" | "mime" | "heic" | "tamanho" | "ilegivel" | "indisponivel" | "falha" };

export interface PedidoDeLeitura {
  base64: string;
  mimeType: string;
  alvo: "proposta" | "captacao";
  tipo?: string;
  schemaType?: string;
  papelSugerido?: string;
  posicao?: number;
  /** Id da mensagem de mídia (o servidor exige `x-idempotency-key`). */
  idempotencyKey: string;
}

export interface DepsDaMidia {
  baixar(ref: string): Promise<{ data: Buffer; contentType: string | null } | null>;
  /** O sujeito tem `document.read` na política da org? */
  temDocumentRead: boolean;
  /** Já amarrada a org/telefone/sujeito por quem monta as deps. */
  lerDocumento?(pedido: PedidoDeLeitura): Promise<LeituraDeDocumento>;
  transcrever?(m: {
    kind: "audio" | "image";
    mimeType: string;
    data: Buffer;
  }): Promise<string | null>;
  /** `NEWTON_MEDIA_INBOUND`: sem ela, `zapi:` nem é baixado. */
  newtonMidiaAtiva(): boolean;
}

export interface ContextoDaMidia {
  orgId: string;
  /** Id da mensagem de mídia: vira a chave de idempotência do servidor. */
  messageId: string;
  alvo?: "proposta" | "captacao";
  tipo?: string;
  schemaType?: string;
  papelSugerido?: string;
  posicao?: number;
}

const naoLido = (motivo: MotivoNaoLido): ResultadoDaMidia => ({ tipo: "nao_lido", motivo });

/** Frase honesta por motivo. Sem código interno, sem URL. */
export function fraseDeNaoLido(motivo: MotivoNaoLido, kind: MidiaRecebida["kind"]): string {
  switch (motivo) {
    case "heic":
      return "Não consigo ler foto nesse formato; mande como captura de tela ou digite.";
    case "tamanho":
      return "Esse arquivo é grande demais para eu ler (limite de 3 MB); mande uma foto menor ou digite.";
    case "mime":
      return "Não leio esse tipo de arquivo; mande uma foto (JPG ou PNG) ou digite.";
    case "ilegivel":
      return "Não consegui ler o documento; mande outra foto mais nítida ou digite.";
    case "sem_leitura":
      return kind === "document"
        ? "Ainda não leio PDF aqui; mande foto ou digite."
        : textoSemLeituraDeMidia(null);
    case "falha":
      return "Não consegui abrir esse arquivo agora; tente de novo ou digite.";
  }
}

async function baixarSeguro(
  deps: DepsDaMidia,
  ref: string
): Promise<{ data: Buffer; contentType: string | null } | null> {
  try {
    return await deps.baixar(ref);
  } catch {
    // A mensagem do erro pode trazer a URL de mídia: descartada de propósito.
    return null;
  }
}

/** Lê a mídia. Nunca lança. */
export async function lerMidia(
  deps: DepsDaMidia,
  m: MidiaRecebida,
  ctx: ContextoDaMidia
): Promise<ResultadoDaMidia> {
  try {
    // Newton: `zapi:<url>` só com a flag. Sem ela, a URL nem é tocada.
    if (m.ref.startsWith(ZAPI_PREFIXO) && !deps.newtonMidiaAtiva()) return naoLido("falha");

    if (m.kind === "audio") return await lerAudio(deps, m);

    // Portão barato: sem a capability não há o que mandar ao servidor, e baixar
    // a mídia só para descartá-la é custo e dado em trânsito à toa.
    if (!deps.temDocumentRead) return naoLido("sem_leitura");

    const baixado = await baixarSeguro(deps, m.ref);
    if (!baixado) return naoLido("falha");
    if (baixado.data.length > TETO_DA_MIDIA_BYTES) return naoLido("tamanho");

    // O tipo vem dos BYTES, não do que o storage ou o cliente declararam.
    const mime = sniffMime(baixado.data);
    if (mime === "image/heic" || mime === "image/heif") return naoLido("heic");
    if (!mime || !MIMES_LEGIVEIS.has(mime)) return naoLido("mime");

    if (!deps.lerDocumento) return naoLido("falha");
    const pedido: PedidoDeLeitura = {
      base64: baixado.data.toString("base64"),
      mimeType: mime,
      alvo: ctx.alvo ?? "proposta",
      idempotencyKey: ctx.messageId,
      ...(ctx.tipo ? { tipo: ctx.tipo } : {}),
      ...(ctx.schemaType ? { schemaType: ctx.schemaType } : {}),
      ...(ctx.papelSugerido ? { papelSugerido: ctx.papelSugerido } : {}),
      ...(ctx.posicao ? { posicao: ctx.posicao } : {}),
    };

    let leitura = await deps.lerDocumento(pedido);
    if (!leitura.ok && leitura.motivo === "indisponivel") {
      // 502: o servidor guardou a chave sem conseguir reabrir a resposta; a
      // mesma chave devolveria 502 de novo. UMA nova tentativa, chave nova.
      leitura = await deps.lerDocumento({ ...pedido, idempotencyKey: `${ctx.messageId}:2` });
    }

    if (leitura.ok) {
      return {
        tipo: "campos",
        documentType: leitura.documentType,
        confianca: leitura.confianca,
        campos: leitura.campos,
        ignorados: leitura.ignorados,
      };
    }
    switch (leitura.motivo) {
      case "politica":
        return naoLido("sem_leitura");
      case "indisponivel":
        return naoLido("falha");
      default:
        return naoLido(leitura.motivo);
    }
  } catch {
    return naoLido("falha");
  }
}

async function lerAudio(deps: DepsDaMidia, m: MidiaRecebida): Promise<ResultadoDaMidia> {
  if (!deps.transcrever) return naoLido("falha");
  const baixado = await baixarSeguro(deps, m.ref);
  if (!baixado) return naoLido("falha");
  if (baixado.data.length > TETO_DA_MIDIA_BYTES) return naoLido("tamanho");
  const texto = await deps.transcrever({
    kind: "audio",
    mimeType: m.mimeType ?? baixado.contentType ?? "audio/ogg",
    data: baixado.data,
  });
  const limpo = texto?.trim();
  return limpo ? { tipo: "texto", texto: limpo } : naoLido("falha");
}

// ──────────────────────────────────────────────────────────────────────────
// T8 — o que o servidor LEU de um documento: a ficha "lido — confira" e a
// gravação SÓ depois do "sim" do corretor.
//
// Regra de PII: o valor lido (CPF, nome, RG) vive só num cofre cifrado
// (AES-256-GCM, chave derivada da `MAX_ENCRYPTION_KEY`, amarrado à thread) no
// `cofreLidos` do fluxo. O checkpoint em claro só tem `lidosPendentes`
// (`[{ path, ref }]`: caminho + id da mensagem, nenhum valor). Nada aqui loga.
// ──────────────────────────────────────────────────────────────────────────

const TAMANHO_DA_TAG = 16;

function chaveDoCofre(): Buffer {
  const raw = process.env.MAX_ENCRYPTION_KEY;
  if (!raw) throw new Error("MAX_ENCRYPTION_KEY não configurada");
  const mestra = Buffer.from(raw, "base64");
  if (mestra.length !== 32) throw new Error("MAX_ENCRYPTION_KEY deve ser 32 bytes em base64");
  // Subchave própria: o cofre dos lidos não divide chave com o de crédito nem o de captação.
  return Buffer.from(hkdfSync("sha256", mestra, Buffer.alloc(0), "max-formularios-lidos-cofre", 32));
}

function cifrarCofre(texto: string, thread: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chaveDoCofre(), iv, { authTagLength: TAMANHO_DA_TAG });
  c.setAAD(Buffer.from(thread, "utf8"));
  const enc = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

function decifrarCofre(payload: string, thread: string): string {
  const [iv, tag, dado] = payload.split(".");
  if (!iv || !tag || !dado) throw new Error("cofre malformado");
  const tagBuf = Buffer.from(tag, "base64");
  // Tag truncada ou alongada (payload adulterado) falha aqui, nunca é aceita por `setAuthTag`.
  if (tagBuf.length !== TAMANHO_DA_TAG) throw new Error("cofre malformado: tag de tamanho inválido");
  const d = createDecipheriv("aes-256-gcm", chaveDoCofre(), Buffer.from(iv, "base64"), { authTagLength: TAMANHO_DA_TAG });
  d.setAAD(Buffer.from(thread, "utf8"));
  d.setAuthTag(tagBuf);
  return Buffer.concat([d.update(Buffer.from(dado, "base64")), d.final()]).toString("utf8");
}

/**
 * Os campos lidos guardados no cofre do fluxo. Qualquer falha (sem cofre, chave
 * ausente ou rotacionada, outra thread, payload adulterado) é `[]`: nunca lança e
 * nunca devolve valor de outra thread.
 */
export function lidosDoCofre(fluxo: Pick<FluxoFormularioV2, "cofreLidos">, thread: string): CampoLido[] {
  if (!fluxo.cofreLidos) return [];
  try {
    const bruto: unknown = JSON.parse(decifrarCofre(fluxo.cofreLidos, thread));
    if (!Array.isArray(bruto)) return [];
    return bruto.filter(
      (c): c is CampoLido =>
        !!c &&
        typeof c === "object" &&
        typeof (c as CampoLido).path === "string" &&
        typeof (c as CampoLido).valor === "string" &&
        typeof (c as CampoLido).confianca === "number"
    );
  } catch {
    return [];
  }
}

/** Reescreve `lidosPendentes` (sem valor) e o cofre a partir da lista de campos. */
function comLidos(
  fluxo: FluxoFormularioV2,
  campos: Array<CampoLido & { ref: string }>,
  thread: string
): { ok: true; fluxo: FluxoFormularioV2 } | { ok: false } {
  const { cofreLidos: _antigo, ...resto } = fluxo;
  if (campos.length === 0) return { ok: true, fluxo: { ...resto, lidosPendentes: [] } };
  try {
    const cofre = cifrarCofre(JSON.stringify(campos.map(({ ref: _ref, ...c }) => c)), thread);
    return {
      ok: true,
      fluxo: { ...resto, lidosPendentes: campos.map((c) => ({ path: c.path, ref: c.ref })), cofreLidos: cofre },
    };
  } catch {
    // Sem chave não há onde guardar o valor com segurança: fail-closed, nada vai ao checkpoint.
    return { ok: false };
  }
}

/** Os pendentes atuais com o valor (do cofre) e a referência (do `lidosPendentes`). */
function pendentesComValor(fluxo: FluxoFormularioV2, thread: string): Array<CampoLido & { ref: string }> {
  const refDe = new Map(fluxo.lidosPendentes.map((l) => [l.path, l.ref]));
  return lidosDoCofre(fluxo, thread)
    .filter((c) => refDe.has(c.path))
    .map((c) => ({ ...c, ref: refDe.get(c.path)! }));
}

/**
 * Guarda o que foi lido como PENDENTE de confirmação. Não toca o rascunho. Leitura
 * nova do mesmo caminho substitui a antiga. `{ ok:false }` = sem como guardar com
 * segurança (sem chave): quem chama responde "não consegui abrir" e não retém nada.
 */
export function registrarLidos(
  fluxo: FluxoFormularioV2,
  leitura: { ref: string; campos: CampoLido[] },
  thread: string
): { ok: true; fluxo: FluxoFormularioV2 } | { ok: false } {
  if (leitura.campos.length === 0) return { ok: true, fluxo };
  const porPath = new Map<string, CampoLido & { ref: string }>();
  for (const c of pendentesComValor(fluxo, thread)) porPath.set(c.path, c);
  for (const c of leitura.campos) porPath.set(c.path, { ...c, ref: leitura.ref });
  return comLidos(fluxo, [...porPath.values()], thread);
}

const BAIXA_CONFIANCA = 0.5;

const PARTES: Record<string, string> = {
  compradores: "Comprador",
  vendedores: "Vendedor",
  locatarios: "Locatário",
  locadores: "Locador",
  testemunhas: "Testemunha",
  proprietarios: "Proprietário",
};

const CAMPOS: Record<string, string> = {
  nome: "Nome",
  cpf: "CPF",
  cnpj: "CNPJ",
  email: "E-mail",
  telefone: "Telefone",
  data_nascimento: "Nascimento",
  estado_civil: "Estado civil",
  regime_bens: "Regime de bens",
  matricula: "Matrícula",
  cartorio: "Cartório",
  endereco: "Endereço",
  numero: "Número",
  complemento: "Complemento",
  bairro: "Bairro",
  cidade: "Cidade",
  uf: "UF",
  cep: "CEP",
  inscricao: "Inscrição",
};

function rotuloDoCampo(campo: string): string {
  return CAMPOS[campo] ?? campo.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Grupo e campo legíveis a partir do caminho do servidor. */
function rotuloDoPath(path: string): { grupo: string; campo: string } {
  const parte = /^(compradores|vendedores|locatarios|locadores|testemunhas|proprietarios)\[(\d+)\]\.(conjuge\.)?(\w+)$/.exec(path);
  if (parte) {
    const base = `${PARTES[parte[1]!]} ${Number(parte[2]) + 1}`;
    return { grupo: parte[3] ? `Cônjuge (${base})` : base, campo: rotuloDoCampo(parte[4]!) };
  }
  const imovel = /^(?:imoveis\[0\]|imovel)\.(\w+)$/.exec(path);
  if (imovel) return { grupo: "Imóvel", campo: rotuloDoCampo(imovel[1]!) };
  return { grupo: "Outros", campo: path };
}

/** Valor do documento para a tela: uma linha, curto e sem sinal de confirmação forjado. */
function valorParaTela(v: string): string {
  return v
    .replace(/[✅✔☑]️?/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * A ficha "lido — confira". Mostra o que foi lido (o corretor precisa ver para
 * conferir), NUNCA afirma que gravou e nunca usa o sinal de confirmação: um valor
 * do documento não pode forjar um "tudo certo". Confiança baixa (< 0.5) pede
 * atenção. `ignorados` é só contagem.
 */
export function textoDeConferencia(l: {
  documentType: string;
  confianca: number;
  campos: CampoLido[];
  ignorados: number;
}): string {
  const baixa = l.confianca < BAIXA_CONFIANCA;
  const linhas: string[] = [
    baixa ? "📄 Documento lido — confira com atenção (a leitura veio incerta):" : "📄 Documento lido — confira:",
  ];
  const grupos = new Map<string, string[]>();
  for (const c of l.campos) {
    const { grupo, campo } = rotuloDoPath(c.path);
    const itens = grupos.get(grupo) ?? [];
    itens.push(`• ${campo}: ${valorParaTela(c.valor)}`);
    grupos.set(grupo, itens);
  }
  for (const [grupo, itens] of grupos) linhas.push("", grupo, ...itens);
  if (l.ignorados > 0) {
    linhas.push("", `${l.ignorados} ${l.ignorados === 1 ? "dado do documento não coube" : "dados do documento não couberam"} na proposta.`);
  }
  linhas.push("", "Nada foi anotado ainda. Confira e me diga se está certo.");
  return linhas.join("\n");
}

const CAMPOS_DA_PARTE = new Set(["nome", "cpf", "cnpj", "email", "telefone", "data_nascimento", "estado_civil", "regime_bens"]);
const CAMPOS_DO_CONJUGE = new Set(["nome", "cpf"]);
const PARTE_DO_PATCH: Record<string, "compradores" | "vendedores"> = {
  compradores: "compradores",
  locatarios: "compradores",
  vendedores: "vendedores",
  locadores: "vendedores",
};

/**
 * O PATCH do `proposal.update` com o que dá para gravar dos lidos, e os caminhos que
 * entraram nele. O resto (testemunha, proprietário, campo sem lugar no PATCH) segue
 * pendente: não há como gravar e não é descartado em silêncio.
 */
function montarPatchDosLidos(campos: CampoLido[]): { patch: PatchV2; gravados: Set<string> } {
  const partes: Record<"compradores" | "vendedores", Array<Record<string, unknown>>> = { compradores: [], vendedores: [] };
  let imovel: Record<string, unknown> | undefined;
  const gravados = new Set<string>();

  for (const c of campos) {
    const parte = /^(compradores|vendedores|locatarios|locadores)\[(\d+)\]\.(conjuge\.)?(\w+)$/.exec(c.path);
    if (parte) {
      const [, grupo, n, conjuge, campo] = parte;
      if (!(conjuge ? CAMPOS_DO_CONJUGE : CAMPOS_DA_PARTE).has(campo!)) continue;
      const lista = partes[PARTE_DO_PATCH[grupo!]!];
      const i = Number(n);
      while (lista.length <= i) lista.push({});
      if (conjuge) {
        const atual = (lista[i]!.conjuge as Record<string, unknown> | undefined) ?? {};
        lista[i]!.conjuge = { ...atual, [campo!]: c.valor };
      } else {
        lista[i]![campo!] = c.valor;
      }
      gravados.add(c.path);
      continue;
    }
    const doImovel = /^imoveis\[0\]\.(\w+)$/.exec(c.path);
    if (doImovel) {
      imovel = { ...(imovel ?? {}), [doImovel[1]!]: c.valor };
      gravados.add(c.path);
    }
  }

  const patch: PatchV2 = {};
  if (partes.compradores.length) patch.compradores = partes.compradores as ParteV2[];
  if (partes.vendedores.length) patch.vendedores = partes.vendedores as ParteV2[];
  if (imovel) patch.imovel = imovel;
  return { patch, gravados };
}

export type ErroDosLidos = ErroDoParcial | "cofre_ilegivel" | "nada_a_gravar";

export type GravacaoDosLidos =
  | { ok: true; fluxo: FluxoFormularioV2; resultado: Extract<ResultadoParcial, { ok: true }> }
  | { ok: false; erro: ErroDosLidos; fluxo: FluxoFormularioV2; resultado?: ResultadoParcial };

/**
 * Grava os lidos no rascunho. SÓ chama o servidor com a prova do "sim" do corretor
 * (`messageIdDoSim`, que vira a `idempotencyKey` pelo `salvarParcial`); sem ela, nada
 * é escrito e os lidos seguem pendentes. Recusa ou falta de resposta NUNCA limpam os
 * lidos (o corretor pode tentar de novo); só o 2xx limpa o que de fato gravou.
 */
export async function gravarLidos(
  deps: Pick<DepsDoFluxo, "acao">,
  fluxo: FluxoFormularioV2,
  thread: string,
  opts: { messageIdDoSim: string }
): Promise<GravacaoDosLidos> {
  if (typeof opts.messageIdDoSim !== "string" || opts.messageIdDoSim.trim().length === 0) {
    return { ok: false, erro: "sem_confirmacao", fluxo };
  }
  const pendentes = pendentesComValor(fluxo, thread);
  if (pendentes.length === 0) {
    // Havia pendência mas o cofre não abriu (chave rotacionada, thread trocada): o valor
    // se perdeu. Limpa o ponteiro sem valor e diz a verdade, em vez de reter lixo.
    const perdido = fluxo.lidosPendentes.length > 0;
    const limpo = comLidos(fluxo, [], thread);
    return { ok: false, erro: perdido ? "cofre_ilegivel" : "nada_a_gravar", fluxo: limpo.ok ? limpo.fluxo : fluxo };
  }

  const { patch, gravados } = montarPatchDosLidos(pendentes);
  if (gravados.size === 0) return { ok: false, erro: "nada_a_gravar", fluxo };

  const r = await salvarParcial(deps, fluxo, patch, { confirmacao: { messageIdDoSim: opts.messageIdDoSim } });
  if (!r.ok) {
    const proximo = r.fluxo && r.fluxo.kind === "proposta_v2" ? r.fluxo : fluxo;
    return { ok: false, erro: r.erro, fluxo: proximo, resultado: r };
  }
  const sobra = pendentes.filter((c) => !gravados.has(c.path));
  const limpo = comLidos(r.fluxo, sobra, thread);
  // Sem como re-cifrar a sobra (chave sumiu entre os dois passos): descarta a sobra, não a deixa em claro.
  const final: FluxoFormularioV2 = limpo.ok ? limpo.fluxo : { ...r.fluxo, lidosPendentes: [], cofreLidos: undefined };
  return { ok: true, fluxo: final, resultado: r };
}
