import type { Interativo, OpcaoInterativa } from "../transport/types";
import { AVISO_ACOES_BOTOES_MAX, AVISO_ACOES_LISTA_MAX, type AcaoAviso, type Aviso } from "./schema";

/**
 * Botões e lista do aviso (M5): a FORMA do que o `aviso` pede, para a Meta.
 * O texto de reserva (e o numerado do Newton) é montado por `renderAvisoTexto`;
 * aqui só se decide se há botão, quais e com que id.
 *
 * Ids `av:<rowId>:<acao>` (botões) e `av:<rowId>:item:<alvoId>` (lista). O
 * toque volta como esse payload e é tratado por `aviso-botao.ts`, sem modelo.
 *
 * Nada aqui sabe de audiência: aviso de `deal_party` é regravado sem ações
 * (`avisoParaAudiencia`) e por isso devolve `null`; quem despacha ainda confere
 * a audiência por conta própria.
 */

export const PREFIXO_AVISO = "av:";

/** Rótulos fixos dos botões (≤20 caracteres, limite da Meta). */
export const ROTULOS_BOTAO: Readonly<Record<AcaoAviso, string>> = {
  abrir: "🔗 Abrir negócio",
  ver_formulario: "🔗 Ver formulário",
  ver_proposta: "🔗 Ver proposta",
  reenviar_link: "📨 Reenviar link",
  lembrar_amanha: "⏰ Me lembra amanhã",
  concluir: "✅ Concluir",
  adiar_1d: "📅 Adiar 1 dia",
  criar_atividade: "➕ Próximo passo",
};

/** Limites da Cloud API (ver também `lib/interativo.ts`). */
const MAX_CORPO = 1024;
const MAX_TITULO_LINHA = 24;
const MAX_DESCRICAO_LINHA = 72;
const BOTAO_DA_LISTA = "Ver itens";

// Por ponto de código: cortar no meio de um par substituto quebra emoji.
function corta(s: string, n: number): string {
  const cs = Array.from(s);
  return cs.length > n ? `${cs.slice(0, n - 1).join("")}…` : s;
}

function lista(aviso: Aviso, rowId: string, corpo: string): Interativo | null {
  const opcoes: OpcaoInterativa[] = [];
  aviso.acoes.slice(0, AVISO_ACOES_LISTA_MAX).forEach((a, i) => {
    if (!a.alvoId) return;
    const texto = aviso.itens[i]?.trim() || `Item ${i + 1}`;
    const longo = Array.from(texto).length > MAX_TITULO_LINHA;
    opcoes.push({
      id: `${PREFIXO_AVISO}${rowId}:item:${a.alvoId}`,
      titulo: corta(texto, MAX_TITULO_LINHA),
      ...(longo ? { descricao: corta(texto, MAX_DESCRICAO_LINHA) } : {}),
    });
  });
  if (opcoes.length === 0) return null;
  return { tipo: "lista", corpo, botao: BOTAO_DA_LISTA, opcoes };
}

/**
 * `null` = só texto: nível A, sem ações, corpo acima do limite da Meta
 * (1024; o texto vai inteiro, com até 1500) ou lista sem nenhuma linha tocável.
 *
 * `forma` null em B/C é tratada como botões: o enfeite não deve sumir porque a
 * plataforma deixou o campo de fora.
 */
export function interativoDoAviso(aviso: Aviso, rowId: string, corpo: string): Interativo | null {
  if (aviso.nivel === "A" || aviso.acoes.length === 0) return null;
  if (Array.from(corpo).length > MAX_CORPO) return null;

  if (aviso.forma === "lista") return lista(aviso, rowId, corpo);

  const opcoes: OpcaoInterativa[] = aviso.acoes.slice(0, AVISO_ACOES_BOTOES_MAX).map((a) => ({
    id: `${PREFIXO_AVISO}${rowId}:${a.id}`,
    titulo: ROTULOS_BOTAO[a.id],
  }));
  return {
    tipo: "botoes",
    corpo,
    opcoes,
    ...(aviso.nivel === "C" && aviso.imagemUrl ? { imagemUrl: aviso.imagemUrl } : {}),
  };
}
