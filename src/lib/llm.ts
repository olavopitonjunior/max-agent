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
  latencyMs: number;
  success: boolean;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
}

export interface CompleteParams {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * `maxTokens` baixo de propósito: a resposta vai pro WhatsApp, onde texto longo
 * não é lido. Cortar aqui é mais honesto que gerar quatro parágrafos e truncar
 * na hora de enviar.
 */
const DEFAULT_MAX_TOKENS = 700;

interface OpenRouterResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
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
        latencyMs: Date.now() - startedAt,
        success: false,
      } satisfies LlmUsage,
    });
  };

  let data: OpenRouterResponse;
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
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
      }),
    });

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

  const text = (data.choices?.[0]?.message?.content ?? "").trim();
  if (!text) return fail("OpenRouter devolveu resposta vazia");

  return {
    text,
    usage: {
      // O provedor pode ter roteado pra outra variante; o custo é do que ELE
      // diz ter usado, não do que pedimos.
      model: data.model ?? model,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - startedAt,
      success: true,
    },
  };
}
