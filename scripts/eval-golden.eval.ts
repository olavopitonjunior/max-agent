/**
 * GOLDEN SET: roda `evals/golden/casos.ts` pelo grafo inteiro, com o modelo de
 * PRODUÇÃO (OpenRouter) e o ImobPro SIMULADO (`scripts/eval-simulador.ts`).
 * Nada é gravado em lugar nenhum. Sem juiz LLM: toda checagem é determinística.
 *
 * Por turno confere: contem/naoContem, verbos chamados/proibidos, argumentos do
 * verbo, formato global (`**`, `##`, ⟨⟩, `n=`, códigos internos, vocativo de
 * terceiro) e promessa sem efeito (texto promete e nenhuma escrita foi feita).
 * No agregado: `promessaSemEfeito`, `perguntasPorTarefa`, `formato`,
 * % de ações certas e o gate (`goldenGate`).
 *
 * Como rodar: ver o cabeçalho de `evals/golden/casos.ts` e
 * `docs/superpowers/evaluation-gates.md`.
 *   Max:    OPENROUTER_API_KEY=... npx vitest run --config vitest.eval.config.ts scripts/eval-golden.eval.ts
 *   Newton: AGENT_DEPLOY_PROFILE=newton (mesma linha)
 *   EVAL_N=1  EVAL_SO=<regex>  EVAL_SAIDA=<json>  EVAL_REPORT_ONLY=true
 */
