import { NOMES_DE_TOOL } from "./tools";
import { NEGRITO_MARKDOWN } from "@/lib/whatsapp-formato";

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

// ─── Código interno que escapa para a conversa ──────────────────────────────

/**
 * Produção 10/11/2026: "o sistema retornou **sem_permissao** para o negócio X"
 * e "está em Formulário (n=5). Quer que eu abra esse **n=5**". `sem_permissao`
 * é o marcador do resultado de consulta e `n` é o campo de numeração da lista:
 * dado interno que o modelo copiou para a frase. O prompt já pede para não
 * escrever isso; aqui é a rede de segurança, no código, por palavra (não por
 * linha: a frase em volta é boa e perder a linha esconderia a resposta).
 */
const CODIGOS_INTERNOS: [RegExp, string][] = [
  [/\bsem_permissao\b/gi, "sem permissão"],
  [/\breferencia_invalida\b/gi, "referência inválida"],
  [/\bnegocio_nao_encontrado\b/gi, "negócio não encontrado"],
  [/\b(?:sem_lista|fora_da_lista)\b/gi, "item fora da lista"],
];

/** Trechos em que um `snake_case` é conteúdo, não vazamento: URL, e-mail, código entre crases. */
const TRECHO_PROTEGIDO = /https?:\/\/\S+|[^\s@]+@[^\s@]+\.[^\s@]+|`[^`\n]*`/g;
const SNAKE_CASE = /\b[a-z]+(?:_[a-z]+)+\b/g;

/**
 * Rede genérica: qualquer `snake_case` fora de URL/e-mail/código é código
 * interno que escapou (`falha_envio`, `aguardando_aprovacao`). Os underscores
 * viram espaço (a frase em volta fica legível e o dado não é inventado) e o
 * token entra no log, para quem depura saber que o modelo copiou encanamento.
 */
function humanizarSnakeCase(texto: string): string {
  const achados = new Set<string>();
  let fim = 0;
  let saida = "";
  const trocar = (trecho: string) =>
    trecho.replace(SNAKE_CASE, (m) => {
      achados.add(m);
      return m.replace(/_/g, " ");
    });
  for (const m of texto.matchAll(TRECHO_PROTEGIDO)) {
    const ini = m.index ?? 0;
    saida += trocar(texto.slice(fim, ini)) + m[0];
    fim = ini + m[0].length;
  }
  saida += trocar(texto.slice(fim));
  if (achados.size > 0) console.warn(`[compose] código interno na resposta humanizado: ${[...achados].join(", ")}`);
  return saida;
}

export function humanizarCodigosInternos(texto: string): string {
  let t = texto;
  for (const [re, troca] of CODIGOS_INTERNOS) t = t.replace(re, troca);
  t = humanizarSnakeCase(t);
  // "(n=5)" some inteiro, com o espaço que o antecede.
  t = t.replace(/[ \t]*\(\s*n\s*=\s*\d+\s*\)/gi, "");
  // "n=5" solto vira "item 5" (a pessoa vê a lista numerada).
  t = t.replace(/\bn\s*=\s*(\d+)\b/gi, "item $1");
  return t;
}

// ─── Vocativo errado ────────────────────────────────────────────────────────

const INTERJEICAO =
  "Perfeito|Certo|Ok|Okay|Beleza|Combinado|Entendido|Claro|Ótimo|Otimo|Show|Pronto|Legal|Obrigado|Obrigada|Valeu|Bom dia|Boa tarde|Boa noite|Olá|Ola|Oi";

/** Palavra de abertura que parece nome mas é conversa ("Resumindo,", "Primeiro,"). */
const NAO_E_NOME = new Set(
  [
    "sim", "nao", "entao", "infelizmente", "claro", "perfeito", "certo", "ok", "beleza", "ola", "oi", "otimo", "show", "pronto",
    "obrigado", "obrigada", "desculpa", "desculpe", "bom", "boa", "aqui", "agora", "hoje", "ainda", "assim", "tambem", "porem",
    "mas", "se", "quando", "como", "para", "por", "sobre", "segundo", "primeiro", "terceiro", "antes", "depois", "enquanto",
    "alias", "veja", "olha", "importante", "atencao", "cuidado", "lembrando", "resumindo", "basicamente", "normalmente",
    "geralmente", "atualmente", "provavelmente", "possivelmente", "exatamente", "realmente", "novamente", "apenas", "so",
    "tudo", "nada", "algo", "isso", "esse", "essa", "este", "esta", "outro", "outra", "ja", "la", "ali", "entretanto",
    "contudo", "portanto", "logo", "dessa", "desse", "nesse", "nessa", "neste", "nesta", "em", "no", "na", "de", "do", "da",
  ]
);

function semAcento(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * Tira do COMEÇO da resposta o vocativo que não é de quem está escrevendo.
 *
 * Prod 10/11/2026: "Perfeito, João" para o Olavo — João era o cliente de um
 * negócio. Na causa (memória que aprendia o próprio vocativo do assistente) o
 * código já foi corrigido; esta é a rede por baixo, no código, porque o modelo
 * mistura nome de cliente com nome de quem fala. Só olha a primeira linha:
 *  - "Interjeição, Nome" + pontuação → tira o nome (quando não for a pessoa E o
 *    nome aparecer no contexto do turno: sem isso "Ok, Feito!" perderia o "Feito");
 *  - "Nome, frase em minúscula" → só quando "Nome" aparece no contexto do turno
 *    (negócios, mensagens): "Resumindo, ..." e "Infelizmente, ..." não são nome.
 */
export function corrigirVocativo(texto: string, ctx: { nomeDaPessoa: string | null; contexto?: string }): string {
  if (!ctx.nomeDaPessoa) return texto;
  const dela = new Set(semAcento(ctx.nomeDaPessoa).split(/\s+/).filter(Boolean));
  const conhecidos = semAcento(ctx.contexto ?? "");

  const a = new RegExp(`^(${INTERJEICAO}),\\s+(\\p{Lu}\\p{L}{1,})([,!.:])(\\s+|$)`, "u").exec(texto);
  if (a) {
    const nome = semAcento(a[2]);
    // Só some quando o nome é de alguém DO TURNO (cliente, negócio, mensagem):
    // "Ok, Feito!" não tem nome nenhum, e tirar "Feito" quebraria a frase.
    // Grafado com maiúscula no contexto: "feito" minúsculo numa frase da pessoa
    // não faz de "Feito" um nome.
    const grafado = a[2].normalize("NFD").replace(/\p{Diacritic}/gu, "");
    const noContexto = new RegExp(`\\b${grafado}\\b`).test((ctx.contexto ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, ""));
    if (!dela.has(nome) && !NAO_E_NOME.has(nome) && noContexto) {
      const resto = texto.slice(a[0].length);
      const abertura = a[3] === "," ? `${a[1]}, ` : `${a[1]}${a[3]} `;
      return `${abertura}${resto}`;
    }
    return texto;
  }

  const b = /^(\p{Lu}\p{L}{1,}),\s+(\p{Ll})/u.exec(texto);
  if (b) {
    const nome = semAcento(b[1]);
    const pareceConversa = NAO_E_NOME.has(nome) || /(mente|ndo)$/.test(nome);
    const ehDeTerceiro = !dela.has(nome) && !pareceConversa && new RegExp(`\\b${nome}\\b`).test(conhecidos);
    if (ehDeTerceiro) {
      return b[2].toUpperCase() + texto.slice(b[0].length);
    }
  }
  return texto;
}

// ─── Markdown do modelo → formatação do WhatsApp ────────────────────────────

/**
 * O modelo escreve markdown (`**negrito**`, `__x__`, `## título`) e o WhatsApp
 * mostra os caracteres crus (prod 16/11: "**1**", "**certidões pendentes**").
 * No WhatsApp o negrito é `*x*` e o itálico `_x_`; título não existe.
 *
 * Determinístico, no único ponto por onde o texto do MODELO sai (`compose`).
 * Texto de template já nasce em sintaxe de WhatsApp e não passa por aqui.
 * Nunca toca em `*` simples: é o negrito certo.
 */
