/**
 * A ficha ✅/⬜ do rascunho (T10).
 *
 * Função pura: recebe o que o servidor disse (`faltando`, a autoridade), o que foi
 * lido de documento e ainda espera confirmação (`lidos`) e devolve o texto. Regras:
 *
 *  - ✅ = obrigatório que NÃO está no `faltando`. O Max nunca recalcula pendência;
 *  - ⬜ = o que o servidor ainda pede;
 *  - 📄 = lido de documento / entendido do texto, ainda NÃO gravado ("lido, confira").
 *    Nunca vira ✅: a confirmação é do corretor (o "sim" do cartão);
 *  - o valor só aparece MASCARADO (CPF `***.456.789-**`, CNPJ, e-mail, telefone) e só
 *    vem da memória do turno: nada daqui vai para checkpoint, memory_facts ou log;
 *  - cabe em 1024 caracteres (limite do corpo interativo do Meta).
 */

import { RE_CNPJ, RE_CPF } from "@/lib/pii";
import type { CampoObrigatorio, Pendencia } from "./contrato";
import type { FluxoFormularioV2 } from "./estado";
import { caminhoGravavel, rotuloDoPath, type CampoLido } from "./midia";
import { PAUSA_DA_FICHA_MS } from "./pausa";

export const LIMITE_DA_FICHA = 1024;

export interface ResumoDoRascunho {
  /** Só rótulo; `valor` (mascarado) existe apenas no turno em que acabou de ser gravado. */
  salvos: Array<{ rotulo: string; valor?: string }>;
}

function ultimoSegmento(path: string): string {
  return path.split(".").pop() ?? path;
}

function soDigitos(s: string): string {
  return s.replace(/\D/g, "");
}

function mascararCpf(d: string): string {
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}

function mascararCnpj(d: string): string {
  return `**.***.***/${d.slice(8, 12)}-**`;
}

function mascararEmail(v: string): string {
  const [local, dominio] = v.trim().split("@");
  if (!local || !dominio) return "***";
  return `${local[0]}***@${dominio}`;
}

function mascararTelefone(v: string): string {
  const d = soDigitos(v);
  if (d.length < 10) return "*****";
  const ddd = d.length >= 11 ? d.slice(-11, -9) : d.slice(-10, -8);
  return `(${ddd}) *****-${d.slice(-4)}`;
}

