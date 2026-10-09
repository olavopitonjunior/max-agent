/**
 * Bateria de RESPOSTAS do Max: o grafo inteiro (com histórico, como na thread
 * real), o modelo de PRODUÇÃO e o ImobPro SIMULADO — nada é escrito em lugar
 * nenhum. Nasceu do teste de 09/10, quando "procure a da Letícia" e "remove o
 * fiador" responderam errado sem que nenhum teste de unidade acusasse.
 *
 * Mede, por turno e no agregado:
 *  - precisão: o texto tem o que precisa e não tem o que não pode;
 *  - ações (tool calling): os verbos esperados foram chamados, os proibidos não;
 *  - latência do grafo (sem a rede do ImobPro), separada por "com/sem modelo";
 *  - prolixidade: caracteres, palavras, linhas, e o teto do compose (500/6);
 *  - qualidade: nota 1–5 de um juiz com rubrica fixa (EVAL_JUIZ, opcional).
 *
 * Uso:
 *   OPENROUTER_API_KEY=... npx vitest run --config vitest.eval.config.ts
 *   EVAL_N=3 (repetições)  EVAL_JUIZ=anthropic/claude-haiku-4.5 (nota; vazio = sem juiz)
 *   EVAL_SAIDA=/caminho/resultado.json (grava o detalhe)
 * Custo: ~45 turnos × (0–2 chamadas do nano) + 1 do juiz por turno. Centavos.
 */
import { it, vi } from "vitest";
import { writeFileSync } from "node:fs";

type Res = { text: string; toolCalls: { name: string; args: Record<string, unknown> }[]; usage: { promptTokens?: number; completionTokens?: number } };
const chamadas: { tools: string[]; tokens: number }[] = [];
vi.mock("@/lib/llm", async (orig) => {
  const r = await orig<typeof import("@/lib/llm")>();
  (globalThis as Record<string, unknown>).__completeReal = r.complete;
  return {
    ...r,
    complete: vi.fn(async (p: Parameters<typeof r.complete>[0]) => {
      const res = (await r.complete(p)) as Res;
      chamadas.push({ tools: res.toolCalls.map((c) => c.name), tokens: (res.usage.promptTokens ?? 0) + (res.usage.completionTokens ?? 0) });
      return res;
    }),
  };
});
vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/acao", () => ({ executarAcao: vi.fn() }));
vi.mock("@/lib/scope", async (orig) => ({ ...(await orig<typeof import("@/lib/scope")>()), consultarEscopo: vi.fn() }));

const { buildGraph, RESET_DO_TURN } = await import("../src/graph/graph");
const { fetchProfile } = await import("../src/lib/cm");
const { executarAcao } = await import("../src/lib/acao");
const { consultarEscopo } = await import("../src/lib/scope");
const { MemorySaver } = await import("@langchain/langgraph");

// ─── O ImobPro simulado ─────────────────────────────────────────────────────

type Prop = { id: string; codigo: string; titulo: string; status: string; estado: string; signatarios: { nome: string; status: string }[] };
const BASE: Prop[] = [
  { id: "p1", codigo: "PROP-2026-0011", titulo: "Apto 302 Rua das Flores", status: "assinada_proponente", estado: "Assinada pelo proponente", signatarios: [{ nome: "Letícia Moraes", status: "assinou" }] },
  { id: "p2", codigo: "PROP-2026-0012", titulo: "Casa Jardim Europa", status: "rascunho", estado: "Rascunho", signatarios: [{ nome: "Letícia Andrade", status: "pendente" }] },
  { id: "p3", codigo: "PROP-2026-0013", titulo: "Sala comercial Centro", status: "enviada", estado: "Enviada", signatarios: [{ nome: "Carlos Pereira", status: "pendente" }] },
  { id: "p4", codigo: "PROP-2026-0014", titulo: "Cobertura Av. Atlântica 1500", status: "rascunho", estado: "Rascunho", signatarios: [{ nome: "Renato Lima", status: "pendente" }] },
];
const EDITAVEIS = new Set(["rascunho", "aguardando_aprovacao", "falha_envio"]);
let props: Prop[] = [];
let seq = 0;
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const palavras = (p: Prop) => norm(`${p.codigo} ${p.titulo} ${p.signatarios.map((s) => s.nome).join(" ")}`).split(/[^a-z0-9]+/).filter(Boolean);
const semZeros = (x: string) => x.replace(/^0+(?=\d)/, "");
const casa = (p: Prop, busca: string) => norm(busca).split(/[^a-z0-9]+/).filter(Boolean).every((w) =>
  palavras(p).some((q) => (/^\d+$/.test(w) ? /^\d+$/.test(q) && semZeros(q) === semZeros(w) : q === w || (w.length >= 4 && q.startsWith(w)))));
