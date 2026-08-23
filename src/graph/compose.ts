import { NOMES_DE_TOOL } from "./tools";

/**
 * Sanitizador de saída — a última coisa entre o modelo e o WhatsApp.
 *
 * ── Por que existe ────────────────────────────────────────────────────────
 *
 * Quem lê é uma pessoa no celular. JSON, nome de ferramenta, `<etiqueta>`,
 * stack trace, id interno e nome de modelo não são respostas ruins: são
 * ENCANAMENTO, e encanamento na conversa quebra a ilusão, entrega desenho
 * interno a quem estiver sondando e, no caso do id, vaza chave de linha do
 * banco de um tenant.
 *
 * O nano erra pouco nisso, mas erra — e o modo de falha é silencioso: ninguém
 * revisa a mensagem antes de ela chegar. É o mesmo argumento que já vale para
 * o texto de confirmação sair de template.
 *
 * ── O que ele NÃO toca, e por que isso é estrutural ───────────────────────
 *
 * **Texto de template não passa por aqui.** Não por disciplina de quem chama:
 * por caminho. O texto do modelo nunca vira `state.reply` diretamente — ele
 * cai em `state.draft`, e o ÚNICO consumidor de `draft` é o nó `compose`, que
 * sanitiza antes de promover a `reply`. Quem um dia quiser emitir texto gerado
 * tem que passar por `draft`, e não existe atalho de `complete().text` para
 * `reply`.
 *
 * Isso não é preciosismo. `textoCriado()` devolve a URL do formulário recém
 * criado — `https://imobpro.ia.br/f/<token>/<slug>` —, e o padrão de id interno
 * daqui casaria com esse token. Sanitizar template mataria o link que é a razão
 * de o turno existir.
 *
 * ── Corte por LINHA, não por trecho ───────────────────────────────────────
 *
 * Achado o padrão, cai a linha inteira. Remover só o trecho deixaria
 * "Vou chamar  pra você" — pior que a linha ausente, porque parece resposta e
 * não é. Se nada sobrar de pé, entra um texto humano de template: dizer que a
 * resposta não saiu é melhor que mandar meia frase.
 */

/**
 * O que sobrou ainda é uma resposta?
 *
 * **Não é medida de comprimento.** A primeira versão exigia 12 caracteres e
 * reprovava "Tudo certo." e "Já vi aqui." — respostas perfeitas num canal cujo
 * próprio prompt manda escrever em duas ou três frases. Trocar uma resposta
 * curta e correta por "não consegui montar a resposta" é um fracasso inventado,
 * e seria o caso COMUM.
 *
 * Sobram dois testes, e cada um pega um resto diferente:
 *
 *  - **Nenhuma palavra.** Se o que ficou não tem sequer uma sequência de duas
 *    letras, é pontuação órfã da linha derrubada.
 *  - **Termina em dois-pontos.** É a introdução cuja carga era exatamente o que
 *    caiu ("Segue:" + o JSON). Frase pela metade parece resposta e não é — o
 *    defeito que o corte por linha existe para evitar.
 */
function aindaEResposta(texto: string): boolean {
  return /\p{L}{2,}/u.test(texto) && !texto.endsWith(":");
}

export const TEXTO_SAIDA_INVALIDA =
  "Não consegui montar a resposta direito agora. Pode repetir a pergunta?";

/**
 * Um padrão por risco, com nome — o nome vai para a auditoria do turn.
 *
 * Nomear em vez de devolver um booleano é o que permite afrouxar o padrão que
 * estiver pegando resposta legítima sem afrouxar os outros seis.
 */
