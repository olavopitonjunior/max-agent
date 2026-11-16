import { linkSeguro, texto } from "./notificacao-projecao";

/**
 * `document.list` (PR-O4c-MA, par do contractmaker PR-O4c-CM, `docs/max.md` §19.5): os documentos
 * de UM negócio ou de UMA proposta.
 *
 * Só leitura, só metadado. O Max diz QUE o documento existe e ONDE ele mora na tela; quem abre é a
 * pessoa, logada. Este módulo nunca produz link de arquivo: o `link` do contrato é um caminho
 * RELATIVO da tela, e qualquer coisa que não seja isso derruba a resposta. Na conversa o caminho
 * sai ABSOLUTO, resolvido por `linkSeguro` (mesma origem de `imobproBase()`, https), para ser
 * clicável no WhatsApp: é sempre uma tela da plataforma, nunca blob, S3 nem ClickSign.
 *
 * ── Parse ESTRITO (R54), o mesmo do `certidao.status` ───────────────────────
 *
 * O conjunto de chaves do item é EXATO: chave a mais (um `url` que apareça um dia), chave a menos,
 * tipo errado, `origem` fora do enum ou `link` que não seja caminho relativo derrubam o item, e um
 * item inválido derruba a resposta inteira (`falha_na_consulta`, ver o despachante). O objeto
 * devolvido é montado campo a campo.
 */

export const ORIGENS_DE_DOCUMENTO = ["anexo", "contrato_assinado", "contrato"] as const;
export type OrigemDeDocumento = (typeof ORIGENS_DE_DOCUMENTO)[number];

export interface DocumentoItem {
  id: string;
  origem: OrigemDeDocumento;
  /** Só o último trecho do nome do arquivo; o servidor já cortou em 120 caracteres. */
  nome: string;
  /** Categoria do catálogo da pasta (ex.: "rg"); `null` quando não tem. */
  categoria: string | null;
  /** Só o contrato aprovado traz a versão; os demais, `null`. */
  versao: number | null;
  criadoEm: string;
  /** Caminho RELATIVO da tela logada. Nunca URL de arquivo. */
  link: string;
}

/** Chaves do item, na ordem do contrato (`docs/max.md` §19.5). */
export const CHAVES_DE_DOCUMENTO = ["id", "origem", "nome", "categoria", "versao", "criadoEm", "link"] as const;

const ehObjeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** As chaves do objeto são EXATAMENTE estas (sem sobra, sem falta), em qualquer ordem. */
function chavesExatas(o: Record<string, unknown>, esperadas: readonly string[]): boolean {
  const reais = Object.keys(o);
  return reais.length === esperadas.length && esperadas.every((c) => Object.hasOwn(o, c));
}

const textoNaoVazio = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const ehInstante = (v: unknown): v is string => textoNaoVazio(v) && !Number.isNaN(new Date(v).getTime());

/**
 * Caminho relativo da tela: começa com UMA barra e só tem caracteres de caminho/consulta. Nunca URL
 * absoluta nem protocolo-relativa (`://` e `//` caem), nunca espaço nem quebra de linha (forjariam
 * linha de lista). Não procura "http" no texto: um cuid pode conter essas letras; o que decide é a
 * forma (barra inicial, sem `://`) e, depois, o `linkSeguro` (mesma origem da plataforma). Os marcadores `* ~` e crase ficam de fora de
 * propósito (formatação do WhatsApp); `_` é permitido (cuid e abas o usam).
 */
const CAMINHO_RELATIVO = /^\/(?!\/)[A-Za-z0-9\-._/?=&%]*$/;
function ehCaminhoRelativo(v: unknown): v is string {
  return typeof v === "string" && CAMINHO_RELATIVO.test(v) && !v.includes("://");
}

