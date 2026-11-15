/**
 * Pausa antes da ficha (T10, D2).
 *
 * O corretor manda o pedido em várias mensagens curtas. Responder a cada uma com
 * "anotei" é ruído; a ficha ✅/⬜ sai quando ele para de escrever (20 s), quando
 * pede ("o que falta", "ficha") ou quando tudo veio numa mensagem só.
 *
 * Duas metades:
 *  - no PRÓPRIO turno, `deveMostrarFicha` (ficha.ts) decide por `ultimaEntradaEm`;
 *  - sem mensagem nova, a ficha precisa SAIR sozinha: agenda-se uma linha no outbox
 *    para `ultimaEntradaEm + 20 s`, com chave `ficha:<subjectKey>`, e toda mensagem
 *    nova cancela a anterior. Três mensagens em 10 s deixam UMA linha pendente.
 *
 * Este módulo só fala com as `DepsDaPausa` (injetadas: o outbox importa o grafo, então
 * o import estático seria um ciclo). Falha da fila nunca derruba o turno.
 *
 * Limite conhecido: o outbox roda por cron a cada minuto, então a ficha agendada sai
 * com precisão de ~1 min, e uma linha do mesmo telefone enviada há menos de 10 min
 * pode segurá-la até o resumo (M8). O caminho rápido é o turno seguinte.
 */

export const PAUSA_DA_FICHA_MS = 20_000;

/** Chave pública da ficha agendada de um sujeito (identidade + org). */
export function chaveDaFicha(subjectKey: string): string {
  return `ficha:${subjectKey}`;
}

/** Prefixo que casa SÓ as linhas deste sujeito (o `:` final impede `u1` de pegar `u10`). */
function prefixoDaFicha(subjectKey: string): string {
  return `${chaveDaFicha(subjectKey)}:`;
}

export interface DepsDaPausa {
  /** Enfileira o texto da ficha para `quando`. `dedupeKey` é único por agendamento. */
  agendar(p: { chave: string; dedupeKey: string; quando: Date; texto: string }): Promise<void>;
  /** Cancela as linhas pendentes cujo `dedupeKey` começa com `prefixo`. */
  cancelar(prefixo: string): Promise<void>;
}

/**
 * Cancela a ficha agendada antes e agenda a nova (a última mensagem manda). `true` =
 * agendada; `false` = a fila falhou (o turno segue; a ficha sai no próximo turno).
 */
export async function agendarFicha(
  deps: DepsDaPausa,
  args: { subjectKey: string; ultimaEntradaEm: number; texto: string }
): Promise<boolean> {
  try {
    await deps.cancelar(prefixoDaFicha(args.subjectKey));
    await deps.agendar({
      chave: chaveDaFicha(args.subjectKey),
      dedupeKey: `${prefixoDaFicha(args.subjectKey)}${args.ultimaEntradaEm}`,
      quando: new Date(args.ultimaEntradaEm + PAUSA_DA_FICHA_MS),
      texto: args.texto,
    });
    return true;
  } catch {
    return false;
  }
}

/** A ficha pendente some (fluxo cancelado, enviado ou vencido; ou a ficha já saiu no turno). Nunca lança. */
export async function cancelarFicha(deps: DepsDaPausa, subjectKey: string): Promise<void> {
  try {
    await deps.cancelar(prefixoDaFicha(subjectKey));
  } catch {
    // Sem a fila, o pior caso é uma ficha repetida: não vale derrubar o turno.
  }
}
