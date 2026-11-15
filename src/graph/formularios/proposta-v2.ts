/**
 * Proposta v2: checklist pelo `options` e gravação parcial (T5).
 *
 * No v2 o servidor é a autoridade do "o que falta" (`faltando`, §18.13.2): a
 * lista vem do `proposal.options` com alvo, do `proposal.create` e do
 * `proposal.update`. Este módulo NUNCA recalcula pendência localmente (o v1 tem
 * sua conta própria, que não vale aqui: ela ignora o obrigatório da org e do
 * modelo).
 *
 * Duas regras que moram aqui:
 *  - "anotei" só depois do 201/200. Recusa (422), falta de resposta e qualquer
 *    outro desfecho nunca afirmam que gravou (`textoDoParcial`);
 *  - o `proposal.create` do v2 vai sem `canal` (D4): o rascunho nasce sem canal
 *    e o canal é escolhido na etapa de assinatura (`tipo_assinatura`).
 *
 * Os desfechos viram dado (`ResultadoParcial`) com o PRÓXIMO fluxo já calculado
 * (`fluxo`): quem chama só persiste. O texto ao corretor é função pura do
 * desfecho. Sem PII aqui: o patch segue para o servidor e não é guardado.
 */

import { nomeDoAgente } from "@/lib/deploy-profile";
import { TEXTO_ESCRITA_INCERTA, type DadosDaProposta, type DepsDoFluxo, type Fluxo, type RespostaDoServidor } from "../fluxos";
import type { OptionsV1, OptionsV2, PatchV2, Pendencia } from "./contrato";
import type { FluxoFormularioV2 } from "./estado";
import { ehFluxoDesligado, rebaixarParaV1 } from "./selecao";

type DepsAcao = Pick<DepsDoFluxo, "acao">;

/** O `faltando` do servidor: a resposta da gravação vence o do `options`; nenhum = `[]`, nunca inventado. */
export function faltandoV2(options: OptionsV1 | OptionsV2, resposta?: { faltando?: Pendencia[] } | null): Pendencia[] {
  if (resposta && Array.isArray(resposta.faltando)) return resposta.faltando;
  const doOptions = "faltando" in options ? options.faltando : undefined;
  return Array.isArray(doOptions) ? doOptions : [];
}

/**
 * `proposal.options` (§18.13.3). Sem alvo a esteira vem de `tipo`/`schemaType`;
 * com alvo (`proposalId` ou `codigo`) a resposta traz o `faltando` da proposta.
 * `null` = sem resposta utilizável: o chamador não inventa um `options`.
 */
export async function consultarOptions(
  deps: DepsAcao,
  args: { tipo?: "venda" | "locacao"; schemaType?: string; alvo?: { proposalId?: string; codigo?: string } }
): Promise<OptionsV1 | OptionsV2 | null> {
  const corpo: Record<string, unknown> = {};
  if (args.tipo) corpo.tipo = args.tipo;
  if (args.schemaType) corpo.schemaType = args.schemaType;
  if (args.alvo?.proposalId) corpo.proposta_id = args.alvo.proposalId;
  else if (args.alvo?.codigo) corpo.codigo = args.alvo.codigo;
  const r = await deps.acao("proposal.options", corpo);
  if (!r || r.status !== 200 || !Array.isArray(r.body?.metodos)) return null;
  return r.body as unknown as OptionsV1 | OptionsV2;
}

export type ErroDoParcial =
  | "dados_invalidos"
  | "documento_proprio"
  | "edicao_pela_tela"
  | "fluxo_desligado"
  | "incerta"
  | "sem_permissao"
  | "nao_encontrada"
  | "nao_editavel"
  | "envio_em_andamento"
  | "signatarios_duplicados"
  | "indisponivel";

export type ResultadoParcial =
  | {
      ok: true;
      criou: boolean;
      proposalId: string;
      codigo?: string;
      /** Do servidor, depois da gravação. */
      faltando: Pendencia[];
      testemunhasSemeadas?: number;
      pdfIndisponivel?: string;
      documento?: { descartado: boolean; link?: string };
      /** O fluxo já apontando para o rascunho e sem chave presa. */
      fluxo: FluxoFormularioV2;
    }
  | {
      ok: false;
      erro: ErroDoParcial;
      /** `documento_proprio` (do servidor) ou `edicao_pela_tela` (só se o servidor mandar um). */
      link?: string;
      /** Campos recusados (`dados_invalidos`). */
      campos?: string[];
      /** Frase do servidor (422), nunca o código. */
      mensagem?: string;
      /** O próximo estado: `null` encerra; v1 quando o servidor desligou o v2. */
      fluxo: Fluxo | null;
    };

