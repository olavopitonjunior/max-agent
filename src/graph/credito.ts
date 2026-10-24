import { nomeDoAgente } from "@/lib/deploy-profile";
import type { ContextoDoTurno, DepsDoFluxo, PassoDoFluxo } from "./fluxos";
import { codigoCitado } from "./localizar";
import { lerConfirmacao, normalizar } from "./tools";
import { imobproBase } from "@/lib/http";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { RE_CNPJ, RE_CPF } from "@/lib/pii";

/**
 * Fluxo `credito` (M2/M3, plano §7.6): coleta da ficha residencial PF da
 * Upestate pelo WhatsApp, campo a campo; no M3, o envio (`credit.request`,
 * sub-flag `MAX_CREDITO_ENVIO`), o resultado e o desdobramento em proposta.
 *
 * Desenho:
 *  - intercepto determinístico (`pedeCredito`) antes da consulta/criação;
 *  - gate: usuário + policy `credit.request` + `credit.preflight` (org ligada);
 *  - atestação (consentimento do pretendente, texto oficial do ImobPro);
 *  - coleta na ordem dos `faltantes` do servidor; validação em código, o LLM só
 *    extrai UM campo quando o código não resolve, e o que ele devolve é
 *    conferido contra o texto (nunca valor inventado);
 *  - cada campo aceito vai por `lead.upsert`: o rascunho mora no ImobPro.
 *
 * Checkpoint: só referência (lead, etapa, campo, consentimento, tentativas).
 * O `lead.upsert` exige o CPF em TODA chamada (contrato do C5), então o CPF e
 * os dados dos solidários em curso ficam no `cofre`, cifrado com a
 * `MAX_ENCRYPTION_KEY` (AES-256-GCM) — nunca em claro no state.
 */

/** Texto oficial da atestação — igual a `TEXTO_ATESTACAO` do ImobPro (`lib/credit/consent.ts`). */
export const TEXTO_ATESTACAO =
  "Autorizo a consulta de crédito (birô/Serasa) para mim e para os demais " +
  "que estão compondo renda nesta locação, para fins de análise de aprovação do aluguel.";

export type CampoCredito =
  | "cpf" | "nome" | "vinculo" | "profissao" | "renda" | "aluguel" | "condominio" | "iptu" | "vaiMorar"
  | "moradorCpf" | "moradorNome" | "moradorParentesco"
  | "maisSolidario" | "solCpf" | "solNome" | "solVinculo" | "solProfissao" | "solRenda";

export interface FluxoCredito {
  kind: "credito";
  etapa: "atestacao" | "coleta" | "revisao" | "enviando" | "resultado";
  leaseClientId?: string;
  leadNome?: string;
  campoAtual?: CampoCredito;
  consentimento?: { texto: string; messageId: string };
  tentativas: number;
  /** Proposta citada no pedido: prefill de nome/aluguel/condomínio/IPTU. */
  propostaId?: string;
  /** Solidários completos (até 3). Os dados ficam no cofre. */
  solidarios?: number;
  /** "Tem mais alguém compondo renda?" já respondido com NÃO (ou chegou a 3). */
  solidariosEncerrados?: boolean;
  /** Pergunta fora do assunto: a resposta do modelo ganha o "Continuando…". */
  pausado?: boolean;
  /** Cifrado — ver o cabeçalho. */
  cofre?: string;
  /**
   * M3: o envio em curso — `valor` é a `messageId` do SIM (`x-idempotency-key`).
   * Com chave guardada, nenhum SIM dispara outro `credit.request`.
   */
  chave?: { verbo: string; valor: string; em?: number };
  /**
   * Já havia análise recente (< 24 h, concluída) e o corretor viu o aviso:
   * o próximo SIM faz uma consulta nova. Em voo ou reenvio arriscado nunca.
   */
  novaConsulta?: boolean;
  /** M3: a decisão que voltou no envio (só `aprovado` fica, para o SIM da proposta). */
  decisao?: string;
  atualizadoEm: number;
}

type Resposta = Extract<PassoDoFluxo, { reply: string }>;

// ─── Flag ────────────────────────────────────────────────────────────────

/** `MAX_CREDITO` (default desligado). Desligada, o Max segue como antes do M2. */
export function creditoLigado(): boolean {
  return /^(1|true|on|sim)$/i.test(process.env.MAX_CREDITO ?? "");
}

/** `MAX_CREDITO_ENVIO` (default desligado, M3): sem ela, o SIM da revisão não envia (comportamento do M2). */
export function envioLigado(): boolean {
  return creditoLigado() && /^(1|true|on|sim)$/i.test(process.env.MAX_CREDITO_ENVIO ?? "");
}

// ─── Textos fixos ────────────────────────────────────────────────────────

export const TEXTO_CREDITO_SEM_POLITICA = "Análise de crédito não está liberada para você nesta imobiliária.";
const TEXTO_POLITICA_INDISPONIVEL = "Não consegui validar sua permissão agora. Nada foi feito; tente de novo em instantes.";
const TEXTO_SEM_RESPOSTA = "Não consegui falar com o sistema agora. Tente de novo em instantes.";
const TEXTO_NAO_AUTORIZOU = "Certo, sem autorização não consulto. Nada foi feito.";
export const TEXTO_APROVAR = "Eu não aprovo análise de crédito; quem decide é a Upestate. Posso te mostrar o status.";
export const TEXTO_SCORE =
  "Não existe score por aqui: a análise de crédito da Upestate não devolve score. " +
  "Posso abrir uma ficha de crédito ou ver o status de uma análise.";
const TEXTO_TENTATIVAS = "Pode conferir e mandar de novo?";

// M3 — envio e resultado (textos fixos da spec).
export const TEXTO_ENVIO_PENDENTE = "Enviei. A Upestate ainda está analisando; te aviso aqui assim que sair.";
export const textoEnvioIncerto = (url: string) =>
  `Não consegui confirmar o envio agora. Não reenvie: veja o status na tela do lead (${url}) ou me pergunte daqui a pouco.`;
export const textoAindaNaoEncontrei = (url: string) =>
  `Ainda não encontrei sua análise. Veja na tela do lead: ${url}, ou me pergunte daqui a pouco.`;
export const TEXTO_EM_ANDAMENTO = "Este CPF já tem uma análise em andamento na Upestate.";
export const TEXTO_TETO = "O limite mensal de análises da imobiliária foi atingido. Fale com o administrador.";
export const TEXTO_INDISPONIVEL = "Análise de crédito indisponível agora.";
const textoCpfDivergente = (url: string) => `O CPF da ficha não bate com o do cadastro. Confira na tela: ${url}`;

const textoInativa = (org: string) => `Análise de crédito não está ativa na ${org}. Fale com o administrador.`;
const link = (caminho: string) => new URL(caminho, imobproBase()).toString();
const linkDoLead = (id?: string) => link(id ? `/locacao/pessoas/clientes/${id}` : "/locacao/credito");

function textoAtestacao(nome?: string): string {
  return `Vou precisar de CPF, renda e vínculo ${nome ? `de ${nome}` : "do pretendente"}. ` +
    `Confirma que ele(a) autorizou a consulta de crédito na Upestate ("${TEXTO_ATESTACAO}")? Responda SIM.`;
}

// ─── Rótulos e sinônimos ─────────────────────────────────────────────────

const VINCULO: Record<number, string> = {
  1: "aposentado/pensionista", 2: "autônomo", 3: "profissional liberal", 4: "empresário",
  5: "servidor público", 6: "CLT", 7: "estudante", 8: "renda de aluguel",
};
const VAI_MORAR: Record<number, string> = {
  1: "vai morar sozinho(a)", 2: "vai morar com outras pessoas", 3: "imóvel para um parente", 4: "imóvel para terceiros",
};
const PARENTESCO: Record<number, string> = {
  1: "pai", 2: "mãe", 3: "filho(a)", 4: "irmão(ã)", 5: "cônjuge", 6: "parente", 7: "amigo(a)", 8: "sócio(a)", 9: "outro",
};

/** Ordem importa: a primeira regra que casa vence; duas regras diferentes = ambíguo (vai ao extrator). */
const SINONIMOS_VINCULO: [RegExp, number][] = [
  [/\b(aposentad\w*|pensionista|inss)\b/, 1],
  [/\b(autonom\w*|freela\w*|bicos?|por conta propria|conta propria|informal|motorista de app|uber)\b/, 2],
  [/\b(liberal)\b/, 3],
  [/\b(empresari\w*|dono de empresa|dona de empresa|tem empresa|socio de empresa)\b/, 4],
  [/\b(servidor\w*|funcionari[oa] public[oa]|concursad\w*)\b/, 5],
  [/\b(clt|carteira assinada|registrad[oa]|celetista|assalariad[oa])\b/, 6],
  [/\b(estudante|universitari[oa])\b/, 7],
  [/\b(renda de alugue\w*|vive de alugue\w*|alugueis|alugueres)\b/, 8],
];
const SINONIMOS_VAI_MORAR: [RegExp, number][] = [
  [/\b(sozinh[oa]|so (ele|ela|eu)|somente (ele|ela))\b/, 1],
  [/\b(?:para|pra|pro)\s+(?:o |a |os |as |um |uma )?(pai|mae|filh\w*|irma\w*|parente|sogr\w*|avo|avos|ti[oa]|prim[oa]|net[oa]|sobrinh\w*)\b|\bparente\b/, 3],
  [/\b(terceir\w*|outra pessoa|um amigo|uma amiga|funcionari[oa])\b/, 4],
  [/\bcom\s+(?:a |o |os |as |sua |seu |suas |seus )?(familia|esposa|esposo|marido|mulher|filh\w*|namorad\w*|companheir\w*|pais|mae|pai|amig\w*|outras pessoas|colegas?)\b|\boutras pessoas\b|\bfamilia\b/, 2],
];
const SINONIMOS_PARENTESCO: [RegExp, number][] = [
  [/\bpai\b/, 1],
  [/\bmae\b/, 2],
  [/\bfilh[oa]s?\b/, 3],
  [/\birma[os]?\b|\birmao\b/, 4],
  [/\b(conjuge|esposa|esposo|marido|mulher|companheir[oa])\b/, 5],
  [/\b(parente|sogr[oa]|ti[oa]|prim[oa]|avo|avos|net[oa]|cunhad[oa]|genro|nora|sobrinh[oa])\b/, 6],
  [/\b(amig[oa]|namorad[oa])\b/, 7],
  [/\bsoci[oa]\b/, 8],
  [/\b(outr[oa]s?)\b/, 9],
];

