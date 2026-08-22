/**
 * Traduz um telefone no rótulo com que ele aparece no log.
 *
 * O log não mostra mais dígito nenhum: `phoneTag` grava um pseudônimo derivado
 * por HMAC (`tel_9f3a1c4d2e77`), estável por pessoa e irreversível sem a chave.
 * Isso resolve o vazamento, mas quebraria a investigação se não houvesse o
 * caminho de ida — e a investigação SEMPRE começa do número, porque começa de
 * alguém reclamando que não recebeu.
 *
 * Uso:
 *   op run -- npx tsx scripts/tel.ts +5511999999999
 *   op run -- npx tsx scripts/tel.ts 5511999999999 11999999999   # várias de uma vez
 *
 * Depois é só buscar o rótulo no painel da Vercel: ele costura webhook, fila,
 * turn e envio da mesma pessoa.
 *
 * **O `op run --` não é opcional.** Este script não carrega `.env` (ao
 * contrário do `migrate.ts`), e o rótulo depende do `MAX_NOTIFY_SECRET` do
 * ambiente que gerou o log: rodar sem ele devolve um rótulo que não existe em
 * produção, e o modo de falha é silencioso — busca vazia parece "nenhum
 * evento", que é a resposta menos confiável que existe. Daí o prefixo `telx_`
 * na saída sem segredo, e o aviso abaixo.
 */

import { conversationKey, maskPhone, phoneTag } from "../src/lib/phone";

const entradas = process.argv.slice(2);

if (entradas.length === 0) {
  console.error("uso: npx tsx scripts/tel.ts <telefone> [<telefone> ...]");
  process.exit(1);
}

if (!process.env.MAX_NOTIFY_SECRET) {
  console.error(
    "AVISO: MAX_NOTIFY_SECRET ausente — os rótulos abaixo saem como `telx_`,\n" +
      "       são de desenvolvimento e NÃO batem com os do log de produção.\n" +
      "       Rode com `op run -- npx tsx scripts/tel.ts <telefone>`.\n"
  );
}

for (const bruto of entradas) {
  const chave = conversationKey(bruto);
  console.log(
    [
      `entrada:  ${bruto}`,
      `chave:    ${chave}`,
      `tela:     ${maskPhone(chave)}`,
      `log:      ${phoneTag(bruto)}`,
    ].join("\n") + "\n"
  );
}