function frase(body: Record<string, unknown>): string | undefined {
  const m = [body.message, body.motivo].find((x): x is string => typeof x === "string" && x.trim().length > 0);
  return m ? m.replace(/\s+/g, " ").trim().slice(0, 300) : undefined;
}

function textoOuUndefined(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function idDe(obj: unknown): { id?: string; codigo?: string } {
  if (!obj || typeof obj !== "object") return {};
  const o = obj as { id?: unknown; codigo?: unknown };
  return { id: textoOuUndefined(o.id), codigo: textoOuUndefined(o.codigo) };
}

/**
 * Grava o que o corretor disse. Sem `proposalId` no fluxo: `proposal.create`
 * (exige `schemaType`, sem `canal`). Com `proposalId`: `proposal.update`, PATCH
 * completo (partes por POSIÇÃO, a lista nunca encolhe; `substituir:true` só com
 * nome novo, R38). `idempotencyKey` é a messageId do turno; uma chave já
 * guardada no fluxo para o MESMO verbo vence (a retentativa não duplica).
 */
export async function salvarParcial(
  deps: DepsAcao,
  f: FluxoFormularioV2,
  patch: PatchV2,
  opts: { idempotencyKey: string; agora?: number; extraido?: DadosDaProposta }
): Promise<ResultadoParcial> {
  const criando = !f.proposalId;
  const verbo = criando ? "proposal.create" : "proposal.update";
  const agora = opts.agora ?? Date.now();
  const semChave: FluxoFormularioV2 = { ...f, chave: undefined, atualizadoEm: agora };

  const corpo: Record<string, unknown> = { ...patch };
  delete corpo.canal; // D4: nunca no rascunho; o canal é da etapa de assinatura
  if (criando) {
    const schemaType = patch.schemaType ?? f.schemaType;
    if (!schemaType) {
      return { ok: false, erro: "dados_invalidos", campos: ["schemaType"], fluxo: semChave };
    }
    corpo.schemaType = schemaType;
    // Só do update: no create o servidor não as lê.
    delete corpo.tipo_assinatura;
    delete corpo.excecoes_canal;
    delete corpo.regerar_documento;
  } else {
    // `schemaType` e `tipo` nunca mudam depois do create.
    delete corpo.schemaType;
    delete corpo.tipo;
    corpo.proposta_id = f.proposalId;
  }

  const chave = f.chave?.verbo === verbo ? f.chave : { verbo, valor: opts.idempotencyKey };
  const r: RespostaDoServidor | null = await deps.acao(verbo, corpo, chave.valor);

  if (!r || (r.status === 409 && r.body?.error === "em_andamento")) {
    return { ok: false, erro: "incerta", fluxo: { ...f, chave, atualizadoEm: agora } };
  }
  if (ehFluxoDesligado(r)) {
    return { ok: false, erro: "fluxo_desligado", fluxo: rebaixarParaV1(f, opts.extraido ?? {}) };
  }
  if (r.status === 403) return { ok: false, erro: "sem_permissao", fluxo: null };
  if (r.status === 404) return { ok: false, erro: "nao_encontrada", fluxo: null };

  if (r.status === 409) {
    switch (r.body?.error) {
      case "edicao_pela_tela":
        return { ok: false, erro: "edicao_pela_tela", link: textoOuUndefined(r.body.link), fluxo: null };
      case "documento_proprio":
        return { ok: false, erro: "documento_proprio", link: textoOuUndefined(r.body.link), fluxo: semChave };
      case "envio_em_andamento":
        return { ok: false, erro: "envio_em_andamento", mensagem: frase(r.body), fluxo: semChave };
      case "signatarios_duplicados":
        return { ok: false, erro: "signatarios_duplicados", fluxo: semChave };
      default:
        // `nao_editavel` e qualquer outro 409: a proposta saiu do rascunho.
        return { ok: false, erro: "nao_editavel", fluxo: null };
    }
  }
  if (r.status === 422 || r.status === 400) {
    const campos = Array.isArray(r.body?.campos) ? r.body.campos.filter((c): c is string => typeof c === "string") : undefined;
    return { ok: false, erro: "dados_invalidos", mensagem: frase(r.body), ...(campos?.length ? { campos } : {}), fluxo: semChave };
  }

  const esperado = criando ? 201 : 200;
  const gravada = criando ? idDe(r.body?.proposal) : idDe(r.body?.proposta);
  const proposalId = gravada.id ?? f.proposalId;
  if (r.status !== esperado || !proposalId) {
    // Pode ter gravado: mantém a chave para a retentativa não duplicar.
    return { ok: false, erro: "indisponivel", fluxo: { ...f, chave, atualizadoEm: agora } };
  }

  const doc = r.body?.documento as { descartado?: unknown; link?: unknown } | undefined;
  return {
    ok: true,
    criou: criando,
    proposalId,
    ...(gravada.codigo ? { codigo: gravada.codigo } : {}),
    faltando: faltandoV2({ metodos: [], signatarios: [], assinaturaConfigurada: true }, r.body as { faltando?: Pendencia[] }),
    ...(typeof r.body?.testemunhasSemeadas === "number" ? { testemunhasSemeadas: r.body.testemunhasSemeadas } : {}),
    ...(typeof r.body?.pdfIndisponivel === "string" ? { pdfIndisponivel: r.body.pdfIndisponivel } : {}),
    ...(doc && typeof doc.descartado === "boolean"
      ? { documento: { descartado: doc.descartado, ...(textoOuUndefined(doc.link) ? { link: textoOuUndefined(doc.link) } : {}) } }
      : {}),
    fluxo: { ...semChave, proposalId },
  };
}

/**
 * O que o Max diz depois de `salvarParcial`. "Anotei" só no `ok`. Vazio no
 * `fluxo_desligado`: o v1 assume no mesmo turno e fala por si, sem erro ao corretor.
 */
export function textoDoParcial(r: ResultadoParcial, ctx: { codigo?: string }): string {
  if (r.ok) return `Anotei e salvei no rascunho${r.codigo ?? ctx.codigo ? ` ${r.codigo ?? ctx.codigo}` : ""}.`;
  const codigo = ctx.codigo ? ` ${ctx.codigo}` : "";
  switch (r.erro) {
    case "dados_invalidos":
      return `${r.mensagem ?? "Algum dado não foi aceito pelo sistema."}\nMe mande e eu ajusto.`;
    case "fluxo_desligado":
      return "";
    case "incerta":
      return TEXTO_ESCRITA_INCERTA;
    case "sem_permissao":
      return `Sua conta não tem permissão para isso pelo ${nomeDoAgente()}. Fale com o administrador da imobiliária.`;
    case "nao_encontrada":
      return "Não encontrei essa proposta para você no sistema.";
    case "nao_editavel":
      return "Essa proposta já saiu do rascunho e não pode mais ser ajustada por aqui.";
    case "edicao_pela_tela":
      return (
        `Essa proposta${codigo} foi editada pela tela (texto, mais de um comprador ou empresa), ` +
        "então o ajuste precisa ser feito por lá. O rascunho continua salvo." +
        (r.link ? `\n${r.link}` : "")
      );
    case "documento_proprio":
      return (
        `Essa proposta${codigo} já tem um documento próprio, que pode ter sido editado à mão. ` +
        "Se eu mudar os dados, o documento precisa ser refeito e o texto editado se perde. " +
        `Confira o documento atual:${r.link ? `\n${r.link}` : " ele está no sistema."}\n` +
        "Quer que eu refaça o documento? (SIM)"
      );
    case "envio_em_andamento":
      return "Tem um envio para assinatura em andamento nessa proposta. Espere terminar para ajustar.";
    case "signatarios_duplicados":
      return "Esse contato já está em outro assinante da proposta. Me mande um telefone ou e-mail diferente.";
    case "indisponivel":
      return "Não consegui falar com o sistema agora. Tenta de novo em instantes.";
  }
}