/** As opções com suporte no texto (número solto ou sinônimo). Vazio = nenhuma. */
function porSinonimo(texto: string, regras: [RegExp, number][], max: number): Set<number> {
  const t = normalizar(texto);
  const solto = /^(\d)$/.exec(t.replace(/^(opcao|numero|n)\s*/, ""));
  if (solto) {
    const n = Number(solto[1]);
    return new Set(n >= 1 && n <= max ? [n] : []);
  }
  return new Set(regras.filter(([re]) => re.test(t)).map(([, n]) => n));
}

/** Incerteza ou recusa ("não sei", "vou perguntar"): nunca vai ao extrator. */
const INCERTEZA = /\b(nao sei|n sei|sei la|nao lembro|vou ver|vou perguntar|vou confirmar|vou checar|depois (te )?(falo|mando|passo|digo)|ainda nao (sei|tenho)|nao tenho (isso|essa info\w*|esse dado)|nao faco ideia|preciso ver)\b/;

/** Atestação: só o SIM explícito vale ("ok", "beleza", 👍 não). Também para o SIM de envio do M3. */
export const CONFIRMA_ESTRITO = /^(sim|s|confirmo|autorizo|autorizou|sim,? (ele|ela) autorizou|sim,? autorizou)[.!]?$/;
export function confirmaEstrito(texto: string): boolean {
  return CONFIRMA_ESTRITO.test(normalizar(texto));
}

// ─── CPF ─────────────────────────────────────────────────────────────────

const so = (x: string) => x.replace(/\D/g, "");

export function cpfValido(raw: string): boolean {
  const cpf = so(raw);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (let n = 9; n < 11; n++) {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(cpf[i]) * (n + 1 - i);
    if (Number(cpf[n]) !== ((soma * 10) % 11) % 10) return false;
  }
  return true;
}

