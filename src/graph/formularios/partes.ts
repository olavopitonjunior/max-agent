/**
 * Quem é comprador e quem é vendedor no `options` do servidor: uma só definição de papel e de
 * contagem para o condutor (conflito de parte), a revisão (itens numerados) e o Flow (telas por
 * parte). Antes cada um tinha a sua cópia.
 *
 * ATENÇÃO: a única fonte de parte do `options` é `signatarios`, que lista só quem ASSINA, na ordem
 * do servidor. Não é a lista posicional das partes do rascunho (`compradores[i]`). Serve de piso
 * para a CONTAGEM de partes; nunca como valor pré-preenchido por posição (ver `revisao.ts`).
 */

import { normalizar } from "../tools";
import type { OptionsV2 } from "./contrato";

export const PAPEL_COMPRADOR: ReadonlySet<string> = new Set(["comprador", "locatario", "proponente", "inquilino"]);
export const PAPEL_VENDEDOR: ReadonlySet<string> = new Set(["vendedor", "locador", "proprietario", "contraparte"]);

export type LadoDaParte = "compradores" | "vendedores";

export interface SignatarioDoLado {
  nome: string;
  /** Papel normalizado como o servidor o disse (`comprador`, `locatario`...). */
  papel: string;
}

/** Os signatários do `options` separados por lado, na ordem recebida. Papel desconhecido fica de fora. */
export function signatariosPorLado(options: OptionsV2): Record<LadoDaParte, SignatarioDoLado[]> {
  const out: Record<LadoDaParte, SignatarioDoLado[]> = { compradores: [], vendedores: [] };
  for (const s of options.signatarios ?? []) {
    const papel = normalizar(s.papel ?? "");
    if (PAPEL_COMPRADOR.has(papel)) out.compradores.push({ nome: s.nome, papel });
    else if (PAPEL_VENDEDOR.has(papel)) out.vendedores.push({ nome: s.nome, papel });
  }
  return out;
}

/** Quantas partes por lado (mínimo 1: a primeira parte sempre existe). */
export function contagemDePartes(options: OptionsV2): Record<LadoDaParte, number> {
  const por = signatariosPorLado(options);
  return { compradores: Math.max(1, por.compradores.length), vendedores: Math.max(1, por.vendedores.length) };
}