/** Uma linha, sem sinal de confirmação forjado (um valor lido não pode fingir "tudo certo"), curta. */
function linhaLimpa(v: string): string {
  return v
    .replace(/[✅✔☑⬜📄]️?/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * O valor como o corretor pode vê-lo na ficha. Pelo NOME do campo (cpf, cnpj, e-mail,
 * telefone) e, em texto livre, pelo FORMATO: um CPF no meio da observação também sai
 * mascarado.
 */
export function mascararValor(path: string, valor: string): string {
  const campo = ultimoSegmento(path);
  const d = soDigitos(valor);
  if (campo === "cpf" && d.length === 11) return mascararCpf(d);
  if (campo === "cnpj" && d.length === 14) return mascararCnpj(d);
  if (campo === "documento") {
    if (d.length === 11) return mascararCpf(d);
    if (d.length === 14) return mascararCnpj(d);
  }
  if (campo === "email" && valor.includes("@")) return mascararEmail(valor);
  if (["telefone", "telefone1", "telefone2", "mobile_phone", "celular"].includes(campo)) return mascararTelefone(valor);
  const semDocumentos = valor
    .replace(RE_CNPJ, (m) => mascararCnpj(soDigitos(m)))
    .replace(RE_CPF, (m) => mascararCpf(soDigitos(m)))
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, (m) => mascararEmail(m));
  return linhaLimpa(semDocumentos);
}

const PAPEL_DITO: Record<string, string> = {
  proponente: "proponente",
  contraparte: "outra parte",
  comprador: "comprador",
  vendedor: "vendedor",
  locatario: "locatário",
  locador: "locador",
  proprietario: "proprietário",
  testemunha: "testemunha",
};

function humanizar(chave: string): string {
  const folha = chave.split(".").pop() ?? chave;
  const t = folha.replace(/\[\d+\]/g, "").replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function rotuloDaPendencia(p: Pendencia, obrigatorios?: CampoObrigatorio[]): string {
  if (p.motivo === "minimo_de_testemunhas") {
    return p.minimo ? `Testemunhas (mínimo ${p.minimo})` : "Testemunhas";
  }
  const def = obrigatorios?.find((o) => o.chave === p.campo);
  const base = def?.rotulo ?? humanizar(p.campo);
  if (!p.signatario) return base;
  const papel = PAPEL_DITO[p.signatario.papel] ?? p.signatario.papel;
  return `${base} do ${papel} ${p.signatario.posicao}`;
}

/**
 * Os ✅: obrigatórios da org que o servidor NÃO lista como faltando (em parte alguma).
 * `gravados` é o valor que acabou de ir para o servidor, só em memória do turno (e sai
 * mascarado).
 */
export function montarResumo(args: {
  obrigatorios: CampoObrigatorio[];
  faltando: Pendencia[];
  gravados?: Record<string, string>;
}): ResumoDoRascunho {
  const faltam = new Set(args.faltando.map((p) => p.campo));
  const salvos: ResumoDoRascunho["salvos"] = [];
  for (const o of args.obrigatorios) {
    if (faltam.has(o.chave)) continue;
    const bruto = args.gravados?.[o.chave];
    salvos.push(bruto !== undefined ? { rotulo: o.rotulo, valor: mascararValor(o.chave, bruto) } : { rotulo: o.rotulo });
  }
  return { salvos };
}

type Item = { tipo: "salvo" | "falta" | "lido"; texto: string };

/**
 * O texto da ficha. ⬜ e 📄 têm prioridade sobre ✅ quando não cabe tudo: o corretor
 * precisa ver o que ainda falta; o que já está salvo pode virar "e mais N".
 */
export function renderizarFicha(args: {
  rascunho: ResumoDoRascunho;
  faltando: Pendencia[];
  lidos: CampoLido[];
  obrigatorios?: CampoObrigatorio[];
  codigo?: string;
}): string {
  const itens: Item[] = [
    ...args.rascunho.salvos.map<Item>((s) => ({
      tipo: "salvo",
      // Defesa em profundidade: mesmo que quem montou o resumo tenha esquecido a máscara, o documento não passa.
      texto: s.valor ? `✅ ${s.rotulo}: ${mascararValor("", s.valor)}` : `✅ ${s.rotulo}`,
    })),
    ...args.faltando.map<Item>((p) => ({ tipo: "falta", texto: `⬜ ${rotuloDaPendencia(p, args.obrigatorios)}` })),
    ...args.lidos.map<Item>((c) => {
      const { grupo, campo } = rotuloDoPath(c.path);
      // M2: sem destino no PATCH, o dado não vai a lugar nenhum: dizer, em vez de pedir confirmação.
      const nota = caminhoGravavel(c.path) ? "(lido, confira)" : "(não cabe na proposta, vou ignorar)";
      return { tipo: "lido", texto: `📄 ${grupo} · ${campo}: ${mascararValor(c.path, c.valor)} ${nota}` };
    }),
  ];

  const cabecalho = args.codigo ? `📋 Rascunho ${args.codigo}` : "📋 Rascunho da proposta";
  const rodape = args.lidos.length
    ? "O que veio de documento ainda não foi anotado: responda SIM se estiver certo."
    : args.faltando.length === 0
      ? "Rascunho completo."
      : "";
  const RESERVA = 40; // "…e mais NN" com folga
  const fixo = cabecalho.length + (rodape ? rodape.length + 2 : 0) + 2;
  const orcamento = LIMITE_DA_FICHA - fixo - RESERVA;

  // Prioridade de permanência: ⬜, 📄, depois ✅.
  const prioridade: Item["tipo"][] = ["falta", "lido", "salvo"];
  const incluidos = new Set<Item>();
  let usado = 0;
  for (const tipo of prioridade) {
    for (const it of itens.filter((i) => i.tipo === tipo)) {
      if (usado + it.texto.length + 1 > orcamento) continue;
      incluidos.add(it);
      usado += it.texto.length + 1;
    }
  }
  const fora = itens.length - incluidos.size;
  const corpo = itens.filter((i) => incluidos.has(i)).map((i) => i.texto);
  if (fora > 0) corpo.push(`…e mais ${fora}`);
  const t = [cabecalho, ...corpo, ...(rodape ? ["", rodape] : [])].join("\n");
  return t.length <= LIMITE_DA_FICHA ? t : `${t.slice(0, LIMITE_DA_FICHA - 1)}…`;
}

function sem(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PEDIDO_DE_FICHA =
  /^(?:(?:max|newton) )?(?:(?:me )?(?:mostra|manda|ve|ver|faz)(?: a| o)? )?(?:ficha|resumo|o que (?:ainda )?falta|que falta|o que falta ainda|falta o que)(?: ainda| ai| agora)?$/;
const FIM_DA_COLETA = /^(?:(?:max|newton) )?(?:pronto|prontinho|so isso|e so isso|era so isso|so isso mesmo|terminei|acabei|acabou|por enquanto e so|e isso)$/;

/** O corretor pediu a ficha de propósito ("o que falta?", "pronto", "só isso")? Frase curta e inteira, nunca um trecho de dado. */
export function pediuAFicha(texto: string): boolean {
  const t = sem(texto);
  if (!t || t.split(" ").length > 7) return false;
  return PEDIDO_DE_FICHA.test(t) || FIM_DA_COLETA.test(t);
}

/**
 * Mostra a ficha agora? (D2) Quando passaram 20 s desde a última entrada (`fluxo` ANTES de
 * registrar a entrada deste turno), quando ele pediu, quando leu mídia ou quando veio tudo
 * numa mensagem (`completo`: nada faltando depois desta mensagem).
 */
export function deveMostrarFicha(
  f: FluxoFormularioV2,
  agora: number,
  texto: string,
  opts: { completo?: boolean; temMidiaLida?: boolean } = {}
): boolean {
  if (opts.completo || opts.temMidiaLida) return true;
  if (pediuAFicha(texto)) return true;
  return agora - f.ultimaEntradaEm >= PAUSA_DA_FICHA_MS;
}