/** "***.***.789-00" — o que o Max repete do CPF. */
export function mascararCpf(cpf: string): string {
  const d = so(cpf);
  return `***.***.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

/** Candidatos a CPF/CNPJ no texto (com ou sem máscara, com espaços entre os grupos). */
function documentosNoTexto(texto: string): { cpfs: string[]; cnpj: boolean } {
  // As MESMAS regex da redação (pii.ts): o que é aceito aqui é sempre redigido lá.
  const cnpj = new RegExp(RE_CNPJ.source).test(texto);
  const brutos = texto.match(new RegExp(RE_CPF.source, "g")) ?? [];
  return { cpfs: [...new Set(brutos.map(so))], cnpj };
}

// ─── Valores (moeda pt-BR, por extenso) ──────────────────────────────────

const PALAVRAS: Record<string, number> = {
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9,
  dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezessete: 17,
  dezoito: 18, dezenove: 19, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70,
  oitenta: 80, noventa: 90, cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, quatrocentos: 400,
  quinhentos: 500, seiscentos: 600, setecentos: 700, oitocentos: 800, novecentos: 900,
};

function numeroDigitado(s: string): number | null {
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) return Number(s.replace(/\./g, "").replace(",", "."));
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) return Number(s.replace(/,/g, ""));
  if (/^\d+,\d{1,2}$/.test(s)) return Number(s.replace(",", "."));
  if (/^\d+(\.\d{1,2})?$/.test(s)) return Number(s);
  return null;
}

/**
 * Os valores em reais que a mensagem cita: "8 mil", "R$ 8.500,00", "8,5 mil",
 * "8k", "oito mil e quinhentos", "mil e duzentos". Sem adivinhar: o que não
 * parece número não entra.
 */
export function valoresNoTexto(texto: string): number[] {
  const t = normalizar(texto).replace(/r\$/g, " ");
  const tokens = t.match(/\d[\d.,]*k?|[a-z]+/g) ?? [];
  const out: number[] = [];
  let total = 0;
  let atual = 0;
  let ativo = false;
  let depoisDoE = false;
  const fechar = () => {
    if (ativo) out.push(Math.round((total + atual) * 100) / 100);
    total = 0; atual = 0; ativo = false; depoisDoE = false;
  };
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]!;
    const prox = tokens[i + 1];
    let n: number | null = null;
    if (/^\d/.test(tk)) {
      const k = tk.endsWith("k");
      const base = numeroDigitado(k ? tk.slice(0, -1) : tk.replace(/[.,]$/, ""));
      n = base === null ? null : k ? base * 1000 : base;
    } else if (tk in PALAVRAS && (!["um", "uma"].includes(tk) || /^(mil|milhao|milhoes)$/.test(prox ?? "") || depoisDoE)) {
      n = PALAVRAS[tk]!;
    }
    if (n !== null) {
      if (ativo && !depoisDoE && atual > 0) fechar();
      atual += n;
      ativo = true;
      depoisDoE = false;
      continue;
    }
    if (tk === "mil") {
      total += (atual || 1) * 1000;
      atual = 0;
      ativo = true;
      depoisDoE = false;
      continue;
    }
    if (tk === "milhao" || tk === "milhoes") {
      total = (total + (atual || 1)) * 1_000_000;
      atual = 0;
      ativo = true;
      continue;
    }
    if (tk === "e" && ativo) { depoisDoE = true; continue; }
    if (tk === "reais" || tk === "real" || tk === "conto" || tk === "contos") continue;
    fechar();
  }
  fechar();
  return [...new Set(out)];
}

/** "aluguel 3 mil, condomínio 800": cada valor ligado ao rótulo que o precede. */
const ROTULOS: [RegExp, CampoCredito][] = [[/\baluguel\b/, "aluguel"], [/\bcondominio\b/, "condominio"], [/\biptu\b/, "iptu"]];
export function valoresRotulados(texto: string): Partial<Record<CampoCredito, number>> {
  const t = normalizar(texto);
  const marcas = ROTULOS.flatMap(([re, campo]) => {
    const m = new RegExp(re.source, "g");
    const out: { campo: CampoCredito; ini: number; fim: number }[] = [];
    for (let x = m.exec(t); x; x = m.exec(t)) out.push({ campo, ini: x.index, fim: x.index + x[0].length });
    return out;
  }).sort((a, b) => a.ini - b.ini);
  const achados: Partial<Record<CampoCredito, number>> = {};
  marcas.forEach((m, i) => {
    const trecho = t.slice(m.fim, marcas[i + 1]?.ini ?? t.length);
    const v = valoresNoTexto(trecho)[0];
    if (v !== undefined && achados[m.campo] === undefined) achados[m.campo] = v;
    else if (v === undefined && m.campo !== "aluguel" && ZERO.test(trecho) && achados[m.campo] === undefined) achados[m.campo] = 0;
  });
  return achados;
}

const ZERO = /\b(nao tem|nao paga|nao ha|nao possui|sem (condominio|iptu|renda)|isent[oa]|nenhum|zero)\b/;

export function brl(v: number): string {
  return `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── Nome e profissão ────────────────────────────────────────────────────

const CONECTORES = new Set(["da", "de", "do", "das", "dos", "e"]);
/** Palavras que não são de nome: "não sei o sobrenome agora" não é um nome. */
const NAO_NOME = new Set([
  "nao", "sim", "sei", "agora", "ainda", "depois", "vou", "vai", "perguntar", "pergunto", "mando", "manda", "tem", "ta",
  "esta", "ok", "oi", "qual", "quando", "como", "porque", "aguarda", "espera", "ja", "nome", "sobrenome", "completo",
  "cpf", "renda", "dela", "dele", "mais", "o", "a", "os", "as", "um", "uma", "que", "se", "me", "te", "eu", "ele", "ela",
]);

/** Nome completo plausível: 2+ palavras de letras, sem dígito. */
export function nomeValido(nome: string): boolean {
  const partes = nome.trim().split(/\s+/);
  if (partes.length < 2 || partes.length > 8 || nome.length > 80) return false;
  if (!partes.every((p) => /^[\p{L}'-]+$/u.test(p))) return false;
  if (partes.some((p) => NAO_NOME.has(normalizar(p)))) return false;
  return partes.filter((p) => !CONECTORES.has(p.toLowerCase())).length >= 2;
}

function limparNome(texto: string): string {
  return texto.trim()
    .replace(/^(o |a )?(nome( completo)?( dele| dela| do pretendente| da pretendente)?\s*(e|é|eh|:)?\s*)/i, "")
    .replace(/^(ele|ela)\s+se\s+chama\s+|^se\s+chama\s+|^chama\s+|^é\s+|^e\s+/i, "")
    .replace(/[.!]+$/, "")
    .trim();
}

function limparProfissao(texto: string): string {
  return texto.trim()
    .replace(/^(a )?profiss[aã]o( dele| dela)?\s*(e|é|eh|:)?\s*/i, "")
    .replace(/^(ele|ela)\s+/i, "")
    .replace(/^(é|e|eh|trabalha como|trabalha de|atua como|atua de)\s+/i, "")
    .replace(/^(um|uma)\s+/i, "")
    .replace(/[.!]+$/, "")
    .trim();
}

const profissaoValida = (p: string) =>
  p.length >= 2 && p.length <= 60 && !/\d/.test(p) && !/[?]/.test(p) && p.split(/\s+/).length <= 6;

// ─── Interpretação de UM campo ───────────────────────────────────────────

export type Interpretacao =
  | { tipo: "ok"; valor: string | number; extras?: Partial<Record<CampoCredito, number>> }
  | { tipo: "erro"; texto: string }
  | { tipo: "pj" }
  | { tipo: "vazio" };

/** O extrator (LLM, tool forçada) de um campo. `null` = falhou. */
export type ExtratorDeCampo = (texto: string, campo: CampoCredito) => Promise<Record<string, unknown> | null>;

type Base = "cpf" | "nome" | "vinculo" | "profissao" | "valor" | "vaiMorar" | "parentesco";
const BASE: Record<CampoCredito, Base | "simnao"> = {
  cpf: "cpf", nome: "nome", vinculo: "vinculo", profissao: "profissao", renda: "valor", aluguel: "valor",
  condominio: "valor", iptu: "valor", vaiMorar: "vaiMorar", moradorCpf: "cpf", moradorNome: "nome",
  moradorParentesco: "parentesco", maisSolidario: "simnao", solCpf: "cpf", solNome: "nome",
  solVinculo: "vinculo", solProfissao: "profissao", solRenda: "valor",
};
const ACEITA_ZERO = new Set<CampoCredito>(["condominio", "iptu", "renda", "solRenda"]);
const TETO_VALOR = 10_000_000;

/** O trecho que o extrator citou está mesmo na mensagem? (`conferirDitado` do crédito) */
function noTexto(trecho: string, texto: string): boolean {
  const a = normalizar(trecho).replace(/[^a-z0-9]+/g, " ").trim();
  const b = normalizar(texto).replace(/[^a-z0-9]+/g, " ");
  return !!a && ` ${b} `.includes(` ${a} `);
}

const trechoDe = (r: Record<string, unknown> | null) => (typeof r?.trecho === "string" ? r.trecho.trim() : "");
const opcaoDe = (r: Record<string, unknown> | null) => (typeof r?.opcao === "number" && Number.isInteger(r.opcao) ? r.opcao : null);

function interpretarValor(campo: CampoCredito, valores: number[], texto: string): Interpretacao | null {
  const zero = ZERO.test(normalizar(texto)) && ACEITA_ZERO.has(campo);
  const positivos = valores.filter((v) => v > 0);
  if (positivos.length === 1 && !zero) {
    const v = positivos[0]!;
    return v > TETO_VALOR ? { tipo: "erro", texto: "Esse valor parece fora do normal." } : { tipo: "ok", valor: v };
  }
  if (!positivos.length && (zero || (ACEITA_ZERO.has(campo) && valores.includes(0)))) return { tipo: "ok", valor: 0 };
  return null;
}

/**
 * Interpreta a resposta a UM campo: código primeiro; o extrator só quando o
 * código não decide (ambíguo, mais de um candidato, frase solta) — e o que ele
 * devolve é conferido contra a mensagem antes de valer.
 */
export async function interpretarCampo(campo: CampoCredito, texto: string, extrairModelo: ExtratorDeCampo): Promise<Interpretacao> {
  const base = BASE[campo];
  const incerto = INCERTEZA.test(normalizar(texto));
  // Incerteza ou pergunta nunca chega ao modelo: não há dado para extrair.
  const extrair: ExtratorDeCampo = async (t, c) => (incerto || /\?\s*$/.test(t) ? null : extrairModelo(t, c));
  if (base === "simnao") {
    const c = lerConfirmacao(texto);
    return c === "sim" ? { tipo: "ok", valor: "sim" } : c === "nao" ? { tipo: "ok", valor: "nao" } : { tipo: "vazio" };
  }

  if (base === "cpf") {
    const { cpfs, cnpj } = documentosNoTexto(texto);
    if (cnpj && !cpfs.length && campo === "cpf") return { tipo: "pj" };
    if (cpfs.length === 1) {
      return cpfValido(cpfs[0]!) ? { tipo: "ok", valor: cpfs[0]! } : { tipo: "erro", texto: "Esse CPF não confere (dígito verificador)." };
    }
    if (cpfs.length > 1) {
      const r = await extrair(texto, campo);
      const escolhido = so(trechoDe(r));
      if (cpfs.includes(escolhido) && cpfValido(escolhido)) return { tipo: "ok", valor: escolhido };
      return { tipo: "erro", texto: "Vi mais de um número aqui. Mande só o CPF." };
    }
    const digitos = so(texto).length;
    if (digitos > 0 && digitos !== 11) return { tipo: "erro", texto: "O CPF tem 11 dígitos." };
    return { tipo: "vazio" };
  }

  if (base === "valor") {
    // Valor dentro de pergunta ("8 mil ou somo o bico?") não vale: pergunta de novo.
    if (/\?\s*$/.test(texto) && valoresNoTexto(texto).length) return { tipo: "erro", texto: "Me mande só o valor que devo anotar." };
    if (incerto) return { tipo: "vazio" };
    const rotulados = valoresRotulados(texto);
    if (Object.keys(rotulados).length && ["aluguel", "condominio", "iptu"].includes(campo)) {
      const v = rotulados[campo];
      if (v === undefined) return { tipo: "erro", texto: "Não achei esse valor na mensagem." };
      if (v > TETO_VALOR) return { tipo: "erro", texto: "Esse valor parece fora do normal." };
      const extras = Object.fromEntries(Object.entries(rotulados).filter(([k]) => k !== campo)) as Partial<Record<CampoCredito, number>>;
      return { tipo: "ok", valor: v, ...(Object.keys(extras).length ? { extras } : {}) };
    }
    const direto = interpretarValor(campo, valoresNoTexto(texto), texto);
    if (direto) return direto;
    const valores = valoresNoTexto(texto);
    if (!valores.length && !ZERO.test(normalizar(texto))) return { tipo: "vazio" };
    const r = await extrair(texto, campo);
    const trecho = trechoDe(r);
    if (!trecho || !noTexto(trecho, texto)) return { tipo: "erro", texto: "Não entendi o valor. Mande só o número, por exemplo: 8.500." };
    const doTrecho = interpretarValor(campo, valoresNoTexto(trecho), trecho);
    return doTrecho ?? { tipo: "erro", texto: "Não entendi o valor. Mande só o número, por exemplo: 8.500." };
  }

  if (base === "nome") {
    if (incerto) return { tipo: "vazio" };
    const limpo = limparNome(texto);
    if (nomeValido(limpo)) return { tipo: "ok", valor: limpo };
    if (/\?\s*$/.test(texto)) return { tipo: "vazio" };
    if (limpo.split(/\s+/).length === 1 && /^[\p{L}'-]+$/u.test(limpo)) return { tipo: "erro", texto: "Preciso do nome completo, com sobrenome." };
    const r = await extrair(texto, campo);
    const trecho = limparNome(trechoDe(r));
    if (trecho && nomeValido(trecho) && noTexto(trecho, texto)) return { tipo: "ok", valor: trecho };
    return { tipo: "vazio" };
  }

  if (base === "profissao") {
    if (incerto) return { tipo: "vazio" };
    const limpo = limparProfissao(texto);
    if (profissaoValida(limpo) && !/\?\s*$/.test(texto)) return { tipo: "ok", valor: limpo };
    if (/\?\s*$/.test(texto)) return { tipo: "vazio" };
    const r = await extrair(texto, campo);
    const trecho = limparProfissao(trechoDe(r));
    if (trecho && profissaoValida(trecho) && noTexto(trecho, texto)) return { tipo: "ok", valor: trecho };
    return { tipo: "vazio" };
  }

  // Enums: sinônimo em código; o extrator só escolhe entre as opções da lista.
  const [regras, max] = base === "vinculo" ? [SINONIMOS_VINCULO, 8] : base === "vaiMorar" ? [SINONIMOS_VAI_MORAR, 4] : [SINONIMOS_PARENTESCO, 9];
  if (incerto) return { tipo: "vazio" };
  const achados = porSinonimo(texto, regras, max);
  if (achados.size === 1) return { tipo: "ok", valor: [...achados][0]! };
  if (base === "vaiMorar" && /^(sim|s|vai|vai sim)$/.test(normalizar(texto))) {
    return { tipo: "erro", texto: "Sozinho(a) ou com outras pessoas? Responda com o número da opção." };
  }
  // Sem sinônimo na frase, o modelo não tem do que escolher: nunca inventa a opção.
  if (!achados.size) return { tipo: "vazio" };
  const r = await extrair(texto, campo);
  const opcao = opcaoDe(r);
  // Saída do modelo só vale se a frase sustenta a opção (um dos sinônimos achados).
  if (opcao !== null && achados.has(opcao)) return { tipo: "ok", valor: opcao };
  return { tipo: "erro", texto: "Ficou ambíguo. Responda com o número da opção." };
}

// ─── Ferramenta do extrator ──────────────────────────────────────────────

const DESCRICAO: Record<Base, string> = {
  cpf: "o CPF da pessoa",
  nome: "o nome completo da pessoa",
  vinculo: "o vínculo de trabalho da pessoa",
  profissao: "a profissão da pessoa",
  valor: "o valor em reais",
  vaiMorar: "se o pretendente vai morar no imóvel",
  parentesco: "o parentesco do morador com o pretendente",
};
const OPCOES: Partial<Record<Base, Record<number, string>>> = { vinculo: VINCULO, vaiMorar: VAI_MORAR, parentesco: PARENTESCO };

/** Tool forçada de UM campo. Texto livre volta como TRECHO copiado (o código interpreta). */
export function toolExtrairCredito(campo: CampoCredito) {
  const base = BASE[campo] === "simnao" ? "nome" : (BASE[campo] as Base);
  const opcoes = OPCOES[base];
  const extra = campo === "condominio" || campo === "iptu" ? ' Se a pessoa disser que não tem, copie esse trecho (ex.: "não tem").' : "";
  return {
    name: "preencher_campo",
    description:
      `Registra ${DESCRICAO[base]} que a pessoa informou NESTA mensagem. Nunca invente nem deduza: ` +
      `sem o dado, chame a ferramenta vazia.${extra}`,
    parameters: {
      type: "object",
      properties: opcoes
        ? {
          opcao: {
            type: "integer",
            enum: Object.keys(opcoes).map(Number),
            description: Object.entries(opcoes).map(([n, r]) => `${n} = ${r}`).join("; "),
          },
        }
        : {
          trecho: {
            type: "string",
            description: "O trecho EXATO da mensagem com o dado, copiado como está (inclusive marcas ⟨…⟩).",
          },
        },
      additionalProperties: false,
    },
  };
}

// ─── Cofre (CPF e solidários, cifrados) ──────────────────────────────────

interface Solidario { documento?: string; nomeCompleto?: string; vinculoEmpregaticio?: number; profissao?: string; rendaMensal?: number }
interface Cofre { cpf?: string; renda?: number; aluguel?: number; vinculo?: number; solidarios?: Solidario[] }

/** Subchave própria (HKDF da `MAX_ENCRYPTION_KEY`): o cofre não divide chave com o token da org. */
function chaveDoCofre(): Buffer {
  const raw = process.env.MAX_ENCRYPTION_KEY;
  if (!raw) throw new Error("MAX_ENCRYPTION_KEY não configurada");
  const mestra = Buffer.from(raw, "base64");
  if (mestra.length !== 32) throw new Error("MAX_ENCRYPTION_KEY deve ser 32 bytes em base64");
  return Buffer.from(hkdfSync("sha256", mestra, Buffer.alloc(0), "max-credito-cofre", 32));
}

/** AES-256-GCM com AAD = thread: o cofre de uma conversa não abre em outra. */
export function cifrarCofre(texto: string, thread: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chaveDoCofre(), iv);
  c.setAAD(Buffer.from(thread, "utf8"));
  const enc = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
export function decifrarCofre(payload: string, thread: string): string {
  const [iv, tag, dado] = payload.split(".");
  if (!iv || !tag || !dado) throw new Error("cofre malformado");
  const d = createDecipheriv("aes-256-gcm", chaveDoCofre(), Buffer.from(iv, "base64"));
  d.setAAD(Buffer.from(thread, "utf8"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(dado, "base64")), d.final()]).toString("utf8");
}

const threadDe = (ctx: ContextoDoTurno) => ctx.thread ?? "sem-thread";
function abrirCofre(f: FluxoCredito, ctx: ContextoDoTurno): Cofre {
  if (!f.cofre) return {};
  try {
    return JSON.parse(decifrarCofre(f.cofre, threadDe(ctx))) as Cofre;
  } catch {
    return {};
  }
}
const fecharCofre = (c: Cofre, ctx: ContextoDoTurno): string => cifrarCofre(JSON.stringify(c), threadDe(ctx));

// ─── Perguntas ───────────────────────────────────────────────────────────

const quem = (f: FluxoCredito) => f.leadNome ?? "o pretendente";
const quemMaiusculo = (f: FluxoCredito) => (f.leadNome ?? "O pretendente");
const deQuem = (f: FluxoCredito) => (f.leadNome ? `de ${f.leadNome}` : "do pretendente");
const OPCOES_VINCULO = "(CLT, autônomo, aposentado, servidor, empresário, estudante, liberal ou renda de aluguel)";

function pergunta(f: FluxoCredito, campo: CampoCredito): string {
  const k = (f.solidarios ?? 0) + 1;
  switch (campo) {
    case "cpf": return `CPF ${deQuem(f)}?`;
    case "nome": return "Nome completo do pretendente?";
    case "vinculo": return `Vínculo de trabalho ${deQuem(f)}? ${OPCOES_VINCULO}`;
    case "profissao": return `Profissão ${deQuem(f)}?`;
    case "renda": return `Renda mensal ${deQuem(f)}?`;
    case "aluguel": return "Valor do aluguel?";
    case "condominio": return 'Valor do condomínio? (se não tiver, diga "não tem")';
    case "iptu": return 'Valor do IPTU? (se não tiver, diga "não tem")';
    case "vaiMorar":
      return `${quem(f)[0]!.toUpperCase()}${quem(f).slice(1)} vai morar no imóvel?\n1. Sim, sozinho(a)\n2. Sim, com outras pessoas\n3. Não, é para um parente\n4. Não, é para terceiros`;
    case "moradorCpf": return "CPF de quem vai morar no imóvel?";
    case "moradorNome": return "Nome completo de quem vai morar?";
    case "moradorParentesco": return "Parentesco dessa pessoa com o pretendente? (pai, mãe, filho, irmão, cônjuge, parente, amigo, sócio ou outro)";
    case "maisSolidario": return "Tem mais alguém compondo renda? Responda SIM ou NÃO.";
    case "solCpf": return `CPF de quem vai compor renda (${k}ª pessoa)?`;
    case "solNome": return "Nome completo dessa pessoa?";
    case "solVinculo": return `Vínculo de trabalho dessa pessoa? ${OPCOES_VINCULO}`;
    case "solProfissao": return "Profissão dessa pessoa?";
    case "solRenda": return "Renda mensal dessa pessoa?";
  }
}

/** O "Continuando…" que volta depois de uma pergunta fora do assunto. */
export function continuacaoCredito(f: FluxoCredito): string {
  const cab = `Continuando a ficha ${deQuem(f)}: `;
  if (f.etapa === "atestacao") return `${cab}confirma que ele(a) autorizou a consulta de crédito na Upestate? Responda SIM.`;
  if (f.etapa === "enviando") return `Sobre a análise ${deQuem(f)}: ainda estou conferindo o envio; te aviso aqui.`;
  if (f.etapa === "resultado") return `Sobre a análise ${deQuem(f)}: quer que eu abra a proposta de locação? Responda SIM ou NÃO.`;
  if (f.etapa === "revisao" || !f.campoAtual) return `${cab}mande RESUMO para ver o que já tenho, ou CANCELAR para parar.`;
  return `${cab}${pergunta(f, f.campoAtual)}`;
}

function eco(campo: CampoCredito, valor: string | number): string {
  switch (campo) {
    case "cpf": case "solCpf": return `CPF ${mascararCpf(String(valor))}`;
    case "moradorCpf": return `CPF do morador ${mascararCpf(String(valor))}`;
    case "vinculo": case "solVinculo": return VINCULO[valor as number]!;
    case "renda": case "solRenda": return `renda ${brl(valor as number)}`;
    case "aluguel": return `aluguel ${brl(valor as number)}`;
    case "condominio": return valor === 0 ? "sem condomínio" : `condomínio ${brl(valor as number)}`;
    case "iptu": return valor === 0 ? "sem IPTU" : `IPTU ${brl(valor as number)}`;
    case "vaiMorar": return VAI_MORAR[valor as number]!;
    case "moradorParentesco": return PARENTESCO[valor as number]!;
    default: return String(valor);
  }
}

// ─── Mapa faltante (servidor) → campo ────────────────────────────────────

const FALTANTE: [RegExp, CampoCredito][] = [
  [/^cpf do pretendente/i, "cpf"],
  [/^nome completo do pretendente/i, "nome"],
  [/^v[ií]nculo/i, "vinculo"],
  [/^profiss/i, "profissao"],
  [/^renda/i, "renda"],
  [/aluguel/i, "aluguel"],
  [/condom/i, "condominio"],
  [/iptu/i, "iptu"],
  [/vai morar/i, "vaiMorar"],
  [/^cpf do morador/i, "moradorCpf"],
  [/^nome completo do morador/i, "moradorNome"],
  [/^parentesco/i, "moradorParentesco"],
];
function campoDoFaltante(rotulo: string): CampoCredito | null {
  return FALTANTE.find(([re]) => re.test(rotulo))?.[1] ?? null;
}
const lista = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// ─── Intercepto ──────────────────────────────────────────────────────────

const NUCLEO = new RegExp(
  String.raw`\b(?:(?:analise|consulta|avaliacao|aprovacao)\s+(?:de\s+)?credito|ficha\s+(?:de\s+)?credito` +
  String.raw`|credito\s+(?:do|da|de|dos|das)\s+\w+|(?:analis|consult|avali|aprov|verific|pux|rod)\w*\s+(?:o\s+)?credito|upestate|score)\b`
);
/** "Como está a análise da Letícia?" — análise de pessoa, sem a palavra crédito. */
const STATUS_SEM_CREDITO =
  /^(?:e\s+)?(?:como (?:esta|anda|ficou|ta|vai)|qual (?:e )?o (?:status|resultado)(?: d[ao])?|e)\s+(?:a\s+)?analise\s+(?:da|do|de)\s+(?!proposta|contrato|document|matricula|certid|imovel|minuta)\w+/;
const APROVAR = /^(?:(?:pode|ja|entao|so)\s+)?aprov(?:a|e|ar)\b/;
/** Dentro da ficha, a forma solta também vale: "aprova aí", "aprova ela". */
const APROVAR_SOLTO = /^(?:(?:pode|ja|entao|so)\s+)?aprov(?:a|e|ar)\s+(?:ai|la|logo|isso|ela|ele|agora|direto|mesmo)\b/;
const EXCLUI = /\b(carta de credito|cartao de credito|consorcio|financiamento|credito imobiliario|credito habitacional)\b/;
const NEGACAO = /\b(nao|nunca|jamais)\b/;
const STATUS = /\b(como (?:esta|anda|ficou|ta|vai)|status|situacao|andamento|saiu|resultado|deu (?:certo|o que)|ja (?:foi|saiu|voltou|aprovou|tem)|foi aprovad\w*|aprovou|reprovou|recusad\w*|retorno)\b/;
const PROCESSO = /^(como (?:funciona|faz|e|fazer|pedir|solicit\w*)|o que|oq|quanto|qual|quais|por que|porque|pra que|para que|precisa|da pra|da para|posso|tem como|e possivel|quem|onde)\b/;
const PEDIDO = /\b(fa[zc]\w*|abr\w+|inici\w+|comec\w+|quero|preciso|pode|consegue|rod\w+|pux\w+|consult\w*|analis\w*|avali\w*|verific\w*|ped\w+|solicit\w+|mand\w+|cri\w+|nov[ao]|preench\w+|cadastr\w+|ficha)\b/;

/**
 * O pedido é de crédito? `abrir` (ficha nova), `status` (análise existente),
 * `score` (recusa fixa) ou `null` — negação e pergunta de processo ("como
 * funciona a análise de crédito?") seguem para o atendimento normal.
 */
export function pedeCredito(texto: string): "abrir" | "status" | "score" | "aprovar" | null {
  const t = normalizar(texto).replace(/^max\b[\s,:-]*/, "").trim();
  // "Aprova aí (o crédito do João)": o Max não decide crédito.
  // Fora da ficha, só com "crédito" na frase ("aprova a proposta do João" não é crédito).
  if (APROVAR.test(t) && !NEGACAO.test(t) && /\bcredito\b/.test(t)) return "aprovar";
  const nucleo = NUCLEO.test(t);
  if (!nucleo && !STATUS_SEM_CREDITO.test(t)) return null;
  if (EXCLUI.test(t) || NEGACAO.test(t)) return null;
  if (/\bscore\b/.test(t)) return "score";
  // "Faz a análise de crédito do Pedro Recusado": com verbo de pedido fora do nome, a palavra
  // de status dentro do nome não conta. Sem verbo ("crédito do João recusado?") segue status.
  const citado = nomeCitado(texto);
  const semNome = citado ? t.replace(normalizar(citado), " ") : t;
  const statusAlvo = semNome !== t && PEDIDO.test(semNome) ? semNome : t;
  if (STATUS.test(statusAlvo) || STATUS_SEM_CREDITO.test(t)) return "status";
  if (PROCESSO.test(t)) return null;
  if (PEDIDO.test(t)) return "abrir";
  return /\bcredito\s+(?:do|da|de|dos|das)\s+\w+/.test(t) ? "status" : "abrir";
}

const GENERICOS = new Set([
  "locatario", "locataria", "inquilino", "inquilina", "pretendente", "cliente", "proposta", "imovel", "apartamento",
  "apto", "casa", "contrato", "lead", "cara", "moca", "rapaz", "senhor", "senhora", "dele", "dela", "pessoa", "credito",
  "candidato", "candidata", "interessado", "interessada", "morador", "moradora", "inquilinos", "clientes", "pretendentes",
]);
/** Antes do nome: "de um inquilino", "da minha cliente", "do novo locatário" — não fazem parte do nome. */
const DETERMINANTES = new Set(["um", "uma", "meu", "minha", "nosso", "nossa", "esse", "essa", "este", "esta", "novo", "nova", "outro", "outra"]);
const PARADA = new Set([
  "que", "pra", "para", "na", "no", "nos", "nas", "com", "por", "pelo", "pela", "ai", "agora", "hoje", "ou", "ja",
  "saiu", "foi", "esta", "ta", "ficou", "aprovou", "favor", "pf", "pfv", "upestate", "e", "prop", "cpf",
]);

/** O nome citado depois de "crédito/análise/ficha … do/da/de" — ou null. */
export function nomeCitado(texto: string): string | null {
  const m = /(?:cr[ée]dito|an[áa]lise|ficha)\s+(?:de\s+cr[ée]dito\s+)?(?:d[oa]s?|de)\s+([\p{L}'-]+(?:\s+[\p{L}'-]+){0,5})/iu.exec(texto);
  if (!m) return null;
  const palavras: string[] = [];
  const brutas = m[1]!.split(/\s+/);
  while (brutas.length && DETERMINANTES.has(normalizar(brutas[0]!))) brutas.shift();
  for (const p of brutas) {
    const n = normalizar(p);
    if (PARADA.has(n)) break;
    palavras.push(p);
  }
  while (palavras.length && CONECTORES.has(normalizar(palavras[palavras.length - 1]!))) palavras.pop();
  if (!palavras.length || GENERICOS.has(normalizar(palavras[0]!))) return null;
  return palavras.map((p) => (CONECTORES.has(p.toLowerCase()) ? p.toLowerCase() : p[0]!.toUpperCase() + p.slice(1))).join(" ");
}

// ─── Início ──────────────────────────────────────────────────────────────

function resposta(fluxo: FluxoCredito | null, reply: string, evento: string): Resposta {
  return { fluxo, reply, evento };
}

function gatePolitica(ctx: ContextoDoTurno, podeEscrever: boolean, cap: "credit.request" | "credit.read"): Resposta | null {
  if (!podeEscrever) return resposta(null, TEXTO_CREDITO_SEM_POLITICA, "credito_sem_usuario");
  if (ctx.politicaIndisponivel) return resposta(null, TEXTO_POLITICA_INDISPONIVEL, "credito_politica_indisponivel");
  if (!ctx.policy.includes(cap)) return resposta(null, TEXTO_CREDITO_SEM_POLITICA, "credito_sem_politica");
  return null;
}

/** "Faz a ficha de crédito da Letícia": gate → atestação. Nada é gravado antes do SIM. */
export async function iniciarCredito(ctx: ContextoDoTurno, deps: DepsDoFluxo, podeEscrever: boolean): Promise<Resposta> {
  const barrado = gatePolitica(ctx, podeEscrever, "credit.request");
  if (barrado) return barrado;

  const t = normalizar(ctx.texto);
  if (/\b(pj|cnpj|pessoa juridica|empresa|comercial)\b/.test(t)) {
    return resposta(null, `PJ/comercial é pela tela do lead: ${linkDoLead()}`, "credito_pj");
  }

  // Proposta citada pelo código: o id vem da busca (o preflight aceita só o id).
  let propostaId: string | undefined;
  const codigo = codigoCitado(ctx.texto);
  if (codigo && ctx.policy.includes("proposal.list")) {
    const r = await deps.acao("proposal.status", { codigo });
    const p = r?.status === 200 && r.body.proposta && typeof r.body.proposta === "object" ? (r.body.proposta as Record<string, unknown>) : null;
    if (typeof p?.id === "string") propostaId = p.id;
  }

  const pre = await deps.acao("credit.preflight", propostaId ? { proposalId: propostaId } : {});
  if (!pre) return resposta(null, TEXTO_SEM_RESPOSTA, "credito_preflight_sem_resposta");
  if (pre.status === 403) return resposta(null, TEXTO_CREDITO_SEM_POLITICA, "credito_preflight_403");
  if (pre.status !== 200) return resposta(null, TEXTO_SEM_RESPOSTA, `credito_preflight_${pre.status}`);
  if (pre.body.configurado !== true || pre.body.orgLigada !== true) {
    return resposta(null, textoInativa(ctx.orgName ?? "sua imobiliária"), "credito_inativo");
  }

  const prefill = pre.body.propostaPrefill && typeof pre.body.propostaPrefill === "object" ? (pre.body.propostaPrefill as Record<string, unknown>) : {};
  const nome = nomeCitado(ctx.texto) ?? (typeof prefill.nome === "string" && prefill.nome.trim() ? prefill.nome.trim() : undefined);
  const f: FluxoCredito = {
    kind: "credito", etapa: "atestacao", tentativas: 0, atualizadoEm: ctx.agora,
    ...(nome ? { leadNome: nome } : {}), ...(propostaId ? { propostaId } : {}),
  };
  return resposta(f, textoAtestacao(nome), "credito_atestacao");
}

// ─── Status ──────────────────────────────────────────────────────────────

function dataBr(v: unknown): string | null {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

/** "Como está a análise da Letícia?" → `credit.status`, resposta do sistema. */
export async function responderStatusCredito(ctx: ContextoDoTurno, deps: DepsDoFluxo, podeEscrever: boolean): Promise<Resposta> {
  const barrado = gatePolitica(ctx, podeEscrever, "credit.read");
  if (barrado) return barrado;
  const { cpfs } = documentosNoTexto(ctx.texto);
  const cpf = cpfs.find(cpfValido);
  const nome = nomeCitado(ctx.texto);
  if (!cpf && !nome) {
    return resposta(null, 'De quem é a análise? Me diga o nome, por exemplo: "como está a análise de crédito da Letícia?"', "credito_status_sem_alvo");
  }
  const alvo = nome ?? mascararCpf(cpf!);
  const r = await deps.acao("credit.status", cpf ? { cpf } : { nome });
  if (!r) return resposta(null, TEXTO_SEM_RESPOSTA, "credito_status_sem_resposta");
  if (r.status === 404) return resposta(null, `Não achei análise de crédito de ${alvo}.`, "credito_status_404");
  if (r.status === 403) return resposta(null, TEXTO_CREDITO_SEM_POLITICA, "credito_status_403");
  if (r.status !== 200) return resposta(null, TEXTO_SEM_RESPOSTA, `credito_status_${r.status}`);
  const lead = (r.body.lead && typeof r.body.lead === "object" ? r.body.lead : {}) as Record<string, unknown>;
  const quemE = typeof lead.nome === "string" && lead.nome ? lead.nome : alvo;
  const url = typeof r.body.link === "string" ? link(r.body.link) : linkDoLead(typeof lead.id === "string" ? lead.id : undefined);
  const ultima = r.body.ultima && typeof r.body.ultima === "object" ? (r.body.ultima as Record<string, unknown>) : null;
  if (!ultima) return resposta(null, `${quemE}: ficha em rascunho, sem análise enviada. ${url}`, "credito_status_rascunho");
  const rotulo = typeof ultima.rotulo === "string" && ultima.rotulo ? ultima.rotulo : "em andamento";
  const data = dataBr(ultima.completedAt) ?? dataBr(ultima.createdAt);
  return resposta(null, `${quemE}: ${rotulo}${data ? ` desde ${data}` : ""}. ${url}`, "credito_status");
}

// ─── Condução ────────────────────────────────────────────────────────────

const CORRIGIR: [RegExp, CampoCredito][] = [
  [/\bcpf\b/, "cpf"], [/\bnome\b/, "nome"], [/\b(vinculo|trabalho)\b/, "vinculo"], [/\bprofissao\b/, "profissao"],
  [/\b(renda|salario)\b/, "renda"], [/\baluguel\b/, "aluguel"], [/\bcondominio\b/, "condominio"], [/\biptu\b/, "iptu"],
  [/\bmorador\b/, "moradorNome"], [/\b(morar|moradia)\b/, "vaiMorar"],
];
function pedeCorrecao(texto: string): CampoCredito | null {
  const t = normalizar(texto);
  if (!/^(corrig\w*|corrij\w*|troc\w*|mud\w*|alter\w*|errei)\b/.test(t)) return null;
  return CORRIGIR.find(([re]) => re.test(t))?.[1] ?? null;
}
const CAMPOS_DE_VALOR: [RegExp, CampoCredito][] = [
  [/^(a |o )?(renda|salario)\b/, "renda"], [/^(o )?aluguel\b/, "aluguel"], [/^(o )?condominio\b/, "condominio"], [/^(o )?iptu\b/, "iptu"],
];
/** A resposta começa nomeando OUTRO campo de valor ("renda é 8.500" quando a pergunta é o aluguel)? */
function campoDeValorNomeado(texto: string, atual: CampoCredito): CampoCredito | null {
  if (BASE[atual] !== "valor") return null;
  const t = normalizar(texto);
  if (!/\d/.test(t)) return null;
  const achado = CAMPOS_DE_VALOR.find(([re]) => re.test(t))?.[1] ?? null;
  return achado && achado !== atual ? achado : null;
}
const PERGUNTA_FORA = /\?\s*$|^(como|quando|onde|por que|porque|o que|qual|quais|quanto|quem|me (fala|diz|explica)|tem como)\b/;

function cancelar(f: FluxoCredito): Resposta {
  if (f.chave) {
    return resposta(null, `Parei. Se o envio chegou à Upestate, o resultado aparece na tela: ${linkDoLead(f.leaseClientId)}`, "credito_cancelado_envio_incerto");
  }
  if (f.etapa === "resultado") return resposta(null, `Certo. A análise fica na tela do lead: ${linkDoLead(f.leaseClientId)}`, "credito_resultado_encerrado");
  return f.leaseClientId
    ? resposta(null, `Parei. A ficha ${deQuem(f)} fica salva como rascunho na tela.`, "credito_cancelado")
    : resposta(null, "Parei. Nada foi salvo.", "credito_cancelado");
}

function pausar(f: FluxoCredito): PassoDoFluxo {
  return { liberar: true, fluxo: { ...f, pausado: true }, evento: "credito_pausado" };
}

function perguntar(f: FluxoCredito, campo: CampoCredito, ctx: ContextoDoTurno, prefixo = ""): Resposta {
  // Mexer na ficha desfaz o "consultar de novo": o próximo SIM volta a conferir a análise recente.
  const g: FluxoCredito = { ...f, etapa: "coleta", campoAtual: campo, tentativas: 0, pausado: false, novaConsulta: undefined, atualizadoEm: ctx.agora };
  return resposta(g, `${prefixo}${pergunta(g, campo)}`, `credito_pergunta_${campo}`);
}

async function resumoDaFicha(f: FluxoCredito, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<Resposta> {
  const c = abrirCofre(f, ctx);
  const tenho = [
    c.cpf ? `CPF ${mascararCpf(c.cpf)}` : "",
    f.leadNome ?? "",
    c.vinculo ? VINCULO[c.vinculo]! : "",
    c.renda !== undefined ? `renda ${brl(c.renda)}` : "",
    c.aluguel !== undefined ? `aluguel ${brl(c.aluguel)}` : "",
    f.solidarios ? `${f.solidarios} pessoa(s) compondo renda` : "",
  ].filter(Boolean);
  let falta: string[] = [];
  if (f.leaseClientId) {
    const r = await deps.acao("credit.preflight", { leaseClientId: f.leaseClientId });
    if (r?.status === 200) falta = lista(r.body.faltantes);
  }
  const atual = f.etapa === "coleta" && f.campoAtual ? `\n\n${pergunta(f, f.campoAtual)}` : f.etapa === "revisao" ? "\n\nResponda *SIM* para enviar." : "";
  return resposta({ ...f, atualizadoEm: ctx.agora },
    `Ficha ${deQuem(f)}:\n• Já tenho: ${tenho.length ? tenho.join(", ") : "nada ainda"}.` +
    (falta.length ? `\n• Falta: ${falta.join(", ").toLowerCase()}.` : "") + atual,
    "credito_resumo");
}

/** Próximo passo depois de um campo aceito: faltante do servidor, solidários, revisão. */
async function seguir(f: FluxoCredito, faltantes: string[], ctx: ContextoDoTurno, deps: DepsDoFluxo, prefixo: string): Promise<Resposta> {
  const campos = faltantes.map(campoDoFaltante).filter((c): c is CampoCredito => !!c);
  if (campos.length) return perguntar(f, campos[0]!, ctx, prefixo);
  if (!f.solidariosEncerrados && (f.solidarios ?? 0) < 3) return perguntar(f, "maisSolidario", ctx, prefixo);
  return revisar({ ...f, solidariosEncerrados: true }, ctx, deps, prefixo);
}

async function revisar(f: FluxoCredito, ctx: ContextoDoTurno, deps: DepsDoFluxo, prefixo = ""): Promise<Resposta> {
  if (!f.leaseClientId) return perguntar(f, "cpf", ctx, prefixo);
  const r = await deps.acao("credit.preflight", { leaseClientId: f.leaseClientId });
  if (!r || r.status !== 200) return resposta({ ...f, etapa: "coleta", campoAtual: undefined, atualizadoEm: ctx.agora }, TEXTO_SEM_RESPOSTA, "credito_revisao_sem_resposta");
  const faltantes = lista(r.body.faltantes);
  if (faltantes.length) return voltarAoFaltante(f, faltantes, ctx, prefixo);
  const c = abrirCofre(f, ctx);
  const lead = r.body.lead && typeof r.body.lead === "object" ? (r.body.lead as Record<string, unknown>) : {};
  const nomeDoLead = typeof lead.nome === "string" && lead.nome.trim() ? lead.nome.trim() : undefined;
  const nome = f.leadNome ?? nomeDoLead ?? "o pretendente";
  // Lead achado pelo CPF: o nome veio do servidor e passa a valer nas mensagens seguintes.
  if (!f.leadNome && nomeDoLead) f = { ...f, leadNome: nomeDoLead };
  const partes = [
    c.aluguel !== undefined ? `Aluguel ${brl(c.aluguel)}` : "",
    c.renda !== undefined ? `renda ${brl(c.renda)}` : "",
    c.vinculo ? VINCULO[c.vinculo]! : "",
    f.solidarios ? `${f.solidarios} pessoa(s) compondo renda` : "",
  ].filter(Boolean);
  const custo = typeof r.body.custoCents === "number" ? ` Custo ${brl(r.body.custoCents / 100)}.` : "";
  const texto =
    `${prefixo}Vou consultar ${nome}${c.cpf ? ` (CPF ${mascararCpf(c.cpf)})` : ""} na Upestate pela ${ctx.orgName ?? "sua imobiliária"}.` +
    (partes.length ? ` ${partes.join(", ")}.` : "") + `${custo} Responda *SIM* para enviar.`;
  return resposta({ ...f, etapa: "revisao", campoAtual: undefined, tentativas: 0, pausado: false, atualizadoEm: ctx.agora }, texto, "credito_revisao");
}

/** A ficha ainda tem faltantes (servidor): volta à coleta do primeiro. */
function voltarAoFaltante(f: FluxoCredito, faltantes: string[], ctx: ContextoDoTurno, prefixo = ""): Resposta {
  const g: FluxoCredito = { ...f, chave: undefined, decisao: undefined };
  const campo = faltantes.map(campoDoFaltante).find((c): c is CampoCredito => !!c);
  const aviso = `${prefixo}Ainda falta: ${faltantes.join(", ").toLowerCase()}.\n`;
  if (campo) return perguntar(g, campo, ctx, aviso);
  return resposta({ ...g, etapa: "coleta", campoAtual: undefined, atualizadoEm: ctx.agora }, `${aviso}Complete pela tela: ${linkDoLead(f.leaseClientId)}`, "credito_faltante_desconhecido");
}

/** O patch de `dataJson.credito` deste campo — só ele, nunca a ficha inteira. */
function patchDoCampo(campo: CampoCredito, valor: string | number, c: Cofre): Record<string, unknown> {
  switch (campo) {
    case "cpf": return { pretendente: { documento: valor } };
    case "nome": return { pretendente: { nomeCompleto: valor } };
    case "vinculo": return { pretendente: { vinculoEmpregaticio: valor } };
    case "profissao": return { pretendente: { profissao: valor } };
    case "renda": return { pretendente: { rendaMensal: valor } };
    case "aluguel": return { locacao: { valorAluguel: valor } };
    case "condominio": return { locacao: { valorCondominio: valor } };
    case "iptu": return { locacao: { valorIptu: valor } };
    case "vaiMorar": return { locacao: { vaiMorar: valor } };
    case "moradorCpf": return { morador: { documento: valor } };
    case "moradorNome": return { morador: { nomeCompleto: valor } };
    case "moradorParentesco": return { morador: { parentesco: valor } };
    // O servidor substitui o array inteiro: vai a lista toda, com o solidário em curso.
    default: return { solidarios: c.solidarios ?? [] };
  }
}

const CAMPO_DO_SOLIDARIO: Partial<Record<CampoCredito, keyof Solidario>> = {
  solCpf: "documento", solNome: "nomeCompleto", solVinculo: "vinculoEmpregaticio", solProfissao: "profissao", solRenda: "rendaMensal",
};
const PROXIMO_DO_SOLIDARIO: Partial<Record<CampoCredito, CampoCredito>> = {
  solCpf: "solNome", solNome: "solVinculo", solVinculo: "solProfissao", solProfissao: "solRenda",
};

/** Grava o campo aceito (`lead.upsert`) e segue. Falha não avança nem perde o que já estava salvo. */
async function gravar(
  f: FluxoCredito, campo: CampoCredito, valor: string | number, ctx: ContextoDoTurno, deps: DepsDoFluxo,
  extras?: Partial<Record<CampoCredito, number>>,
): Promise<Resposta> {
  const c = abrirCofre(f, ctx);
  const g: FluxoCredito = { ...f };
  if (campo === "cpf") c.cpf = String(valor);
  if (campo === "nome") g.leadNome = String(valor);
  if (campo === "renda") c.renda = Number(valor);
  if (campo === "aluguel") c.aluguel = Number(valor);
  if (campo === "vinculo") c.vinculo = Number(valor);
  const chaveSol = CAMPO_DO_SOLIDARIO[campo];
  if (chaveSol) {
    const sols = [...(c.solidarios ?? [])];
    const i = f.solidarios ?? 0;
    sols[i] = { ...(sols[i] ?? {}), [chaveSol]: valor };
    c.solidarios = sols;
  }
  if (!c.cpf) return perguntar({ ...g, cofre: undefined }, "cpf", ctx);

  let campos: Record<string, unknown> = { v: 1, tipo: "residencial", ...patchDoCampo(campo, valor, c) };
  // Valores que vieram junto ("aluguel 3 mil, condomínio 800"): mesma escrita.
  for (const [k, v] of Object.entries(extras ?? {}) as [CampoCredito, number][]) {
    const p = patchDoCampo(k, v, c) as Record<string, Record<string, unknown>>;
    for (const [g, obj] of Object.entries(p)) campos[g] = { ...((campos[g] as object) ?? {}), ...obj };
    if (k === "aluguel") c.aluguel = v;
  }
  let nome = campo === "nome" ? String(valor) : undefined;
  // Lead ainda não existe: o nome citado (ou o da proposta) vai junto; a proposta completa o prefill.
  if (!f.leaseClientId) {
    if (!nome && g.leadNome && nomeValido(g.leadNome)) nome = g.leadNome;
    if (f.propostaId) {
      const pre = await deps.acao("credit.preflight", { proposalId: f.propostaId });
      const p = pre?.status === 200 && pre.body.propostaPrefill && typeof pre.body.propostaPrefill === "object" ? (pre.body.propostaPrefill as Record<string, unknown>) : {};
      const locacao: Record<string, number> = {};
      if (typeof p.aluguel === "number") { locacao.valorAluguel = p.aluguel; c.aluguel = p.aluguel; }
      if (typeof p.condominio === "number") locacao.valorCondominio = p.condominio;
      if (typeof p.iptu === "number") locacao.valorIptu = p.iptu;
      if (Object.keys(locacao).length) campos = { ...campos, locacao: { ...locacao, ...((campos.locacao as object) ?? {}) } };
      if (!nome && typeof p.nome === "string" && nomeValido(p.nome)) nome = p.nome;
    }
    // O 1º upsert cria o lead: CPF (e nome) entram também na ficha, senão voltariam como faltantes.
    campos = { ...campos, pretendente: { documento: c.cpf, ...(nome ? { nomeCompleto: nome } : {}), ...((campos.pretendente as object) ?? {}) } };
  }
  const args: Record<string, unknown> = {
    cpf: c.cpf, campos, ...(nome ? { nome } : {}), ...(f.consentimento ? { consentimento: f.consentimento } : {}),
  };
  let cofre: string;
  try {
    cofre = fecharCofre(c, ctx);
  } catch {
    return resposta(f, TEXTO_SEM_RESPOSTA, "credito_cofre_indisponivel");
  }
  const r = await deps.acao("lead.upsert", args, `${ctx.messageId}:${campo}`);
  if (!r) return resposta({ ...f, atualizadoEm: ctx.agora }, `Não consegui salvar agora. Manda de novo em instantes.\n${pergunta(f, campo)}`, "credito_upsert_sem_resposta");
  const anotado = `Anotei: ${[eco(campo, valor), ...Object.entries(extras ?? {}).map(([k, v]) => eco(k as CampoCredito, v as number))].join(", ")}.\n`;
  if (r.status === 422 && r.body.error === "nome_obrigatorio") {
    return perguntar({ ...g, cofre }, "nome", ctx, anotado);
  }
  if (r.status === 422 && r.body.error === "documento_invalido") {
    return resposta({ ...f, atualizadoEm: ctx.agora }, `Esse CPF não confere. ${pergunta(f, campo)}`, "credito_documento_invalido");
  }
  if (r.status === 404) {
    return resposta({ ...f, cofre: undefined, campoAtual: "cpf", atualizadoEm: ctx.agora },
      `Não consegui abrir a ficha desse CPF pelo ${nomeDoAgente()}. Confira o número ou use a tela: ${linkDoLead()}`, "credito_upsert_404");
  }
  if (r.status === 403) return resposta(null, TEXTO_CREDITO_SEM_POLITICA, "credito_upsert_403");
  if (r.status !== 200 && r.status !== 201) {
    return resposta({ ...f, atualizadoEm: ctx.agora }, `O sistema não aceitou esse dado. ${pergunta(f, campo)}`, `credito_upsert_${r.status}`);
  }

  const salvo: FluxoCredito = {
    ...g, cofre, tentativas: 0, atualizadoEm: ctx.agora,
    ...(typeof r.body.id === "string" ? { leaseClientId: r.body.id } : {}),
  };
  if (campo === "solRenda") {
    const n = (f.solidarios ?? 0) + 1;
    const fim = n >= 3;
    return seguir({ ...salvo, solidarios: n, solidariosEncerrados: fim }, [], ctx, deps, anotado);
  }
  const proxSol = PROXIMO_DO_SOLIDARIO[campo];
  if (proxSol) return perguntar(salvo, proxSol, ctx, anotado);
  // Correção feita na revisão volta direto para ela (o servidor ainda decide o que falta).
  return seguir(salvo, lista(r.body.faltantes), ctx, deps, anotado);
}

export async function conduzirCredito(f: FluxoCredito, ctx: ContextoDoTurno, deps: DepsDoFluxo, podeEscrever = true): Promise<PassoDoFluxo> {
  const t = normalizar(ctx.texto);
  const confirmacao = lerConfirmacao(ctx.texto);
  if (/^(cancela|cancelar|desisto|desistir|para|parar|pare)$/.test(t) || /\b(cancela a ficha|desisto|nao quero mais)\b/.test(t)) {
    return cancelar(f);
  }
  const barrado = gatePolitica(ctx, podeEscrever, "credit.request");
  if (barrado) return { ...barrado, fluxo: ctx.politicaIndisponivel ? { ...f, atualizadoEm: ctx.agora } : null };

  // Status, score ou "aprova aí" no meio da ficha: resposta fixa, e a ficha continua.
  const outro = pedeCredito(ctx.texto) ?? (APROVAR_SOLTO.test(t) && !NEGACAO.test(t) ? "aprovar" : null);
  if (outro === "status" || outro === "score" || outro === "aprovar") {
    const r = outro === "status"
      ? await responderStatusCredito(ctx, deps, podeEscrever)
      : resposta(null, outro === "score" ? TEXTO_SCORE : TEXTO_APROVAR, `credito_${outro}`);
    const g: FluxoCredito = { ...f, atualizadoEm: ctx.agora };
    return resposta(g, `${r.reply}\n\n${continuacaoCredito(g)}`, `${r.evento}_na_ficha`);
  }

  if (f.etapa === "enviando") return conferirEnvio(f, ctx, deps);
  if (f.etapa === "resultado") return desdobrarResultado(f, ctx, deps);

  if (f.etapa === "atestacao") {
    if (confirmaEstrito(ctx.texto)) {
      const g: FluxoCredito = { ...f, consentimento: { texto: TEXTO_ATESTACAO, messageId: ctx.messageId } };
      // Atestação refeita depois de um 412 (M3): a ficha já existe, volta ao resumo.
      if (f.leaseClientId) return revisar(g, ctx, deps, "Obrigado. ");
      return perguntar(g, "cpf", ctx, "Obrigado. ");
    }
    if (confirmacao === "nao") return resposta(null, TEXTO_NAO_AUTORIZOU, "credito_sem_autorizacao");
    if (PERGUNTA_FORA.test(t) || /\?\s*$/.test(ctx.texto)) return pausar(f);
    return resposta({ ...f, atualizadoEm: ctx.agora }, `Preciso dessa confirmação antes de qualquer dado. ${textoAtestacao(f.leadNome)}`, "credito_atestacao_repetida");
  }

  if (/^(resumo|ver resumo|mostra o resumo|o que voce ja tem)$/.test(t)) return resumoDaFicha(f, ctx, deps);
  const correcao = pedeCorrecao(ctx.texto);
  if (correcao === "cpf") {
    return resposta({ ...f, atualizadoEm: ctx.agora },
      `O CPF identifica a ficha e não muda por aqui. Para outro CPF, diga CANCELAR e comece de novo, ou corrija na tela: ${linkDoLead(f.leaseClientId)}`,
      "credito_corrigir_cpf");
  }
  if (correcao) return perguntar({ ...f, solidariosEncerrados: f.etapa === "revisao" ? true : f.solidariosEncerrados }, correcao, ctx);

  if (f.etapa === "revisao") {
    // Mesmo SIM estrito da atestação: o M3 envia aqui (consulta sobre a pessoa — nunca em dobro).
    if (confirmaEstrito(ctx.texto)) {
      // Sub-flag desligada: o comportamento do M2 (nada é enviado).
      if (!envioLigado()) {
        return resposta(null, `Envio entra na próxima versão; a ficha está salva: ${linkDoLead(f.leaseClientId)}`, "credito_envio_m3");
      }
      return enviar(f, ctx, deps);
    }
    if (confirmacao === "nao") return cancelar(f);
    return pausar(f);
  }

  // Coleta. Sem campo (pausa da revisão, falha no preflight): o servidor diz o que falta.
  if (!f.campoAtual) {
    if (PERGUNTA_FORA.test(t)) return pausar(f);
    return revisar(f, ctx, deps);
  }
  const nomeado = campoDeValorNomeado(ctx.texto, f.campoAtual);
  if (nomeado) {
    // "renda é 8.500" na pergunta do aluguel: grava na renda e volta ao aluguel (o servidor diz o que falta).
    const ro = await interpretarCampo(nomeado, ctx.texto, async (texto, c) => (deps.extrairCredito ? deps.extrairCredito(texto, c) : null));
    if (ro.tipo === "ok") return gravar(f, nomeado, ro.valor, ctx, deps, ro.extras);
  }
  const campo = f.campoAtual;
  const extrair: ExtratorDeCampo = async (texto, c) => (deps.extrairCredito ? deps.extrairCredito(texto, c) : null);
  const r = await interpretarCampo(campo, ctx.texto, extrair);
  if (r.tipo === "pj") {
    return resposta(null, `PJ/comercial é pela tela do lead: ${linkDoLead(f.leaseClientId)}`, "credito_pj");
  }
  if (r.tipo === "vazio") {
    if (PERGUNTA_FORA.test(t) || ctx.texto.length > 60) return pausar(f);
    return falhou(f, campo, "Não entendi.", ctx);
  }
  if (r.tipo === "erro") return falhou(f, campo, r.texto, ctx);

  if (campo === "maisSolidario") {
    if (r.valor === "sim") return perguntar(f, "solCpf", ctx);
    return revisar({ ...f, solidariosEncerrados: true }, ctx, deps);
  }
  return gravar(f, campo, r.valor, ctx, deps, r.extras);
}

function falhou(f: FluxoCredito, campo: CampoCredito, motivo: string, ctx: ContextoDoTurno): Resposta {
  const tentativas = f.tentativas + 1;
  const g: FluxoCredito = { ...f, tentativas: tentativas >= 3 ? 0 : tentativas, atualizadoEm: ctx.agora };
  const texto = tentativas >= 3 ? `${TEXTO_TENTATIVAS}\n${pergunta(f, campo)}` : `${motivo} ${pergunta(f, campo)}`;
  return resposta(g, texto, `credito_invalido_${campo}`);
}

// ─── Envio e resultado (M3) ──────────────────────────────────────────────

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const urlDoLead = (f: FluxoCredito, body?: Record<string, unknown>) => {
  const rel = str(body?.leadLink);
  return rel ? link(rel) : linkDoLead(f.leaseClientId);
};

// A justificativa da Upestate (texto livre do provedor) NUNCA é lida aqui:
// o resultado é rótulo + link do lead; o detalhe mora na tela.

const ROTULO_PADRAO: Record<string, string> = { aprovado: "Aprovado", revisao: "Em revisão", reprovado: "Reprovado", pendencia: "Pendência", erro: "Erro" };

const DIA_MS = 24 * 3600_000;
const EM_VOO = new Set(["pending", "submitting", "processing"]);

function instante(v: unknown): number | null {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}
const diaMes = (t: number) => new Date(t).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });

/** A última análise do lead impede um envio novo? (recente, em voo ou reenvio arriscado) */
function analiseQueBarra(ultima: Record<string, unknown>, agora: number): { rotulo: string; em: number | null; soRecente: boolean } | null {
  if (!Object.keys(ultima).length) return null;
  const em = instante(ultima.createdAt);
  const recente = em !== null && agora - em < DIA_MS;
  const emVoo = EM_VOO.has(String(ultima.status ?? "")) || ultima.decision === "pendente";
  const arriscado = ultima.reenvioArriscado === true;
  if (!recente && !emVoo && !arriscado) return null;
  return { rotulo: str(ultima.rotulo) ?? "em andamento", em, soRecente: !emVoo && !arriscado };
}

/**
 * Revisão + SIM estrito com `MAX_CREDITO_ENVIO`: preflight → status (análise
 * recente/em voo barra) → `credit.request` com a `messageId` do SIM como
 * chave. A análise não tem custo (12/10); o cuidado é não fazer consulta
 * duplicada sobre a pessoa: sem resposta (timeout/5xx) a chave fica e o Max
 * NUNCA reenvia sozinho.
 */
async function enviar(f: FluxoCredito, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  // Já houve um SIM para este resumo: nunca um segundo envio.
  if (f.chave) return conferirEnvio(f, ctx, deps);
  if (!f.leaseClientId) return perguntar(f, "cpf", ctx);
  const naoEnviado = (evento: string) => resposta({ ...f, atualizadoEm: ctx.agora }, `${TEXTO_SEM_RESPOSTA} Nada foi enviado.`, evento);

  const pre = await deps.acao("credit.preflight", { leaseClientId: f.leaseClientId });
  if (!pre) return naoEnviado("credito_envio_preflight_sem_resposta");
  if (pre.status === 403) return resposta(null, TEXTO_CREDITO_SEM_POLITICA, "credito_envio_preflight_403");
  if (pre.status !== 200) return naoEnviado(`credito_envio_preflight_${pre.status}`);
  if (pre.body.configurado !== true || pre.body.orgLigada !== true) {
    return resposta(null, textoInativa(ctx.orgName ?? "sua imobiliária"), "credito_inativo");
  }
  const nomeDoLead = str(obj(pre.body.lead).nome);
  if (!f.leadNome && nomeDoLead) f = { ...f, leadNome: nomeDoLead };
  const faltantes = lista(pre.body.faltantes);
  if (faltantes.length) return voltarAoFaltante(f, faltantes, ctx);

  // Análise recente (< 24 h), em voo ou com reenvio arriscado: não consulta a pessoa de novo.
  const st = await deps.acao("credit.status", { leaseClientId: f.leaseClientId });
  if (!st || (st.status !== 200 && st.status !== 404)) return naoEnviado("credito_envio_status_sem_resposta");
  const barra = st.status === 200 ? analiseQueBarra(obj(st.body.ultima), ctx.agora) : null;
  if (barra && !(barra.soRecente && f.novaConsulta)) {
    const quando = barra.em !== null ? ` de ${diaMes(barra.em)}` : "";
    const base = `Já existe uma análise ${deQuem(f)}${quando}: ${barra.rotulo}. Veja na tela: ${linkDoLead(f.leaseClientId)}`;
    if (barra.soRecente) {
      // Concluída e recente: o corretor decide. Só o próximo SIM estrito consulta de novo; NÃO encerra.
      const g: FluxoCredito = { ...f, etapa: "revisao", novaConsulta: true, pausado: false, atualizadoEm: ctx.agora };
      return resposta(g, `${base}\n\nQuer fazer uma consulta nova mesmo assim? Responda *SIM*.`, "credito_envio_oferece_nova");
    }
    return resposta(null, base, "credito_envio_ja_existe");
  }

  const chave = { verbo: "credit.request", valor: ctx.messageId, em: ctx.agora };
  const emCurso: FluxoCredito = { ...f, etapa: "enviando", chave, pausado: false, atualizadoEm: ctx.agora };
  const args: Record<string, unknown> = { leaseClientId: f.leaseClientId, ...(f.consentimento ? { consentimento: f.consentimento } : {}) };
  const r = await deps.acao("credit.request", args, chave.valor);
  // Timeout/5xx: o servidor pode ter enviado. A chave fica e o Max nunca
  // reenvia — o status (ou o aviso `credit_result`, se o pedido chegou) diz o desfecho.
  if (!r) return resposta(emCurso, textoEnvioIncerto(linkDoLead(f.leaseClientId)), "credito_envio_incerto");
  return traduzirEnvio(f, r, ctx);
}

function traduzirEnvio(f: FluxoCredito, r: { status: number; body: Record<string, unknown> }, ctx: ContextoDoTurno): Resposta {
  const url = urlDoLead(f, r.body);
  const erro = str(r.body.error);
  switch (r.status) {
    case 202: return resposta(null, TEXTO_ENVIO_PENDENTE, "credito_envio_202");
    case 200: return resultado(f, r.body, ctx);
    case 412: {
      // Consentimento não registrado no servidor: refaz a atestação (o resumo volta depois do SIM).
      const g: FluxoCredito = { ...f, etapa: "atestacao", consentimento: undefined, chave: undefined, campoAtual: undefined, tentativas: 0, atualizadoEm: ctx.agora };
      return resposta(g, `A autorização não ficou registrada. ${textoAtestacao(f.leadNome)}`, "credito_envio_412");
    }
    case 422: {
      if (erro === "cpf_divergente") return resposta(null, textoCpfDivergente(url), "credito_envio_cpf_divergente");
      if (erro === "cpf_ausente") return resposta(null, `O cadastro deste cliente está sem CPF. Complete na tela: ${url}`, "credito_envio_cpf_ausente");
      const faltantes = [...lista(r.body.faltantes), ...lista(r.body.missing)];
      if (faltantes.length) return voltarAoFaltante(f, faltantes, ctx);
      return resposta(null, `O sistema não aceitou o envio. Confira a ficha na tela: ${url}`, "credito_envio_422");
    }
    case 409:
      if (r.body.reason === "provedor_desligado") return resposta(null, textoInativa(ctx.orgName ?? "sua imobiliária"), "credito_envio_desligado");
      return resposta(null, TEXTO_EM_ANDAMENTO, "credito_envio_409");
    case 402: return resposta(null, TEXTO_TETO, "credito_envio_402");
    case 503: return resposta(null, TEXTO_INDISPONIVEL, "credito_envio_503");
    case 403: return resposta(null, TEXTO_CREDITO_SEM_POLITICA, "credito_envio_403");
    case 404: return resposta(null, `Não consegui abrir essa ficha pelo ${nomeDoAgente()}. Confira na tela: ${url}`, "credito_envio_404");
    default: return resposta(null, `O sistema não aceitou o envio. Confira a ficha na tela: ${url}`, `credito_envio_${r.status}`);
  }
}

/** 200 do envio: rótulo + link — nunca a justificativa (texto livre do provedor). */
function resultado(f: FluxoCredito, body: Record<string, unknown>, ctx: ContextoDoTurno): Resposta {
  const decisao = str(body.decision);
  const url = urlDoLead(f, body);
  if (!decisao || decisao === "pendente") return resposta(null, TEXTO_ENVIO_PENDENTE, "credito_resultado_pendente");
  const rotulo = str(body.rotulo) ?? ROTULO_PADRAO[decisao] ?? decisao;
  if (decisao === "aprovado") {
    // A proposta só é oferecida a quem pode criá-la.
    if (!ctx.policy.includes("proposal.create")) {
      return resposta(null, `Aprovado na Upestate. Veja na tela do lead: ${url}`, "credito_resultado_aprovado_sem_proposta");
    }
    const g: FluxoCredito = { ...f, etapa: "resultado", decisao, chave: undefined, pausado: false, atualizadoEm: ctx.agora };
    return resposta(g, `Aprovado na Upestate. Quer que eu abra a proposta de locação ${deQuem(f)}?`, "credito_resultado_aprovado");
  }
  if (decisao === "revisao" || decisao === "reprovado") {
    const humanizada = body.podePedirHumanizada === true;
    const cab = decisao === "revisao"
      ? `${quemMaiusculo(f)} ficou em revisão na análise automática da Upestate${/revis/i.test(rotulo) ? "" : ` (${rotulo})`} — ainda não é aprovação.`
      : `${quemMaiusculo(f)} foi recusado(a) na análise automática da Upestate (${rotulo}).`;
    const passo = humanizada
      ? `Próximo passo: pedir a análise humanizada, com comprovantes de renda, na tela do lead. O motivo também está lá: ${url}`
      : `O motivo está na tela do lead: ${url}`;
    return resposta(null, `${cab}\n${passo}`, `credito_resultado_${decisao}`);
  }
  if (decisao === "pendencia") {
    return resposta(null, `A Upestate pediu complemento da ficha (${rotulo}). Veja na tela do lead: ${url}`, "credito_resultado_pendencia");
  }
  return resposta(null, `A análise não pôde ser concluída (${rotulo}). Veja na tela do lead: ${url}`, `credito_resultado_${decisao}`);
}

/** "manda de novo", "reenvia", "sim" de novo… — com envio incerto, nada disso reenvia. */
const PEDE_REENVIO = /\b(de novo|novamente|reenvi\w*|mand\w*|envi\w*|tent\w*|confer\w*|cheg\w*|saiu|foi)\b/;

/**
 * Envio sem resposta (chave guardada). SIM ou "manda de novo" só CONSULTAM
 * (`credit.status`): nunca outro `credit.request`. Se o pedido chegou ao
 * ImobPro, o aviso `credit_result` chega pelo `/notify`; se não chegou, nada
 * avisa — por isso o texto manda olhar a tela do lead ou perguntar de novo.
 */
async function conferirEnvio(f: FluxoCredito, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const t = normalizar(ctx.texto);
  if (lerConfirmacao(ctx.texto) !== "sim" && !confirmaEstrito(ctx.texto) && !PEDE_REENVIO.test(t)) {
    // Outro assunto: o modelo responde; a chave fica (nenhum SIM futuro reenvia).
    return { liberar: true, fluxo: { ...f, pausado: false }, evento: "credito_envio_incerto_liberado" };
  }
  const url = linkDoLead(f.leaseClientId);
  const r = f.leaseClientId ? await deps.acao("credit.status", { leaseClientId: f.leaseClientId }) : null;
  const ultima = r?.status === 200 ? obj(r.body.ultima) : {};
  const rotulo = str(ultima.rotulo);
  // Só vale a análise deste envio: criada depois do SIM (1 min de folga de relógio).
  const criada = instante(ultima.createdAt);
  const desteEnvio = criada !== null && criada >= (f.chave?.em ?? 0) - 60_000;
  if (rotulo && desteEnvio) {
    return resposta(null, `Não reenviei. A análise ${deQuem(f)} está como "${rotulo}": ${url}`, "credito_envio_conferido");
  }
  return resposta({ ...f, atualizadoEm: ctx.agora }, textoAindaNaoEncontrei(url), "credito_envio_sem_reenvio");
}

/** Resultado aprovado: SIM abre a proposta de locação com nome e aluguel; NÃO encerra. */
async function desdobrarResultado(f: FluxoCredito, ctx: ContextoDoTurno, deps: DepsDoFluxo): Promise<PassoDoFluxo> {
  const confirmacao = lerConfirmacao(ctx.texto);
  const url = linkDoLead(f.leaseClientId);
  if (confirmacao === "nao") return resposta(null, `Certo. A análise fica na tela do lead: ${url}`, "credito_resultado_encerrado");
  // Outra conversa: o resultado já foi dito; o fluxo acaba e o modelo responde.
  if (confirmacao !== "sim") return { liberar: true, fluxo: null, evento: "credito_resultado_liberado" };
  if (!ctx.policy.includes("proposal.create")) {
    return resposta(null, `Sua conta não tem permissão para criar proposta pelo ${nomeDoAgente()}. A análise fica na tela do lead: ${url}`, "credito_proposta_sem_politica");
  }
  // Nome pro cabeçalho e aluguel do cofre são só conveniência: quem garante os
  // dois (e o CPF, que o Max nunca manda) é o `proposal.create` com
  // `leaseClientId` (contractmaker #1580) — por isso a proposta FICA ligada ao
  // lead e a coleta não pede nome, CPF nem aluguel de novo (ver `faltandoNaProposta`).
  // Posse recusada só vem como 404 (`fluxos.criarRascunho` oferece abrir sem
  // vínculo); 403 é RBAC/política e 400 é corpo inválido — nenhum dos dois é
  // tratado como posse.
  const pre = f.leaseClientId ? await deps.acao("credit.preflight", { leaseClientId: f.leaseClientId }) : null;
  const nome = (pre?.status === 200 ? str(obj(pre.body.lead).nome) : null) ?? f.leadNome;
  const aluguel = abrirCofre(f, ctx).aluguel;
  const { iniciarProposta } = await import("./fluxos");
  const passo = await iniciarProposta("locacao", undefined, ctx.agora, deps, {
    ...(nome ? { proponente: { nome } } : {}),
    ...(aluguel ? { valor: aluguel } : {}),
    finalidade: "residencial",
  }, f.leaseClientId);
  const cab = nome ? `Abrindo a proposta de locação de ${nome}.\n\n` : "";
  return { ...passo, reply: `${cab}${passo.reply}`, evento: `credito_proposta_${passo.evento}` };
}