const achar = (a: Record<string, unknown>) => props.find((p) => p.id === a.proposta_id || p.id === a.id || p.codigo === String(a.codigo ?? "").toUpperCase());
const pdf = { link: "https://app.imobpro.test/p/rascunho.pdf", expiraEm: new Date(Date.now() + 2 * 3600e3).toISOString() };
const lista = (a: Record<string, unknown>) => {
  const b = typeof a.busca === "string" ? a.busca : null;
  const items = b ? props.filter((p) => casa(p, b)) : props;
  return { items: items.slice(0, 10), total: items.length, ...(b ? { busca: norm(b) } : {}) };
};

async function imobpro({ verb, args = {} }: { verb: string; args?: Record<string, unknown> }): Promise<{ status: number; body: Record<string, unknown> }> {
  const p = achar(args);
  switch (verb) {
    case "proposal.list": return { status: 200, body: lista(args) };
    case "proposal.status": return p ? { status: 200, body: { proposta: p } } : { status: 404, body: { error: "nao_encontrada" } };
    case "proposal.complete": return { status: 200, body: { status: "completa" } };
    case "proposal.convert": return { status: 201, body: { negocio: { id: "d1", link: "https://app.imobpro.test/deals/d1" }, formulario: { id: "f1", link: "https://app.imobpro.test/f/abc" } } };
    case "proposal.delete":
      if (!p) return { status: 404, body: { error: "nao_encontrada" } };
      if (p.status === "enviada") return { status: 409, body: { error: "ja_enviada" } };
      props = props.filter((x) => x !== p);
      return { status: 200, body: { ok: true, proposta: { codigo: p.codigo } } };
    case "proposal.duplicate": {
      if (!p) return { status: 404, body: { error: "nao_encontrada" } };
      const novo = { ...p, id: `n${++seq}`, codigo: `PROP-2026-00${20 + seq}`, status: "rascunho", estado: "Rascunho" };
      props.push(novo);
      return { status: 201, body: { proposta: { id: novo.id, codigo: novo.codigo, status: "rascunho" }, origem: { codigo: p.codigo } } };
    }
    case "proposal.update":
      if (!p) return { status: 404, body: { error: "nao_encontrada" } };
      if (!EDITAVEIS.has(p.status)) return { status: 409, body: { error: "nao_editavel", estado: p.estado } };
      return { status: 200, body: { proposta: { id: p.id, codigo: p.codigo }, pdf } };
    case "proposal.create": {
      const novo: Prop = { id: `c${++seq}`, codigo: `PROP-2026-00${40 + seq}`, titulo: "Nova", status: "rascunho", estado: "Rascunho", signatarios: [] };
      props.push(novo);
      return { status: 201, body: { proposal: { id: novo.id, code: novo.codigo }, proposta: { id: novo.id, codigo: novo.codigo }, pdf } };
    }
    case "proposal.options":
      return { status: 200, body: { assinaturaConfigurada: true, metodos: [{ valor: "whatsapp", rotulo: "WhatsApp" }, { valor: "email", rotulo: "E-mail" }], signatarios: p?.signatarios.map((s) => ({ nome: s.nome, papel: "proponente" })) ?? [] } };
    case "proposal.preflight": return { status: 200, body: { ok: true, modelo: true, assinaturaConfigurada: true } };
    case "form.options": return { status: 200, body: { campos: [] } };
    default: return { status: 501, body: { error: `nao_simulado:${verb}` } };
  }
}

// ─── Cenários ───────────────────────────────────────────────────────────────

type Espera = {
  /** O que uma boa resposta faz — vai para o juiz. */
  ideal: string;
  contem?: (string | RegExp)[];
  naoContem?: (string | RegExp)[];
  /** Verbos (scope-action ou scope-query) que TÊM de ser chamados. */
  verbos?: string[];
  /** Verbos que NÃO podem ser chamados neste turno. */
  proibidos?: string[];
  /** Conferência dos argumentos de um verbo (null = ok). */
  args?: { verbo: string; confere: (a: Record<string, unknown>) => string | null };
};
type Turno = { fala: string } & Espera;
type Conversa = { nome: string; categoria: string; turnos: Turno[] };

