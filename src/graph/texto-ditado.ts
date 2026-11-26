/**
 * Conferência do que o extrator devolveu contra o que o corretor ESCREVEU.
 * Módulo folha (sem imports do grafo): usado por `conferirDitado` em fluxos.ts.
 */

/** Minúsculas, sem acento, só letras/dígitos separados por espaço simples. */
export function semAcento(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** O valor aparece no texto, como palavras inteiras (sem acento nem caixa)? */
export function noTexto(valor: string | undefined, texto: string): boolean {
  const v = semAcento(valor ?? "");
  if (!v) return false;
  return ` ${semAcento(texto)} `.includes(` ${v} `);
}

/** Rótulos de papel/campo que o extrator às vezes deixa colados no começo do nome ("Comprador Maria Souza"). */
const ROTULOS_DE_NOME = new Set([
  "comprador", "compradora", "vendedor", "vendedora", "locatario", "locataria", "proprietario", "proprietaria", "nome",
]);

/**
 * Tira o ROTULO do INÍCIO do nome ("Comprador TESTE Comprador Smoke" → "TESTE Comprador Smoke"; "Nome: Lúcia
 * Prado" → "Lúcia Prado"). Só a primeira palavra, com ou sem ":" depois; o mesmo termo no meio ou no fim do nome
 * fica. Só vale quando o nome, com esse rótulo, está no TEXTO e o rótulo é dele (nada escrito como rótulo logo
 * antes): "comprador Comprador Smoke" tem o rótulo fora do nome, e um nome que o texto não traz fica como veio.
 * Se o rótulo for tudo o que há, devolve o nome como veio (nunca um nome vazio).
 */
export function semRotuloNoNome(nome: string, texto: string): string {
  const m = /^\s*(\p{L}+)(?:\s*:\s*|\s+)(\S[\s\S]*)$/u.exec(nome);
  if (!m || !ROTULOS_DE_NOME.has(semAcento(m[1]!))) return nome;
  const alvo = semAcento(nome).split(" ").filter(Boolean);
  const p = palavras(texto);
  const colado = p.some(
    (_, i) => alvo.every((a, k) => p[i + k]?.norm === a) && !ROTULOS_DE_NOME.has(p[i - 1]?.norm ?? ""),
  );
  return colado ? m[2]!.trim() : nome;
}

/** A marca de dado de teste que o corretor cola no nome: TESTE, teste2... */
const MARCA_DE_TESTE = /^teste\d*$/;

/**
 * Palavras de prosa que, ao lado de um "teste" em minúsculas, mostram que ele é a palavra comum
 * ("é um teste João Silva", "teste de fogo"), não a marca colada ao nome.
 */
const PROSA_AO_REDOR_DE_TESTE = new Set([
  "e", "um", "uma", "o", "a", "os", "as", "de", "do", "da", "dos", "das", "no", "na", "num", "numa", "em", "para", "pra", "pro",
  "esse", "essa", "este", "esta", "meu", "minha", "so", "mais", "outro", "outra", "foi", "era", "eh", "ser", "sera", "fazer", "faz",
  "fiz", "ainda", "apenas", "somente", "como", "com", "sem", "que", "isso", "isto", "aqui", "agora", "ao", "aos", "por",
]);

type Palavra = { norm: string; raw: string; ini: number; fim: number };
function palavras(texto: string): Palavra[] {
  return [...texto.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    norm: semAcento(m[0]),
    raw: m[0],
    ini: m.index ?? 0,
    fim: (m.index ?? 0) + m[0].length,
  }));
}

/**
 * O extrator tratava "TESTE" como ruído ("TESTE Comprador Smoke" → "Comprador Smoke").
 * Se o nome extraído aparece no texto com uma marca TESTE colada (só espaços entre eles,
 * antes ou depois), o nome vale como foi escrito, com a grafia do corretor. Sem a marca
 * colada, ou sem o nome no texto, devolve o nome como veio.
 */
export function nomeComoEscrito(nome: string, texto: string): string {
  const alvo = semAcento(nome).split(" ").filter(Boolean);
  if (alvo.length === 0) return nome;
  const p = palavras(texto);
  const colados = (a: Palavra, b: Palavra) => /^\s+$/.test(texto.slice(a.fim, b.ini));
  for (let i = 0; i + alvo.length <= p.length; i++) {
    const trecho = p.slice(i, i + alvo.length);
    if (!trecho.every((w, k) => w.norm === alvo[k] && (k === 0 || colados(trecho[k - 1]!, w)))) continue;
    const primeira = trecho[0]!;
    const ultima = trecho[trecho.length - 1]!;
    const antes = p[i - 1];
    const depois = p[i + alvo.length];
    // TESTE em caixa alta ou com número é marca; "teste" em minúsculas só quando a palavra do outro lado não é prosa.
    const ehMarca = (m: Palavra, lado: Palavra | undefined) =>
      MARCA_DE_TESTE.test(m.norm) && (m.raw !== m.raw.toLowerCase() || /\d/.test(m.raw) || !lado || !PROSA_AO_REDOR_DE_TESTE.has(lado.norm));
    const ini = antes && ehMarca(antes, p[i - 2]) && colados(antes, primeira) ? antes.ini : primeira.ini;
    const fim = depois && ehMarca(depois, p[i + alvo.length + 1]) && colados(ultima, depois) ? depois.fim : ultima.fim;
    if (ini === primeira.ini && fim === ultima.fim) continue;
    return texto.slice(ini, fim).replace(/\s+/g, " ").trim();
  }
  return nome;
}
