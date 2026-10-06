import type { TipoDeReferencia } from "./tools";

/**
 * G2 — referências numeradas, não IDs.
 *
 * ── Por que o CÓDIGO numera, e não o modelo ───────────────────────────────
 *
 * Até aqui o resultado de uma leitura entrava no prompt com o `id` de cada
 * linha, e o nano era quem decidia como chamar cada item. Dois problemas, e o
 * segundo é o que importa para o PR 6:
 *
 *  - o `id` é chave de linha do banco de um tenant. O sanitizador derruba o
 *    cuid que escapar na resposta, mas o melhor id vazado é o que o modelo
 *    nunca viu;
 *  - "envia a 2" só é uma ação segura se "2" significar a MESMA proposta para
 *    a pessoa e para o código. Se quem numerasse fosse o modelo, a lista que a
 *    pessoa leu e o alvo que o código executa poderiam divergir em silêncio —
 *    e a ação seguinte é paga (ClickSign cobra por signatário).
 *
 * Então: o código numera 1..N, guarda número → id no estado da conversa com
 * TTL, e o modelo recebe só número + rótulo. Referência fora do mapa vigente é
 * recusada AQUI (`resolverReferencia`), nunca "a mais parecida".
 */

/** No máximo isto por lista — é também o teto de itens de lista da G6. */
export const ITENS_POR_LISTA = 5;

/** Mesmo prazo da pendência de escrita: meia hora depois, a lista já saiu da conversa. */
export const REFERENCIA_TTL_MS = 30 * 60 * 1000;

export interface ItemReferenciado {
  /** O número que a pessoa vê e usa. Começa em 1. */
  n: number;
  tipo: TipoDeReferencia;
  /** O id real. NUNCA vai para o prompt nem para a resposta. */
  id: string;
  /** O que a pessoa leu ao lado do número (título, código ou referência). */
  rotulo: string;
}

export interface MapaDeReferencias {
  /** Epoch ms de quando a lista foi montada. Base do TTL. */
  criadoEm: number;
  /**
   * `messageId` do turn que montou o mapa. Duas listas no MESMO turn
   * (negócios e propostas) continuam a numeração em vez de reiniciar — senão
   * "o 1" teria dois donos.
   */
  turno: string;
  itens: ItemReferenciado[];
}

/**
 * O rótulo que identifica o item para a pessoa, por ordem de preferência.
 *
 * O corretor comissionado não recebe `titulo` (carrega endereço) — recebe
 * `referencia`, e é ela que vira o rótulo dele. Sem nenhum dos campos, o
 * rótulo é genérico: inventar um nome seria pior que não ter.
 *
 * ⚠️ Exceção DELIBERADA a "id nunca aparece" (aceita no review de segurança do
 * PR 2, D7): a `referencia` do servidor é "Negócio #<6 ÚLTIMOS caracteres
 * do id, em maiúsculas>" (`referenciaDoNegocio` no ImobPro). É um sufixo curto, não a
 * chave — não abre nada sozinho, e é o único jeito de o corretor sem acesso
 * ao endereço dizer DE QUAL negócio fala ao gerente.
 */
function rotuloDe(item: Record<string, unknown>, tipo: TipoDeReferencia): string {
  for (const campo of ["titulo", "codigo", "referencia"]) {
    const v = item[campo];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 80);
  }
  return tipo === "proposta" ? "Proposta" : "Negócio";
}

/**
 * Numera uma lista que uma leitura devolveu.
 *
 * Devolve:
 *  - `paraOModelo`: os itens com `n` no lugar do `id` — é só isso que entra
 *    no prompt;
 *  - `mapa`: o mapa vigente, já com estes itens somados (ou reiniciado, se o
 *    anterior era de outro turn);
 *  - `cortados`: quantos ficaram de fora pelo teto de `ITENS_POR_LISTA` — o
 *    chamador declara o truncamento, para o modelo dizer que há mais.
 *
 * Item sem `id` string não entra no mapa nem na lista: um número que não
 * aponta para nada é exatamente a referência inventada que a G2 proíbe.
 */
