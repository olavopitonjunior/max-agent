/**
 * Chamada ao modelo, via OpenRouter, com a contabilidade de custo junto.
 *
 * **Mesmo provedor e mesmo modelo do Newton** (`openai/gpt-5.4-nano`), por
 * decisão de custo: os dois agentes fazem trabalho parecido — transmitir e
 * explicar processo — e o nano custa ~US$0,20/M de entrada contra alguns
 * dólares dos modelos grandes. Num canal de WhatsApp, onde cada mensagem é um
 * turn, essa diferença é o orçamento inteiro.
 *
 * O ImobPro é a fonte da verdade do gasto de IA (`/settings/ai-usage`), e o Max
 * roda fora dele — se este módulo não reportar, o painel de lá mente por
 * omissão. Por isso `complete` devolve o consumo em vez de escondê-lo.
 *
 * Uma linha de AIUsage **por modelo**, nunca agregada: um turn que usou dois
 * modelos somado num bucket só cobraria o caro a preço do barato, e esse número
 * alimenta o teto mensal por agente.
 */

import { fetchWithTimeout, LLM_TIMEOUT_MS } from "./http";

const BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Modelo padrão. Vem de env pra dar pra trocar sem deploy, mas o default
 * acompanha o Newton de propósito — divergir os dois só se houver motivo
 * medido, não por gosto.
 *
 * O `model` do AgentProfile do ImobPro é IGNORADO aqui: aquele campo carrega id
 * de modelo Anthropic, e o registry de lá já declara `supports.model: false`
 * para o Max justamente porque este runtime não o honra. Um seletor que não
 * seleciona nada é pior que a ausência do seletor.
 */
export const DEFAULT_MODEL = process.env.MAX_MODEL ?? "openai/gpt-5.4-nano";

export interface LlmUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  /**
   * Tokens do prompt que vieram do CACHE DE PREFIXO do provedor. É o campo que
   * torna a conta honesta: medido em 21/08, um turn com 1792 de 1956 tokens
   * cacheados custou US$ 0,00010614 enquanto a tabela de preços do ImobPro
   * dizia US$ 0,00042870 — **superestimativa de 304%**, porque a tabela não
   * tem como saber quanto do prompt foi reaproveitado.
   *
   * ── DISJUNTO de `promptTokens`, e isso é conversão nossa ─────────────────
   *
   * As duas famílias de provedor contam de jeitos opostos:
   *
   *  · **OpenAI/OpenRouter**: `prompt_tokens_details.cached_tokens` está DENTRO
   *    de `prompt_tokens` (1956 de prompt, dos quais 1792 cacheados);
   *  · **Anthropic**: `cache_read_input_tokens` é SEPARADO de `input_tokens`.
   *
   * O ImobPro adota a convenção da Anthropic — `calcCostUsd` soma as parcelas
   * (`promptTokens*input + cacheReadTokens*cacheRead`) e todo produtor de lá
   * popula assim. Mandar a contagem sobreposta faria os cacheados serem
   * contados DUAS vezes.
   *
   * Hoje isso não muda o custo, porque o `gpt-5.4-nano` não tem `cacheRead` na
   * tabela de preços e a parcela zera — mas é bomba armada: no dia em que
   * alguém cadastrar aquele preço, a estimativa vira `1956*input +
   * 1792*cacheRead` em vez de `164*input + 1792*cacheRead`. Pior que os 304%
   * que este trabalho veio corrigir.
   *
   * Por isso `promptTokens` sai daqui **já descontado**. Quem reconcilia com a
   * fatura do OpenRouter é o `generationId`, não a contagem de token — é
   * exatamente para isso que ele existe.
   */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Crédito REAL cobrado, direto do `usage.cost` do OpenRouter.
   *
   * **`null` quando o campo não vier — nunca 0.** Zero é um número, e um turn
   * que custou zero de verdade tem que ser distinguível de um que ninguém
   * mediu; o segundo precisa cair na tabela de preços do outro lado. O
   * receptor trata `null` como ausência e marca a linha como `estimated`.
   */
  costUsd: number | null;
  /**
   * `id` da resposta do OpenRouter. Não é usado hoje: existe para reconciliar
   * uma linha contra o `/v1/generation` deles quando alguém contestar a conta.
   * Sem ele, "por que este turn custou isso?" não tem resposta possível.
   */
  generationId: string | null;
  latencyMs: number;
  success: boolean;
}