const ESCRITAS = ["proposal.delete", "proposal.update", "proposal.duplicate", "proposal.convert", "proposal.send", "proposal.create", "form.create"];
const SEM_ESCRITA = { proibidos: ESCRITAS };

const CONVERSAS: Conversa[] = [
  // Consulta
  { nome: "listar tudo", categoria: "consulta", turnos: [
    { fala: "liste as minhas propostas", ideal: "Lista as 4 propostas com código e situação, sem inventar nem oferecer 'o resto' que não existe.",
      contem: ["PROP-2026-0011", "PROP-2026-0012", "PROP-2026-0013", "PROP-2026-0014"], ...SEM_ESCRITA },
  ] },
  { nome: "procurar pelo nome (2 casam)", categoria: "consulta", turnos: [
    { fala: "procure a proposta da letícia", ideal: "Mostra as DUAS propostas da Letícia (Moraes e Andrade), com código, e nenhuma de outra pessoa.",
      contem: ["PROP-2026-0011", "PROP-2026-0012"], naoContem: ["PROP-2026-0013", "PROP-2026-0014", /encontrei 1 /i], ...SEM_ESCRITA },
  ] },
  { nome: "status pelo endereço", categoria: "consulta", turnos: [
    { fala: "qual o status da proposta da rua das flores?", ideal: "Diz que a PROP-2026-0011 (Apto 302 Rua das Flores) está assinada pelo proponente.",
      contem: ["0011", /assinad/i], naoContem: ["PROP-2026-0013"], ...SEM_ESCRITA },
  ] },
  { nome: "status pelo nome", categoria: "consulta", turnos: [
    { fala: "como está a proposta do Carlos?", ideal: "Diz que a PROP-2026-0013 do Carlos foi enviada e a assinatura dele está pendente.",
      contem: ["0013", /enviad|pendente/i], naoContem: ["PROP-2026-0011"], ...SEM_ESCRITA },
  ] },
  { nome: "nome que não existe", categoria: "consulta", turnos: [
    { fala: "tem alguma proposta da Mariana?", ideal: "Diz que não achou proposta da Mariana, sem listar propostas de outras pessoas como se fossem dela.",
      contem: [/n[aã]o (achei|encontrei)/i], naoContem: [/Mariana.*PROP-2026-001[1-4]/i], ...SEM_ESCRITA },
  ] },
  { nome: "filtrar por estado", categoria: "consulta", turnos: [
    { fala: "quais propostas estão em rascunho?", ideal: "Lista só as em rascunho: PROP-2026-0012 e PROP-2026-0014.",
      contem: ["0012", "0014"], naoContem: ["PROP-2026-0011", "PROP-2026-0013"], ...SEM_ESCRITA },
  ] },
  { nome: "pelo código", categoria: "consulta", turnos: [
    { fala: "me mostra a PROP-2026-0013", ideal: "Mostra a PROP-2026-0013 (Sala comercial Centro), enviada, Carlos pendente.",
      contem: ["0013"], ...SEM_ESCRITA },
  ] },
  // Conversão
  { nome: "converter pelo nome completo", categoria: "conversao", turnos: [
    { fala: "Max, transforme a proposta da Letícia Moraes em negócio e gere o link do formulário", ideal: "Resume a PROP-2026-0011 e pede SIM antes de converter.",
      contem: ["0011", /SIM/], ...SEM_ESCRITA },
    { fala: "SIM", ideal: "Confirma a conversão com o link do negócio e o do formulário.",
      contem: ["deals/d1", "f/abc"], verbos: ["proposal.convert"] },
  ] },
  { nome: "converter pelo primeiro nome (1 convertível)", categoria: "conversao", turnos: [
    { fala: "converte a proposta da Letícia em negócio", ideal: "Acha a PROP-2026-0011 (a assinada) e pede SIM, ou pergunta qual das duas.",
      contem: ["0011"], ...SEM_ESCRITA },
  ] },
  // Edição de proposta existente
  { nome: "mudar o valor pelo nome", categoria: "edicao", turnos: [
    { fala: "muda o valor da proposta da Letícia Andrade para 480 mil", ideal: "Mostra o ajuste (valor R$ 480.000) da PROP-2026-0012 e pede SIM; não muda o nome de ninguém.",
      contem: ["0012", /480/, /SIM/], ...SEM_ESCRITA },
    { fala: "SIM", ideal: "Confirma que atualizou o rascunho PROP-2026-0012, com o PDF.",
      contem: [/atualizei/i, "0012"], verbos: ["proposal.update"],
      args: { verbo: "proposal.update", confere: (a) => a.proposta_id !== "p2" ? `alvo=${a.proposta_id}` : a.valor !== 480000 ? `valor=${a.valor}` : (a.proponente as { nome?: string } | undefined)?.nome ? "mudou o nome do proponente" : null } },
  ] },
  { nome: "corrigir e-mail pelo código", categoria: "edicao", turnos: [
    { fala: "corrige o e-mail do comprador na proposta PROP-2026-0014 para renato.lima@exemplo.com", ideal: "Mostra o ajuste do e-mail na PROP-2026-0014 e pede SIM.",
      contem: ["0014", "renato.lima@exemplo.com", /SIM/], ...SEM_ESCRITA },
    { fala: "sim", ideal: "Confirma a atualização.", verbos: ["proposal.update"],
      args: { verbo: "proposal.update", confere: (a) => (a.proponente as { email?: string } | undefined)?.email === "renato.lima@exemplo.com" ? null : "e-mail não foi" } },
  ] },
  { nome: "remover fiador", categoria: "edicao", turnos: [
    { fala: "remove o fiador da proposta da Letícia Andrade", ideal: "Diz que fiador não se ajusta pelo WhatsApp e indica a tela da proposta; não exclui a proposta nem diz que não edita proposta nenhuma.",
      contem: [/fiador/i, /tela/i], naoContem: [/exclu[ií]da/i, /n[aã]o (tenho como|consigo) (alterar|editar).{0,20}proposta/i], ...SEM_ESCRITA },
  ] },
  { nome: "editar proposta enviada", categoria: "edicao", turnos: [
    { fala: "muda o valor da proposta do Carlos para 300 mil", ideal: "Explica que a PROP-2026-0013 já foi enviada e não pode ser editada; sugere duplicar ou a tela.",
      contem: ["0013", /enviad/i, /duplic|tela/i], ...SEM_ESCRITA },
  ] },
  { nome: "duplicar e ajustar a cópia", categoria: "edicao", turnos: [
    { fala: "duplica a proposta da Letícia Moraes", ideal: "Resume a duplicação da PROP-2026-0011 e pede SIM.", contem: ["0011", /SIM/], ...SEM_ESCRITA },
    { fala: "SIM", ideal: "Confirma o rascunho novo e convida a dizer o que trocar.", verbos: ["proposal.duplicate"], contem: [/rascunho/i] },
    { fala: "muda o valor para 1,1 milhão", ideal: "Mostra o ajuste do valor (R$ 1.100.000) no rascunho novo e pede SIM.", contem: [/1\.100\.000|1,1 milh/i, /SIM/], ...SEM_ESCRITA },
    { fala: "SIM", ideal: "Confirma a atualização do rascunho novo.", verbos: ["proposal.update"],
      args: { verbo: "proposal.update", confere: (a) => String(a.proposta_id).startsWith("n") && a.valor === 1100000 ? null : `alvo=${a.proposta_id} valor=${a.valor}` } },
  ] },
  { nome: "editar em forma de pergunta", categoria: "edicao", turnos: [
    { fala: "pode mudar o valor da proposta da Letícia Andrade para 470 mil?", ideal: "Mostra o ajuste (R$ 470.000) da PROP-2026-0012 e pede SIM.",
      contem: ["0012", /470/, /SIM/], ...SEM_ESCRITA },
  ] },
  { nome: "editar em dois passos", categoria: "edicao", turnos: [
    { fala: "edita a proposta da Letícia Andrade", ideal: "Pergunta o que mudar na PROP-2026-0012 e diz o que dá para ajustar.", contem: ["0012"], ...SEM_ESCRITA },
    { fala: "o valor passa a ser 455 mil", ideal: "Mostra o ajuste do valor (R$ 455.000) e pede SIM.", contem: [/455/, /SIM/], ...SEM_ESCRITA },
    { fala: "sim", ideal: "Confirma a atualização da PROP-2026-0012.", verbos: ["proposal.update"],
      args: { verbo: "proposal.update", confere: (a) => a.proposta_id === "p2" && a.valor === 455000 ? null : `alvo=${a.proposta_id} valor=${a.valor}` } },
  ] },
  { nome: "edição mista com fiador", categoria: "edicao", turnos: [
    { fala: "remove o fiador e muda o valor da proposta da Letícia Andrade para 490 mil", ideal: "Avisa que fiador é só pela tela e mostra o ajuste do valor (R$ 490.000) pedindo SIM.",
      contem: [/fiador/i, /490/, /SIM/], ...SEM_ESCRITA },
  ] },
  { nome: "trocar telefone pelo código", categoria: "edicao", turnos: [
    { fala: "na proposta PROP-2026-0014, troca o telefone do comprador para 11 98888-7777", ideal: "Mostra o ajuste do telefone na PROP-2026-0014 e pede SIM.",
      contem: ["0014", /98888/, /SIM/], ...SEM_ESCRITA },
  ] },
  { nome: "editar pelo primeiro nome (só uma editável)", categoria: "edicao", turnos: [
    { fala: "muda o valor da proposta da Letícia para 450 mil", ideal: "Escolhe a PROP-2026-0012 (a da Letícia em rascunho), mostra o ajuste e pede SIM.",
      contem: ["0012", /450/], naoContem: ["PROP-2026-0011"], ...SEM_ESCRITA },
  ] },
  { nome: "status já assinada", categoria: "consulta", turnos: [
    { fala: "a proposta da Letícia Moraes já foi assinada?", ideal: "Diz que a PROP-2026-0011 foi assinada pelo proponente (Letícia Moraes).", contem: ["0011", /assin/i], ...SEM_ESCRITA },
  ] },
  { nome: "filtrar enviadas", categoria: "consulta", turnos: [
    { fala: "quais propostas foram enviadas?", ideal: "Lista só a PROP-2026-0013 (enviada).", contem: ["0013"], naoContem: ["PROP-2026-0012", "PROP-2026-0014"], ...SEM_ESCRITA },
  ] },
  { nome: "minuta do contrato", categoria: "escopo", turnos: [
    { fala: "corrige a minuta do contrato da Letícia", ideal: "Diz que o Max não edita contrato e indica a tela do negócio.", contem: [/contrato/i, /tela/i], ...SEM_ESCRITA },
  ] },
  { nome: "tirar a proposta", categoria: "robustez", turnos: [
    { fala: "tira a proposta da Letícia", ideal: "Não apaga nem altera nada sem confirmação; pergunta ou oferece excluir com SIM.", proibidos: ESCRITAS },
  ] },
  // Exclusão
  { nome: "excluir com escolha", categoria: "gestao", turnos: [
    { fala: "exclui a proposta da Letícia", ideal: "Lista as duas da Letícia numeradas e pergunta qual.", contem: ["0011", "0012"], ...SEM_ESCRITA },
    { fala: "2", ideal: "Resume a exclusão da PROP-2026-0012 e pede SIM.", contem: ["0012", /SIM/], ...SEM_ESCRITA },
    { fala: "SIM", ideal: "Confirma a exclusão.", contem: [/exclu[ií]da/i], verbos: ["proposal.delete"] },
  ] },
  { nome: "excluir e desistir", categoria: "gestao", turnos: [
    { fala: "apaga a proposta PROP-2026-0014", ideal: "Resume a exclusão da PROP-2026-0014 e pede SIM.", contem: ["0014"], ...SEM_ESCRITA },
    { fala: "não", ideal: "Confirma que nada foi alterado.", contem: [/nada foi alterado/i], ...SEM_ESCRITA },
  ] },
  { nome: "excluir enviada", categoria: "gestao", turnos: [
    { fala: "exclui a proposta do Carlos", ideal: "Resume a exclusão da PROP-2026-0013 e pede SIM.", contem: ["0013"], ...SEM_ESCRITA },
    { fala: "SIM", ideal: "Explica que a proposta já foi enviada e não pode ser excluída; só cancelada pela tela.", contem: [/enviada/i], naoContem: [/exclu[ií]da\./i] },
  ] },
  // Escopo do Max
  { nome: "capacidades", categoria: "escopo", turnos: [
    { fala: "o que vc pode fazer?", ideal: "Lista o que a política libera (propostas, conversão, negócios) e diz que contrato e cobrança são pela tela.",
      contem: [/duplicar/i, /excluir/i], naoContem: [/certid/i, /cobran[cç]a de comiss/i], ...SEM_ESCRITA },
  ] },
  { nome: "enviar contrato", categoria: "escopo", turnos: [
    { fala: "manda o contrato pra assinatura", ideal: "Diz que o Max não envia contrato e indica a tela do negócio.", contem: [/contrato/i, /tela/i], ...SEM_ESCRITA },
  ] },
  { nome: "editar cláusula", categoria: "escopo", turnos: [
    { fala: "edita a cláusula do contrato", ideal: "Diz que o Max não edita contrato e indica a tela do negócio, sem perguntas desnecessárias.",
      contem: [/n[aã]o (gero|edito)/i, /tela/i], naoContem: [/venda ou (de )?loca/i], ...SEM_ESCRITA },
  ] },
  { nome: "prazo do contrato", categoria: "escopo", turnos: [
    { fala: "muda o prazo do contrato da Letícia para 36 meses", ideal: "Diz que o Max não edita contrato; indica a tela do negócio.", contem: [/contrato/i, /tela/i], ...SEM_ESCRITA },
  ] },
  { nome: "cobrança", categoria: "escopo", turnos: [
    { fala: "gera um boleto de cobrança pro Carlos", ideal: "Diz que cobrança não é pelo Max.", contem: [/cobran[cç]a/i], ...SEM_ESCRITA },
  ] },
  { nome: "certidões", categoria: "escopo", turnos: [
    { fala: "emite as certidões do vendedor da Letícia", ideal: "Não promete emitir certidões; orienta pelo sistema.", naoContem: [/vou emitir|emiti as|solicitei/i], ...SEM_ESCRITA },
  ] },
  // Não sequestrar
  { nome: "negação de exclusão", categoria: "robustez", turnos: [
    { fala: "não exclui a proposta PROP-2026-0013", ideal: "Não exclui nada; responde de forma neutra.", proibidos: ESCRITAS },
  ] },
  { nome: "pergunta sobre exclusão", categoria: "robustez", turnos: [
    { fala: "posso excluir a proposta?", ideal: "Explica que pode pedir 'exclui a proposta da X' e que rascunho pode ser excluído; não exclui nada.", proibidos: ESCRITAS },
  ] },
  { nome: "pergunta sobre contrato", categoria: "robustez", turnos: [
    { fala: "o contrato da Letícia já foi enviado?", ideal: "Não executa nada; responde que o Max não acompanha contrato por aqui ou orienta a tela.", proibidos: ESCRITAS },
  ] },
  { nome: "saudação", categoria: "robustez", turnos: [
    { fala: "oi", ideal: "Cumprimenta em uma ou duas linhas e oferece ajuda.", proibidos: ESCRITAS },
  ] },
  { nome: "agradecimento", categoria: "robustez", turnos: [
    { fala: "valeu, obrigado!", ideal: "Responde curto e cordial.", proibidos: ESCRITAS },
  ] },
  // Criação e envio
  { nome: "criar proposta", categoria: "criacao", turnos: [
    { fala: "quero fazer uma proposta de venda", ideal: "Começa a coleta perguntando os dados da proposta de venda.", ...SEM_ESCRITA },
  ] },
  { nome: "link de formulário", categoria: "criacao", turnos: [
    { fala: "me manda o link do formulário de locação", ideal: "Começa o formulário de negócio de locação (resumo/pergunta), sem criar nada ainda.", ...SEM_ESCRITA },
  ] },
  { nome: "enviar rascunho pelo nome", categoria: "envio", turnos: [
    { fala: "envia a proposta da Letícia Andrade para assinatura", ideal: "Retoma a PROP-2026-0012 e oferece os tipos de assinatura (WhatsApp/e-mail).",
      contem: ["0012", /whatsapp/i], ...SEM_ESCRITA },
  ] },
];

