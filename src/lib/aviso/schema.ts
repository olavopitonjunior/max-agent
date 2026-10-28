import { z } from "zod";

/**
 * Contrato `aviso` (v1) — a descrição estruturada de uma notificação, que o
 * contractmaker manda junto de `title`/`body` e o Max renderiza (texto no M2,
 * botões no M5). Fonte única nos dois repos: mudou aqui, muda lá.
 *
 * O `aviso` é ENFEITE: o `/notify` o lê com `.optional().catch(undefined)`, de
 * modo que um aviso malformado (ou de uma versão futura) é descartado sem
 * erro e sai o `title/body` de hoje. Por isso os limites abaixo são rígidos —
 * melhor perder o enfeite do que renderizar algo fora do que a Meta aceita.
 */

export const NIVEIS_AVISO = ["A", "B", "C"] as const;
export const ACOES_AVISO = [
  "abrir",
  "ver_formulario",
  "ver_proposta",
  "reenviar_link",
  "lembrar_amanha",
  "concluir",
  "adiar_1d",
  "criar_atividade",
] as const;

export type NivelAviso = (typeof NIVEIS_AVISO)[number];
export type AcaoAviso = (typeof ACOES_AVISO)[number];

/** Limites do contrato. `forma:"botoes"` = botões de resposta; `"lista"` = lista interativa. */
export const AVISO_TEXTO_MAX = 120;
export const AVISO_FRASE_MAX = 300;
export const AVISO_ITENS_MAX = 4;
export const AVISO_ACOES_BOTOES_MAX = 3;
export const AVISO_ACOES_LISTA_MAX = 10;

/** Numa linha só: quebra de linha dentro de um campo quebraria o layout do WhatsApp. */
const umaLinha = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !/[\r\n]/.test(s), { message: "deve ficar numa linha" });

export const avisoSchema = z
  .object({
    v: z.literal(1),
    /** = `kind` da notificação. */
    evento: z.string().min(1).max(32),
    nivel: z.enum(NIVEIS_AVISO),
    /** Do mapa fixo de emojis por evento (o Max não valida qual). */
    emoji: z.string().min(1).max(16),
    titulo: umaLinha(AVISO_TEXTO_MAX),
    negocio: umaLinha(AVISO_TEXTO_MAX).nullable(),
    /** Já com `*negrito*` nos dados escapados. */
    frase: z.string().max(AVISO_FRASE_MAX),
    /** Itens exibidos, sem o "• ". */
    itens: z.array(umaLinha(AVISO_TEXTO_MAX)).max(AVISO_ITENS_MAX),
    /** Quantos itens ficaram de fora. */
    itensExtras: z.number().int().min(0),
    link: z
      .object({
        rotulo: umaLinha(AVISO_TEXTO_MAX),
        url: z.string().url().max(2048),
      })
      .nullable(),
    acoes: z
      .array(
        z.object({
          id: z.enum(ACOES_AVISO),
          alvoId: z.string().min(1).max(128).optional(),
        })
      )
      .max(AVISO_ACOES_LISTA_MAX),
    forma: z.enum(["botoes", "lista"]).nullable(),
    responsavel: umaLinha(AVISO_TEXTO_MAX).optional(),
    equipe: umaLinha(AVISO_TEXTO_MAX).optional(),
    departamento: umaLinha(AVISO_TEXTO_MAX).optional(),
    /** Nível C e e-mail B. */
    esteira: z
      .object({
        etapas: z.array(umaLinha(AVISO_TEXTO_MAX)).max(20),
        atual: z.number().int().min(0),
      })
      .optional(),
    /** Só nível C; URL assinada, sem PII. */
    imagemUrl: z.string().url().max(2048).optional(),
  })
  .superRefine((a, ctx) => {
    const teto = a.forma === "lista" ? AVISO_ACOES_LISTA_MAX : AVISO_ACOES_BOTOES_MAX;
    if (a.acoes.length > teto) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acoes"],
        message: `no máximo ${teto} ações com forma ${a.forma ?? "null"}`,
      });
    }
    if (a.imagemUrl !== undefined && a.nivel !== "C") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["imagemUrl"],
        message: "imagemUrl só no nível C",
      });
    }
  });

export type Aviso = z.infer<typeof avisoSchema>;

/**
 * Nada para parte/cliente com ação ou imagem: para `deal_party` o aviso é
 * gravado sem ações, sem forma e sem `imagemUrl` (o texto fica). Não muta a
 * entrada. Sem aviso devolve `null`.
 */
export function avisoParaAudiencia(audience: string, aviso: Aviso | null | undefined): Aviso | null {
  if (!aviso) return null;
  if (audience !== "deal_party") return aviso;
  const { imagemUrl: _descartada, ...resto } = aviso;
  return { ...resto, acoes: [], forma: null };
}

/**
 * Chave de agrupamento do aviso na fila: o `dealId`, quando há e o nível não é
 * C (C é celebração e sai sozinho). Sem aviso, sem dealId ou nível C: `null`.
 */
export function groupKeyDoAviso(
  dealId: string | null | undefined,
  aviso: Pick<Aviso, "nivel"> | null | undefined
): string | null {
  if (!dealId || !aviso || aviso.nivel === "C") return null;
  return dealId;
}