export function paraWhatsApp(texto: string): string {
  return texto
    // `**x**`: a mesma regra do ponto de saída (`paraFormatoWhatsapp`, #169), que não
    // corrompe máscara de documento (`***.456.789-**`), `2**3` nem URL.
    .replace(NEGRITO_MARKDOWN, "*$1*")
    // `__x__` só quando os sublinhados não estão colados em palavra (snake__case__nome, URL).
    .replace(/(?<![\p{L}\p{N}_])__(?=[^\s_])([^_\n]*?[^\s_])__(?![\p{L}\p{N}_])/gu, "_$1_")
    // Marcador de título no começo da linha.
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
}

// ─── G6 — teto de tamanho, imposto no código ────────────────────────────────

/**
 * ≤ 500 caracteres e ≤ 6 linhas, contando o "Quer ver o resto?".
 *
 * No código, e não só no prompt: o prompt já pede "curto", e o nano obedece
 * quase sempre — o "quase" é o que a métrica 4 do plano mede (respostas acima
 * do teto: 0). Um teto que depende de o modelo obedecer não é teto.
 */
export const TETO_CARACTERES = 500;
export const TETO_LINHAS = 6;
export const SUFIXO_RESTO = "Quer ver o resto?";

/**
 * Corta no último limite NATURAL que cabe: fim de linha ou fim de frase; na
 * falta, o último espaço; e só em último caso no meio. Frase cortada no meio
 * parece resposta e não é — o mesmo defeito que o sanitizador evita cortando
 * por linha.
 *
 * Devolve o `resto` para quem chama guardar e mandar se a pessoa pedir. `null`
 * = coube inteiro, e aí o texto volta INTACTO (nem o espaço das pontas muda).
 */
