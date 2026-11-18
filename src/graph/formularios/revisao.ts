/**
 * A revisão final do rascunho (PR-C, T11/T12), a parte pura:
 *
 *  - `itensDaRevisao`: a lista NUMERADA dos campos a conferir, gerada do `obrigatorios[]` do
 *    servidor e das partes que o rascunho já tem (nada escrito à mão, nada de valor);
 *  - `textoDaRevisao`: a ficha numerada que vai ao Newton e serve de corpo e de reserva ao Flow no
 *    Max. Sem CPF, sem valor: só rótulo e ✅/⬜. Nunca leva link da tela (R20: texto fixo);
 *  - `lerCorrecaoNumerada`: "2 Maria Souza" corrige o item 2, pela MESMA leitura do texto livre.
 *
 * Nada aqui grava. A correção vira campo lido, ficha com cartão e o "sim" de sempre (o condutor).
 */

import { normalizar } from "../tools";
import { LIMITE_DA_FICHA } from "./ficha";
import { caminhoCanonico, lerCampoPorCaminho, type RespostaAoCampo } from "./proposta-v2";
import type { CampoObrigatorio, OptionsV2, Pendencia } from "./contrato";
import { signatariosPorLado, type LadoDaParte } from "./partes";

export type { LadoDaParte };

/** Quantas partes por lado o rascunho tem (mínimo 1: o item da primeira parte sempre existe) e o papel dito. */
export function partesDaRevisao(options: OptionsV2): Record<LadoDaParte, { quantas: number; papel: string }> {
  const por = signatariosPorLado(options);
  const rotulo = (lado: LadoDaParte, padrao: string): string => {
    const papel = por[lado][0]?.papel;
    return papel ? papel.charAt(0).toUpperCase() + papel.slice(1) : padrao;
  };
  return {
    compradores: { quantas: Math.max(1, por.compradores.length), papel: rotulo("compradores", "Comprador") },
    vendedores: { quantas: Math.max(1, por.vendedores.length), papel: rotulo("vendedores", "Vendedor") },
  };
}

const LADO_DO_PREFIXO: Record<string, LadoDaParte> = { proponente: "compradores", contraparte: "vendedores" };

/**
 * Os caminhos canônicos que a revisão numera (`compradores[0].nome`, `negociacao.valor`), na ordem
 * do `obrigatorios[]`; o de parte se repete por parte. Chave que o rascunho não edita por aqui
 * (corretor, testemunhas) fica de fora: numerar o que não corrige seria prometer o que não existe.
 */
export function itensDaRevisao(options: OptionsV2): string[] {
  const partes = partesDaRevisao(options);
  const out: string[] = [];
  const vistos = new Set<string>();
  const poe = (path: string): void => {
    if (!vistos.has(path)) {
      vistos.add(path);
      out.push(path);
    }
  };
  for (const o of options.obrigatorios ?? []) {
    const m = /^(proponente|contraparte)\.[a-z_0-9]+$/.exec(o.chave);
    if (m) {
      const lado = LADO_DO_PREFIXO[m[1]!]!;
      for (let i = 0; i < partes[lado].quantas; i++) poe(caminhoCanonico(o.chave, { posicao: i + 1, papel: "" }));
      continue;
    }
    if (/^(imovel|negociacao)\.[a-z_0-9]+$/.test(o.chave)) poe(o.chave);
  }
  return out;
}

function rotuloDoItem(path: string, options: OptionsV2): string {
  const def = (options.obrigatorios ?? []).find((o) => caminhoCanonico(o.chave, { posicao: 1, papel: "" }).replace(/\[\d+\]/g, "[]") === path.replace(/\[\d+\]/g, "[]"));
  const rotulo = def?.rotulo ?? path;
  const m = /^(compradores|vendedores)\[(\d+)\]\./.exec(path);
  if (!m) return rotulo;
  const lado = m[1] as LadoDaParte;
  const partes = partesDaRevisao(options)[lado];
  const posicao = Number(m[2]) + 1;
  return `${partes.papel} ${posicao} · ${rotulo}`;
}

/** Caminho canônico do que o servidor ainda pede (para o ⬜). */
function caminhosFaltando(faltando: Pendencia[]): Set<string> {
  return new Set(faltando.filter((p) => p.motivo !== "minimo_de_testemunhas").map((p) => caminhoCanonico(p.campo, p.signatario)));
}

