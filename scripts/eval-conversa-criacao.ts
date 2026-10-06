/**
 * Os dois fluxos de criação contra o modelo de PRODUÇÃO (conversa real de 06/10).
 *
 * Mede as duas únicas coisas que o modelo faz nos fluxos:
 *  1. ENTRADA — num pedido de criação, chamar `propor_criacao` NA HORA (sem
 *     perguntar antes; quem pergunta é o fluxo), com o tipo certo: "proposta"
 *     para proposta, "venda"/"locacao" para formulário de negócio.
 *  2. EXTRAÇÃO — dentro do fluxo, preencher `preencher_proposta` com o que a
 *     mensagem diz (números como número, sem inventar, cliente ≠ quem fala).
 *
 * Uso:  OPENROUTER_API_KEY=... npx tsx scripts/eval-conversa-criacao.ts [--n 5]
 * Custo: ~(entradas + extrações) × n chamadas curtas. Centavos.
 */

import { complete, DEFAULT_MODEL } from "../src/lib/llm";
import { buildSystemPrompt, comoMensagemDoUsuario } from "../src/graph/prompt";
import { ferramentasDoTurno } from "../src/graph/tools";
import { argsDaCriacao } from "../src/graph/despachante";
import { SYSTEM_DA_EXTRACAO, TOOL_EXTRAIR_PROPOSTA, sanearDados } from "../src/graph/fluxos";
import type { Capability } from "../src/graph/policy";

const POLITICA: Capability[] = ["deal.list", "deal.pending", "proposal.list", "form.create", "proposal.create", "proposal.send"];
const OLAVO = { orgId: "org1", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };

const ENTRADAS: { texto: string; tipo: "proposta" | "venda" | "locacao" }[] = [
  { texto: "Pode gerar uma proposta pra mim?", tipo: "proposta" },
  { texto: "preciso fazer uma proposta pro meu cliente", tipo: "proposta" },
  { texto: "quero criar um formulário de negócio de venda", tipo: "venda" },
  { texto: "me manda o link do formulário de locação", tipo: "locacao" },
];

const EXTRACOES: { texto: string; confere: (d: ReturnType<typeof sanearDados>) => string | null }[] = [
  {
    texto:
      "Rua Senador godoi, 606, Vila São geraldo. Comprador Letícia Gonçalves Nogueira. Valor de 1.500.000, sendo 200.000 financiado e o restante a vista no contrato de financiamento.",
    confere: (d) =>
      !d.proponente?.nome?.includes("Letícia")
        ? "nome do comprador"
        : d.valor !== 1_500_000
          ? `valor=${d.valor}`
          : !(d.imovel?.endereco ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().includes("godoi")
            ? "endereço"
            : null,
  },
  {
    texto: "o comprador é o João Pereira da Silva, telefone 11 98765-4321, CPF 123.456.789-09, proposta de 1,2 milhão",
    confere: (d) =>
      d.valor !== 1_200_000
        ? `valor=${d.valor}`
        : (d.proponente?.telefone ?? "").replace(/\D/g, "").endsWith("987654321")
          ? null
          : "telefone",
  },
  {
    texto: "o valor muda pra 1,4 milhão",
    confere: (d) => (d.valor === 1_400_000 && !d.proponente?.nome ? null : `valor=${d.valor} nome=${d.proponente?.nome}`),
  },
];

async function main() {
  const iN = process.argv.indexOf("--n");
  const n = iN > 0 && Number(process.argv[iN + 1]) > 0 ? Number(process.argv[iN + 1]) : 5;
  const model = DEFAULT_MODEL;
  const system = buildSystemPrompt({ orgName: OLAVO.orgName, userName: OLAVO.userName, hits: [], criacao: "disponivel" });
  let ok = 0;
  let total = 0;

  console.log(`modelo: ${model}  n=${n}\n── ENTRADA`);
  for (const e of ENTRADAS) {
    const tools = ferramentasDoTurno({ policy: POLITICA, texto: e.texto, identity: OLAVO }).entradas.map((x) => x.def);
    let acertos = 0;
    const erros: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await complete({
        system,
        messages: [{ role: "user", content: comoMensagemDoUsuario(e.texto) }],
        model,
        tools: tools.length ? tools : undefined,
      });
      const c = r.toolCalls.find((t) => t.name === "propor_criacao");
      const a = c ? argsDaCriacao(c.args, OLAVO.userName) : null;
      if (a?.tipo === e.tipo) acertos++;
      else erros.push(c ? `chamou ${JSON.stringify(c.args)}` : `texto: ${(r.text ?? "").slice(0, 100).replace(/\n/g, " ")}`);
    }
    ok += acertos;
    total += n;
    console.log(`${JSON.stringify(e.texto)}: ${acertos}/${n}`);
    for (const x of erros.slice(0, 2)) console.log(`   ✗ ${x}`);
  }

  console.log(`\n── EXTRAÇÃO`);
  for (const e of EXTRACOES) {
    let acertos = 0;
    const erros: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await complete({
        system: SYSTEM_DA_EXTRACAO,
        messages: [{ role: "user", content: comoMensagemDoUsuario(e.texto) }],
        model,
        tools: [TOOL_EXTRAIR_PROPOSTA as never],
        toolChoice: TOOL_EXTRAIR_PROPOSTA.name,
      });
      const args = r.toolCalls.find((t) => t.name === TOOL_EXTRAIR_PROPOSTA.name)?.args ?? {};
      const falha = e.confere(sanearDados(args));
      if (!falha) acertos++;
      else erros.push(`${falha} ← ${JSON.stringify(args).slice(0, 160)}`);
    }
    ok += acertos;
    total += n;
    console.log(`${JSON.stringify(e.texto.slice(0, 50))}…: ${acertos}/${n}`);
    for (const x of erros.slice(0, 2)) console.log(`   ✗ ${x}`);
  }
  console.log(`\nTOTAL: ${ok}/${total} (${Math.round((100 * ok) / total)}%)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