export function limitarTamanho(texto: string): { texto: string; resto: string | null } {
  let t = texto.trim();
  if (t.length <= TETO_CARACTERES && t.split("\n").length <= TETO_LINHAS) {
    return { texto, resto: null };
  }

  // Separadores vazios não justificam esconder palavras ou pedir continuação.
  // Só compacta após exceder o teto; preserva todas as linhas com conteúdo.
  t = t.split("\n").filter((linha) => linha.trim().length > 0).join("\n");
  if (t.length <= TETO_CARACTERES && t.split("\n").length <= TETO_LINHAS) {
    return { texto: t, resto: null };
  }

  // O sufixo ocupa uma linha e seus caracteres: o orçamento do corpo desconta.
  const orcamentoChars = TETO_CARACTERES - SUFIXO_RESTO.length - 1;
  const orcamentoLinhas = TETO_LINHAS - 1;

  // Primeiro por linhas — o prefixo de linhas inteiras é prefixo do texto.
  let candidato = t.split("\n").slice(0, orcamentoLinhas).join("\n");
  let corte = candidato.length;

  if (candidato.length > orcamentoChars) {
    candidato = candidato.slice(0, orcamentoChars);
    // Um limite natural só vale se não deixar a parte minúscula: cortar em 20
    // caracteres para "respeitar a frase" jogaria quase tudo no resto.
    const minimo = Math.floor(orcamentoChars * 0.3);
    const fimDeFrase = Math.max(
      ...[...candidato.matchAll(/[.!?…](?=\s|$)/g)].map((m) => (m.index ?? -1) + 1),
      -1
    );
    const fimDeLinha = candidato.lastIndexOf("\n");
    const natural = Math.max(fimDeFrase, fimDeLinha);
    const espaco = candidato.lastIndexOf(" ");
    corte =
      natural >= minimo ? natural : espaco >= minimo ? espaco : orcamentoChars;
  }

  const parte = t.slice(0, corte).trimEnd();
  const resto = t.slice(corte).trim();
  if (!resto) return { texto: parte, resto: null };
  return { texto: `${parte}\n${SUFIXO_RESTO}`, resto };
}

// ─── Afirmação de criação que não aconteceu ─────────────────────────────────

/**
 * A resposta que substitui um "criei" que não aconteceu — por MODO de criação:
 * oferecer "me diga criar proposta" a quem não pode criar mandaria a pessoa a
 * um caminho fechado.
 */
export const TEXTO_NADA_CRIADO =
  'Ainda não criei nada por aqui. Se quiser o rascunho, me diga "criar proposta ' +
  'de venda" (ou de locação) e eu preparo para você confirmar.';
export const TEXTO_NADA_CRIADO_SEM_CRIACAO =
  "Ainda não criei nada por aqui: a criação é feita pelo sistema.";

/**
 * Toda escrita de verdade sai por TEMPLATE (`textoCriado`, `textoProposta`) e
 * não passa pelo `compose`. Logo, afirmação de CONCLUSÃO em `draft` é falsa
 * por construção. Conversa real de 2026-10-06: "Ok, proposta de venda rascunho
 * criada" sem nenhuma proposta no banco.
 *
 * Estreito de propósito (code review do #55): o Max EXPLICA o processo o tempo
 * todo — "a proposta é criada em rascunho", "a ficha precisa ser criada pela
 * imobiliária", "o link que te enviei" —, e trocar essas respostas por "não
 * criei nada" seria a mentira do outro lado. Por isso:
 *  - primeira pessoa só com verbo de criação, nunca "enviei/mandei" (o link
 *    real foi enviado por template e o modelo o cita depois), e não negada;
 *  - particípio só colado no objeto sem verbo genérico/passivo no meio ("é",
 *    "será", "precisa ser", "quando", "não"...).
 */