import { it, vi, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { goldenGate, goldenMetrics, detectaPromessaSemEfeito, violacoesDeFormato, vocativoErrado, summarizeQuality, type QualityRow } from "./eval-quality";
import { S, reiniciar, imobpro, consultaGolden } from "./eval-simulador";
import { CASOS, TERCEIROS_PADRAO, type CasoGolden, type ConfereArgs, type Esperado } from "../evals/golden/casos";
import type { LlmUsage } from "../src/lib/llm";

// Cofre da ficha de crédito: chave descartável, nada é gravado.
process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

type Res = { text: string; toolCalls: { name: string; args: Record<string, unknown> }[]; usage: LlmUsage };
const chamadas: { usage: LlmUsage; tools: string[] }[] = [];
vi.mock("@/lib/llm", async (orig) => {
  const r = await orig<typeof import("@/lib/llm")>();
  return {
    ...r,
    complete: vi.fn(async (p: Parameters<typeof r.complete>[0]) => {
      const res = (await r.complete(p)) as Res;
      chamadas.push({ usage: res.usage, tools: res.toolCalls.map((c) => c.name) });
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

const { buildGraph, RESET_DO_TURN, respostaDoTurno, encerrarTurno } = await import("../src/graph/graph");
const { fetchProfile } = await import("../src/lib/cm");
const { executarAcao } = await import("../src/lib/acao");
const { consultarEscopo } = await import("../src/lib/scope");
const { isWriteVerb } = await import("../src/lib/runtime/catalog");
const { MemorySaver } = await import("@langchain/langgraph");

const POLITICA = {
  byRole: {
    "*": [
      "deal.list", "deal.detail", "deal.pending", "proposal.list", "proposal.create", "proposal.send", "proposal.delete",
      "form.create", "credit.read", "credit.request", "captacao.create", "captacao.send", "captacao.list",
      "metrics.get", "contract.status", "pending.summary", "property.list", "notification.list", "activity.list",
    ],
  },
  byRecipient: {},
  brokerDefault: [],
};
const usuario = { orgId: "org-eval", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };

// ─── Checagens ──────────────────────────────────────────────────────────────

const testa = (t: string, x: string | RegExp) => (typeof x === "string" ? t.includes(x) : x.test(t));

/** "dados.proprietarios.0.nome" -> valor aninhado (índice numérico entra em array). */
function porCaminho(obj: unknown, caminho: string): unknown {
  return caminho.split(".").reduce<unknown>((acc, k) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[k];
  }, obj);
}

function confereArgs(chamados: { verbo: string; args: Record<string, unknown> }[], esperado: ConfereArgs): string[] {
  const doVerbo = chamados.filter((c) => c.verbo === esperado.verbo);
  if (!doVerbo.length) return [`args ${esperado.verbo}: verbo não chamado`];
  const faltas = (args: Record<string, unknown>) =>
    Object.entries(esperado.contem).flatMap(([caminho, regra]) => {
      const v = porCaminho(args, caminho);
      const ok = regra === true ? v !== undefined && v !== null && v !== "" : regra instanceof RegExp ? regra.test(String(v ?? "")) : v === regra;
      return ok ? [] : [`${caminho}=${JSON.stringify(v)} (esperado ${String(regra)})`];
    });
  const tentativas = doVerbo.map((c) => faltas(c.args));
  if (tentativas.some((f) => !f.length)) return [];
  return [`args ${esperado.verbo}: ${tentativas[0]!.join("; ")}`];
}

/** O turno mostrou o resumo que pede a confirmação (conta para `perguntasPorTarefa`). */
const CARD = /\bSIM\b|\bConfirma\?|Criei o rascunho/;

function avaliaTurno(esp: Esperado, resposta: string, chamados: { verbo: string; args: Record<string, unknown> }[]) {
  const nomes = chamados.map((c) => c.verbo);
  const textFailures = [
    ...(esp.contem ?? []).filter((x) => !testa(resposta, x)).map((x) => `falta ${x}`),
    ...(esp.naoContem ?? []).filter((x) => testa(resposta, x)).map((x) => `sobra ${x}`),
  ];
  const actionFailures = [
    ...(esp.acoes ?? []).filter((v) => !nomes.includes(v)).map((v) => `não chamou ${v}`),
    ...(esp.acoesProibidas ?? []).filter((v) => nomes.includes(v)).map((v) => `chamou ${v}`),
    ...(esp.args ?? []).flatMap((a) => confereArgs(chamados, a)),
  ];
  return {
    textChecks: (esp.contem?.length ?? 0) + (esp.naoContem?.length ?? 0),
    actionChecks: (esp.acoes?.length ?? 0) + (esp.acoesProibidas?.length ?? 0) + (esp.args?.length ?? 0),
    textFailures,
    actionFailures,
    safetyFailures: (esp.acoesProibidas ?? []).filter((v) => nomes.includes(v)),
  };
}

function configuraAmbiente(c: CasoGolden) {
  const amb = new Set(c.ambiente ?? ["consultas", "captacao"]);
  const liga = (nome: string, on: boolean) => (on ? (process.env[nome] = "true") : delete process.env[nome]);
  liga("MAX_EXTENDED_QUERIES", amb.has("consultas"));
  if (amb.has("consultas")) process.env.MAX_ROLLOUT_ORGS = JSON.stringify({ [usuario.orgId]: ["queries"] });
  else delete process.env.MAX_ROLLOUT_ORGS;
  liga("MAX_CAPTACAO", amb.has("captacao"));
  liga("MAX_CAPTACAO_ENVIO", amb.has("captacao"));
  liga("MAX_CREDITO", amb.has("credito"));
  liga("MAX_CREDITO_ENVIO", amb.has("credito") && !!c.envio);
}

// ─── Execução ───────────────────────────────────────────────────────────────

it("golden set", { timeout: 30 * 60_000 }, async () => {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY ausente");
  const perfil = (process.env.AGENT_DEPLOY_PROFILE ?? "").trim().toLowerCase() === "newton" ? "newton" : "max";
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, maxPolicy: POLITICA } as never);

  const chamados: { verbo: string; args: Record<string, unknown> }[] = [];
  let escritas = 0;
  vi.mocked(executarAcao).mockImplementation((async (p: { verb: string; args?: Record<string, unknown>; idempotencyKey?: string }) => {
    chamados.push({ verbo: p.verb, args: p.args ?? {} });
    if (isWriteVerb(p.verb)) escritas++;
    if (p.verb === "credit.request" && S.envio === "sem_resposta") return null;
    return imobpro(p, true);
  }) as never);
  vi.mocked(consultarEscopo).mockImplementation((async (p: { verb: string; args?: Record<string, unknown> }) => {
    chamados.push({ verbo: p.verb, args: p.args ?? {} });
    return consultaGolden(p);
  }) as never);

  const n = Math.max(1, Math.min(10, Math.floor(Number(process.env.EVAL_N) || 1)));
  const filtro = process.env.EVAL_SO ? new RegExp(process.env.EVAL_SO, "i") : null;
  const casos = CASOS.filter((c) => c.bot === perfil && (!filtro || filtro.test(c.id) || filtro.test(c.origem)));
  const rows: QualityRow[] = [];
  const linhas: Record<string, unknown>[] = [];
  const usage: LlmUsage[] = [];
  let msg = 0;

  for (let rodada = 1; rodada <= n; rodada++) {
    for (const c of casos) {
      reiniciar({ golden: true, envio: c.envio ?? null });
      configuraAmbiente(c);
      const app = buildGraph().compile({ checkpointer: new MemorySaver() });
      const thread = `golden-${rodada}-${c.id}`;
      const terceiros = c.terceiros ?? TERCEIROS_PADRAO;
      let turn = 0;
      for (const t of c.turnos) {
        chamadas.length = 0;
        chamados.length = 0;
        escritas = 0;
        const t0 = Date.now();
        const messageId = `g${++msg}`;
        const s = await app.invoke(
          { inbound: { messageId, fromPhone: "5511987654321", groupId: null, kind: "text" as const, text: t.usuario, mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null },
            identity: usuario, ...RESET_DO_TURN },
          { configurable: { thread_id: thread } },
        );
        const ms = Date.now() - t0;
        const resposta = String(respostaDoTurno(messageId) ?? s.reply ?? "");
        encerrarTurno(messageId);

        const a = avaliaTurno(t.esperado, resposta, chamados);
        const formato = violacoesDeFormato(resposta);
        const voc = vocativoErrado(resposta, terceiros);
        if (voc) formato.push(`vocativo:${voc}`);
        const promessas = detectaPromessaSemEfeito(resposta, escritas);
        const costs = chamadas.map((x) => x.usage.costUsd);
        usage.push(...chamadas.map((x) => x.usage));
        rows.push({
          caseId: c.id, repetition: rodada, turn: ++turn, response: resposta,
          textChecks: a.textChecks, actionChecks: a.actionChecks, textFailures: a.textFailures, actionFailures: a.actionFailures,
          safetyFailures: a.safetyFailures, latencyMs: ms,
          costUsd: costs.some((v) => v === null) ? null : costs.reduce<number>((acc, v) => acc + (v ?? 0), 0),
          model: chamadas.map((x) => x.usage.model).join(",") || "deterministic", memoryChecks: 0, memoryFailures: 0,
          writes: escritas, tarefa: c.tarefa ?? null, cardExibido: CARD.test(resposta), promessas, formato,
        });
        linhas.push({
          rodada, caso: c.id, bot: c.bot, turno: turn, usuario: t.usuario, resposta, ms, verbos: chamados.map((x) => x.verbo),
          escritas, falhasTexto: a.textFailures, falhasAcao: a.actionFailures, formato, promessas,
        });
        const ok = !a.textFailures.length && !a.actionFailures.length && !formato.length && !promessas.length;
        console.log(
          `${ok ? "OK " : "FALHA"} [${c.bot}] ${c.id} #${turn} "${t.usuario.slice(0, 60)}" ${ms}ms verbos=${chamados.map((x) => x.verbo).join(",") || "-"}` +
            `${ok ? "" : `\n    ${[...a.textFailures, ...a.actionFailures, ...formato.map((f) => `formato ${f}`), ...promessas.map((p) => `promessa "${p}"`)].join("; ")}`}` +
            `\n    > ${resposta.replace(/\n/g, " / ").slice(0, 240)}`,
        );
      }
    }
  }

  const gate = goldenGate(rows);
  const metricas = goldenMetrics(rows);
  const quality = summarizeQuality(rows);
  const turnosOk = linhas.filter((l) => !(l.falhasTexto as string[]).length && !(l.falhasAcao as string[]).length && !(l.formato as string[]).length && !(l.promessas as string[]).length).length;
  const resumo = {
    perfil, casos: casos.length, turnos: rows.length, turnosPerfeitos: turnosOk,
    acoesCorretas: gate.acoesCorretas, promessaSemEfeito: metricas.promessaSemEfeito.turnos, formato: metricas.formato.turnos,
    perguntasPorTarefa: metricas.perguntasPorTarefa.porTipo, gatePassed: gate.passed, motivos: gate.motivos,
  };
  console.log(`\n== RESUMO GOLDEN (${perfil})\n${JSON.stringify(resumo, null, 2)}`);
  if (process.env.EVAL_SAIDA) {
    writeFileSync(process.env.EVAL_SAIDA, JSON.stringify({
      schemaVersion: 1, perfil, repetitions: n, evaluatedAt: new Date().toISOString(),
      effectMode: "mock-tools-real-llm", resumo, gate, metricas, quality, usage, linhas,
    }, null, 2));
  }
  expect(rows.length, "golden: nenhuma conversa selecionada para este perfil").toBeGreaterThan(0);
  if (process.env.EVAL_REPORT_ONLY !== "true") expect(gate.passed, `gate do golden: ${gate.motivos.join("; ")}`).toBe(true);
});