export function numerarLista(params: {
  items: unknown[];
  tipo: TipoDeReferencia;
  anterior: MapaDeReferencias | null;
  turno: string;
  agora: number;
}): { paraOModelo: Record<string, unknown>[]; mapa: MapaDeReferencias; cortados: number } {
  // "Mesmo turn" é o mesmo `messageId`. Uma retentativa da fila reprocessa o
  // mesmo `messageId` e CONTINUA a numeração do mapa gravado (ex.: 6..10 em
  // vez de 1..5). Cosmético e aceito (D8 do review): os números continuam
  // únicos e o mapa continua sendo a verdade.
  const base =
    params.anterior && params.anterior.turno === params.turno
      ? params.anterior
      : { criadoEm: params.agora, turno: params.turno, itens: [] };

  const validos = params.items.filter(
    (it): it is Record<string, unknown> =>
      !!it && typeof it === "object" && typeof (it as { id?: unknown }).id === "string"
  );
  const mostrados = validos.slice(0, ITENS_POR_LISTA);

  let proximo = base.itens.reduce((m, i) => Math.max(m, i.n), 0) + 1;
  const novos: ItemReferenciado[] = [];
  const paraOModelo = mostrados.map((item) => {
    const n = proximo++;
    novos.push({ n, tipo: params.tipo, id: item.id as string, rotulo: rotuloDe(item, params.tipo) });
    // `n` primeiro, e o `id` FORA: é o que o modelo usa para se referir ao
    // item, e não existe outro identificador para ele repetir.
    const resto = Object.fromEntries(Object.entries(item).filter(([k]) => k !== "id"));
    return { n, ...resto };
  });

  return {
    paraOModelo,
    mapa: { criadoEm: base.criadoEm, turno: base.turno, itens: [...base.itens, ...novos] },
    cortados: validos.length - mostrados.length,
  };
}

export type Resolucao =
  | { ok: true; item: ItemReferenciado }
  | { ok: false; motivo: "sem_lista" | "expirada" | "fora_da_lista" | "tipo_errado" };

/**
 * "A 2" → o item 2 da lista vigente, ou recusa.
 *
 * Sem consumidor em produção ainda (D9 do review, aceito): quem resolve "a 2"
 * em ação é o PR 6. A função e a recusa já ficam aqui, testadas, para a ação
 * nascer em cima delas e não de um parse novo.
 *
 * Recusa em vez de aproximar, sempre: número que não está no mapa, mapa
 * vencido, número não inteiro, ou um item de outro tipo ("envia a proposta 2"
 * quando o 2 é um negócio). O PR 6 transforma a recusa em "qual delas?" com a
 * lista de novo — o que nunca pode acontecer é executar sobre o vizinho.
 */
export function resolverReferencia(
  mapa: MapaDeReferencias | null | undefined,
  n: unknown,
  opts: { agora?: number; tipo?: TipoDeReferencia } = {}
): Resolucao {
  if (!mapa || mapa.itens.length === 0) return { ok: false, motivo: "sem_lista" };
  const agora = opts.agora ?? Date.now();
  if (agora - mapa.criadoEm > REFERENCIA_TTL_MS) return { ok: false, motivo: "expirada" };

  const numero = typeof n === "string" && /^\s*\d+\s*$/.test(n) ? Number(n) : n;
  if (typeof numero !== "number" || !Number.isInteger(numero)) {
    return { ok: false, motivo: "fora_da_lista" };
  }
  const item = mapa.itens.find((i) => i.n === numero);
  if (!item) return { ok: false, motivo: "fora_da_lista" };
  if (opts.tipo && item.tipo !== opts.tipo) return { ok: false, motivo: "tipo_errado" };
  return { ok: true, item };
}

/**
 * A lista como a pessoa lê: "1. Rótulo". Uma linha por item, no máximo
 * `ITENS_POR_LISTA` — por construção, porque o mapa nunca guarda mais que
 * isso por lista. É o texto que o PR 6 usa para perguntar "qual delas?".
 */
export function renderizarLista(itens: ItemReferenciado[]): string {
  return itens
    .slice(0, ITENS_POR_LISTA)
    .map((i) => `${i.n}. ${i.rotulo}`)
    .join("\n");
}
