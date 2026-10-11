/**
 * Tokenização e redação de PII do corretor — pré-requisito do crédito (M2/M3).
 *
 * ── Duas formas, dois destinos ────────────────────────────────────────────
 *
 *  - `tokenizar`/`destokenizar*`: pra quem vai e volta do provedor de IA
 *    DENTRO do mesmo turno. O modelo recebe `⟨CPF_1⟩` em vez do CPF real,
 *    pode ecoar o token na resposta ou num argumento de tool, e quem recebe
 *    de volta troca o token pelo valor — SÓ no caminho de saída pro
 *    WhatsApp/ImobPro, e só com o mapa DESTE turno (ver `destokenizarResposta`
 *    sobre o que acontece quando o token é de OUTRO turno/pessoa).
 *  - `redigir`/`redigirProfundo`: mão única, sem mapa, token FIXO (`⟨CPF⟩`,
 *    sem número). Pra log, auditoria e qualquer texto que ATRAVESSE turno
 *    (resumo do `compact`, fato do `extractFacts`) — concatenar token
 *    numerado de um turno com o mapa de outro é exatamente a colisão que o
 *    fixo evita: `⟨CPF_1⟩` do resumo de ONTEM nunca é a mesma pessoa que
 *    `⟨CPF_1⟩` do mapa de HOJE, então esses dois textos usam o token sem
 *    número, que não casa com NENHUM mapa.
 *
 * ── Lacunas conhecidas (fora desta fatia) ─────────────────────────────────
 *
 *  - Telefone sem DDD (`98765-0003` solto, sem os dois dígitos da área) não é
 *    reconhecido — ambíguo demais com outros números de 8-9 dígitos (CEP sem
 *    hífen, parte de um valor). Fica para quando houver caso real.
 *  - `toolResults`/`userName`/`orgName` entram CRUS no prompt: são dados que
 *    já vieram do ImobPro (não "digitado pelo corretor nesta mensagem"), que
 *    é o que esta fatia cobre. M2/M3 tratam o que entra pelo crédito.
 *
 * Puro: sem I/O, sem `env`, sem depender de outro módulo do projeto — é o que
 * permite testar as dezenas de formato/negativo sem banco nem rede.
 */

export type Categoria = "CPF" | "CNPJ" | "EMAIL" | "TEL" | "CEP" | "VALOR";

/**
 * Token (`⟨CPF_1⟩`) → valor original. Vive no campo `piiMap` do state do
 * grafo, resetado no `RESET_DO_TURN` — mas "state do grafo" aqui é
 * `PostgresSaver`: o LangGraph GRAVA o checkpoint (logo, o mapa) a cada
 * super-step, até o reset do turno seguinte apagar a chave. Não é um valor
 * que fica só em memória — ver o comentário do campo em `graph.ts`.
 */
export type MapaPii = Record<string, string>;

/**
 * Categorias redigidas na auditoria (`conversation_turn`, `inbound_queue`).
 * Telefone/CEP/valor ficam de fora — ver `turnlog.ts`. Uma constante só,
 * usada pelos dois lugares que escrevem a mesma coluna, pra não haver como um
 * divergir do outro.
 */
export const CAMPOS_DA_AUDITORIA: Categoria[] = ["CPF", "CNPJ", "EMAIL"];

const TODAS_CATEGORIAS: Categoria[] = ["CPF", "CNPJ", "EMAIL", "TEL", "CEP", "VALOR"];

// ─── Dígito verificador — mesma regra do `buildProposalPayload` ────────────

/** CPF com DV válido. Sem isto, qualquer sequência de 11 dígitos virava alvo. */
function cpfValido(raw: string): boolean {
  const cpf = raw.replace(/\D/g, "");
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (let n = 9; n < 11; n++) {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(cpf[i]) * (n + 1 - i);
    if (Number(cpf[n]) !== ((soma * 10) % 11) % 10) return false;
  }
  return true;
}