export interface EntradaDoTexto {
  options: OptionsV2;
  itens: string[];
  /** O que o servidor ainda pede DEPOIS da última gravação; `null` = não sei (sem ✅/⬜). */
  faltando: Pendencia[] | null;
  /** Texto antes da lista (o "salvei" da gravação); entra no orçamento de caracteres. */
  prefixo?: string;
  /** O Flow vai junto: o texto convida a tocar nele; a lista continua como reserva. */
  comFlow?: boolean;
}

/** R20: texto fixo. O link do Google Doc (`documento_proprio`) convida à edição à mão e trava a gravação. */
export const TEXTO_EDITAR_PELA_TELA = "Para editar pela tela, abra a proposta no sistema.";

export const TEXTO_CORRIJA_ASSIM =
  'Para corrigir, mande o número e o valor (ex.: "2 Maria Souza") ou diga em frase. Nada é gravado sem o seu SIM.';

/**
 * A ficha numerada. Cabe em `LIMITE_DA_FICHA` (corpo do Flow e do botão): o que não couber vira
 * "…e mais N itens" (a numeração segue valendo para os que ficaram de fora).
 */
export function textoDaRevisao(a: EntradaDoTexto): string {
  const faltam = a.faltando ? caminhosFaltando(a.faltando) : null;
  const marca = (path: string): string => (faltam === null ? "" : faltam.has(path) ? " ⬜" : " ✅");
  const cabecalho = a.comFlow ? "📋 Revisão da proposta. Toque em *Revisar* para conferir pelo formulário." : "📋 Revisão da proposta";
  const rodape = [TEXTO_CORRIJA_ASSIM, TEXTO_EDITAR_PELA_TELA].join("\n");
  const prefixo = a.prefixo ? `${a.prefixo}\n\n` : "";
  const RESERVA = 40; // "…e mais NN itens" com folga
  const orcamento = LIMITE_DA_FICHA - prefixo.length - cabecalho.length - rodape.length - 4 - RESERVA;
  const linhas: string[] = [];
  let usado = 0;
  for (let i = 0; i < a.itens.length; i++) {
    const linha = `${i + 1}. ${rotuloDoItem(a.itens[i]!, a.options)}${marca(a.itens[i]!)}`;
    if (usado + linha.length + 1 > orcamento) break;
    linhas.push(linha);
    usado += linha.length + 1;
  }
  const fora = a.itens.length - linhas.length;
  if (fora > 0) linhas.push(`…e mais ${fora} ${fora === 1 ? "item" : "itens"}`);
  const t = `${prefixo}${[cabecalho, ...linhas].join("\n")}\n\n${rodape}`;
  return t.length <= LIMITE_DA_FICHA ? t : `${t.slice(0, LIMITE_DA_FICHA - 1)}…`;
}

// ─── Pedido e correção ──────────────────────────────────────────────────────

const PEDIDO_DE_REVISAO =
  /^(?:(?:max|newton) )?(?:(?:me )?(?:mostra|manda|ve|ver|faz|quero|vamos|bora)(?: a| o| de)? )?(?:(?:a )?revisao(?: da proposta| final)?|revisar(?: a proposta| tudo)?|conferir(?: a proposta| tudo)?|conferencia(?: da proposta)?)(?: agora| ai)?$/;

/** O corretor pediu a revisão de propósito? Frase curta e inteira, nunca um trecho de dado. */
export function pedeRevisao(texto: string): boolean {
  const t = normalizar(texto).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.split(" ").length > 6) return false;
  return PEDIDO_DE_REVISAO.test(t);
}

export type CorrecaoNumerada = { tipo: "nenhuma" } | { tipo: "item"; n: number; path: string; leitura: RespostaAoCampo };

/**
 * "2 Maria Souza" / "2. Maria Souza" / "2: 123.456.789-09": o item `n` da lista recebe o valor, pela
 * MESMA leitura e validação do texto livre (CPF com dígito, valor, data, opção do catálogo). Número
 * fora da lista não é correção ("50 mil de sinal" segue para a extração normal).
 */
export function lerCorrecaoNumerada(texto: string, itens: string[], obrigatorios?: CampoObrigatorio[]): CorrecaoNumerada {
  const m = /^\s*(\d{1,2})\s*[.):\-]?\s+(\S[\s\S]*)$/.exec(texto);
  if (!m) return { tipo: "nenhuma" };
  const n = Number(m[1]);
  if (n < 1 || n > itens.length) return { tipo: "nenhuma" };
  const path = itens[n - 1]!;
  return { tipo: "item", n, path, leitura: lerCampoPorCaminho(path, "revisao", m[2]!.trim(), obrigatorios) };
}