/** Lê UM item pelo contrato; `null` = fora do contrato (a resposta inteira vira falha). */
export function lerDocumento(item: unknown): DocumentoItem | null {
  if (!ehObjeto(item) || !chavesExatas(item, CHAVES_DE_DOCUMENTO)) return null;
  if (!(textoNaoVazio(item.id) && textoNaoVazio(item.nome) && ehInstante(item.criadoEm))) return null;
  if (!ORIGENS_DE_DOCUMENTO.includes(item.origem as OrigemDeDocumento)) return null;
  if (!(item.categoria === null || textoNaoVazio(item.categoria))) return null;
  if (!ehCaminhoRelativo(item.link)) return null;
  // O render o resolve contra a origem da plataforma; se o `linkSeguro` o recusa (longo demais,
  // origem estranha), o item está fora do contrato e a resposta vira `falha_na_consulta`.
  if (linkSeguro(item.link) === null) return null;
  // `versao`: número inteiro ≥ 1 SÓ no contrato aprovado; a chave existe em todos, `null` nos demais.
  if (item.versao !== null && !(typeof item.versao === "number" && Number.isInteger(item.versao) && item.versao >= 1)) return null;
  if ((item.origem === "contrato") !== (item.versao !== null)) return null;

  return {
    id: item.id,
    origem: item.origem as OrigemDeDocumento,
    nome: item.nome,
    categoria: item.categoria,
    versao: item.versao,
    criadoEm: item.criadoEm,
    link: item.link,
  };
}

// ─── Render (WhatsApp) ──────────────────────────────────────────────────────

/** Vazio, negado, outra org, sem módulo e inexistente chegam iguais (`{items:[]}`): o Max não distingue, e não vaza. */
export const SEM_DOCUMENTOS_NEGOCIO = "Não encontrei documentos nesse negócio.";
export const SEM_DOCUMENTOS_PROPOSTA = "Não encontrei documentos nessa proposta.";
/** Nome de reserva quando o nome vindo do servidor some depois da limpeza. */
const NOME_DE_RESERVA = "Documento";

/**
 * Texto vindo do servidor dentro de uma linha de WhatsApp: sem controle, sem os marcadores de
 * formatação (`*` negrito, `_` itálico, `~` riscado, crase monoespaçado: forjariam formatação) e
 * sem sobra de espaço. Mesma regra do `certidao-status.ts`.
 */
function limpo(v: string): string {
  return (texto(v) ?? "").replace(/[*_~`]+/g, "").replace(/\s+/g, " ").trim();
}

const FUSO = "America/Sao_Paulo";

/** Instante ISO -> "17/10/2026" no horário de Brasília. */
function dataLocal(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("pt-BR", { timeZone: FUSO, day: "2-digit", month: "2-digit", year: "numeric" });
}

/** A origem como a pessoa lê. Nunca o código (`contrato_assinado`). */
function origemLegivel(d: DocumentoItem): string {
  if (d.origem === "contrato") return `Contrato aprovado v${d.versao}`;
  if (d.origem === "contrato_assinado") return "Contrato assinado";
  return "Anexo";
}

function linhaDoDocumento(d: DocumentoItem): string {
  const nome = limpo(d.nome) || NOME_DE_RESERVA;
  // A categoria dos contratos repete a origem (`contrato`, `contrato_assinado`): só o anexo a mostra.
  // O sublinhado do código vira espaço ANTES da limpeza (`contrato_assinado` -> "contrato assinado").
  const categoria = d.origem === "anexo" && d.categoria ? limpo(d.categoria.replace(/_/g, " ")) : "";
  const quando = dataLocal(d.criadoEm);
  const origem = `${origemLegivel(d)}${categoria ? ` (${categoria})` : ""}${quando ? `, ${quando}` : ""}`;
  return `- ${nome} — ${origem} — abra no sistema: ${linkSeguro(d.link)}`;
}

/**
 * O resumo dos documentos de UM negócio/proposta, pronto para a conversa: uma linha por documento,
 * PT-BR, sem negrito (nada de `**`), sem id, sem link de arquivo (só a URL da tela). Recebe itens JÁ lidos por `lerDocumento`,
 * nunca o JSON cru. O arquivo nunca sai daqui: o caminho é da tela, onde a pessoa abre logada.
 */
export function renderDocumentos(itens: readonly DocumentoItem[], origem: "negocio" | "proposta", truncado: boolean): string {
  if (itens.length === 0) return origem === "proposta" ? SEM_DOCUMENTOS_PROPOSTA : SEM_DOCUMENTOS_NEGOCIO;
  const linhas = [origem === "proposta" ? "Documentos da proposta:" : "Documentos do negócio:", ...itens.map(linhaDoDocumento)];
  if (truncado) linhas.push(`Mostrando os ${itens.length} mais recentes.`);
  return linhas.join("\n");
}
