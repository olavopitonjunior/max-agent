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
  /**
   * Lido sem se saber de quem é o documento (I4). Só existe DENTRO do cofre cifrado (nunca no
   * checkpoint em claro) e impede a gravação: ver `montarPatchDosLidos`.
   */
  semPapel?: boolean;
  /**
   * Veio como RESPOSTA a uma pergunta do Max sobre esta posição (`faltando.signatario.posicao`).
   * Um CPF/CNPJ solto numa posição já ocupada só vale se foi perguntado: do contrário não diz de
   * QUEM é e vira conflito (I1). Só existe dentro do cofre cifrado.
   */
  perguntado?: boolean;
}

export type MotivoNaoLido =
  | "mime" | "heic" | "tamanho" | "ilegivel" | "sem_leitura" | "falha" | "processando"
  /** N4: sem a chave do cofre não há onde guardar o valor lido; reenviar não ajuda. */
  | "sem_cofre"
  /** M3: o servidor desligou o fluxo v2 (403 `fluxo_desligado`); o fluxo volta ao v1. */
  | "fluxo_desligado";

export type ResultadoDaMidia =
  | { tipo: "texto"; texto: string }
  | {
      tipo: "campos";
      documentType: string;
      confianca: number;
      campos: CampoLido[];
      ignorados: number;
      /** Dado de pessoa lido sem papel (nem legenda nem campo aguardado): não pode ser gravado (I4). */
      papelIncerto?: boolean;
    }
  | { tipo: "nao_lido"; motivo: MotivoNaoLido };

/** O que `cm.lerDocumento` devolve; o mapeamento de status HTTP mora lá. */
export type LeituraDeDocumento =
  | { ok: true; documentType: string; confianca: number; campos: CampoLido[]; ignorados: number }
  | {
      ok: false;
      motivo: "politica" | "fluxo_desligado" | "mime" | "heic" | "tamanho" | "ilegivel" | "indisponivel" | "processando" | "falha";
    };

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
  /**
   * Baixa a mídia. `lerMidia` SEMPRE passa `{ distinguirTamanho: true }`: o adaptador que recusa
   * por tamanho devolve `{ erro: "tamanho" }` (e não `null`), para a resposta ser "grande demais".
   */
  baixar(
    ref: string,
    opts?: { distinguirTamanho?: boolean }
  ): Promise<{ data: Buffer; contentType: string | null } | { erro: "tamanho" } | null>;
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
  /**
   * `MAX_OCR_TRANSCRIBE_FALLBACK` (T9): sem `document.read`, foto COM legenda é
   * transcrita e vira texto. O custo da transcrição é registrado pelo servidor
   * (AIUsage): este lado não reporta uso.
   */
  fallbackDeTranscricao?: boolean;
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

/** Os papéis do contrato (`papel_sugerido`, max.md §18.13.13). */
export type PapelSugerido = "proponente" | "vendedor" | "conjuge" | "proprietario" | "testemunha" | "imovel";

const semAcento = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Cada papel e as palavras que o dizem (texto já sem acento e em minúsculas). Na proposta o
 * proprietário é o lado vendedor: `proprietario` do contrato é de captação e não é enviado aqui.
 */
const PALAVRAS_DO_PAPEL: Array<[PapelSugerido, RegExp]> = [
  ["vendedor", /\b(?:vendedor(?:a|es|as)?|proprietari[oa]s?)\b/],
  ["proponente", /\b(?:comprador(?:a|es|as)?|proponentes?|locatari[oa]s?|inquilin[oa]s?)\b/],
  ["conjuge", /\b(?:conjuges?|espos[oa]s?|marido|companheir[oa]s?)\b/],
  ["testemunha", /\btestemunhas?\b/],
  ["imovel", /\b(?:matriculas?|iptu|escrituras?|imovel|imoveis)\b/],
];

const ORDINAIS: Array<[RegExp, number]> = [
  [/\bprimeir[oa]s?\b/g, 1],
  [/\bsegund[oa]s?\b/g, 2],
  [/\bterceir[oa]s?\b/g, 3],
  [/\bquart[oa]s?\b/g, 4],
  [/\bquint[oa]s?\b/g, 5],
];

/** Posição citada na legenda (1 a 10); `null` = nenhuma; `"ambigua"` = mais de uma, diferentes. */
function posicaoDaLegenda(t: string): number | null | "ambigua" {
  const achadas = new Set<number>();
  // `search` e não `test`: o `/g` do regex compartilhado guardaria `lastIndex` entre chamadas.
  for (const [re, n] of ORDINAIS) if (t.search(re) >= 0) achadas.add(n);
  for (const m of t.matchAll(/\b(10|[1-9])\s*[º°ª]/g)) achadas.add(Number(m[1]));
  for (const m of t.matchAll(
    /\b(?:comprador|vendedor|proponente|locatari|inquilin|testemunha|proprietari|conjuge|espos)\w*\s*(?:n[º°.]?\s*)?(10|[1-9])\b/g
  ))
    achadas.add(Number(m[1]));
  if (achadas.size === 0) return null;
  return achadas.size === 1 ? [...achadas][0]! : "ambigua";
}