const PADROES: { padrao: string; re: RegExp }[] = [
  {
    /**
     * Objeto/array literal e bloco de código cercado. Uma frase de WhatsApp não
     * tem `{"chave":` nem abre ``` — o padrão é específico o bastante para não
     * pegar uma chave usada como pontuação.
     */
    padrao: "json",
    re: /```|\{\s*["'`]?[\w-]+["'`]?\s*:|^\s*[[\]{}]+\s*$|"\w+"\s*:\s*["[{\d]/,
  },
  {
    /**
     * Nome de ferramenta do catálogo, e o vocabulário de tool-calling que o
     * modelo às vezes narra ("vou emitir um tool_call").
     *
     * A lista vem do catálogo, não daqui: quando o PR 6 acrescentar as tools de
     * leitura, elas passam a ser bloqueadas sem ninguém lembrar deste arquivo.
     */
    padrao: "nome_de_tool",
    re: new RegExp(
      `\\b(${NOMES_DE_TOOL.join("|")}|tool_?calls?|function_?call|tool_?use)\\b`,
      "i"
    ),
  },
  {
    /**
     * Etiqueta XML/HTML — inclusive as nossas (`<material>`, e em breve
     * `<dados_do_sistema>`), que é o caso que mais importa: o modelo repetindo a
     * cerca revelaria a estrutura do prompt.
     *
     * Exige letra COLADA no `<`, então "valor entre 300 < x > 400" não casa.
     */
    padrao: "tag",
    re: /<\/?[a-z][a-z0-9_-]*(\s[^<>]*)?\/?>/i,
  },
  {
    /**
     * O nome de classe de erro, e SÓ ele é case-sensitive.
     *
     * A versão anterior era `\b\w*error\b` sob `/i`, e comia **"terror"**:
     * "Que terror esse trânsito na Faria Lima" virava o texto de contingência.
     * É o modo de falha silencioso que o cabeçalho deste arquivo diz existir
     * para evitar, e "terror" não é palavra rara num brasileiro falando de
     * trânsito, juro ou burocracia.
     *
     * `\w*Error` (camelCase) pega `TypeError`/`ReferenceError`; `error` e
     * `ERROR` soltos pegam a forma que o modelo escreve ao narrar a falha. O
     * que deixa de casar é "error" GRUDADO dentro de palavra portuguesa, que
     * era o defeito inteiro.
     */
    padrao: "stack_trace",
    re: /\b\w*Error\b|\berror\b|\bERROR\b/,
  },
  {
    /** O resto do vocabulário de falha técnica — aqui o `/i` é seguro. */
    padrao: "stack_trace",
    re: /\bat\s+[\w$.]+\s*\(|\bat\s+\/[\w./-]+:\d+|\becon\w*refused\b|\betimedout\b|\bstack ?trace\b|\bundefined\b|\bnull pointer\b|\b(4|5)\d{2}\s+(bad request|unauthorized|forbidden|not found|internal server)/i,
  },
  {
    /**
     * Id interno: uuid e cuid. É o padrão mais perigoso dos sete — casa com o
     * token do link de formulário —, e é exatamente por isso que texto de
     * template não passa por aqui (ver o cabeçalho).
     *
     * O cuid exige ao menos um dígito entre os 24 caracteres: sem isso, uma
     * palavra de 25 letras começando com "c" viraria falso positivo.
     */
    padrao: "id_interno",
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\bc(?=[a-z0-9]{24}\b)(?=[a-z0-9]*\d)[a-z0-9]{24}\b/i,
  },
  {
    /**
     * Nome de modelo ou de provedor.
     *
     * `claude`, `gemini` e `llama` NÃO entram soltos, pela mesma decisão
     * registrada na deny-list (`prompt.ts`): existem prédios chamados Gemini, e
     * "O imóvel fica no Edifício Gemini, na Vila Olímpia" era derrubado inteiro
     * — a pessoa recebia o texto de contingência por ter dito um endereço.
     *
     * O que continua caindo é a forma que de fato vaza encanamento: o id com
     * barra (`openai/gpt-5.4-nano`), a versionada (`claude-3`, `gemini 1.5`) e a
     * auto-apresentação ("sou o Claude"), que é o vazamento que interessa.
     */
    padrao: "nome_de_modelo",
    re: /\b(openai|anthropic|google|meta-llama|mistralai|deepseek|x-ai|qwen|openrouter)\/[\w.:-]+|\b(chat ?gpt|gpt-[\w.]+|openrouter|langgraph|langchain)\b|\b(claude|gemini|llama|grok|mistral)[\s-]?v?\d|\b(sou|eu sou|me chamo|aqui e)\s+(o\s+|a\s+)?(claude|gemini|llama|grok)\b/i,
  },
  {
    /**
     * Segredo e configuração. Um modelo que resolva "explicar" de onde tirou a
     * resposta não pode nomear variável de ambiente nem chave.
     */
    padrao: "config",
    re: /\bprocess\.env\b|\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)*_(KEY|SECRET|TOKEN|URL|ID|PASSWORD|DSN)\b|\b(api[- ]?key|bearer\s+[\w.-]{8,})\b/,
  },
];

/**
 * Link da própria plataforma é ENTREGA, não encanamento.
 *
 * O `id_interno` casa com o token de um link de formulário
 * (`/f/<cuid>/joao-silva`) e com o id de uma proposta
 * (`/pipeline/propostas/<cuid>/editar`). Eu tinha argumentado que isso era
 * inofensivo porque texto de template não passa pelo sanitizador — e estava
 * **errado por um caminho que não vi**: o link volta ao histórico no turn em
 * que o template o escreveu, e no turn seguinte a pessoa diz "me manda o link
 * de novo". Aí quem escreve a URL é o MODELO, o padrão dispara, a linha inteira
 * cai e não sobra nada — a pessoa recebe "não consegui montar a resposta"
 * exatamente quando pediu a coisa mais simples da conversa. Achado em code
 * review, reproduzido antes de consertar.
 *
 * A URL da plataforma é mascarada ANTES da varredura e devolvida depois. Vale
 * para todos os padrões, não só o do id: um link para o nosso próprio produto
 * não é vazamento — quem abre precisa de sessão, e o que o guardrail persegue é
 * o identificador SOLTO na conversa, que continua caindo.
 */
const URL_DA_PLATAFORMA = /https?:\/\/[\w-]+(\.[\w-]+)*\.ia\.br\/\S*/gi;
const MASCARA = " link ";

export interface Saida {
  /** O que pode ser enviado. */
  texto: string;
  /** Nomes dos padrões que dispararam. Vazio = passou limpo. */
  bloqueios: string[];
}

/**
 * Deixa passar o que é conversa; derruba a linha que é encanamento.
 *
 * Determinístico e sem modelo: um segundo LLM revisando o primeiro custaria
 * outro turn e teria a mesma chance de errar.
 */
export function sanitizar(bruto: string): Saida {
  const bloqueios = new Set<string>();

  const linhas = bruto.split("\n").filter((linha) => {
    if (!linha.trim()) return true;
    // A linha é julgada SEM as URLs da plataforma — mas o que sobrevive é a
    // linha original, com elas. Ver `URL_DA_PLATAFORMA`.
    const julgada = linha.replace(URL_DA_PLATAFORMA, MASCARA);
    const achados = PADROES.filter((p) => p.re.test(julgada));
    achados.forEach((p) => bloqueios.add(p.padrao));
    return achados.length === 0;
  });

  // Sobra de linha em branco onde a linha derrubada estava: duas em sequência
  // viram uma, e as das pontas somem.
  const texto = linhas
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (bloqueios.size === 0) return { texto: bruto, bloqueios: [] };

  if (!aindaEResposta(texto)) {
    return {
      texto: TEXTO_SAIDA_INVALIDA,
      // `vazio` é o desfecho, não um padrão — mas entra na mesma lista porque
      // quem lê a auditoria quer saber, em um campo só, que a pessoa recebeu o
      // texto de contingência e não a resposta.
      bloqueios: [...bloqueios, "vazio"],
    };
  }

  return { texto, bloqueios: [...bloqueios] };
}
