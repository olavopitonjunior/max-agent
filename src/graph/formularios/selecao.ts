/**
 * Seleção v1 × v2 por conversa (D3).
 *
 * A versão é decidida UMA vez, no início do fluxo, e gravada nele
 * (`FluxoFormularioV2.versao`; `FluxoCaptacao.versao`; proposta v1 não carrega
 * campo e vale 1). Regras:
 *
 *  - v2 só com a feature local `formularios_v2` (global + org) E o servidor
 *    dizendo `options.fluxoV2 === true`;
 *  - fluxo já aberto manda: v1 aberto termina no v1 mesmo se a org virar no
 *    meio; v2 aberto cai para v1 se a feature ou o servidor desligarem
 *    (o turno seguinte rebaixa, nunca quebra);
 *  - 403 `fluxo_desligado` num verbo v2 rebaixa o fluxo para v1 com o que já
 *    foi extraído; o v1 pede o resto, sem mensagem de erro ao corretor.
 *
 * Puro: não chama o servidor.
 */

import { featureEnabled } from "@/lib/runtime/rollout";
import type { DadosDaProposta, Fluxo, RespostaDoServidor } from "../fluxos";
import type { FluxoCaptacao } from "../captacao";
import type { OptionsV1, OptionsV2 } from "./contrato";
import type { FluxoFormularioV2, VersaoDoFluxo } from "./estado";

type FluxoProposta = Extract<Fluxo, { kind: "proposta" }>;

/** Versão do fluxo de formulário aberto; `null` quando o fluxo não é de formulário (proposta/captação). */
export function versaoDoFluxo(f: Fluxo | null | undefined): VersaoDoFluxo | null {
  if (!f) return null;
  if (f.kind === "proposta_v2") return 2;
  if (f.kind === "proposta") return 1;
  if (f.kind === "captacao") return f.versao === 2 ? 2 : 1;
  return null;
}

export function escolherVersao(args: {
  orgId: string;
  options: OptionsV1 | OptionsV2;
  /** O fluxo de formulário que já estava aberto neste turno, se houver. */
  fluxoAberto?: Fluxo | null;
}): VersaoDoFluxo {
  const novaVersao: VersaoDoFluxo =
    featureEnabled("formularios_v2", args.orgId) && args.options.fluxoV2 === true ? 2 : 1;
  const aberta = versaoDoFluxo(args.fluxoAberto);
  if (aberta === 1) return 1; // v1 aberto termina no v1, mesmo se a org virou
  if (aberta === 2) return novaVersao; // v2 aberto só segue v2 se tudo continua ligado
  return novaVersao;
}

/** 403 `{ error: "fluxo_desligado" }` do servidor (§18.13.1). Outro 403 (política, RBAC) não é o gate. */
export function ehFluxoDesligado(r: RespostaDoServidor | null | undefined): boolean {
  return !!r && r.status === 403 && r.body?.error === "fluxo_desligado";
}

/**
 * Rebaixa o fluxo v2 para o v1 preservando o extraído. Sem rascunho, o v1
 * começa em `coleta` e já sabe o que foi dito; com rascunho, retoma em `ajustes`
 * e marca `ajustePendente` quando há dado que o servidor ainda não gravou.
 */
export function rebaixarParaV1(f: FluxoFormularioV2, extraido: DadosDaProposta): FluxoProposta {
  const temExtraido = Object.keys(extraido).length > 0;
  if (f.proposalId) {
    return {
      kind: "proposta",
      etapa: "ajustes",
      natureza: f.esteira,
      dados: extraido,
      propostaId: f.proposalId,
      ...(temExtraido ? { ajustePendente: true } : {}),
      atualizadoEm: f.atualizadoEm,
    };
  }
  return { kind: "proposta", etapa: "coleta", natureza: f.esteira, dados: extraido, atualizadoEm: f.atualizadoEm };
}

/** `rebaixarParaV1` só quando a resposta é o gate `fluxo_desligado`; senão `null`. */
export function rebaixarSeFluxoDesligado(
  f: FluxoFormularioV2,
  resposta: RespostaDoServidor | null,
  extraido: DadosDaProposta
): FluxoProposta | null {
  return ehFluxoDesligado(resposta) ? rebaixarParaV1(f, extraido) : null;
}

/** A captação v2 usa o mesmo estado; rebaixar é só marcar v1 (o v1 lê o que já está lá). */
export function rebaixarCaptacaoParaV1(f: FluxoCaptacao): FluxoCaptacao {
  return { ...f, versao: 1 };
}
