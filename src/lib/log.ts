import { phoneTag } from "./phone";

/**
 * Log estruturado dos pontos quentes.
 *
 * O problema que isto resolve não é estética: hoje "por que fulano não
 * recebeu resposta?" se investiga juntando linhas de texto livre por
 * telefone, à mão, no painel da Vercel — e o telefone é justamente o campo
 * que a máscara esconde. Sem um id que atravesse webhook → fila → turn →
 * envio, cada etapa é uma ilha.
 *
 * `messageId` da Z-API é essa costura: ele nasce no webhook, vive na linha da
 * fila (`message_id`), acompanha o turn e liga a resposta enviada
 * (`reply_message_id`). Uma busca por ele devolve a conversa inteira.
 *
 * JSON de uma linha porque é o que a busca da Vercel filtra bem (`event:` ou
 * `messageId:` como termo), e porque um dia isso pode virar dreno para um
 * coletor sem reescrever call-site nenhum.
 *
 * **Contrato dos dois campos de id** (misturá-los derrota a costura — quem
 * busca por um campo tem que achar sempre a mesma natureza de coisa):
 *  - `messageId` = a mensagem que ORIGINOU o evento (a recebida, no inbound).
 *  - `sentMessageId` = o id que o provedor devolveu do que SAIU. Vale para
 *    resposta e para notificação proativa — por isso não se chama "reply".
 *
 * Duas garantias que o call-site não precisa lembrar:
 *  - **emitir nunca lança.** Estes logs ficam DENTRO de blocos onde uma
 *    exceção reverteria trabalho já feito (entre o `sendText` e a
 *    liquidação, por exemplo, o catch limparia o marcador e reenviaria uma
 *    mensagem que o provedor já aceitou). Log não pode ter esse poder.
 *  - **telefone vira pseudônimo em qualquer campo**, não só no `phone`: texto
 *    livre de erro do provedor costuma ecoar o número do destinatário
 *    ("Z-API /send-text 400: invalid phone 5511...").
 *
 * **Por que pseudônimo (`tel_9f3a1c4d2e77`) e não máscara (`5511***4321`)**:
 * a máscara escondia 5 dígitos, mas em celular BR o primeiro é sempre `9` —
 * sobravam ~10 mil combinações, e dentro da carteira de uma imobiliária os 4
 * finais já identificam a pessoa. O log da Vercel é retido e pesquisável fora
 * do nosso controle de acesso, então aqui o alvo é **não vazar dígito nenhum**.
 * O pseudônimo correlaciona igual (é estável por pessoa) e é irreversível sem a
 * chave. A tela do super-admin continua com a máscara, e isso é deliberado —
 * `maskPhone` em `phone.ts` explica por quê.
 */

export interface LogFields {
  /** Costura de ponta a ponta — o `messageId` da Z-API, quando houver. */
  messageId?: string | null;
  /** Id da linha da fila (inbound_queue.id ou outbox.id). */
  rowId?: string | null;
  orgId?: string | null;
  /** Cru: o pseudônimo é derivado aqui, para não depender de disciplina no chamador. */
  phone?: string | null;
  /** Id devolvido pelo provedor no que SAIU (resposta ou notificação). */
  sentMessageId?: string | null;
  ms?: number;
  [k: string]: unknown;
}

/**
 * Telefone em texto livre, **com ou sem separador**.
 *
 * A versão anterior era `\b\d{10,13}\b`, que só casa dígito contíguo — e por
 * isso não cobria a razão de o `scrub` existir. O texto de erro que a Z-API
 * devolve é corpo bruto de um provedor externo, e validação de telefone
 * costuma formatar o número na mensagem: `+55 (11) 98765-4321` passava
 * INTEIRO, sem nada, justamente pelo caminho que promete não vazar dígito.
 *
 * Casa uma sequência de 10 a 15 dígitos com até dois caracteres de separação
 * entre eles (`) ` conta como dois). O corte final é por CONTAGEM DE DÍGITOS,
 * feita depois, e não pela regex — é o que impede data ISO de virar rótulo.
 *
 * O `(?<!\w)` na frente não é detalhe de estilo: sem ele, o próprio rótulo
 * `tel_9f3a1c4d2e77` seria varrido de novo nas ~1% das vezes em que o hash sai
 * só com dígitos — e aí a MESMA pessoa teria dois rótulos, que é exatamente o
 * defeito que o pseudônimo veio impedir. Ele também evita casar dígito no meio
 * de um identificador.
 */