// ─── Execução e métricas ────────────────────────────────────────────────────

const POLITICA = { byRole: { "*": ["deal.list", "deal.pending", "proposal.list", "form.create", "proposal.create", "proposal.send", "proposal.delete"] }, byRecipient: {}, brokerDefault: [] };
const usuario = { orgId: "org-eval", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };

type Linha = {
  rodada: number; conversa: string; categoria: string; fala: string; resposta: string;
  ms: number; chamadasLlm: number; tokens: number; toolsLlm: string[]; verbos: string[];
  chars: number; palavras: number; linhas: number; acimaDoTeto: boolean;
  falhasTexto: string[]; falhasAcao: string[]; nota?: number; motivo?: string; ideal: string;
  /** O turno tinha o que conferir no texto / nas ações (sem isso não entra no %). */
  temTexto: boolean; temAcao: boolean; juizFalhou?: boolean;
};

const testa = (t: string, x: string | RegExp) => (typeof x === "string" ? t.includes(x) : x.test(t));

async function julgar(l: Linha, historico: string): Promise<{ nota?: number; motivo?: string }> {
  const juiz = process.env.EVAL_JUIZ;
  if (!juiz) return {};
  const complete = (globalThis as Record<string, unknown>).__completeReal as (p: unknown) => Promise<Res>;
  const system =
    "Você avalia respostas do Max, assistente de WhatsApp de corretores de imóveis (pt-BR). Regras do produto: " +
    "o Max cria, ajusta, envia, duplica, exclui, acha e converte PROPOSTAS e cria formulário de negócio; NÃO gera, edita, aprova nem envia " +
    "CONTRATO e NÃO faz cobrança nem certidões (indica a tela do sistema); escrita só depois de resumo + SIM; deve citar o código da proposta; " +
    "WhatsApp pede respostas curtas. Dê nota 1–5: 5 = correta, completa e enxuta; 4 = correta com pequeno excesso ou omissão; " +
    "3 = parcialmente útil ou com pergunta desnecessária; 2 = errada em ponto importante ou promete o que não faz; 1 = errada/enganosa. " +
    'Responda SÓ JSON: {"nota": n, "motivo": "até 15 palavras"}.';
  const user = `Conversa até aqui:\n${historico || "(início)"}\n\nMensagem: ${l.fala}\nResposta do Max:\n${l.resposta}\n\nO que uma boa resposta faz: ${l.ideal}`;
  try {
    const r = await complete({ system, messages: [{ role: "user", content: user }], model: juiz, timeoutMs: 30000 });
    const j = JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as { nota?: number; motivo?: string };
    return { nota: typeof j.nota === "number" ? j.nota : undefined, motivo: j.motivo };
  } catch {
    return { juizFalhou: true } as { nota?: number; motivo?: string };
  }
}