/** O papel que a `parteRef` do campo aguardado (`comprador:2`, `imovel`) nomeia; `{}` se não é de pessoa/imóvel. */
function papelDaParteRef(parteRef: string): { papel?: PapelSugerido; posicao?: number } {
  const m = /^(comprador|proponente|locatario|vendedor|locador|proprietario|conjuge|testemunha|imovel)(?::(\d+))?$/.exec(parteRef);
  if (!m) return {};
  const papel: PapelSugerido =
    m[1] === "comprador" || m[1] === "proponente" || m[1] === "locatario"
      ? "proponente"
      : m[1] === "vendedor" || m[1] === "locador" || m[1] === "proprietario"
        ? "vendedor"
        : (m[1] as PapelSugerido);
  const n = m[2] ? Number(m[2]) : undefined;
  return n && n >= 1 && n <= 10 && papel !== "imovel" ? { papel, posicao: n } : { papel };
}

/**
 * De QUEM é o documento (I4): a legenda diz primeiro; sem legenda útil, vale o campo que o
 * fluxo está esperando (`aguardaCampo.parteRef`). Legenda ambígua (dois papéis, ou duas posições)
 * NÃO cai no campo aguardado: o conflito é do corretor. `{}` = indeterminado, e quem chama não
 * pode assumir "comprador 1" (a leitura entra como "sem papel" e nada é gravado por omissão).
 */
export function derivarPapel(
  legenda: string | undefined,
  aguardaCampo: { parteRef: string; path?: string } | undefined
): { papel?: PapelSugerido; posicao?: number } {
  const t = legenda ? semAcento(legenda) : "";
  const papeis = PALAVRAS_DO_PAPEL.filter(([, re]) => re.test(t)).map(([p]) => p);
  if (papeis.length > 1) return {};
  if (papeis.length === 1) {
    const papel = papeis[0]!;
    if (papel === "imovel") return { papel };
    const pos = posicaoDaLegenda(t);
    if (pos === "ambigua") return {};
    return pos === null ? { papel } : { papel, posicao: pos };
  }
  return aguardaCampo ? papelDaParteRef(aguardaCampo.parteRef) : {};
}

const CAMINHO_DE_PESSOA = /^(?:compradores|vendedores|locatarios|locadores|proprietarios|testemunhas)\[/;

/**
 * A leitura é "sem papel" quando NÃO se mandou papel ao servidor e o documento trouxe dado de
 * PESSOA: sem papel o servidor assume comprador 1, e isso não pode ser tratado como "de quem é".
 * Dado do imóvel não precisa de papel (matrícula, IPTU e escritura vão sempre para o imóvel).
 */
export function camposSemPapel(campos: CampoLido[], papelSugerido: string | undefined): boolean {
  return !papelSugerido && campos.some((c) => CAMINHO_DE_PESSOA.test(c.path));
}

/** Marcador do que se grava/loga no lugar da ficha com valores lidos de documento. */
export const MARCADOR_DOCUMENTO_LIDO = "[documento lido: valores omitidos do log]";

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
    case "sem_cofre":
      // Reenviar não resolve: o problema não é o arquivo.
      return "A leitura de documentos está indisponível agora. Digite os dados que eu confiro com você.";
    case "fluxo_desligado":
      return "Não leio documentos por aqui no momento. Pode digitar os dados que eu sigo daqui.";
    case "processando":
      // O prazo estourou, mas o servidor segue lendo (e cobra uma vez só, pela chave da mensagem).
      // Mandar a mesma foto de novo seria uma segunda leitura paga: a frase diz para esperar.
      return "Ainda estou lendo esse documento e pode demorar. Aguarde alguns minutos antes de mandar de novo, para não ler duas vezes.";
  }
}

type Baixada = { data: Buffer; contentType: string | null };

