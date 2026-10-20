/**
 * Conversa com o Max pela linha de comando, sem passar pela Z-API.
 *
 * Existe por um bloqueio concreto: a instância Z-API do Max está desemparelhada,
 * e enquanto não for repareada nada dele é exercitável pelo WhatsApp. Este script
 * injeta um `InboundMessage` direto no `runTurn` — o mesmo caminho que a fila
 * chama —, então identidade, RAG, memória, ferramentas e confirmação rodam de
 * verdade, contra o ImobPro de verdade. O que ele NÃO cobre é o transporte:
 * webhook, fila e envio.
 *
 * Uso:
 *   npx tsx scripts/turn.ts <telefone> "<mensagem>"
 *   npx tsx scripts/turn.ts +5511999999999 "me manda um link de formulario"
 *   npx tsx scripts/turn.ts +5511999999999 "sim"
 *
 * O `thread_id` inclui organização, telefone e sujeito autenticado; duas
 * execuções do mesmo sujeito continuam a mesma conversa.
 *
 * `--novo` limpa a thread antes de rodar, para começar do zero sem trocar de
 * número.
 */

import { randomUUID } from "node:crypto";
import { runTurn } from "../src/graph/graph";
import { liveNamespaceFor } from "../src/lib/runtime/context";
import { subjectDe } from "../src/lib/scope";
import { resolveIdentity } from "../src/lib/identity";
import { normalizeBrPhone } from "../src/lib/phone";
import { limparThreadDoCheckpointer } from "../src/lib/checkpointer-reset";
import { db } from "../src/lib/db";

function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const [telefone, ...resto] = args;
  const texto = resto.join(" ");

  if (!telefone || !texto) {
    console.error(
      'uso: npx tsx scripts/turn.ts <telefone> "<mensagem>" [--novo]'
    );
    process.exit(1);
  }

  const e164 = normalizeBrPhone(telefone);
  if (!e164) {
    console.error(`telefone inválido: ${telefone}`);
    process.exit(1);
  }

  if (has("novo")) {
    const identity = await resolveIdentity(e164);
    if (identity.kind === "resolved") {
      const thread = liveNamespaceFor(identity.candidate.orgId, e164, subjectDe(identity.candidate));
      // As tabelas são do checkpointer do LangGraph. Limpar a thread aqui é
      // conveniência de teste — em produção nada apaga histórico.
      await limparThreadDoCheckpointer(thread);
      console.log(`[harness] thread ${thread} limpa\n`);
    }
  }

  const inicio = Date.now();
  const resultado = await runTurn({
    messageId: `harness-${randomUUID()}`,
    fromPhone: e164,
    groupId: null,
    kind: "text",
    text: texto,
    mediaUrl: null,
    mimeType: null,
    senderName: null,
    replyToMessageId: null,
    timestampMs: Date.now(),
  });

  console.log(`> ${texto}`);
  console.log(`\n${resultado.reply ?? "(sem resposta)"}\n`);
  console.log(`[${Date.now() - inicio}ms]`);

  // O mesmo trabalho pós-resposta que a fila faz — sem ele a extração de memória
  // nunca seria exercitada por aqui.
  if (resultado.afterReply) {
    await resultado.afterReply();
  }
}

main()
  .catch((err) => {
    console.error("\n[harness] falhou:", err);
    process.exitCode = 1;
  })
  .finally(() => db().end().catch(() => undefined));
