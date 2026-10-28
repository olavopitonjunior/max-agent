import { query } from "../db";
import type { Interativo } from "../transport/types";
import { escaparMarkdownWa } from "./escapar";
import { PREFIXO_AVISO, ROTULOS_BOTAO } from "./interativo";
import { AVISO_TEXTO_TOTAL_MAX } from "./render";
import type { AcaoAviso, Aviso, NivelAviso } from "./schema";

/**
 * Agrupamento de rajadas (M8): o que o mesmo telefone recebe sobre o mesmo
 * negócio em pouco tempo vira UM resumo, em vez de uma mensagem por evento.
 *
 * A regra (decisão 5 do plano): a chave é `phone + dealId` (`group_key` da
 * outbox, M1). O primeiro aviso sai na hora. O que chega enquanto um irmão
 * saiu há menos de 10 min espera até `sent_at + 10 min`; no despacho, 2 ou mais
 * retidos viram um resumo e 1 retido sai normal. Marco (nível C) nunca espera e
 * nunca entra: `groupKeyDoAviso` já lhe nega a chave.
 *
 * Este arquivo tem as peças que não dependem do laço do `dispatchDue`: o prazo
 * de espera (consultado no `enqueue`) e o texto/botão do resumo.
 */

/** Quanto tempo depois do irmão enviado o próximo aviso do negócio pode sair. */
export const AGRUPAMENTO_JANELA_MS = 10 * 60_000;

/** Teto do corpo interativo da Meta (ver `aviso/interativo.ts`). */
const CORPO_INTERATIVO_MAX = 1024;

/**
 * Quando este aviso pode sair para respeitar o agrupamento: o `sent_at + 10 min`
 * do irmão (mesmo telefone e negócio) enviado há menos de 10 min, ou `null` =
 * sem espera. Nível C, sem chave de grupo ou sem nível: sempre `null`.
 *
 * `deal_party` fica de fora dos irmãos: parte do negócio nunca entra em
 * agrupamento, nem como causa de espera para o corretor.
 *
 * Falha de banco = `null`: na dúvida o aviso sai agora. Atrasar por erro é pior
 * do que mandar duas mensagens.
 */
export async function atrasoDeAgrupamento(
  phone: string,
  groupKey: string | null,
  nivel: NivelAviso | null
): Promise<Date | null> {
  if (!groupKey || !nivel || nivel === "C") return null;
  try {
    const rows = await query<{ ate: Date | null }>(
      `SELECT max(sent_at) + ($3 || ' milliseconds')::interval AS ate
         FROM outbox
        WHERE phone = $1 AND group_key = $2 AND status = 'sent'
          AND audience <> 'deal_party'
          AND sent_at > now() - ($3 || ' milliseconds')::interval`,
      [phone, groupKey, String(AGRUPAMENTO_JANELA_MS)]
    );
    const ate = rows[0]?.ate;
    return ate ? new Date(ate) : null;
  } catch (err) {
    console.warn(
      "[outbox] atraso de agrupamento não calculado — o aviso sai sem espera:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

export interface ResumoCtx {
  orgName: string;
  /**
   * URL do negócio para a linha `👉 Abrir negócio: <url>`. `null` quando o link
   * vai num botão (a Meta interativa) ou não há link.
   */
  link: string | null;
  /** Teto do texto. Padrão: 1500 (`whatsappBody`). O corpo interativo usa 1024. */
  max?: number;
}

/**
 * Texto do resumo:
 *
 * ```
 * 📌 *<negócio>* andou bastante agora:
 * • <emoji> <titulo>
 * …
 *
 * 👉 Abrir negócio: <url>      (só sem botão)
 *
 * _Org_
 * ```
 *
 * Sem bloco "Responda:" de propósito: o "1" digitado depois de um resumo não é
 * resposta a aviso nenhum (ver `numero.ts`).
 *
 * Negócio, título e org passam por `escaparMarkdownWa`. Estourando o teto, corta
 * itens do FIM (a rajada mais antiga é a que fica) e fecha com `• …e mais N`.
 */
export function resumoDaRajada(avisos: Aviso[], ctx: ResumoCtx): string {
  const max = ctx.max ?? AVISO_TEXTO_TOTAL_MAX;
  const negocio = avisos.find((a) => a.negocio)?.negocio ?? null;
  const cabecalho = negocio
    ? `📌 *${escaparMarkdownWa(negocio)}* andou bastante agora:`
    : "📌 Este negócio andou bastante agora:";
  const linhas = avisos.map((a) => `• ${a.emoji} ${escaparMarkdownWa(a.titulo)}`);
  const org = ctx.orgName.trim();
  const fim = [ctx.link ? `👉 Abrir negócio: ${ctx.link}` : null, org ? `_${escaparMarkdownWa(org)}_` : null].filter(
    (x): x is string => x !== null
  );

  const montar = (n: number): string => {
    const itens = linhas.slice(0, n);
    if (n < linhas.length) itens.push(`• …e mais ${linhas.length - n}`);
    return [`${cabecalho}\n${itens.join("\n")}`, ...fim].join("\n\n");
  };

  for (let n = linhas.length; n >= 0; n--) {
    const texto = montar(n);
    // `.length` (UTF-16), como o resto do contrato: o mais estrito dos dois jeitos de contar.
    if (texto.length <= max) return texto;
  }
  // Nem sem itens cabe (URL gigante): corta por ponto de código, sem partir emoji.
  let corte = "";
  for (const cp of montar(0)) {
    if (corte.length + cp.length > max) break;
    corte += cp;
  }
  return corte;
}

const ACOES_DE_LINK: ReadonlySet<AcaoAviso> = new Set(["abrir", "ver_formulario", "ver_proposta"]);

/**
 * Que linha e que ação o botão do resumo aponta, para o roteador do M6
 * (`av:<rowId>:<acao>`) devolver o link do negócio.
 *
 * O roteador só aceita ação que está no `aviso` da linha tocada, então "a
 * primeira linha + `abrir`" falharia quando o primeiro aviso é, por exemplo, um
 * lembrete de formulário (reenviar · lembrar · ver_formulario). Daí: a primeira
 * linha cujo aviso tem `abrir`; sem nenhuma, a primeira que tem outra ação de
 * link; sem nenhuma, `null` (o resumo sai só com o link no texto).
 */
export function acaoDeLinkDoResumo(
  linhas: ReadonlyArray<{ id: string; aviso: Pick<Aviso, "acoes"> }>
): { rowId: string; acao: AcaoAviso } | null {
  for (const l of linhas) {
    if (l.aviso.acoes.some((a) => a.id === "abrir")) return { rowId: l.id, acao: "abrir" };
  }
  for (const l of linhas) {
    const a = l.aviso.acoes.find((x) => ACOES_DE_LINK.has(x.id));
    if (a) return { rowId: l.id, acao: a.id };
  }
  return null;
}

/** O resumo da Meta: texto + 1 botão "🔗 Abrir negócio". `null` = corpo grande demais para a Meta. */
export function interativoDoResumo(corpo: string, alvo: { rowId: string; acao: AcaoAviso }): Interativo | null {
  if (Array.from(corpo).length > CORPO_INTERATIVO_MAX) return null;
  return {
    tipo: "botoes",
    corpo,
    opcoes: [{ id: `${PREFIXO_AVISO}${alvo.rowId}:${alvo.acao}`, titulo: ROTULOS_BOTAO[alvo.acao] }],
  };
}

/** Teto do corpo do resumo interativo, para quem monta o texto. */
export const RESUMO_CORPO_INTERATIVO_MAX = CORPO_INTERATIVO_MAX;