const AFIRMA_EM_PRIMEIRA_PESSOA = /(?<!\bnao )\b(criei|gerei|cadastrei|registrei)\b/;
const AFIRMA_OBJETO_CRIADO =
  /\b(?:proposta|formulario|ficha|rascunho|cadastro)\b(?:(?!\b(?:e|sera|seja|ser|sao|quando|pode|podem|precisa|precisam|deve|nao|depois|antes|vai|vou)\b)[^.\n]){0,40}\b(?:criad[oa]s?|gerad[oa]s?)\b/;

/**
 * Afirmação de ENVIO para assinatura sem envio no turn (prod 07/10: "a proposta
 * já foi enviada para assinatura" com o rascunho intacto e zero envelopes). O
 * envio real sai por template (`fluxos.ts`), nunca por `draft`.
 */
const AFIRMA_ENVIO =
  /(?<!\bnao )\b(enviei|encaminhei|disparei|mandei|enviamos|mandamos|encaminhamos)\b[^.\n]{0,40}\bassinatura\b|(?<!\bnao )\b(foi|ja foi|esta sendo)\s+(enviad|encaminhad|disparad)[oa]s?\b[^.\n]{0,40}\bassinatura\b|(?<!\bnao )\bfoi (pra|para) (a )?assinatura\b|\bseguindo (para|pra) (a )?assinatura\b|\bvou (enviar|encaminhar|disparar|mandar)\b[^.\n]{0,40}\bassinatura\b|\b(enviando|encaminhando)\b[^.\n]{0,40}\bassinatura\b/;

export const TEXTO_NADA_ENVIADO =
  'Ainda não enviei nada para assinatura. Para enviar, me diga "enviar proposta para assinatura" e eu confirmo os assinantes com você.';
export const TEXTO_NADA_ENVIADO_SEM_ENVIO =
  "Ainda não enviei nada para assinatura: o envio é feito pelo sistema.";

/** O texto do modelo AFIRMA ter enviado (ou estar enviando) algo para assinatura? */
export function afirmaEnvio(texto: string): boolean {
  const t = texto.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return AFIRMA_ENVIO.test(t);
}

/**
 * O modelo livre ENCENANDO o fluxo: pedindo "responda SIM" ou "responda com um
 * número" (prod 07/10: inventou a confirmação e o menu de assinatura). Toda
 * confirmação e todo menu numerado saem de template; no texto livre, é teatro.
 */
/** Dirigido à pessoa (início de frase): "Responda SIM", "Digite 1 ou 2". */
const ENCENA_CONFIRMACAO = /(^|[.!?:\n]\s*)(responda|responde|digite)\b[^.\n]{0,25}\b(sim|1 ou 2)\b/;
/** Menu numerado montado pelo modelo + "responda com o número". */
const ENCENA_MENU = /(^|[.!?:\n]\s*)(responda|responde|digite)\b[^.\n]{0,25}\bcom (o|um) numero\b/;

export const TEXTO_SEM_ENCENACAO =
  'Para eu criar ou enviar algo, sou eu que conduzo pelo sistema. Me diga o que quer fazer — por exemplo, "enviar a proposta para assinatura" ou "criar uma proposta".';

export function encenaConfirmacao(texto: string): boolean {
  const t = texto.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\*/g, "");
  if (ENCENA_CONFIRMACAO.test(t)) return true;
  return ENCENA_MENU.test(t) && /^\s*\d[.)]?\s+\S/m.test(t);
}

/** O texto do modelo AFIRMA ter concluído uma criação? */
export function afirmaCriacao(texto: string): boolean {
  const t = texto.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return AFIRMA_EM_PRIMEIRA_PESSOA.test(t) || AFIRMA_OBJETO_CRIADO.test(t);
}

// ─── Promessa em presente/futuro que o turno não cumpriu ────────────────────

