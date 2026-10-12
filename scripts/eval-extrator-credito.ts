/**
 * Eval do EXTRATOR de campo da ficha de crédito (M2): ~60 respostas reais de
 * corretor, campo a campo, pelo mesmo caminho do grafo — código primeiro
 * (`interpretarCampo`), e o modelo de produção só quando o código não decide
 * (tool forçada `preencher_campo`, texto tokenizado pelo M1, destokenizado
 * na volta, trecho conferido contra a mensagem).
 *
 * Uso:  OPENROUTER_API_KEY=... npx tsx scripts/eval-extrator-credito.ts [--model x]
 * Custo: só os casos que chegam ao modelo (~25 chamadas curtas). Centavos.
 * Critério: acurácia ≥ 95% e ZERO valor inventado (valor aceito que a pessoa
 * não disse).
 */

import { complete, DEFAULT_MODEL } from "../src/lib/llm";
import { comoMensagemDoUsuario } from "../src/graph/prompt";
import { SYSTEM_DA_EXTRACAO } from "../src/graph/fluxos";
import { interpretarCampo, toolExtrairCredito, valoresNoTexto, type CampoCredito, type ExtratorDeCampo } from "../src/graph/credito";
import { destokenizarArgs, tokenizar } from "../src/lib/pii";

type Esperado = string | number | null;
interface Caso { campo: CampoCredito; texto: string; esperado: Esperado }

const CASOS: Caso[] = [
  // CPF
  { campo: "cpf", texto: "111.444.777-35", esperado: "11144477735" },
  { campo: "cpf", texto: "o cpf dela é 11144477735", esperado: "11144477735" },
  { campo: "cpf", texto: "cpf 111 444 777 35", esperado: "11144477735" },
  { campo: "cpf", texto: "cpf 111.444.777-35, telefone 11 98888-7777", esperado: "11144477735" },
  { campo: "cpf", texto: "dela é 111.444.777-35 e o do marido 529.982.247-25, usa o dela", esperado: "11144477735" },
  { campo: "cpf", texto: "111.444.777-36", esperado: null },
  { campo: "cpf", texto: "ainda não tenho o cpf", esperado: null },
  { campo: "cpf", texto: "1114447773", esperado: null },
  // Nome
  { campo: "nome", texto: "Letícia Andrade", esperado: "Letícia Andrade" },
  { campo: "nome", texto: "o nome completo é Maria da Silva Souza", esperado: "Maria da Silva Souza" },
  { campo: "nome", texto: "ela se chama Ana Paula Lima", esperado: "Ana Paula Lima" },
  { campo: "nome", texto: "pode colocar Carlos Eduardo Pereira, é o nome dele no RG", esperado: "Carlos Eduardo Pereira" },
  { campo: "nome", texto: "Letícia", esperado: null },
  { campo: "nome", texto: "não sei o sobrenome agora", esperado: null },
  // Vínculo
  { campo: "vinculo", texto: "CLT", esperado: 6 },
  { campo: "vinculo", texto: "carteira assinada", esperado: 6 },
  { campo: "vinculo", texto: "ela é registrada numa empresa de TI", esperado: 6 },
  { campo: "vinculo", texto: "aposentado pelo INSS", esperado: 1 },
  { campo: "vinculo", texto: "trabalha por conta própria", esperado: 2 },
  { campo: "vinculo", texto: "é servidora pública estadual", esperado: 5 },
  { campo: "vinculo", texto: "empresário, tem uma loja", esperado: 4 },
  { campo: "vinculo", texto: "estudante", esperado: 7 },
  { campo: "vinculo", texto: "vive de aluguéis de uns imóveis", esperado: 8 },
  { campo: "vinculo", texto: "médica com consultório próprio, profissional liberal", esperado: 3 },
  { campo: "vinculo", texto: "faz uber e uns bicos", esperado: 2 },
  { campo: "vinculo", texto: "é concursado da prefeitura", esperado: 5 },
  { campo: "vinculo", texto: "6", esperado: 6 },
  { campo: "vinculo", texto: "não sei ainda, vou perguntar", esperado: null },
  // Profissão
  { campo: "profissao", texto: "analista de sistemas", esperado: "analista de sistemas" },
  { campo: "profissao", texto: "ela é enfermeira", esperado: "enfermeira" },
  { campo: "profissao", texto: "trabalha como motorista", esperado: "motorista" },
  { campo: "profissao", texto: "a profissão dele é engenheiro civil, trabalha numa construtora grande aqui da região", esperado: "engenheiro civil" },
  // Renda
  { campo: "renda", texto: "8 mil", esperado: 8000 },
  { campo: "renda", texto: "R$ 8.500,00", esperado: 8500 },
  { campo: "renda", texto: "8,5 mil", esperado: 8500 },
  { campo: "renda", texto: "oito mil e quinhentos", esperado: 8500 },
  { campo: "renda", texto: "ganha uns 12k por mês", esperado: 12000 },
  { campo: "renda", texto: "uns 4.200 reais líquido", esperado: 4200 },
  { campo: "renda", texto: "ela ganha 8 mil e o marido 3 mil, coloca só o dela", esperado: 8000 },
  { campo: "renda", texto: "salário de 6 mil mais 2 mil de comissão, considera 6 mil", esperado: 6000 },
  { campo: "renda", texto: "não sei quanto ela ganha", esperado: null },
  { campo: "renda", texto: "bem", esperado: null },
  // Aluguel / condomínio / IPTU
  { campo: "aluguel", texto: "2500", esperado: 2500 },
  { campo: "aluguel", texto: "R$ 2.500", esperado: 2500 },
  { campo: "aluguel", texto: "o aluguel é dois mil e quinhentos", esperado: 2500 },
  { campo: "aluguel", texto: "aluguel 3 mil, condomínio 800", esperado: 3000 },
  { campo: "condominio", texto: "não tem", esperado: 0 },
  { campo: "condominio", texto: "não tem condomínio", esperado: 0 },
  { campo: "condominio", texto: "650", esperado: 650 },
  { campo: "condominio", texto: "condomínio 650 e iptu 120", esperado: 650 },
  { campo: "iptu", texto: "isento", esperado: 0 },
  { campo: "iptu", texto: "120 reais por mês", esperado: 120 },
  { campo: "iptu", texto: "não sei o iptu", esperado: null },
  // Vai morar / parentesco
  { campo: "vaiMorar", texto: "sozinha", esperado: 1 },
  { campo: "vaiMorar", texto: "com a esposa e os filhos", esperado: 2 },
  { campo: "vaiMorar", texto: "é para a mãe dele morar", esperado: 3 },
  { campo: "vaiMorar", texto: "vai alugar pra um funcionário da empresa", esperado: 4 },
  { campo: "vaiMorar", texto: "2", esperado: 2 },
  { campo: "moradorParentesco", texto: "mãe", esperado: 2 },
  { campo: "moradorParentesco", texto: "é o filho dela", esperado: 3 },
  { campo: "moradorParentesco", texto: "esposa", esperado: 5 },
  { campo: "moradorParentesco", texto: "sogra", esperado: 6 },
  // Revisão do M2: incerteza, valor dentro de pergunta, vínculo sem sinônimo.
  { campo: "vinculo", texto: "vou ver com ela e depois te falo", esperado: null },
  { campo: "vinculo", texto: "trabalha numa loja do shopping", esperado: null },
  { campo: "renda", texto: "8 mil ou somo o bico?", esperado: null },
];

