import type { ToolLogEntry } from "@/lib/turnlog";

/**
 * Por onde o turn foi RESOLVIDO — a coluna `route` de `conversation_turn`
 * (migration 020), vazia desde que foi criada.
 *
 * Sem ela, "quantos turns o modelo respondeu e quantos saíram de fluxo
 * determinístico" só se respondia lendo `timings_json` e `tools_json` à mão. A
 * rota não vem de um roteador (ainda não existe): é DERIVADA do caminho que o
 * grafo fez. Cada nó só passa adiante quando não respondeu, então o nó mais
 * avançado no caminho é o que resolveu:
 *
 *   gate → continuar → conduzir → confirm → retrieve/answer(/tools) → compose
 *
 * Valores:
 *   halt            — o `gate` cortou (kill switch, deny-list, org suspensa,
 *                     anexo que não lê…); o motivo exato está em `error`
 *   continuar       — "quer ver o resto?"
 *   fluxo:<kind>    — fluxo determinístico (consulta, gestao, proposta, credito…)
 *   confirmacao     — o SIM/NÃO de uma escrita pendente
 *   modelo          — o LLM respondeu (com ou sem tools: `tools_json` diz quais)
 *   gate            — não deveria ocorrer: sem `halt` o `gate` sempre segue.
 *                     Aparecer no painel é sinal de caminho novo no grafo.
 *
 * NULL = turn que lançou exceção (ver `comRastro`) ou linha anterior a isto.
 */
export function rotaDoTurn(
  timings: { no: string }[],
  toolLog: ToolLogEntry[],
  halt?: string | null
): string | null {
  if (halt) return "halt";
  const nos = new Set(timings.map((t) => t.no));
  if (nos.has("answer")) return "modelo";
  if (nos.has("confirm")) return "confirmacao";
  if (nos.has("conduzir")) {
    // O `conduzir` registra o fluxo que respondeu; o último é o que valeu.
    const fluxo = [...toolLog].reverse().find((t) => t.name === "fluxo");
    const kind = typeof fluxo?.args.kind === "string" ? fluxo.args.kind : null;
    return kind ? `fluxo:${kind}` : "fluxo";
  }
  if (nos.has("continuar")) return "continuar";
  return nos.size ? "gate" : null;
}