/** O download ou o MOTIVO de não ter vindo (nunca lança; o teto de 3 MB vale aqui também). */
async function baixarSeguro(
  deps: DepsDaMidia,
  ref: string
): Promise<{ ok: true; midia: Baixada } | { ok: false; motivo: MotivoNaoLido }> {
  try {
    const r = await deps.baixar(ref, { distinguirTamanho: true });
    if (!r) return { ok: false, motivo: "falha" };
    if ("erro" in r) return { ok: false, motivo: "tamanho" };
    if (r.data.length > TETO_DA_MIDIA_BYTES) return { ok: false, motivo: "tamanho" };
    return { ok: true, midia: r };
  } catch {
    // A mensagem do erro pode trazer a URL de mídia: descartada de propósito.
    return { ok: false, motivo: "falha" };
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
    // É "não leio mídia por aqui", não "tente de novo": reenviar não muda nada enquanto a flag estiver off.
    if (m.ref.startsWith(ZAPI_PREFIXO) && !deps.newtonMidiaAtiva()) return naoLido("sem_leitura");

    if (m.kind === "audio") return await lerAudio(deps, m);

    // Portão barato: sem a capability não há o que mandar ao servidor, e baixar
    // a mídia só para descartá-la é custo e dado em trânsito à toa.
    if (!deps.temDocumentRead) {
      // T9: o único caminho de leitura sem a capability é a transcrição de IMAGEM com
      // legenda. Sem legenda não há turno para o texto alimentar (os lidos vivem só no
      // turno), então nem se paga a transcrição. PDF nunca: o transcribe é de imagem.
      if (deps.fallbackDeTranscricao && m.kind === "image" && m.legenda?.trim() && deps.transcrever) {
        return await lerImagemPorTranscricao(deps, m);
      }
      return naoLido("sem_leitura");
    }

    // Fail-closed SEM custo: o valor lido só tem onde ficar com a chave do cofre. Sem ela, ler
    // (e pagar o OCR) para depois descartar o resultado seria gasto sem entrega.
    if (!cofreDisponivel()) return naoLido("sem_cofre");

    const b = await baixarSeguro(deps, m.ref);
    if (!b.ok) return naoLido(b.motivo);
    const baixado = b.midia;

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
      case "fluxo_desligado":
        return naoLido("fluxo_desligado");
      case "indisponivel":
        return naoLido("falha");
      default:
        return naoLido(leitura.motivo);
    }
  } catch {
    return naoLido("falha");
  }
}

/** Prefixo do texto transcrito de uma imagem (T9): é DADO de documento, não fala do corretor. */
const PREFIXO_TEXTO_NA_IMAGEM = "Texto na imagem: ";

async function lerImagemPorTranscricao(deps: DepsDaMidia, m: MidiaRecebida): Promise<ResultadoDaMidia> {
  const b = await baixarSeguro(deps, m.ref);
  if (!b.ok) return naoLido(b.motivo);
  const baixado = b.midia;
  const mime = sniffMime(baixado.data);
  if (mime === "image/heic" || mime === "image/heif") return naoLido("heic");
  if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") return naoLido("mime");
  let texto: string | null | undefined;
  try {
    texto = await deps.transcrever!({ kind: "image", mimeType: mime, data: baixado.data });
  } catch {
    // A mensagem do erro pode trazer a URL de mídia: descartada de propósito.
    return naoLido("falha");
  }
  const limpo = texto?.trim();
  return limpo ? { tipo: "texto", texto: `${PREFIXO_TEXTO_NA_IMAGEM}${limpo}` } : naoLido("falha");
}