function extrator(model: string, contador: { chamadas: number }): ExtratorDeCampo {
  return async (texto, campo) => {
    contador.chamadas += 1;
    const tool = toolExtrairCredito(campo);
    // Mesmo caminho do `depsDoFluxo.extrair` (graph.ts): tokeniza só para a chamada.
    const { texto: textoTok, mapa } = tokenizar(texto);
    const r = await complete({
      system: SYSTEM_DA_EXTRACAO,
      messages: [{ role: "user", content: comoMensagemDoUsuario(textoTok) }],
      model,
      tools: [tool],
      toolChoice: tool.name,
    });
    const args = r.toolCalls.find((c) => c.name === tool.name)?.args ?? {};
    return destokenizarArgs(args, mapa);
  };
}

const igual = (a: Esperado, b: string | number) =>
  typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;

async function main() {
  const i = process.argv.indexOf("--model");
  const model = i >= 0 ? process.argv[i + 1]! : DEFAULT_MODEL;
  console.log(`modelo: ${model}\ncasos:  ${CASOS.length}\n`);
  const contador = { chamadas: 0 };
  const extrair = extrator(model, contador);
  let acertos = 0;
  const inventados: string[] = [];
  const erros: string[] = [];
  for (const c of CASOS) {
    const antes = contador.chamadas;
    const r = await interpretarCampo(c.campo, c.texto, extrair);
    const usouModelo = contador.chamadas > antes;
    const obtido = r.tipo === "ok" ? r.valor : null;
    const ok = obtido === null ? c.esperado === null : c.esperado !== null && igual(c.esperado, obtido);
    if (ok) acertos += 1;
    else erros.push(`  [${c.campo}] "${c.texto}" → ${JSON.stringify(obtido)} (esperado ${JSON.stringify(c.esperado)})`);
    // Inventado: aceitou um valor que a mensagem não traz.
    if (obtido !== null && !ok) {
      const valorFora = typeof obtido === "number" && ["renda", "aluguel", "condominio", "iptu", "solRenda"].includes(c.campo) &&
        obtido !== 0 && !valoresNoTexto(c.texto).includes(obtido);
      if (c.esperado === null || valorFora) inventados.push(`  [${c.campo}] "${c.texto}" → ${JSON.stringify(obtido)}`);
    }
    process.stdout.write(ok ? (usouModelo ? "M" : ".") : "x");
  }
  const acuracia = (100 * acertos) / CASOS.length;
  console.log(`\n\nacurácia: ${acuracia.toFixed(1)}% (${acertos}/${CASOS.length}) · chamadas ao modelo: ${contador.chamadas}`);
  if (erros.length) console.log(`\nerros:\n${erros.join("\n")}`);
  if (inventados.length) console.log(`\nINVENTADOS:\n${inventados.join("\n")}`);
  const aprovado = acuracia >= 95 && inventados.length === 0;
  console.log(aprovado ? "\nVEREDITO: aprovado." : "\nVEREDITO: REPROVADO (≥95% e 0 inventado).");
  process.exit(aprovado ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