/**
 * W45–W46: "Perfeito, ajusto o complemento" / "vou ajustar" / "já atualizo" /
 * "assim que tiver o status, eu te atualizo por aqui" — e nada foi gravado, nem
 * há como o Max voltar a falar sozinho depois. É a mesma mentira do "criei", só
 * que no futuro, e o `travarCriacaoFalsa` só enxergava o passado.
 *
 * Sem escrita no turno, a FRASE da promessa cai e entra um texto de template
 * (o resto da resposta fica: o status que veio junto continua valendo). Três
 * desfechos, por o que a frase prometia:
 *  - aviso/atualização POSTERIOR → diz o que o Max não faz sozinho e onde ver;
 *  - alteração de um campo conhecido → pergunta concreta que leva ao fluxo;
 *  - alteração sem alvo → nada foi alterado, diga o que mudar.
 *
 * Estreito de propósito (mesma lição do #55): só primeira pessoa COMPROMETENDO-SE
 * ("vou", "já", "perfeito, ajusto", "te aviso", "será ajustado"). "Quer que eu
 * ajuste?", "posso ajustar" e "se confirmar, eu mostro" são oferta/pergunta e
 * passam — o que leva a pessoa ao fluxo é exatamente a oferta.
 */
const VERBOS_DE_ALTERACAO =
  "ajust\\w+|atualiz\\w+|alter\\w+|corrig\\w+|mud\\w+|troc\\w+|edit\\w+|anot\\w+|registr\\w+|salv\\w+|grav\\w+|aplic\\w+";
const NORM = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

const PROMETE_FUTURO = new RegExp(
  `\\b(?:vou|irei|vamos|iremos)\\s+(?:te\\s+|lhe\\s+)?(?:${VERBOS_DE_ALTERACAO}|avis\\w+|notific\\w+|retorn\\w+|cri\\w+|ger\\w+|cadastr\\w+)\\b`
);
/** "Ajusto…", "Já atualizo…", "Perfeito, ajusto…": presente comprometendo, no início da frase. */
const PROMETE_PRESENTE_ANCORADO = new RegExp(
  `^(?:(?:ja|agora|entao|perfeito|certo|ok|okay|beleza|combinado|pode deixar|claro|entendido)\\b[,.!;:]?\\s+)*(?:eu\\s+)?(?:ajusto|atualizo|altero|corrijo|mudo|troco|edito|anoto|aplico|notifico)\\b`
);
/** "Ajusto o valor e te aviso": a segunda metade também promete. */
const PROMETE_PRESENTE_COORDENADO = /\b(?:e|depois)\s+(?:eu\s+)?(?:ajusto|atualizo|altero|corrijo|aviso|notifico)\b/;
const PROMETE_AVISO = /\b(?:te|lhe)\s+(?:atualizo|aviso|notifico|retorno|informo)\b|\bavisarei\b|\batualizarei\b/;

/** Passiva de alteração: "será ajustado/atualizado/corrigido…" (particípio, não "será feito pela imobiliária"). */
const PROMETE_PASSIVA_ALTERACAO = /\b(?:sera|serao|ficara|ficarao)\s+(?:ajustad|atualizad|alterad|corrigid|mudad|trocad|editad|anotad|registrad|salv|gravad|aplicad)[oa]s?\b/;

function frasesDe(texto: string): string[] {
  return texto.match(/[^.!?\n]+(?:[.!?]+|$)|\n/g) ?? [texto];
}

function fraseEhPromessa(frase: string): boolean {
  const t = NORM(frase).trim();
  // Pergunta ou oferta não compromete: "quer que eu ajuste?", "posso ajustar".
  if (/\?\s*$/.test(t.trim())) return false;
  if (/\b(?:ainda )?nao\s+(?:vou|irei|ajust\w+|atualiz\w+|alter\w+|avis\w+)\b/.test(t)) return false;
  if (/\b(?:quer|queira|posso|podemos|prefere|gostaria)\b/.test(t)) return false;
  return (
    PROMETE_FUTURO.test(t) ||
    PROMETE_PRESENTE_ANCORADO.test(t) ||
    PROMETE_PRESENTE_COORDENADO.test(t) ||
    PROMETE_AVISO.test(t) ||
    PROMETE_PASSIVA_ALTERACAO.test(t)
  );
}

/** O texto do modelo PROMETE (presente/futuro) algo que não é conversa nem oferta? */
export function promessaSemEfeito(texto: string): boolean {
  return frasesDe(texto).some(fraseEhPromessa);
}

export const TEXTO_SEM_AVISO_POSTERIOR =
  "Não consigo avisar depois por conta própria: só falo por aqui quando você escreve ou quando o sistema notifica. " +
  "Para ver o status agora, me pergunte pelo negócio ou abra a proposta no sistema.";