const TELEFONE_EM_TEXTO = /(?<!\w)\+?\d(?:[\s().-]{0,2}\d){9,14}/g;

/**
 * Faixa E.164 do BR, com e sem DDI e com e sem o 9º dígito.
 *
 * O trade-off está escolhido de propósito e é assimétrico: sobra-redigir um
 * número que não era telefone estraga uma linha de log; sub-redigir vaza PII
 * para um log retido fora do nosso controle de acesso. Quando a dúvida existe,
 * ela se resolve a favor de esconder.
 *
 * Consequência conhecida: epoch em milissegundos tem 13 dígitos e vira rótulo.
 * Já era assim com a máscara; o que muda é que antes saía reconhecível
 * (`1755***0000`) e agora sai indistinguível de pessoa. Vale saber antes de
 * investigar algo que tenha timestamp no corpo do erro.
 */
function pareceTelefone(trecho: string): boolean {
  const digitos = trecho.replace(/\D/g, "").length;
  return digitos >= 10 && digitos <= 13;
}

/**
 * Profundidade máxima da varredura.
 *
 * O `scrub` precisa descer em objeto e array — o contrato deste módulo diz
 * "telefone em QUALQUER campo, sem depender de disciplina no chamador", e
 * tratar só string de primeiro nível tornava isso falso: `{ resposta: { erro:
 * "…5511987654321" } }` saía limpo. Hoje nenhum call-site passa objeto, mas
 * `LogFields` permite, e o dia em que alguém logar o corpo de uma resposta de
 * provedor é o dia em que o vazamento aparece sem ninguém tocar neste arquivo.
 *
 * O teto existe porque estrutura circular faria a recursão não terminar, e
 * este módulo tem a promessa mais dura de todas: **emitir nunca lança**. Abaixo
 * do teto o valor é substituído em vez de percorrido — deixar passar seria
 * exatamente o buraco que a recursão veio fechar.
 */
const PROFUNDIDADE_MAXIMA = 6;

function ehObjetoSimples(valor: object): boolean {
  const proto = Object.getPrototypeOf(valor);
  return proto === Object.prototype || proto === null;
}

function scrub(valor: unknown, profundidade = 0): unknown {
  if (typeof valor === "string") {
    return valor.replace(TELEFONE_EM_TEXTO, (t) => (pareceTelefone(t) ? phoneTag(t) : t));
  }
  if (profundidade >= PROFUNDIDADE_MAXIMA) return "[profundo demais]";
  if (Array.isArray(valor)) return valor.map((v) => scrub(v, profundidade + 1));
  // Só objeto simples: `Date`, `Error` e afins não são percorríveis por
  // `entries` sem virar `{}` — passam direto e o `JSON.stringify` os resolve.
  if (valor !== null && typeof valor === "object" && ehObjetoSimples(valor)) {
    return Object.fromEntries(
      Object.entries(valor).map(([k, v]) => [k, scrub(v, profundidade + 1)])
    );
  }
  return valor;
}

function emit(level: "info" | "warn" | "error", event: string, f: LogFields): void {
  let linha: string;
  try {
    const { phone, ...rest } = f;
    const limpos = Object.fromEntries(
      Object.entries(rest).map(([k, v]) => [k, scrub(v)])
    );
    linha = JSON.stringify({
      event,
      ...(phone ? { phone: phoneTag(phone) } : {}),
      ...limpos,
    });
  } catch (err) {
    // Valor circular, BigInt, getter que lança: o log degrada, o turn segue.
    linha = JSON.stringify({
      event,
      logError: err instanceof Error ? err.message : String(err),
    });
  }
  if (level === "error") console.error(linha);
  else if (level === "warn") console.warn(linha);
  else console.log(linha);
}

export const log = {
  info: (event: string, fields: LogFields = {}) => emit("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => emit("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => emit("error", event, fields),
};