/** CNPJ com DV válido — mesmo motivo do CPF: 14 dígitos soltos não bastam. */
function cnpjValido(raw: string): boolean {
  const cnpj = raw.replace(/\D/g, "");
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const pesos2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const dv = (base: string, pesos: number[]) => {
    const soma = base.split("").reduce((acc, d, i) => acc + Number(d) * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  if (dv(cnpj.slice(0, 12), pesos1) !== Number(cnpj[12])) return false;
  if (dv(cnpj.slice(0, 13), pesos2) !== Number(cnpj[13])) return false;
  return true;
}

// ─── Padrões por categoria ──────────────────────────────────────────────────
//
// Ordem de aplicação importa: CPF e CNPJ primeiro, pra que seus dígitos já
// virem token antes do regex de TELEFONE (bem mais permissivo) correr — sem
// isso, o meio de um CNPJ formatado casaria como telefone. Validado com DV
// real: uma sequência de 11/14 dígitos que não seja CPF/CNPJ não é tocada e
// segue disponível para TEL/CEP tentarem.

/** 3 grupos de 3 + 2, com ou sem pontuação. Nunca cai sobre CRECI (não tem esse formato). */
const RE_CPF = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g;
/** 2+3+3+4+2, com ou sem pontuação/barra. */
const RE_CNPJ = /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g;
const RE_EMAIL = /[^\s@:;,<>()]+@[^\s@:;,<>()]+\.[a-z]{2,}/gi;
/**
 * DDD(2) + nono dígito opcional + 4 + 4, com/sem +55, com/sem máscara.
 * Precisa de 10 a 11 dígitos — por isso "PROP-2026-0001" (8 dígitos),
 * CRECI (5–6 dígitos) e número de apto (1–3) nunca batem aqui.
 *
 * `(?<!\d)` no início (achado em review): sem ele, a REGEX casava a CAUDA de
 * um número mais longo — "contrato nº 2026000012345" devolvia "202⟨TEL_1⟩",
 * cortando os 3 primeiros dígitos em vez de deixar o número inteiro de lado.
 */
const RE_TEL = /(?<!\d)(?:\+?55[\s.-]*)?\(?\d{2}\)?[\s.-]*9?\d{4}[\s.-]?\d{4}(?!\d)/g;
/** Só a forma com hífen (5+3): é a que se escreve; sem hífen colide com telefone sem DDD. */
const RE_CEP = /(?<!\d)\d{5}-\d{3}(?!\d)/g;
/**
 * Um número (com separador de milhar/decimal BR opcional), delimitado por
 * fronteira de dígito nas duas pontas — é o que garante casar o número
 * INTEIRO e não parte dele (achado em review: a versão anterior cortava
 * dígito de "R$1500"/"1500 reais" porque não ancorava as pontas).
 */
const NUM = String.raw`(?<!\d)(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?(?!\d)`;
/**
 * Só com sinal de contexto — "R$" na frente (podendo terminar em "mil"/
 * "milhão"/"milhões") ou "reais"/"mil reais" depois. Número solto ("apto
 * 302", "CRECI 123456") nunca entra: é exatamente o negativo que o plano
 * pede.
 */
const RE_VALOR = new RegExp(
  String.raw`R\$\s*${NUM}(?:\s*(?:mil|milh(?:ão|ões)))?\b|${NUM}\s*(?:mil\s*)?reais\b`,
  "gi"
);

const VALIDADOR: Partial<Record<Categoria, (m: string) => boolean>> = {
  CPF: cpfValido,
  CNPJ: cnpjValido,
};

const REGEX: Record<Categoria, RegExp> = {
  CPF: RE_CPF,
  CNPJ: RE_CNPJ,
  EMAIL: RE_EMAIL,
  TEL: RE_TEL,
  CEP: RE_CEP,
  VALOR: RE_VALOR,
};

const TOKEN_RE = /^⟨([A-Z]+)_(\d+)⟩$/;

/**
 * Chave de DEDUPLICAÇÃO — não o valor que fica no mapa. "111.444.777-35" e
 * "11144477735" são o MESMO CPF; sem normalizar antes de comparar, cada
 * formato ganhava o próprio token (achado em review). CPF/CNPJ/CEP: só
 * dígitos. TEL: dígitos sem o DDI 55 (pra "+5511999998888" e "11999998888"
 * casarem). EMAIL: minúsculo. VALOR: o texto como veio (formato É parte do
 * que a pessoa quis dizer, e "R$1500"/"1.500 reais" já são casos raros
 * demais pra valer a complexidade de normalizar também).
 */
function chaveCanonica(categoria: Categoria, valor: string): string {
  if (categoria === "EMAIL") return valor.toLowerCase();
  if (categoria === "VALOR") return valor;
  const d = valor.replace(/\D/g, "");
  if (categoria === "TEL") return d.startsWith("55") && (d.length === 12 || d.length === 13) ? d.slice(2) : d;
  return d; // CPF, CNPJ, CEP
}

/**
 * Tokeniza as categorias PII de `texto`, substituindo pelo padrão
 * `⟨CATEGORIA_n⟩`. Mesmo valor dentro da mesma chamada (ou de uma chamada
 * anterior cujo `mapa` é passado de volta) recebe o MESMO token — é o que
 * permite reaproveitar o mapa entre mensagens do mesmo turno.
 *
 * Devolve um NOVO mapa (não muta `mapaExistente`), com tudo que já havia mais
 * o que foi achado agora.
 */
export function tokenizar(
  texto: string,
  mapaExistente: MapaPii = {}
): { texto: string; mapa: MapaPii } {
  const mapa: MapaPii = { ...mapaExistente };

  // Reconstrói "valor já visto → token" e o próximo número por categoria, a
  // partir do que o mapa recebido já tinha — sem isto, reaproveitar o mapa
  // entre mensagens recomeçaria a numeração do zero e duplicaria token.
  const porValor = new Map<string, string>();
  const contadores: Record<Categoria, number> = { CPF: 0, CNPJ: 0, EMAIL: 0, TEL: 0, CEP: 0, VALOR: 0 };
  for (const [token, valor] of Object.entries(mapa)) {
    const m = TOKEN_RE.exec(token);
    if (!m) continue;
    const [, categoria, numero] = m;
    if (categoria in contadores) {
      contadores[categoria as Categoria] = Math.max(contadores[categoria as Categoria], Number(numero));
      porValor.set(`${categoria}:${chaveCanonica(categoria as Categoria, valor)}`, token);
    }
  }

  const gerar = (categoria: Categoria, valorOriginal: string): string => {
    const chave = `${categoria}:${chaveCanonica(categoria, valorOriginal)}`;
    const existente = porValor.get(chave);
    if (existente) return existente;
    contadores[categoria] += 1;
    const token = `⟨${categoria}_${contadores[categoria]}⟩`;
    porValor.set(chave, token);
    mapa[token] = valorOriginal;
    return token;
  };

  let out = texto;
  for (const categoria of TODAS_CATEGORIAS) {
    const valida = VALIDADOR[categoria];
    out = out.replace(REGEX[categoria], (m) => (valida && !valida(m) ? m : gerar(categoria, m)));
  }

  return { texto: out, mapa };
}

/**
 * Troca cada token em `texto` pelo valor real do `mapa`. Usado SÓ no caminho
 * de saída (resposta ao corretor, argumento de tool como `proposal.create`) —
 * nunca antes de gravar em log ou auditoria.
 */
export function destokenizar(texto: string, mapa: MapaPii): string {
  let out = texto;
  for (const [token, valor] of Object.entries(mapa)) {
    out = out.split(token).join(valor);
  }
  return out;
}

/**
 * Mesma troca de `destokenizar`, recursiva — para os `args` de uma tool, que
 * chegam como objeto (às vezes aninhado: `proponente.telefone`). Espelha
 * `folhasSemCredencial` de `redigir.ts`, mesmo motivo: serializar o objeto
 * inteiro como string arriscaria devolver JSON inválido.
 */
export function destokenizarProfundo<T>(valor: T, mapa: MapaPii): T {
  if (Object.keys(mapa).length === 0) return valor;
  if (typeof valor === "string") return destokenizar(valor, mapa) as T;
  if (Array.isArray(valor)) return valor.map((v) => destokenizarProfundo(v, mapa)) as T;
  if (valor && typeof valor === "object") {
    return Object.fromEntries(
      Object.entries(valor).map(([k, v]) => [k, destokenizarProfundo(v, mapa)])
    ) as T;
  }
  return valor;
}

/**
 * Token no formato "normal" (`⟨CPF_1⟩`), ou mutilado: minúsculo, `<>` no
 * lugar de `⟨⟩`, espaço dentro (`⟨ TEL_1 ⟩`) — tudo que o modelo às vezes
 * escreve em vez de copiar o token literal. Sem o `_n`: também casa o fixo
 * (`⟨CPF⟩`) ecoado de um resumo/fato de OUTRO turno, que por desenho nunca
 * está no mapa deste.
 *
 * Restrito às 6 categorias conhecidas (achado em review): um `[A-Za-z]+`
 * genérico casava QUALQUER coisa entre `<>` — `<b>negrito</b>` virava
 * `[dado]negrito</b>`, comendo marcação que não é token nenhum.
 */
const CATEGORIAS_TOKEN = "CPF|CNPJ|EMAIL|TEL|CEP|VALOR";
const TOKEN_SOLTO = new RegExp(`[⟨<]\\s*(${CATEGORIAS_TOKEN})(?:_(\\d+))?\\s*[⟩>]`, "gi");

/**
 * Destokeniza para a RESPOSTA ao corretor.
 *
 * Um passo só (achado em review): normaliza o que achou — mutilado ou não —
 * pra forma canônica `⟨CAT_n⟩` (ou `⟨CAT⟩` sem índice) e consulta o mapa
 * ANTES de desistir. `<TEL_1>` com `⟨TEL_1⟩` no mapa volta o telefone
 * normalmente; só quando a chave canônica não está no mapa — de OUTRO
 * turno, ou o modelo inventou um índice que nunca existiu — é que vira
 * `[dado]`. Nunca o valor de outra pessoa, nunca o token cru.
 */
export function destokenizarResposta(texto: string, mapa: MapaPii): string {
  let restantes = 0;
  const out = texto.replace(TOKEN_SOLTO, (_match, categoria: string, numero: string | undefined) => {
    const canonico = `⟨${categoria.toUpperCase()}${numero ? `_${numero}` : ""}⟩`;
    const valor = mapa[canonico];
    if (valor !== undefined) return valor;
    restantes += 1;
    return "[dado]";
  });
  if (restantes > 0) {
    console.warn(`[pii] ${restantes} token(s) sem mapa na resposta — trocado(s) por [dado]`);
  }
  return out;
}

/**
 * Destokeniza para os `args` de uma tool (`proposal.create` e afins).
 * Decisão de produto (review), OPOSTA à da resposta: um token sem mapa fica
 * COMO ESTÁ — não existe `[dado]` que o ImobPro aceite como CPF, então
 * mandar o token literal faz o servidor RECUSAR o campo, que é o
 * comportamento certo (nunca inventar um valor). Hoje é só um alias de
 * `destokenizarProfundo`; existe com nome próprio para o call-site em
 * `graph.ts` dizer a decisão, não só a mecânica.
 */
export function destokenizarArgs<T>(valor: T, mapa: MapaPii): T {
  return destokenizarProfundo(valor, mapa);
}

/**
 * Redação de mão única para log e auditoria (`conversation_turn`, erro,
 * `console.*`): token FIXO, sem número, sem mapa — nada aqui precisa (ou
 * deve) voltar a ser legível.
 *
 * `campos` deixa o chamador redigir só um subconjunto — `turnlog.ts` usa
 * `["CPF", "CNPJ", "EMAIL"]`: decisão de produto (telefone/CEP/valor
 * continuam em claro ali, ver o cabeçalho de `turnlog.ts`).
 */
export function redigir(texto: string, campos: Categoria[] = TODAS_CATEGORIAS): string {
  let out = texto;
  for (const categoria of campos) {
    const valida = VALIDADOR[categoria];
    out = out.replace(REGEX[categoria], (m) => (valida && !valida(m) ? m : `⟨${categoria}⟩`));
  }
  return out;
}

/**
 * `redigir` recursivo — para `tools_json` e qualquer objeto (às vezes
 * aninhado) antes de virar log ou auditoria. Mesmo motivo de
 * `destokenizarProfundo`: serializar o objeto inteiro como string arriscaria
 * devolver JSON inválido.
 */
export function redigirProfundo<T>(valor: T, campos: Categoria[] = TODAS_CATEGORIAS): T {
  if (typeof valor === "string") return redigir(valor, campos) as T;
  if (Array.isArray(valor)) return valor.map((v) => redigirProfundo(v, campos)) as T;
  if (valor && typeof valor === "object") {
    return Object.fromEntries(
      Object.entries(valor).map(([k, v]) => [k, redigirProfundo(v, campos)])
    ) as T;
  }
  return valor;
}