async function lerAudio(deps: DepsDaMidia, m: MidiaRecebida): Promise<ResultadoDaMidia> {
  if (!deps.transcrever) return naoLido("falha");
  const b = await baixarSeguro(deps, m.ref);
  if (!b.ok) return naoLido(b.motivo);
  const baixado = b.midia;
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

/** A chave do cofre existe e tem o formato certo? Confere ANTES de pagar o OCR (nunca lança). */
export function cofreDisponivel(): boolean {
  try {
    chaveDoCofre();
    return true;
  } catch {
    return false;
  }
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

/** Quantas falas anteriores o cofre guarda (a janela de extração usa no máximo isto menos a atual). */
const FALAS_NO_COFRE = 7;
/** Teto por fala (o da janela, `JANELA_MAX_CHARS`): o que passa disso nunca caberia na janela. */
const FALA_MAX_CHARS = 6000;

/**
 * As falas anteriores do corretor neste fluxo, abertas do cofre. Qualquer falha (sem cofre, chave
 * ausente ou rotacionada, outra thread, payload adulterado) é `[]`: nunca lança e nunca devolve
 * fala de outra thread.
 */
export function falasDoCofre(fluxo: Pick<FluxoFormularioV2, "cofreFalas">, thread: string): string[] {
  if (!fluxo.cofreFalas) return [];
  try {
    const bruto: unknown = JSON.parse(decifrarCofre(fluxo.cofreFalas, `falas|${thread}`));
    return Array.isArray(bruto) ? bruto.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Acrescenta a fala do corretor ao cofre de falas (as mais novas ficam). Sem chave, descarta o
 * cofre inteiro: a fala nunca vai em claro para o checkpoint (a janela fica sem anteriores).
 */
export function guardarFala(fluxo: FluxoFormularioV2, texto: string, thread: string): FluxoFormularioV2 {
  const { cofreFalas: _antigo, ...resto } = fluxo;
  if (!cofreDisponivel()) return resto;
  const falas = [...falasDoCofre(fluxo, thread), texto.slice(0, FALA_MAX_CHARS)].slice(-FALAS_NO_COFRE);
  return { ...resto, cofreFalas: cifrarCofre(JSON.stringify(falas), `falas|${thread}`) };
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
  leitura: { ref: string; campos: CampoLido[]; semPapel?: boolean },
  thread: string
): { ok: true; fluxo: FluxoFormularioV2 } | { ok: false } {
  if (leitura.campos.length === 0) return { ok: true, fluxo };
  const porPath = new Map<string, CampoLido & { ref: string }>();
  for (const c of pendentesComValor(fluxo, thread)) porPath.set(c.path, c);
  for (const c of leitura.campos) {
    // `semPapel` é decidido por quem lê e vale para a leitura inteira; nunca herdado do que o servidor mandou.
    const { semPapel: _vindo, ...limpo } = c;
    porPath.set(c.path, { ...limpo, ...(leitura.semPapel ? { semPapel: true } : {}), ref: leitura.ref });
  }
  // F4: o mesmo CPF dito para duas posições do mesmo lado é uma pessoa só (antes do cartão e do SIM).
  return comLidos(fluxo, unificarDocumentoRepetido([...porPath.values()]), thread);
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
export function rotuloDoPath(path: string): { grupo: string; campo: string } {
  const parte = /^(compradores|vendedores|locatarios|locadores|testemunhas|proprietarios)\[(\d+)\]\.(conjuge\.)?(\w+)$/.exec(path);
  if (parte) {
    const base = `${PARTES[parte[1]!]} ${Number(parte[2]) + 1}`;
    return { grupo: parte[3] ? `Cônjuge (${base})` : base, campo: rotuloDoCampo(parte[4]!) };
  }
  const imovel = /^(?:imoveis\[0\]|imovel)\.(\w+)$/.exec(path);
  if (imovel) return { grupo: "Imóvel", campo: rotuloDoCampo(imovel[1]!) };
  const negociacao = /^negociacao\.(\w+)$/.exec(path);
  if (negociacao) return { grupo: "Negociação", campo: NEGOCIACAO[negociacao[1]!] ?? rotuloDoCampo(negociacao[1]!) };
  const corretor = /^corretor\.(\w+)$/.exec(path);
  if (corretor) return { grupo: "Corretor", campo: CORRETOR[corretor[1]!] ?? rotuloDoCampo(corretor[1]!) };
  if (path === "observacoes") return { grupo: "Outros", campo: "Observações" };
  // Genérico: nunca o caminho técnico ("seguro.apolice_numero") para o corretor; só o último trecho, legível.
  const ultimo = path.split(".").pop()?.replace(/\[\d+\]/g, "") ?? "";
  return { grupo: "Outros", campo: ultimo ? rotuloDoCampo(ultimo) : "Outro dado" };
}

const NEGOCIACAO: Record<string, string> = {
  valor: "Valor da negociação",
  sinal: "Sinal",
  prazo_meses: "Prazo (meses)",
  data_entrada: "Data de entrada",
  modalidade: "Modalidade",
};

const CORRETOR: Record<string, string> = {
  creci: "CRECI",
};

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
  papelIncerto?: boolean;
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
  if (l.papelIncerto) {
    // Sem saber de quem é, "está certo" não tem sentido: o mesmo dado serviria a qualquer parte.
    linhas.push(
      "",
      "De quem é esse documento? (comprador, vendedor, cônjuge, testemunha...) Mande a foto de novo com isso na legenda.",
      "Nada foi anotado ainda."
    );
  } else {
    linhas.push("", "Nada foi anotado ainda. Confira e me diga se está certo.");
  }
  return linhas.join("\n");
}

const CAMPOS_DA_PARTE = new Set(["nome", "cpf", "cnpj", "email", "telefone", "data_nascimento", "estado_civil", "regime_bens"]);
const CAMPOS_DO_CONJUGE = new Set(["nome", "cpf"]);
const CAMPOS_NUMERICOS = new Set(["valor", "sinal", "prazo_meses"]);
const CAMPOS_DA_NEGOCIACAO = new Set(["valor", "sinal", "prazo_meses", "modalidade", "data_entrada"]);
const PARTE_DO_PATCH: Record<string, "compradores" | "vendedores"> = {
  compradores: "compradores",
  locatarios: "compradores",
  vendedores: "vendedores",
  locadores: "vendedores",
};

const RE_PARTE = /^(compradores|vendedores|locatarios|locadores)\[(\d+)\]\.(conjuge\.)?(\w+)$/;

/**
 * O caminho tem destino no PATCH do `proposal.update`? (M2) Testemunha, proprietário,
 * RG, endereço de pessoa e qualquer campo fora das listas fechadas NÃO têm: o dado não
 * cabe na proposta, e quem o guardasse "pendente" o reteria para sempre.
 */
export function caminhoGravavel(path: string): boolean {
  const parte = RE_PARTE.exec(path);
  if (parte) return (parte[3] ? CAMPOS_DO_CONJUGE : CAMPOS_DA_PARTE).has(parte[4]!);
  if (/^(?:imoveis\[0\]|imovel)\.\w+$/.test(path)) return true;
  const neg = /^negociacao\.(\w+)$/.exec(path);
  if (neg) return CAMPOS_DA_NEGOCIACAO.has(neg[1]!);
  return path === "corretor.creci" || path === "observacoes";
}

export type GrupoDaParte = "compradores" | "vendedores";

/** Nome (por posição) das partes que o servidor já tem: a base do M1 e da conferência N1. */
export type PartesGravadas = Record<GrupoDaParte, string[]>;

export interface OpcoesDaGravacao {
  messageIdDoSim: string;
  /** O que o servidor já tem (de `options.signatarios`). Sem isto, trata-se como rascunho sem partes. */
  partes?: PartesGravadas;
  /** O corretor disse "é o mesmo, troca": R38, escreve com `substituir:true`. */
  substituir?: { grupo: GrupoDaParte; posicao: number };
  /** O corretor disse "é outro": os lidos dessa posição vão para a próxima livre. */
  comoNovaParte?: { grupo: GrupoDaParte; posicao: number };
}

export interface ConflitoDeParte {
  grupo: GrupoDaParte;
  posicao: number;
  nomeAtual: string;
}

const nomeNormalizado = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Mesmo nome? Caixa/acento à parte, e "Maria Teste" cabe em "Maria Teste da Silva". */
function mesmoNome(a: string, b: string): boolean {
  const pa = nomeNormalizado(a).split(" ").filter((p) => p.length > 2);
  const pb = nomeNormalizado(b).split(" ").filter((p) => p.length > 2);
  if (pa.length === 0 || pb.length === 0) return true; // nada comparável: não há conflito detectável
  const [curto, longo] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
  return curto.every((p) => longo.includes(p));
}

// ─── O mesmo CPF/CNPJ em duas partes (F4) ───────────────────────────────────

/** Duas partes (lado + posição) que trazem o mesmo documento. Nunca leva o número. */
export interface DocumentoRepetido {
  a: { grupo: GrupoDaParte; posicao: number };
  b: { grupo: GrupoDaParte; posicao: number };
}

interface ParteDoLido {
  prefixo: string;
  grupo: GrupoDaParte;
  posicao: number;
  conjuge: boolean;
  campo: string;
}

function parteDoLido(path: string): ParteDoLido | null {
  const m = RE_PARTE.exec(path);
  if (!m) return null;
  return { prefixo: m[1]!, grupo: PARTE_DO_PATCH[m[1]!]!, posicao: Number(m[2]), conjuge: !!m[3], campo: m[4]! };
}

const reescreverPosicao = (path: string, de: number, para: number): string => path.replace(`[${de}]`, `[${para}]`);

/** Documento (CPF ou CNPJ) da parte, só dígitos; vazio quando o valor não tem cara de documento. */
function documentoDaParte(c: CampoLido): { chave: string; grupo: GrupoDaParte; posicao: number } | null {
  const p = parteDoLido(c.path);
  if (!p || p.conjuge || (p.campo !== "cpf" && p.campo !== "cnpj")) return null;
  const d = c.valor.replace(/\D/g, "");
  return d.length === 11 || d.length === 14 ? { chave: d, grupo: p.grupo, posicao: p.posicao } : null;
}

function nomeDaParte(campos: CampoLido[], grupo: GrupoDaParte, posicao: number): string | undefined {
  for (const c of campos) {
    const p = parteDoLido(c.path);
    if (p && !p.conjuge && p.campo === "nome" && p.grupo === grupo && p.posicao === posicao) return c.valor;
  }
  return undefined;
}

/** Nomes que se contradizem (os dois presentes e diferentes) = duas pessoas com o mesmo documento. */
function nomesContraditorios(campos: CampoLido[], a: DocumentoRepetido["a"], b: DocumentoRepetido["b"]): boolean {
  const na = nomeDaParte(campos, a.grupo, a.posicao);
  const nb = nomeDaParte(campos, b.grupo, b.posicao);
  return !!na && !!nb && !mesmoNome(na, nb);
}

function documentosPorChave(campos: CampoLido[]): Map<string, Array<{ grupo: GrupoDaParte; posicao: number }>> {
  const porChave = new Map<string, Array<{ grupo: GrupoDaParte; posicao: number }>>();
  for (const c of campos) {
    const d = documentoDaParte(c);
    if (!d) continue;
    const lista = porChave.get(d.chave) ?? [];
    if (!lista.some((x) => x.grupo === d.grupo && x.posicao === d.posicao)) lista.push({ grupo: d.grupo, posicao: d.posicao });
    porChave.set(d.chave, lista);
  }
  return porChave;
}

/**
 * O mesmo CPF/CNPJ em duas posições do MESMO lado, sem nomes que se contradigam, é UMA pessoa dita
 * duas vezes: as posições viram uma (a menor fica; o que só a outra trazia passa para ela; os lados
 * seguintes sobem). Nada disso toca o servidor: é a arrumação do que ainda é só leitura pendente.
 * Documento igual em lados diferentes, ou em nomes diferentes, NÃO é unificado: é ambíguo
 * (`documentoRepetido`) e quem decide é o corretor.
 */
export function unificarDocumentoRepetido<T extends CampoLido>(campos: T[]): T[] {
  let atual = campos;
  for (const posicoes of documentosPorChave(campos).values()) {
    if (posicoes.length < 2) continue;
    const grupo = posicoes[0]!.grupo;
    if (posicoes.some((p) => p.grupo !== grupo)) continue;
    const ordenadas = posicoes.map((p) => p.posicao).sort((x, y) => x - y);
    const alvo = ordenadas[0]!;
    if (ordenadas.slice(1).some((q) => nomesContraditorios(atual, { grupo, posicao: alvo }, { grupo, posicao: q }))) continue;
    const sobram = ordenadas.slice(1);
    const resultado: T[] = [];
    const ocupados = new Set<string>();
    for (const c of atual) {
      const p = parteDoLido(c.path);
      if (p && p.grupo === grupo && p.posicao === alvo) ocupados.add(c.path);
    }
    for (const c of atual) {
      const p = parteDoLido(c.path);
      if (!p || p.grupo !== grupo || !sobram.includes(p.posicao)) {
        resultado.push(c);
        continue;
      }
      const novo = reescreverPosicao(c.path, p.posicao, alvo);
      if (ocupados.has(novo)) continue; // o campo já existe na posição que fica: ela vale
      ocupados.add(novo);
      resultado.push({ ...c, path: novo });
    }
    // Fecha o buraco: o que vinha depois de uma posição removida sobe.
    atual = resultado.map((c) => {
      const p = parteDoLido(c.path);
      if (!p || p.grupo !== grupo) return c;
      const abaixo = sobram.filter((q) => q < p.posicao).length;
      return abaixo > 0 ? { ...c, path: reescreverPosicao(c.path, p.posicao, p.posicao - abaixo) } : c;
    });
  }
  return atual;
}

/** O primeiro documento que ainda está em duas partes que NÃO dá para tratar como a mesma pessoa. */
export function documentoRepetido(campos: CampoLido[]): DocumentoRepetido | null {
  for (const posicoes of documentosPorChave(unificarDocumentoRepetido(campos)).values()) {
    if (posicoes.length >= 2) return { a: posicoes[0]!, b: posicoes[1]! };
  }
  return null;
}

/** O nome lido para a parte (do cofre), se houver. */
export function nomeLidoDaParte(campos: CampoLido[], grupo: GrupoDaParte, posicao: number): string | undefined {
  return nomeDaParte(campos, grupo, posicao);
}

interface PatchMontado {
  patch: PatchV2;
  gravados: Set<string>;
  /** Sem destino (M2) ou com valor impossível: sai do cofre. */
  descartados: string[];
  conflito?: ConflitoDeParte;
}

/**
 * O PATCH do `proposal.update` com o que dá para gravar dos lidos, e os caminhos que
 * entraram nele.
 *
 *  - M1: nunca manda uma posição "vazia" que o servidor recusa. A posição i só vai se
 *    todas as anteriores já existem ou vão no mesmo PATCH; senão o dado segue pendente.
 *  - M2: o que não tem destino é devolvido em `descartados`.
 *  - N1: nome diferente do da parte já gravada na mesma posição não é escrito: devolve
 *    `conflito` e nada é gravado (quem decide é o corretor).
 */
function montarPatchDosLidos(campos: CampoLido[], op: Pick<OpcoesDaGravacao, "partes" | "substituir" | "comoNovaParte">): PatchMontado {
  const existentes: PartesGravadas = op.partes ?? { compradores: [], vendedores: [] };
  const descartados: string[] = [];
  const gravados = new Set<string>();
  const porGrupo: Record<GrupoDaParte, Map<number, Record<string, unknown>>> = { compradores: new Map(), vendedores: new Map() };
  const caminhosPorGrupo: Record<GrupoDaParte, Map<number, string[]>> = { compradores: new Map(), vendedores: new Map() };
  let imovel: Record<string, unknown> | undefined;
  let negociacao: NonNullable<PatchV2["negociacao"]> | undefined;
  let corretor: NonNullable<PatchV2["corretor"]> | undefined;
  let observacoes: string | undefined;
  let conflito: ConflitoDeParte | undefined;

  // I1: quem trouxe o NOME da posição neste lote já disse de quem é o documento.
  const comNomeNoLote = new Set<string>();
  for (const c of campos) {
    const m = RE_PARTE.exec(c.path);
    if (m && !m[3] && m[4] === "nome" && !c.semPapel) comNomeNoLote.add(`${PARTE_DO_PATCH[m[1]!]}:${m[2]}`);
  }

  // "É outro": a posição pedida passa a ser a próxima livre (depois do que já existe e do que veio).
  const nova = op.comoNovaParte;
  let destinoDaNova = -1;
  if (nova) {
    destinoDaNova = existentes[nova.grupo].length;
    for (const c of campos) {
      const m = RE_PARTE.exec(c.path);
      if (m && PARTE_DO_PATCH[m[1]!] === nova.grupo && Number(m[2]) !== nova.posicao) {
        destinoDaNova = Math.max(destinoDaNova, Number(m[2]) + 1);
      }
    }
  }

  for (const c of campos) {
    if (!caminhoGravavel(c.path)) {
      descartados.push(c.path);
      continue;
    }
    // I4: sem saber de quem é, o dado não vai para parte nenhuma (nem para a posição que o
    // servidor assumiu por omissão): fica pendente até alguém dizer.
    if (c.semPapel) continue;

    const parte = RE_PARTE.exec(c.path);
    if (parte) {
      const [, grupoBruto, n, conjuge, campo] = parte;
      const grupo = PARTE_DO_PATCH[grupoBruto!]!;
      const posicaoLida = Number(n);
      let i = posicaoLida;
      if (nova && nova.grupo === grupo && nova.posicao === i) i = destinoDaNova;
      const nomeAtual = existentes[grupo][i];
      const trocando = op.substituir?.grupo === grupo && op.substituir.posicao === i;
      if (!conjuge && campo === "nome" && nomeAtual && !trocando && !mesmoNome(nomeAtual, c.valor)) {
        conflito ??= { grupo, posicao: i, nomeAtual };
      }
      // I1: documento sem nome, numa posição ocupada, que ninguém perguntou: não diz de quem é.
      if (
        !conjuge &&
        (campo === "cpf" || campo === "cnpj") &&
        nomeAtual &&
        !trocando &&
        !c.perguntado &&
        !comNomeNoLote.has(`${grupo}:${posicaoLida}`)
      ) {
        conflito ??= { grupo, posicao: i, nomeAtual };
      }
      const alvo = porGrupo[grupo].get(i) ?? {};
      if (conjuge) {
        alvo.conjuge = { ...((alvo.conjuge as Record<string, unknown> | undefined) ?? {}), [campo!]: c.valor };
      } else {
        alvo[campo!] = c.valor;
      }
      // M9: o servidor só aceita `substituir:true` junto de um nome novo (R38); documento sozinho,
      // numa troca confirmada, é só o documento.
      if (trocando && !conjuge && campo === "nome") alvo.substituir = true;
      porGrupo[grupo].set(i, alvo);
      caminhosPorGrupo[grupo].set(i, [...(caminhosPorGrupo[grupo].get(i) ?? []), c.path]);
      continue;
    }

    const doImovel = /^(?:imoveis\[0\]|imovel)\.(\w+)$/.exec(c.path);
    if (doImovel) {
      imovel = { ...(imovel ?? {}), [doImovel[1]!]: c.valor };
      gravados.add(c.path);
      continue;
    }
    const neg = /^negociacao\.(\w+)$/.exec(c.path);
    if (neg) {
      const campo = neg[1]!;
      if (CAMPOS_NUMERICOS.has(campo)) {
        const n = Number(c.valor);
        if (!Number.isFinite(n) || n <= 0) {
          descartados.push(c.path);
          continue;
        }
        negociacao = { ...(negociacao ?? {}), [campo]: n };
      } else {
        negociacao = { ...(negociacao ?? {}), [campo]: c.valor };
      }
      gravados.add(c.path);
      continue;
    }
    if (c.path === "corretor.creci") {
      corretor = { ...(corretor ?? {}), creci: c.valor };
      gravados.add(c.path);
      continue;
    }
    if (c.path === "observacoes") {
      observacoes = c.valor;
      gravados.add(c.path);
    }
  }

  if (conflito) return { patch: {}, gravados: new Set(), descartados, conflito };

  const patch: PatchV2 = {};
  for (const grupo of ["compradores", "vendedores"] as const) {
    const mapa = porGrupo[grupo];
    if (mapa.size === 0) continue;
    let cursor = existentes[grupo].length;
    const lista: Array<Record<string, unknown>> = [];
    for (const i of [...mapa.keys()].sort((a, b) => a - b)) {
      if (i > cursor) continue; // buraco (M1): fica pendente, não vira posição vazia
      while (lista.length < i) lista.push({});
      lista[i] = mapa.get(i)!;
      for (const p of caminhosPorGrupo[grupo].get(i) ?? []) gravados.add(p);
      cursor = Math.max(cursor, i + 1);
    }
    if (lista.length) patch[grupo] = lista as ParteV2[];
  }
  if (imovel) patch.imovel = imovel;
  if (negociacao) patch.negociacao = negociacao;
  if (corretor) patch.corretor = corretor;
  if (observacoes !== undefined) patch.observacoes = observacoes;
  return { patch, gravados, descartados };
}

export type ErroDosLidos = ErroDoParcial | "cofre_ilegivel" | "nada_a_gravar" | "papel_indefinido" | "conflito_de_parte" | "documento_repetido";

export type GravacaoDosLidos =
  | { ok: true; fluxo: FluxoFormularioV2; resultado: Extract<ResultadoParcial, { ok: true }>; descartados: string[] }
  | {
      ok: false;
      erro: ErroDosLidos;
      fluxo: FluxoFormularioV2;
      resultado?: ResultadoParcial;
      descartados: string[];
      conflito?: ConflitoDeParte;
      repetido?: DocumentoRepetido;
    };

/**
 * Grava os lidos no rascunho. SÓ chama o servidor com a prova do "sim" do corretor
 * (`messageIdDoSim`, que vira a `idempotencyKey` pelo `salvarParcial`); sem ela, nada
 * é escrito e os lidos seguem pendentes. Recusa ou falta de resposta NUNCA limpam os
 * lidos (o corretor pode tentar de novo); só o 2xx limpa o que de fato gravou.
 *
 * O que não tem destino no PATCH (M2) sai do cofre assim que o "sim" chega e volta em
 * `descartados`, para o corretor ouvir "não cabe na proposta". Se o servidor recusar a
 * escrita, nada sai do cofre (a tentativa seguinte refaz o cálculo).
 */
export async function gravarLidos(
  deps: Pick<DepsDoFluxo, "acao">,
  fluxo: FluxoFormularioV2,
  thread: string,
  opts: OpcoesDaGravacao
): Promise<GravacaoDosLidos> {
  if (typeof opts.messageIdDoSim !== "string" || opts.messageIdDoSim.trim().length === 0) {
    return { ok: false, erro: "sem_confirmacao", fluxo, descartados: [] };
  }
  const pendentes = unificarDocumentoRepetido(pendentesComValor(fluxo, thread));
  if (pendentes.length === 0) {
    // Havia pendência mas o cofre não abriu (chave rotacionada, thread trocada): o valor
    // se perdeu. Limpa o ponteiro sem valor e diz a verdade, em vez de reter lixo.
    const perdido = fluxo.lidosPendentes.length > 0;
    const limpo = comLidos(fluxo, [], thread);
    return { ok: false, erro: perdido ? "cofre_ilegivel" : "nada_a_gravar", fluxo: limpo.ok ? limpo.fluxo : fluxo, descartados: [] };
  }

  // F4: o mesmo CPF/CNPJ em duas pessoas diferentes nunca vai ao servidor (ele recusaria com 409 depois do "sim").
  const repetido = documentoRepetido(pendentes);
  if (repetido) return { ok: false, erro: "documento_repetido", fluxo, descartados: [], repetido };

  const { patch, gravados, descartados, conflito } = montarPatchDosLidos(pendentes, opts);
  const semDestino = new Set(descartados);

  // Re-cifra o cofre só com o que sobra. Sem chave, descarta tudo (nunca em claro).
  const comOsRestantes = (base: FluxoFormularioV2, restantes: Array<CampoLido & { ref: string }>): FluxoFormularioV2 => {
    const limpo = comLidos(base, restantes, thread);
    return limpo.ok ? limpo.fluxo : { ...base, lidosPendentes: [], cofreLidos: undefined };
  };

  if (conflito) {
    return {
      ok: false,
      erro: "conflito_de_parte",
      fluxo: descartados.length ? comOsRestantes(fluxo, pendentes.filter((c) => !semDestino.has(c.path))) : fluxo,
      descartados,
      conflito,
    };
  }

  if (gravados.size === 0) {
    const restantes = pendentes.filter((c) => !semDestino.has(c.path));
    return {
      ok: false,
      erro: restantes.some((c) => c.semPapel) ? "papel_indefinido" : "nada_a_gravar",
      fluxo: descartados.length ? comOsRestantes(fluxo, restantes) : fluxo,
      descartados,
    };
  }

  const r = await salvarParcial(deps, fluxo, patch, { confirmacao: { messageIdDoSim: opts.messageIdDoSim } });
  if (!r.ok) {
    const proximo = r.fluxo && r.fluxo.kind === "proposta_v2" ? r.fluxo : fluxo;
    return { ok: false, erro: r.erro, fluxo: proximo, resultado: r, descartados: [] };
  }
  const sobra = pendentes.filter((c) => !gravados.has(c.path) && !semDestino.has(c.path));
  return { ok: true, fluxo: comOsRestantes(r.fluxo, sobra), resultado: r, descartados };
}
