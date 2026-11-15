import { linkSeguro, texto } from "./notificacao-projecao";

/**
 * O bloco `avisos` do `pending.summary` (copiloto 2.8, par do contractmaker#3130),
 * como o Max o entrega ao modelo.
 *
 * O CM devolve `{ disponivel, total, totalExato?, itens: [{ id, origem, tipo, titulo, corpo,
 * prioridade, entidade: {tipo,id}|null, link|null, criadoEm }] }`. Aqui é WHITELIST, como em
 * `projetarNotificacao` (regra 5 do `docs/max.md`): campo novo do servidor só chega ao modelo
 * depois de alguém decidir isso aqui.
 *
 *  - **Sai:** `titulo`, `corpo`, `prioridade`, `criadoEm`, `entidade.tipo` e `link` (mesmo host do
 *    ImobPro, https). **Não sai:** `id` do aviso, `entidade.id`, `origem`, `tipo` e qualquer outro.
 *    O modelo não precisa de id interno para contar o aviso, e o que ele não recebe, não vaza.
 *  - **`titulo` e `corpo` são DADO de terceiro** (nascem de cliente/observação de formulário):
 *    saem sem quebra de linha nem caractere de controle, até `LIMITE_CORPO_AVISO` caracteres,
 *    e o item vai marcado `_untrusted` (a cerca do prompt os trata como dado, nunca instrução).
 *  - **`disponivel: false` fica `false`.** Nunca vira lista vazia: "não consegui ler os avisos"
 *    e "não há aviso" são respostas diferentes.
 *  - **`totalExato: false` passa** (o prompt manda dizer "mais de N").
 *  - No máximo `MAX_AVISOS` itens: o bloco inteiro cabe num único item do `fenceToolResults`,
 *    que corta em 4000 caracteres, e um corte no meio do JSON perderia justamente o total.
 */
export const MAX_AVISOS = 5;
export const LIMITE_CORPO_AVISO = 200;

export interface AvisoProjetado {
  titulo?: string;
  corpo?: string;
  prioridade?: number;
  criadoEm?: string;
  entidade?: { tipo: string };
  link?: string;
  _untrusted?: true;
}

export interface AvisosProjetados {
  disponivel: boolean;
  total: number;
  totalExato?: false;
  itens: AvisoProjetado[];
}

const INDISPONIVEL: AvisosProjetados = { disponivel: false, total: 0, itens: [] };

function projetarAviso(v: unknown): AvisoProjetado | null {
  if (!v || typeof v !== "object") return null;
  const it = v as Record<string, unknown>;
  const titulo = texto(it.titulo);
  const corpo = texto(it.corpo)?.slice(0, LIMITE_CORPO_AVISO) ?? null;
  // Sem texto não há o que dizer à pessoa: o item some (e a contagem do servidor fica como veio).
  if (!titulo && !corpo) return null;
  const saida: AvisoProjetado = {};
  if (titulo) saida.titulo = titulo;
  if (corpo) saida.corpo = corpo;
  if (typeof it.prioridade === "number" && Number.isFinite(it.prioridade)) saida.prioridade = it.prioridade;
  if (typeof it.criadoEm === "string") saida.criadoEm = it.criadoEm.slice(0, 40);
  const ent = it.entidade;
  if (ent && typeof ent === "object") {
    const tipo = texto((ent as Record<string, unknown>).tipo);
    if (tipo) saida.entidade = { tipo: tipo.slice(0, 40) };
  }
  const link = linkSeguro(it.link);
  if (link) saida.link = link;
  saida._untrusted = true;
  return saida;
}

/** Forma inesperada (bloco que não é o contrato) = indisponível, nunca "sem avisos". */
export function projetarAvisos(bloco: unknown): AvisosProjetados {
  if (!bloco || typeof bloco !== "object" || Array.isArray(bloco)) return INDISPONIVEL;
  const b = bloco as Record<string, unknown>;
  if (b.disponivel !== true || !Array.isArray(b.itens)) return INDISPONIVEL;
  const itens = b.itens.map(projetarAviso).filter((x): x is AvisoProjetado => x !== null);
  const total = typeof b.total === "number" && Number.isInteger(b.total) && b.total >= 0 ? b.total : itens.length;
  return {
    disponivel: true,
    total: Math.max(total, itens.length),
    ...(b.totalExato === false ? { totalExato: false as const } : {}),
    itens: itens.slice(0, MAX_AVISOS),
  };
}

/**
 * Aplica a projeção ao resumo de `pending.summary`. Os outros blocos passam como vieram.
 *
 * `permitido: false` (a política não tem `pending.avisos`) REMOVE o bloco mesmo que o servidor o
 * tenha mandado: o receptor já o omite, mas a regra aqui não depende de o outro lado estar certo.
 */
export function projetarResumoDePendencias(resumo: unknown, permitido: boolean): unknown {
  if (!resumo || typeof resumo !== "object" || Array.isArray(resumo)) return resumo;
  const r = resumo as Record<string, unknown>;
  if (!Object.hasOwn(r, "avisos")) return resumo;
  const { avisos, ...resto } = r;
  return permitido ? { ...resto, avisos: projetarAvisos(avisos) } : resto;
}
