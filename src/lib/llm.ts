import Anthropic from "@anthropic-ai/sdk";

/**
 * Chamada ao modelo, com a contabilidade de custo junto.
 *
 * O ImobPro é a fonte da verdade do gasto de IA (`/settings/ai-usage`), e o Max
 * roda fora dele — se este módulo não reportar, o painel de lá mente por
 * omissão: o custo do agente simplesmente não existe. Por isso `complete`
 * devolve o consumo em vez de escondê-lo, e o chamador manda pra
 * `POST /api/agents/usage`.
 *
 * Uma linha de AIUsage **por modelo**, nunca agregada: um turn que usou dois
 * modelos somado num bucket só cobraria o caro a preço do barato, e esse número
 * alimenta o teto mensal por agente.
 */

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY não configurada");
    client = new Anthropic({ apiKey });
  }
  return client;
}

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
  model: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * `maxTokens` baixo de propósito: a resposta vai pro WhatsApp, onde texto longo
 * não é lido. Cortar aqui é mais honesto que gerar quatro parágrafos e truncar
 * na hora de enviar.
 */
const DEFAULT_MAX_TOKENS = 700;

export async function complete(p: CompleteParams): Promise<LlmResult> {
  const startedAt = Date.now();
  try {
    const res = await anthropic().messages.create({
      model: p.model,
      max_tokens: p.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: p.temperature ?? 0.3,
      system: p.system,
      messages: p.messages,
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    return {
      text,
      usage: {
        model: res.model,
        promptTokens: res.usage.input_tokens,
        completionTokens: res.usage.output_tokens,
        latencyMs: Date.now() - startedAt,
        success: true,
      },
    };
  } catch (err) {
    // O turn falhado também conta: sem registrar a tentativa, um agente que só
    // erra aparece no painel como um agente que não custa nada.
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      usage: {
        model: p.model,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - startedAt,
        success: false,
      } satisfies LlmUsage,
    });
  }
}