/**
 * Ferramenta oferecida ao modelo, no formato do OpenAI/OpenRouter.
 *
 * `parameters` é JSON Schema. Fica como `unknown` de propósito: tipar o schema
 * aqui não valida nada em runtime (quem valida é o provedor) e só acrescentaria
 * um tipo para manter.
 */
export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  name: string;
  /** Já parseado. Vem como string JSON do provedor. */
  args: Record<string, unknown>;
}

export interface LlmResult {
  text: string;
  /**
   * Vazio quando o modelo respondeu em texto — o caso comum.
   *
   * Nunca há texto E chamada juntos no uso deste projeto: quando o modelo
   * chama ferramenta, quem escreve a resposta é o template, não ele.
   */
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
}

export interface CompleteParams {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Quando presente, o modelo pode chamar uma destas em vez de responder.
   *
   * Só é passado nos turns em que o prefiltro achou plausível — expor ferramenta
   * em toda mensagem custa tokens de entrada em TODO turn e dá ao nano mais
   * oportunidade de chamar sem motivo.
   */
  tools?: LlmTool[];
  /**
   * Prazo da chamada. Default `LLM_TIMEOUT_MS` (o teto do `answer`); as
   * chamadas curtas (compactação, extração de memória) passam
   * `LLM_SHORT_TIMEOUT_MS` — esperar 45s por um resumo de 5 linhas seguraria
   * a function pelo triplo do necessário.
   */
  timeoutMs?: number;
}

/**
 * `maxTokens` baixo de propósito: a resposta vai pro WhatsApp, onde texto longo
 * não é lido. Cortar aqui é mais honesto que gerar quatro parágrafos e truncar
 * na hora de enviar.
 */
const DEFAULT_MAX_TOKENS = 700;

interface OpenRouterToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenRouterResponse {
  /** Id da geração, para reconciliação via `/v1/generation`. */
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenRouterToolCall[] };
  }>;
  /**
   * O `usage` inline do OpenRouter já traz custo e cache — não exige nenhum
   * parâmetro no request. Até 22/08 este tipo declarava só os dois contadores
   * de token, e o resto era descartado na porta de entrada.
   */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** Crédito real cobrado, em USD. */
    cost?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
  };
  error?: { message?: string };
}

/**
 * Número do provedor → número nosso, com uma regra só: **o que não veio vira
 * `null`, nunca 0.** Um custo ausente carimbado como zero seria indistinguível
 * de um turn de graça, e o receptor perderia a chance de cair na estimativa.
 */
