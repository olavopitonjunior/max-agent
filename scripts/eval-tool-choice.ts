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
  /** Quando deve, qual `tipo`. Chamar certo com o tipo errado é pior que não chamar. */
  tipo?: "venda" | "locacao" | "proposta";
}

/**
 * As frases negativas não são aleatórias: são as que se PARECEM com um pedido.
 * "Como funciona o formulário?" contém a palavra que dispara o prefiltro, e é
 * exatamente onde um modelo pequeno confunde pergunta com ordem.
 */
const CASOS: Caso[] = [
  // ── Pedem VENDA ──────────────────────────────────────────────────────────
  { texto: "me manda um link de formulário de venda pro João Silva", esperado: true, tipo: "venda" },
  { texto: "cria um formulário de compra e venda aí", esperado: true, tipo: "venda" },
  { texto: "abre uma ficha de venda nova pra Maria Souza", esperado: true, tipo: "venda" },
  { texto: "gera o formulário pra eu mandar pro comprador", esperado: true, tipo: "venda" },
  { texto: "faz um formulário de venda pro Pedro Almeida por favor", esperado: true, tipo: "venda" },

  // ── Pedem LOCAÇÃO ────────────────────────────────────────────────────────
  { texto: "cria um formulário de locação pro inquilino", esperado: true, tipo: "locacao" },
  { texto: "me manda a ficha de aluguel do apartamento da Vila Nova", esperado: true, tipo: "locacao" },
  { texto: "abre um cadastro de locação comercial pra loja", esperado: true, tipo: "locacao" },
  { texto: "preciso do link do formulário de aluguel", esperado: true, tipo: "locacao" },

  // ── Pedem PROPOSTA ───────────────────────────────────────────────────────
  { texto: "cria uma proposta pro Carlos", esperado: true, tipo: "proposta" },
  { texto: "abre uma proposta nova aí", esperado: true, tipo: "proposta" },
  { texto: "monta um rascunho de proposta pra esse cliente", esperado: true, tipo: "proposta" },

  // ── Perguntam SOBRE, ou é outra coisa ────────────────────────────────────
  { texto: "como funciona o formulário de venda?", esperado: false },
  { texto: "quantas etapas tem o formulário?", esperado: false },
  { texto: "o cliente precisa de login pra preencher o formulário?", esperado: false },
  { texto: "quanto tempo demora a certidão de matrícula?", esperado: false },
  { texto: "como funciona a assinatura pela ClickSign?", esperado: false },
  { texto: "o formulário que mandei ontem foi preenchido?", esperado: false },
  { texto: "quando cai a comissão depois do contrato assinado?", esperado: false },
  { texto: "bom dia, tudo bem?", esperado: false },
  { texto: "o link que você mandou expirou?", esperado: false },
  { texto: "a proposta que mandei semana passada foi aceita?", esperado: false },
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
  /**
   * Chamou certo, com o tipo ERRADO. Contado à parte porque é o erro mais caro
   * dos três: a pessoa lê "formulário de venda", confirma achando que pediu
   * aluguel, e o documento errado nasce COM a confirmação dela em cima.
   */
  let tipoErrado = 0;
  const erros: string[] = [];
  /** O prefiltro barra ANTES do modelo — um falso negativo dele é definitivo. */
  const barradosPeloPrefiltro: string[] = [];

  for (const caso of CASOS) {
    const ofereceu = shouldOfferTools(caso.texto);
    if (!ofereceu && caso.esperado) barradosPeloPrefiltro.push(caso.texto);

    let chamou = false;
    let tipo: unknown;
    if (ofereceu) {
      const r = await complete({
        system,
        messages: [{ role: "user", content: caso.texto }],
        model,
        tools: [FORM_TOOL],
      });
      const call = r.toolCalls.find((c) => c.name === TOOL_PROPOR_FORM);
      chamou = Boolean(call);
      tipo = call?.args.tipo;
    }

    let simbolo = ".";
    if (caso.esperado && chamou) {
      vp++;
      if (caso.tipo && tipo !== caso.tipo) {
        tipoErrado++;
        simbolo = "T";
        erros.push(
          `  TIPO (esperado ${caso.tipo}, veio ${String(tipo)}): "${caso.texto}"`
        );
      }
    } else if (caso.esperado && !chamou) {
      fn++;
      simbolo = "x";
      erros.push(`  FN (não propôs): "${caso.texto}"`);
    } else if (!caso.esperado && chamou) {
      fp++;
      simbolo = "x";
      erros.push(`  FP (propôs à toa): "${caso.texto}"`);
    } else vn++;

    process.stdout.write(simbolo);
  }

  const recall = vp + fn > 0 ? vp / (vp + fn) : 1;
  const precisao = vp + fp > 0 ? vp / (vp + fp) : 1;
  const acertoDeTipo = vp > 0 ? (vp - tipoErrado) / vp : 1;

  console.log("\n");
  console.log(`recall:   ${(recall * 100).toFixed(0)}%  (${vp}/${vp + fn} pedidos atendidos)`);
  console.log(`precisão: ${(precisao * 100).toFixed(0)}%  (${fp} proposta(s) à toa)`);
  console.log(`tipo:     ${(acertoDeTipo * 100).toFixed(0)}%  (${tipoErrado} com tipo errado)`);
  console.log(`acertos:  ${vp - tipoErrado + vn}/${CASOS.length}`);

  if (erros.length) console.log(`\n${erros.join("\n")}`);
  if (barradosPeloPrefiltro.length) {
    console.log(
      `\nBarrados pelo PREFILTRO (o modelo nem viu — corrigir o regex em tools.ts):\n` +
        barradosPeloPrefiltro.map((t) => `  "${t}"`).join("\n")
    );
  }

  /**
   * Dois critérios, e o de TIPO é o mais duro de propósito.
   *
   * Recall baixo custa a feature (a pessoa pede e não é atendida). Tipo errado
   * custa CONFIANÇA: o documento errado nasce com a confirmação da pessoa em
   * cima, e ela não tem como saber que confirmou outra coisa senão relendo. Um
   * recall de 90% com tipo de 80% é pior que o contrário.
   */
  const veredito =
    recall < 0.8
      ? "recall abaixo de 80% — o nano não serve para esta escolha."
      : acertoDeTipo < 0.9
        ? "recall ok, mas o TIPO erra demais — a pessoa confirmaria a coisa errada."
        : null;

  console.log(
    veredito
      ? `\nVEREDITO: ${veredito} Subir o modelo SÓ nos turns que passam o prefiltro.`
      : "\nVEREDITO: aceitável para seguir com o nano."
  );
}

main().catch((err) => {
  console.error("\nfalhou:", err);
  process.exitCode = 1;
});