export const TEXTO_NADA_ALTERADO_PERGUNTE =
  "Ainda não alterei nada por aqui. Me diga o que quer mudar e o novo valor, que eu mostro o resumo para você confirmar.";

/** Campo que a frase promete mexer — o rótulo que a pessoa reconhece, com artigo. */
const ALVOS_DE_CORRECAO: [RegExp, string][] = [
  [/\bcomplemento\b/, "o complemento"],
  [/\b(?:valor|preco|aluguel)\b/, "o valor"],
  [/\b(?:telefone|celular|whatsapp)\b/, "o telefone"],
  [/\be-?mail\b/, "o e-mail"],
  [/\bcpf\b/, "o CPF"],
  [/\bendereco\b/, "o endereço"],
  [/\bbairro\b/, "o bairro"],
  [/\bcidade\b/, "a cidade"],
  [/\bsinal\b/, "o sinal"],
  [/\bcomissao\b/, "a comissão"],
  [/\bmatricula\b/, "a matrícula"],
  [/\bprazo\b/, "o prazo"],
  [/\bnome\b/, "o nome"],
  [/\bcanal\b/, "o canal da assinatura"],
];

function alvoDeCorrecao(fraseNormalizada: string): string | null {
  return ALVOS_DE_CORRECAO.find(([re]) => re.test(fraseNormalizada))?.[1] ?? null;
}

/**
 * Cai a frase da promessa; entra o texto honesto UMA vez, no lugar da primeira.
 * Sem escrita no turno e sem promessa, devolve o texto intacto.
 */
export function travarPromessaSemEfeito(
  texto: string,
  ctx: { houveEscrita?: boolean }
): { texto: string; travou: boolean } {
  if (ctx.houveEscrita) return { texto, travou: false };
  const frases = frasesDe(texto);
  if (!frases.some(fraseEhPromessa)) return { texto, travou: false };

  let honesto: string | null = null;
  const saida: string[] = [];
  for (const frase of frases) {
    if (!fraseEhPromessa(frase)) {
      saida.push(frase);
      continue;
    }
    if (honesto !== null) continue;
    const t = NORM(frase);
    const alvo = alvoDeCorrecao(t);
    const prometeAviso = PROMETE_AVISO.test(t) || /\b(?:avis|notific|retorn)\w+/.test(t);
    honesto = alvo
      ? `Ainda não alterei nada. Quer que eu altere ${alvo}? Me confirme o novo valor.`
      : prometeAviso
        ? TEXTO_SEM_AVISO_POSTERIOR
        : TEXTO_NADA_ALTERADO_PERGUNTE;
    saida.push(`\n${honesto}\n`);
  }
  // A frase honesta ganha a própria linha; o resto da resposta segue como veio.
  const corpo = saida.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { texto: corpo, travou: true };
}

/**
 * Troca a afirmação falsa pelo texto honesto.
 *
 * Não troca quando o turn LEU dados com sucesso: "proposta criada em 05/10"
 * pode ser fato de um item listado. Leitura que FALHOU não conta — senão a
 * falha desligaria a trava justamente no turn em que o modelo improvisa.
 *
 * `houveEscrita` (opcional; ausente = sem escrita): a PROMESSA em
 * presente/futuro só é trocada quando o turno não escreveu nada — e vale mesmo
 * quando o turno leu (ler não é cumprir o "ajusto").
 */
export function travarCriacaoFalsa(
  texto: string,
  ctx: { houveLeitura: boolean; podeCriar: boolean; podeEnviar?: boolean; houveEscrita?: boolean }
): { texto: string; travou: boolean } {
  if (encenaConfirmacao(texto)) return { texto: TEXTO_SEM_ENCENACAO, travou: true };
  const promessa = travarPromessaSemEfeito(texto, ctx);
  texto = promessa.texto;
  if (ctx.houveLeitura) return { texto, travou: promessa.travou };
  if (afirmaEnvio(texto)) {
    return { texto: ctx.podeEnviar ? TEXTO_NADA_ENVIADO : TEXTO_NADA_ENVIADO_SEM_ENVIO, travou: true };
  }
  if (!afirmaCriacao(texto)) return { texto, travou: promessa.travou };
  return {
    texto: ctx.podeCriar ? TEXTO_NADA_CRIADO : TEXTO_NADA_CRIADO_SEM_CRIACAO,
    travou: true,
  };
}
