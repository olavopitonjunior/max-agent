/**
 * O nano acerta QUANDO chamar a ferramenta?
 *
 * O modelo é `openai/gpt-5.4-nano`, escolhido por custo. Nano-tier erra escolha
 * de ferramenta com mais frequência que os modelos grandes, e a Fase 3 foi
 * construída assumindo que ele acerta — esta é a medição que confirma ou derruba
 * a suposição, antes de ela virar problema de produção.
 *
 * Os dois erros NÃO custam a mesma coisa:
 *
 *  - **Falso positivo** (propõe sem ninguém ter pedido): custa uma pergunta boba.
 *    A pessoa ignora ou diz não, e a proposta é descartada no turn seguinte.
 *    Irritante, não perigoso — nenhuma ferramenta executa sozinha.
 *  - **Falso negativo** (a pessoa pede e ele não propõe): custa a feature. Ela
 *    pede, recebe um texto genérico, e conclui que o Max não faz isso.
 *
 * Então o número que manda é o RECALL. Precisão baixa se conserta no prompt;
 * recall baixo significa modelo errado para a tarefa.
 *
 * Uso:  OPENROUTER_API_KEY=... npx tsx scripts/eval-tool-choice.ts
 *       ...  npx tsx scripts/eval-tool-choice.ts --model openai/gpt-5.4-mini
 *
 * Custo: ~20 chamadas de ~400 tokens de entrada. Centavos.
 */

import { complete, DEFAULT_MODEL } from "../src/lib/llm";
import { buildSystemPrompt } from "../src/graph/prompt";
import { FORM_TOOL, TOOL_PROPOR_FORM, shouldOfferTools } from "../src/graph/tools";

interface Caso {
  texto: string;
  /** A ferramenta DEVE ser chamada? */
  esperado: boolean;
}

/**
 * As frases negativas não são aleatórias: são as que se PARECEM com um pedido.
 * "Como funciona o formulário?" contém a palavra que dispara o prefiltro, e é
 * exatamente onde um modelo pequeno confunde pergunta com ordem.
 */
const CASOS: Caso[] = [
  // Pedem formulário.
  { texto: "me manda um link de formulário pro João Silva", esperado: true },
  { texto: "cria um formulário de venda aí", esperado: true },
  { texto: "preciso do link pro cliente preencher", esperado: true },
  { texto: "abre uma ficha nova pra Maria Souza", esperado: true },
  { texto: "gera um formulário pra eu mandar pro comprador", esperado: true },
  { texto: "cadastra um cliente novo pra mim", esperado: true },
  { texto: "manda o link do formulário", esperado: true },
  { texto: "quero abrir um negócio novo, me manda a ficha", esperado: true },
  { texto: "faz um formulário pro Pedro Almeida por favor", esperado: true },
  { texto: "consegue criar o formulário do apartamento da Vila Nova?", esperado: true },

  // Perguntam SOBRE o formulário, ou sobre outra coisa.
  { texto: "como funciona o formulário de venda?", esperado: false },
  { texto: "quantas etapas tem o formulário?", esperado: false },
  { texto: "o cliente precisa de login pra preencher o formulário?", esperado: false },
  { texto: "quanto tempo demora a certidão de matrícula?", esperado: false },
  { texto: "como funciona a assinatura pela ClickSign?", esperado: false },
  { texto: "o formulário que mandei ontem foi preenchido?", esperado: false },
  { texto: "quando cai a comissão depois do contrato assinado?", esperado: false },
  { texto: "bom dia, tudo bem?", esperado: false },
  { texto: "o link que você mandou expirou?", esperado: false },
  { texto: "preciso de um contrato de locação, não de venda", esperado: false },
];

async function main() {
  const i = process.argv.indexOf("--model");
  const model = i >= 0 ? process.argv[i + 1] : DEFAULT_MODEL;

  const system = buildSystemPrompt({
    orgName: "RE/MAX Trio",
    userName: "Marcia Gerente",
    hits: [],
    tenantInstructions: null,
  });

  console.log(`modelo: ${model}\ncasos:  ${CASOS.length}\n`);

  let vp = 0;
  let fp = 0;
  let vn = 0;
  let fn = 0;
  const erros: string[] = [];
  /** O prefiltro barra ANTES do modelo — um falso negativo dele é definitivo. */
  const barradosPeloPrefiltro: string[] = [];

  for (const caso of CASOS) {
    const ofereceu = shouldOfferTools(caso.texto);
    if (!ofereceu && caso.esperado) barradosPeloPrefiltro.push(caso.texto);

    let chamou = false;
    if (ofereceu) {
      const r = await complete({
        system,
        messages: [{ role: "user", content: caso.texto }],
        model,
        tools: [FORM_TOOL],
      });
      chamou = r.toolCalls.some((c) => c.name === TOOL_PROPOR_FORM);
    }

    if (caso.esperado && chamou) vp++;
    else if (caso.esperado && !chamou) {
      fn++;
      erros.push(`  FN (não propôs): "${caso.texto}"`);
    } else if (!caso.esperado && chamou) {
      fp++;
      erros.push(`  FP (propôs à toa): "${caso.texto}"`);
    } else vn++;

    process.stdout.write(caso.esperado === chamou ? "." : "x");
  }

  const recall = vp + fn > 0 ? vp / (vp + fn) : 1;
  const precisao = vp + fp > 0 ? vp / (vp + fp) : 1;

  console.log("\n");
  console.log(`recall:   ${(recall * 100).toFixed(0)}%  (${vp}/${vp + fn} pedidos atendidos)`);
  console.log(`precisão: ${(precisao * 100).toFixed(0)}%  (${fp} proposta(s) à toa)`);
  console.log(`acertos:  ${vp + vn}/${CASOS.length}`);

  if (erros.length) console.log(`\n${erros.join("\n")}`);
  if (barradosPeloPrefiltro.length) {
    console.log(
      `\nBarrados pelo PREFILTRO (o modelo nem viu — corrigir o regex em tools.ts):\n` +
        barradosPeloPrefiltro.map((t) => `  "${t}"`).join("\n")
    );
  }

  // Recall é o que decide trocar de modelo; precisão se conserta no prompt.
  console.log(
    recall < 0.8
      ? "\nVEREDITO: recall abaixo de 80% — o nano não serve para esta escolha. " +
          "Subir o modelo SÓ nos turns que passam o prefiltro."
      : "\nVEREDITO: recall aceitável para seguir com o nano."
  );
}

main().catch((err) => {
  console.error("\nfalhou:", err);
  process.exitCode = 1;
});
