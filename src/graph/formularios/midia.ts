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

import { sniffMime } from "@/lib/transport/newton-media";
import { textoSemLeituraDeMidia } from "../prompt";

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