function custoDoProvedor(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Contador de token do provedor → inteiro não-negativo. */
function contador(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * Converte a contagem SOBREPOSTA do OpenAI/OpenRouter para a convenção
 * DISJUNTA que o ImobPro usa — ver o doc de `LlmUsage.cacheReadTokens`.
 *
 * `Math.max(0, ...)` porque um provedor que reportasse mais cacheados que
 * prompt (contraditório, mas nada garante que não aconteça) viraria um
 * `promptTokens` negativo — e negativo numa coluna que alimenta budget é pior
 * que impreciso.
 */
function separarCache(promptBruto: unknown, cacheadoBruto: unknown): {
  promptTokens: number;
  cacheReadTokens: number;
} {
  const prompt = contador(promptBruto);
  const cacheado = Math.min(contador(cacheadoBruto), prompt);
  return { promptTokens: Math.max(0, prompt - cacheado), cacheReadTokens: cacheado };
}

/**
 * Converte as chamadas do provedor, descartando o que não dá pra usar.
 *
 * `arguments` vem como STRING JSON, e um modelo pequeno às vezes devolve JSON
 * quebrado. Uma chamada sem nome ou com args ilegíveis é descartada em vez de
 * propagada: quem consome isto decide executar uma ação, e argumento adivinhado
 * é a pior coisa que se pode passar adiante. Descartar faz o turn cair no
 * caminho de texto, que é o comportamento seguro.
 */
function parseToolCalls(raw: OpenRouterToolCall[] | undefined): LlmToolCall[] {
  if (!raw?.length) return [];

  const out: LlmToolCall[] = [];
  for (const call of raw) {
    const name = call.function?.name;
    if (!name) continue;

    const rawArgs = call.function?.arguments?.trim();
    let args: Record<string, unknown> = {};
    if (rawArgs) {
      try {
        const parsed = JSON.parse(rawArgs);
        // `JSON.parse` aceita `"texto"`, `3` e `null` — nada disso é argumento.
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          console.warn(`[llm] args de ${name} não são objeto — chamada ignorada`);
          continue;
        }
        args = parsed as Record<string, unknown>;
      } catch {
        console.warn(`[llm] args de ${name} não são JSON — chamada ignorada`);
        continue;
      }
    }
    out.push({ name, args });
  }
  return out;
}

export async function complete(p: CompleteParams): Promise<LlmResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY não configurada");

  const model = p.model ?? DEFAULT_MODEL;
  const startedAt = Date.now();

  const fail = (message: string): never => {
    // O turn que falhou também custou tempo: sem registrar a tentativa, um
    // agente que só erra aparece no painel como um agente que não gasta nada.
    throw Object.assign(new Error(message), {
      usage: {
        model,
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        // Não houve cobrança conhecida — e `null` diz isso sem afirmar que
        // foi de graça.
        costUsd: null,
        generationId: null,
        latencyMs: Date.now() - startedAt,
        success: false,
      } satisfies LlmUsage,
    });
  };

  let data: OpenRouterResponse;
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Atribuição no painel do OpenRouter — separa o gasto do Max do
        // gasto do Newton, que usa a mesma conta.
        "HTTP-Referer": "https://max-agent-olive.vercel.app",
        "X-Title": "Max Agent (ImobPro)",
      },
      body: JSON.stringify({
        model,
        max_tokens: p.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: p.temperature ?? 0.3,
        messages: [{ role: "system", content: p.system }, ...p.messages],
        ...(p.tools?.length
          ? {
              tools: p.tools.map((t) => ({
                type: "function",
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                },
              })),
              // `auto` e não `required`: a esmagadora maioria dos turns é
              // pergunta de processo, e forçar chamada transformaria "como
              // funciona a assinatura?" numa proposta de criar formulário.
              tool_choice: "auto",
            }
          : {}),
      }),
    }, p.timeoutMs ?? LLM_TIMEOUT_MS);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return fail(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
    }
    data = (await res.json()) as OpenRouterResponse;
  } catch (err) {
    if (err instanceof Error && "usage" in err) throw err;
    return fail(err instanceof Error ? err.message : String(err));
  }

  // O OpenRouter responde 200 com `error` no corpo quando o roteamento falha
  // (modelo indisponível, sem crédito). Tratar como sucesso devolveria uma
  // resposta vazia ao usuário, em silêncio.
  if (data.error) return fail(`OpenRouter: ${data.error.message ?? "erro sem mensagem"}`);

  const message = data.choices?.[0]?.message;
  const text = (message?.content ?? "").trim();
  const toolCalls = parseToolCalls(message?.tool_calls);

  /**
   * Vazio só é falha quando NÃO houve chamada de ferramenta.
   *
   * Uma resposta com `tool_calls` traz `content: null` — é o formato normal, não
   * um erro. Antes desta linha o retorno vazio era falha incondicional, e ligar
   * ferramenta sem mexer aqui faria TODA chamada virar erro, com o agravante de
   * o `fail` registrar consumo com `success: false` e o usuário receber o texto
   * genérico de "tive um problema pra responder".
   */
  if (!text && toolCalls.length === 0) {
    return fail("OpenRouter devolveu resposta vazia");
  }

  return {
    text,
    toolCalls,
    usage: {
      // O provedor pode ter roteado pra outra variante; o custo é do que ELE
      // diz ter usado, não do que pedimos.
      model: data.model ?? model,
      // Descontado: o `cached_tokens` do OpenRouter vem DENTRO do
      // `prompt_tokens`, e o ImobPro conta as duas parcelas separadas.
      ...separarCache(
        data.usage?.prompt_tokens,
        data.usage?.prompt_tokens_details?.cached_tokens
      ),
      completionTokens: data.usage?.completion_tokens ?? 0,
      cacheWriteTokens: data.usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
      // O crédito que ELE cobrou, não o que a tabela de preços do ImobPro
      // acha que custou. `null` quando não vier — ver `custoDoProvedor`.
      costUsd: custoDoProvedor(data.usage?.cost),
      generationId: data.id ?? null,
      latencyMs: Date.now() - startedAt,
      success: true,
    },
  };
}
