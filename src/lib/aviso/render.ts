import { escaparMarkdownWa } from "./escapar";
import { AVISO_ITENS_MAX, type AcaoAviso, type Aviso } from "./schema";

/** Teto do corpo no WhatsApp (`NOTIFY_BODY_MAX` no contractmaker). */
export const AVISO_TEXTO_TOTAL_MAX = 1500;

export interface AvisoRenderCtx {
  recipientName: string;
  orgName: string;
  /** `interativo`: botões/lista cumprem as ações. `numerado`: o texto pede "Responda 1/2". */
  modo: "interativo" | "numerado";
  /**
   * `true` só quando o link vai num botão (M5+). Aí a linha 👉 é redundante e
   * sai. Padrão `false`: sem botão, o link precisa estar no texto.
   */
  linkNoBotao?: boolean;
}

/** Ações que abrem uma URL: o botão/linha 👉 cumpre, nunca entram na lista numerada. */
const ACOES_DE_LINK: ReadonlySet<AcaoAviso> = new Set(["abrir", "ver_formulario", "ver_proposta"]);

/** Rótulos do modo numerado: sem emoji, minúsculos. */
const ROTULO_NUMERADO: Partial<Record<AcaoAviso, string>> = {
  reenviar_link: "reenviar link",
  lembrar_amanha: "lembrar amanhã",
  concluir: "concluir",
  adiar_1d: "adiar 1 dia",
  criar_atividade: "próximo passo",
};

/** Corta em `max` unidades UTF-16 (o `.length` do contrato) sem partir um par substituto; termina em "…". */
function cortar(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 0) return "";
  let out = "";
  for (const cp of s) {
    if (out.length + cp.length > max - 1) break;
    out += cp;
  }
  return `${out.trimEnd()}…`;
}

interface Partes {
  cabecalho: string;
  frase: string;
  itens: string[];
  extras: number;
  link: string | null;
  responda: string | null;
  assinatura: string | null;
}

function montar(p: Partes, nItens: number, frase: string): string {
  const blocos: string[] = [p.cabecalho];
  if (frase) blocos.push(frase);
  const extras = p.extras + (p.itens.length - nItens);
  const linhas = p.itens.slice(0, nItens).map((i) => `• ${i}`);
  if (extras > 0) linhas.push(`• e mais ${extras}`);
  if (linhas.length) blocos.push(linhas.join("\n"));
  if (p.link) blocos.push(p.link);
  if (p.responda) blocos.push(p.responda);
  if (p.assinatura) blocos.push(p.assinatura);
  return blocos.join("\n\n");
}

/**
 * Texto do aviso (níveis A/B/C) para o WhatsApp. Formato fixado pelo spec:
 * saudação + `emoji *título*`, frase, itens, `👉 link`, bloco numerado (só no
 * modo `numerado`) e `_Org_`.
 *
 * Teto de 1500: corta itens primeiro (mantendo "• e mais N"); a frase só é
 * truncada (com "…") em último caso.
 */
export function renderAvisoTexto(aviso: Aviso, ctx: AvisoRenderCtx): string {
  const primeiro = ctx.recipientName.trim().split(/\s+/)[0] ?? "";
  const saudacao = primeiro ? `Oi, ${escaparMarkdownWa(primeiro)}! ` : "";
  const cabecalho = `${saudacao}${aviso.emoji} *${escaparMarkdownWa(aviso.titulo)}*`;

  const temAcaoDeLink = aviso.acoes.some((a) => ACOES_DE_LINK.has(a.id));
  const linkNaLinha = aviso.link && !(ctx.linkNoBotao === true && temAcaoDeLink);

  let responda: string | null = null;
  if (ctx.modo === "numerado") {
    const opcoes = aviso.acoes
      .map((a) => ROTULO_NUMERADO[a.id])
      .filter((r): r is string => !!r);
    if (opcoes.length) {
      responda = `Responda:\n${opcoes.map((r, i) => `*${i + 1}* · ${r}`).join("\n")}`;
    }
  }

  const org = ctx.orgName.trim();
  const partes: Partes = {
    cabecalho,
    frase: aviso.frase,
    itens: aviso.itens.map(escaparMarkdownWa),
    extras: aviso.itensExtras,
    link: linkNaLinha && aviso.link ? `👉 ${aviso.link.rotulo}: ${aviso.link.url}` : null,
    responda,
    assinatura: org ? `_${escaparMarkdownWa(org)}_` : null,
  };

  // Mais de 4 itens: os 4 primeiros + "• e mais N" (N inclui itensExtras).
  const exibidos = Math.min(partes.itens.length, AVISO_ITENS_MAX);

  for (let n = exibidos; n >= 0; n--) {
    const texto = montar(partes, n, partes.frase);
    if (texto.length <= AVISO_TEXTO_TOTAL_MAX) return texto;
  }

  // Sem itens e ainda estoura: trunca a frase (último recurso).
  const semFrase = montar(partes, 0, "");
  const folga = AVISO_TEXTO_TOTAL_MAX - semFrase.length - 2; // "\n\n" da frase
  if (folga > 0) return montar(partes, 0, cortar(partes.frase, folga));
  return cortar(semFrase, AVISO_TEXTO_TOTAL_MAX); // só a URL gigante chega aqui
}
