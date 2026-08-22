/**
 * fetch com prazo — o único jeito de chamar upstream neste serviço.
 *
 * Sem timeout, um upstream pendurado consome o orçamento INTEIRO da function
 * (10–60s) e produz o pior modo de falha: a linha da fila fica em
 * `processing` até virar órfã e a pessoa espera 10+ minutos por uma resposta
 * que um erro rápido teria destravado em segundos. Nenhum `fetch` cru fora
 * daqui.
 *
 * Os orçamentos são por classe de upstream, não por chamada — mudou de
 * provedor, muda aqui:
 */

/** Z-API: API de mensageria, responde em ms; 10s já é generosidade. */
export const ZAPI_TIMEOUT_MS = 10_000;

/** ImobPro: consultas de identidade/RAG/escrita. A transcrição é a exceção —
 * sobe até 3 MB em base64 E espera o Gemini transcrever um áudio que pode ter
 * minutos; 20s cortava exatamente as mídias que MAX_MEDIA_BYTES aceita
 * (achado do code review), então ela usa a classe do LLM. */
export const IMOBPRO_TIMEOUT_MS = 8_000;
export const IMOBPRO_TRANSCRIBE_TIMEOUT_MS = 45_000;

/**
 * Alerta de canal: o receptor manda o E-MAIL antes de responder, e um SMTP em
 * cold start (boot da function + `import("nodemailer")` + TLS + AUTH + envio,
 * mais uma conexão Prisma quando o destinatário vem do banco) passa dos 8s com
 * facilidade.
 *
 * O estrago de errar isto para baixo é específico e feio: o e-mail SAI, nós
 * desistimos por timeout, o claim é desfeito e o cron manda tudo de novo um
 * minuto depois — alerta duplicado em série, justamente durante o incidente.
 * O alerta é raro (só na transição), então esperar não custa nada; o cron tem
 * `maxDuration = 60`, e 25s deixa folga para o despacho da fila depois.
 */
export const IMOBPRO_ALERT_TIMEOUT_MS = 25_000;

/** LLM: a resposta longa de um modelo lento. O `answer` usa o teto cheio;
 * compactação e extração de memória são curtas e não merecem esperar tanto. */
export const LLM_TIMEOUT_MS = 45_000;
export const LLM_SHORT_TIMEOUT_MS = 20_000;

/**
 * A base do ImobPro, num lugar só — estava duplicada entre `cm.ts` e
 * `identity.ts`, e divergir as duas apontaria identidade e escrita para
 * ambientes diferentes sem nenhum erro visível.
 */
export const imobproBase = (): string =>
  process.env.CONTRACTMAKER_API_URL ?? "https://imobpro.ia.br";

/**
 * `AbortSignal.timeout` lança `TimeoutError` (DOMException); a mensagem crua
 * ("The operation was aborted due to timeout") não diz QUEM estourou. O
 * wrapper traduz para um erro que carrega a URL e o prazo — é o que vai parar
 * em `last_error` e no log.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`timeout de ${timeoutMs}ms em ${new URL(url).host}${new URL(url).pathname}`);
    }
    throw err;
  }
}