const pct = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
};
const media = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

it("bateria de respostas", { timeout: 30 * 60_000 }, async () => {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY ausente");
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: POLITICA } as never);
  const verbos: { verbo: string; args: Record<string, unknown> }[] = [];
  vi.mocked(executarAcao).mockImplementation((async (p: { verb: string; args?: Record<string, unknown> }) => {
    verbos.push({ verbo: p.verb, args: p.args ?? {} });
    return imobpro(p);
  }) as never);
  vi.mocked(consultarEscopo).mockImplementation((async (p: { verb: string; args?: Record<string, unknown> }) => {
    verbos.push({ verbo: p.verb, args: p.args ?? {} });
    if (p.verb !== "proposal.list") return { items: [], truncated: false };
    const l = lista(p.args ?? {});
    return { items: l.items, truncated: l.total > l.items.length };
  }) as never);

  const n = Math.max(1, Number(process.env.EVAL_N) || 1);
  const filtro = process.env.EVAL_SO ? new RegExp(process.env.EVAL_SO, "i") : null;
  const linhas: Linha[] = [];
  let msg = 0;
  for (let rodada = 1; rodada <= n; rodada++) {
    for (const c of CONVERSAS) {
      if (filtro && !filtro.test(c.nome) && !filtro.test(c.categoria)) continue;
      props = BASE.map((p) => ({ ...p, signatarios: p.signatarios.map((s) => ({ ...s })) }));
      seq = 0;
      const app = buildGraph().compile({ checkpointer: new MemorySaver() });
      const thread = `eval-${rodada}-${c.nome}`;
      let historico = "";
      for (const t of c.turnos) {
        chamadas.length = 0;
        verbos.length = 0;
        const t0 = Date.now();
        const s = await app.invoke(
          { inbound: { messageId: `m${++msg}`, fromPhone: "5511987654321", groupId: null, kind: "text" as const, text: t.fala, mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null },
            identity: usuario, ...RESET_DO_TURN },
          { configurable: { thread_id: thread } }
        );
        const ms = Date.now() - t0;
        const resposta = String(s.reply ?? "");
        const nomes = verbos.map((v) => v.verbo);
        const falhasTexto = [
          ...(t.contem ?? []).filter((x) => !testa(resposta, x)).map((x) => `falta ${x}`),
          ...(t.naoContem ?? []).filter((x) => testa(resposta, x)).map((x) => `sobra ${x}`),
        ];
        const falhasAcao = [
          ...(t.verbos ?? []).filter((v) => !nomes.includes(v)).map((v) => `não chamou ${v}`),
          ...(t.proibidos ?? []).filter((v) => nomes.includes(v)).map((v) => `chamou ${v}`),
        ];
        if (t.args) {
          const chamada = verbos.find((v) => v.verbo === t.args!.verbo);
          const erro = chamada ? t.args.confere(chamada.args) : null;
          if (erro) falhasAcao.push(`${t.args.verbo}: ${erro}`);
        }
        const l: Linha = {
          rodada, conversa: c.nome, categoria: c.categoria, fala: t.fala, resposta, ms,
          chamadasLlm: chamadas.length, tokens: chamadas.reduce((a, b) => a + b.tokens, 0), toolsLlm: chamadas.flatMap((x) => x.tools),
          verbos: nomes, chars: resposta.length, palavras: resposta.split(/\s+/).filter(Boolean).length,
          linhas: resposta.split("\n").filter((x) => x.trim()).length, acimaDoTeto: resposta.length > 500 || resposta.split("\n").filter((x) => x.trim()).length > 6,
          falhasTexto, falhasAcao, ideal: t.ideal,
          temTexto: !!(t.contem?.length || t.naoContem?.length), temAcao: !!(t.verbos?.length || t.proibidos?.length || t.args),
        };
        Object.assign(l, await julgar(l, historico));
        historico += `\nCorretor: ${t.fala}\nMax: ${resposta}`;
        linhas.push(l);
        const ok = !falhasTexto.length && !falhasAcao.length;
        console.log(`${ok ? "✓" : "✗"} [${c.categoria}] ${c.nome} › "${t.fala}" ${ms}ms llm=${l.chamadasLlm} ${l.chars}c${l.nota ? ` nota=${l.nota}` : ""}` +
          `${ok ? "" : `\n    ${[...falhasTexto, ...falhasAcao].join("; ")}`}\n    ↳ ${resposta.replace(/\n/g, " / ").slice(0, 220)}`);
      }
    }
  }

  const com = linhas.filter((l) => l.chamadasLlm > 0);
  const sem = linhas.filter((l) => l.chamadasLlm === 0);
  const notas = linhas.map((l) => l.nota).filter((x): x is number => typeof x === "number");
  const comTexto = linhas.filter((l) => l.temTexto);
  const comAcao = linhas.filter((l) => l.temAcao);
  const resumo = {
    turnos: linhas.length,
    // Só sobre os turnos que têm o que conferir — "oi" sem asserção não infla o %.
    precisao: +(100 * comTexto.filter((l) => !l.falhasTexto.length).length / Math.max(1, comTexto.length)).toFixed(1),
    acoesCorretas: +(100 * comAcao.filter((l) => !l.falhasAcao.length).length / Math.max(1, comAcao.length)).toFixed(1),
    turnosPerfeitos: +(100 * linhas.filter((l) => !l.falhasTexto.length && !l.falhasAcao.length).length / linhas.length).toFixed(1),
    qualidadeMedia: notas.length ? +media(notas).toFixed(2) : null,
    turnosJulgados: `${notas.length}/${linhas.length}`,
    notasAte3: notas.filter((x) => x <= 3).length,
    latencia: {
      semModelo: { n: sem.length, p50: pct(sem.map((l) => l.ms), 0.5), p95: pct(sem.map((l) => l.ms), 0.95) },
      comModelo: { n: com.length, p50: pct(com.map((l) => l.ms), 0.5), p95: pct(com.map((l) => l.ms), 0.95) },
    },
    chamadasLlmPorTurno: +media(linhas.map((l) => l.chamadasLlm)).toFixed(2),
    tokensPorTurno: Math.round(media(linhas.map((l) => l.tokens))),
    prolixidade: {
      mediaChars: Math.round(media(linhas.map((l) => l.chars))), p95Chars: pct(linhas.map((l) => l.chars), 0.95),
      mediaPalavras: Math.round(media(linhas.map((l) => l.palavras))), mediaLinhas: +media(linhas.map((l) => l.linhas)).toFixed(1),
      acimaDoTeto: linhas.filter((l) => l.acimaDoTeto).length,
    },
    porCategoria: Object.fromEntries([...new Set(linhas.map((l) => l.categoria))].map((cat) => {
      const ls = linhas.filter((l) => l.categoria === cat);
      const ns = ls.map((l) => l.nota).filter((x): x is number => typeof x === "number");
      return [cat, { turnos: ls.length, ok: ls.filter((l) => !l.falhasTexto.length && !l.falhasAcao.length).length, nota: ns.length ? +media(ns).toFixed(2) : null }];
    })),
  };
  console.log(`\n── RESUMO\n${JSON.stringify(resumo, null, 2)}`);
  const baixas = linhas.filter((l) => (l.nota ?? 5) <= 3);
  if (baixas.length) console.log(`\n── NOTAS ≤ 3\n${baixas.map((l) => `${l.nota} ${l.conversa} › "${l.fala}": ${l.motivo}`).join("\n")}`);
  if (process.env.EVAL_SAIDA) writeFileSync(process.env.EVAL_SAIDA, JSON.stringify({ resumo, linhas }, null, 2));
});
