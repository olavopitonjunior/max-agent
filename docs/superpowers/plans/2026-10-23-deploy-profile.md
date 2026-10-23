# Newton no motor do Max — Fase 0 e Fase 1: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Congelar e exportar o Newton do VPS (Fase 0) e dar ao motor do `max-agent` um perfil de deploy com transporte, nome e pacotes de tools trocáveis, mantendo o Max idêntico ao baseline 20d8a6f (Fase 1).

**Architecture:** Um módulo `deploy-profile` lê `AGENT_DEPLOY_PROFILE` (ausente ⇒ `max`). A porta de transporte (`src/lib/transport/index.ts`) passa a delegar a um adapter escolhido pelo perfil; a outbox consulta as capacidades do adapter em vez de `=== "meta"`. O nome do agente sai de literal e vem do perfil. `ferramentasDoTurno` soma pacotes de tools do perfil (vazios na Fase 1).

**Tech Stack:** TypeScript 5.7, Next 14.2 (App Router), LangGraph 0.2, vitest 2.1, Postgres (pg 8), Node 22.

**Spec:** `/Users/olavo/.claude/plans/wobbly-spinning-shell.md` (aprovado 23/10/2026). Este plano cobre só a Fase 0 e a Fase 1. Fases 2–5 e a Trilha B ganham planos próprios quando a Fase 1 estiver em staging.

## Global Constraints

- Base do trabalho: `origin/staging` do max-agent = `20d8a6f`. Conferir antes de começar; se mudou, rebasear e refazer o baseline (Task 0.1).
- `AGENT_DEPLOY_PROFILE` ausente ⇒ comportamento idêntico ao de hoje. Esta é a única env nova de perfil; `AGENT_TRANSPORT` é a única env nova de transporte.
- Nomes `MAX_*` de env, kill switches e flags ficam como estão.
- Segredo só do 1Password `Personal`; nunca em URL, argumento, log, chat, commit ou evidência. `.env` só por `op inject`.
- Nada de GitHub Actions como gate ou deploy.
- Antes de commit/PR: agente `orchestrator` (modelo sonnet) e seguir o veredito. O max-agent não tem `scripts/preflight-git.sh`. Nunca push direto em `staging`/`master`.
- Comandos git/gh/vercel: uma chamada Bash por comando.
- Subagentes: `model` explícito; proibido `/tmp`; usar `/Users/olavo/.claude/jobs/81a64a8c/tmp`.
- VPS: só leitura. Nenhum restart, overwrite ou escrita em `/docker`.
- Nenhuma mensagem real de WhatsApp nesta fase.

## Review Focus

1. **`AGENT_DEPLOY_PROFILE` com espaço ou maiúscula** (`" Max "`) deve valer como `max`; valor desconhecido deve **derrubar** a inicialização, nunca cair em `max` silenciosamente. Teste na Task 1.1.
2. **`AGENT_TRANSPORT=log` esquecida em produção** faria o Max "enviar" sem enviar. Em `VERCEL_ENV=production` o override `log` é recusado com erro. Teste na Task 1.2.
3. **Kill switch e trava do playground com adapter `log`**: `MAX_OUTBOUND_KILL=true` continua lançando `outbound_disabled`, e o modo não-`live` continua lançando `playground_transport_denied`, antes de qualquer adapter. Teste na Task 1.2.
4. **`sendTemplate` num adapter sem template** lança `transport_sem_template`; nunca cai para texto livre por conta própria. Teste na Task 1.2.
5. **Perfil `newton` com transporte ainda inexistente** (`newton-bridge`, Fase 2) lança `transport_nao_implementado` na primeira chamada, para ninguém subir o deploy Newton antes da hora. Teste na Task 1.2.

---

## Fase 0 — Congelar, exportar, verificar

Nenhuma tarefa da Fase 0 muda comportamento em produção.

### Task 0.1: Baseline de testes em 20d8a6f

**Files:**
- Create: `docs/superpowers/evidence/2026-10-23-baseline-20d8a6f.md` (no worktree da Task 1.1; entra no PR da Fase 1)

- [ ] **Step 1: Subir o Postgres de teste.** O cluster antigo (outro job) não existe mais.

```bash
initdb -D /Users/olavo/.claude/jobs/81a64a8c/tmp/pg-maxtest -U max --auth=trust
pg_ctl -D /Users/olavo/.claude/jobs/81a64a8c/tmp/pg-maxtest -o "-p 54329 -k /Users/olavo/.claude/jobs/81a64a8c/tmp" -l /Users/olavo/.claude/jobs/81a64a8c/tmp/pg-maxtest.log start
createdb -h 127.0.0.1 -p 54329 -U max maxtest
```
Expected: `pg_isready -h 127.0.0.1 -p 54329` responde "aceitando conexões". O `.env.test` do repo já aponta para `postgres://max@127.0.0.1:54329/maxtest`.

- [ ] **Step 2: Instalar e migrar no checkout desanexado** `/Users/olavo/.claude/jobs/81a64a8c/tmp/ma-staging` (já em 20d8a6f; copiar `.env.test` do checkout principal).

```bash
npm ci
MIGRATE_ENV=.env.test npm run db:migrate
```
Expected: migrações até `026_durable_delivery_fence.sql` aplicadas.

- [ ] **Step 3: Rodar e guardar.** Saída JSON no tmp do job.

```bash
npx vitest run --reporter=json --outputFile=/Users/olavo/.claude/jobs/81a64a8c/tmp/baseline-suite.json
npx vitest run --config vitest.runtime-eval.config.ts --reporter=json --outputFile=/Users/olavo/.claude/jobs/81a64a8c/tmp/baseline-replay.json
npm run typecheck
npm run lint
npm run build
```
Feito 23/10: 2610/2610 verdes, replay 3/3, typecheck, lint e build OK. Exige, num cluster novo, `PostgresSaver.setup()` uma vez e `ALTER SYSTEM SET lc_messages = 'C'` (detalhe na evidência).

- [ ] **Step 4: Escrever a evidência.** Tabela com totais (passaram/falharam/ignorados) da suíte e do replay, nome completo de cada teste que falhou, resultado de typecheck/lint/build, SHA, versão do Node. Sem segredo, sem telefone.

### Task 0.2: Snapshot do VPS em repo privado

**Files:**
- Create: repo GitHub privado `olavopitonjunior/newton-vps-snapshot`, clonado em `~/dev/newton-vps-snapshot`
- Create: `MANIFEST.sha256`, `ENV_NAMES.md`, `README.md` nesse repo

- [ ] **Step 1: Empacotar no VPS, só leitura.** Pela chave `op://Personal/newton-vps.ssh-key` (host `newton-vps`). Incluir `/docker/openclaw-sidecar/{src,personas}`, `/docker/openclaw-mvzp/docker-compose.yml`, `/docker/openclaw-mvzp/contractmaker-mcp-server` (com `dist`). Excluir `node_modules`, `.env*`, `*.pem`, `*.key`, dados do gbrain. `tar` para stdout e gravar em `/Users/olavo/.claude/jobs/81a64a8c/tmp/vps-snapshot.tgz`; nada escrito no VPS.
- [ ] **Step 2: Manifesto dos dois lados.** `sha256sum` de cada arquivo no VPS (stdout) e no Mac após extrair. Expected: `diff` vazio.
- [ ] **Step 3: Nomes das envs.** `docker inspect` do `openclaw-mvzp-sidecar-1` filtrado para só a chave (`cut -d= -f1`). Gravar em `ENV_NAMES.md`. Nunca o valor.
- [ ] **Step 4: Varredura de segredo antes do primeiro commit.** `gitleaks detect --no-git -s .` e um `grep -rIE '(sk-|Bearer [A-Za-z0-9]|password\s*[:=])'`. Qualquer achado: remover o arquivo do snapshot e anotar no README que foi removido e por quê.
- [ ] **Step 5: Criar o repo privado e subir.** `gh repo create olavopitonjunior/newton-vps-snapshot --private`, commit único "snapshot do VPS em 2026-10-23", push. Passa pelo hook global do gitleaks. README diz: só leitura, nada é deployado daqui, data e host.

### Task 0.3: Exportar a memória do gbrain

**Files:**
- Create: documento no 1Password `Personal`, item `newton-gbrain-export-2026-10-23` (JSON)
- Modify: `README.md` do snapshot (contagem e hash do export, não o conteúdo)

Decisão minha: o export fica no cofre, não no git. Ele contém dados de negócio por deal.

- [ ] **Step 1: Achar a API.** Ler o cliente do gbrain no snapshot (`src/` do sidecar, buscar `GBRAIN_URL`) e anotar rotas de listar e ler.
- [ ] **Step 2: Exportar de dentro do VPS.** `curl` no `GBRAIN_URL` a partir do próprio host (ou `docker exec` no sidecar, só GET). Saída para stdout, gravada em `/Users/olavo/.claude/jobs/81a64a8c/tmp/gbrain-export.json` com forma `{ exportedAt, items: [{ slug, content, author, createdAt, updatedAt }] }`.
- [ ] **Step 3: Conferir.** Contagem de itens igual à listagem; todo `slug` casa com `^deal/`. Anotar contagem e sha256 no README do snapshot.
- [ ] **Step 4: Guardar e apagar a cópia local.** `op document create … --vault Personal --title newton-gbrain-export-2026-10-23`, depois apagar o JSON do tmp.

### Task 0.4: Alcance do MySQL da NewCore

**Files:**
- Modify: `README.md` do snapshot (seção "Alcance do MySQL")

- [ ] **Step 1: Ler host e porta** de `NEWCORE_DB_HOST`/`NEWCORE_DB_PORT` no container (só esses dois valores, nunca usuário ou senha) e verificar se é IP privado, `localhost` ou um nome público.
- [ ] **Step 2: Testar TCP de fora do VPS.** Do Mac: `nc -z -w 5 <host> <porta>`. O Mac não está em allowlist nenhuma, então serve de prova para "IP qualquer, como a Vercel".
- [ ] **Step 3: Registrar a conclusão** numa de três: (a) aberto, nc-data vai direto com `mysql2`; (b) só do VPS por allowlist, precisa de IP fixo ou túnel; (c) host privado, precisa de túnel. (b) e (c) bloqueiam só o pacote nc-data da Fase 2, não a migração.

### Task 0.5: Cancelar o passo 2 do plano N1

**Files:**
- Modify: `/Users/olavo/.claude/plans/newton-n1-vps-handoff.md` (topo da seção "O que falta")

- [ ] **Step 1:** Inserir a nota, texto exato:

```markdown
> **Cancelado em 23/10/2026.** Os passos 2–5 deste plano não serão executados no VPS. O Newton migra para o motor do max-agent (plano `wobbly-spinning-shell.md`); as 5 tools de atividades chegam pelo motor. O passo 1 (levantamento) foi feito e vale como insumo.
```

---

## Fase 1 — Perfil de deploy no motor

Um worktree e uma branch: `feat/deploy-profile` a partir de `origin/staging`, pedida ao `orchestrator` antes de editar. Quatro commits (Tasks 1.1–1.4) e **um** PR para `staging`. Decisão minha: o plano aprovado previa 3–4 PRs; um PR com quatro commits revisados um a um custa uma rodada de gate e uma prova só, e todo o conteúdo fica atrás do default.

Decisões minhas que estreitam o plano aprovado (YAGNI):
- `erro.ts` não muda na Fase 1. Adapter que não é Meta nunca lança `MetaHttpError`, então a classificação devolve `null` e o caminho genérico já vale.
- `templateSet` sai do perfil. A outbox só consulta template quando o adapter tem janela de 24h; `newton-bridge` não tem.
- `CAPABILITIES` não muda na Fase 1. A união `CORE + packs` entra com o primeiro pacote real (nc-data, Fase 2), junto com o contrato nos dois repos.
- `allowedOrgIds` sai do perfil. O porteiro da Fase 2 decide onde ele mora.

### Task 1.1: Módulo `deploy-profile` e agentKey no cliente da plataforma

**Files:**
- Create: `src/lib/deploy-profile.ts`
- Modify: `src/lib/cm.ts:97,125,169,587` (os quatro `"max"` literais)
- Test: `src/lib/__tests__/deploy-profile.test.ts`, caso novo em `src/lib/__tests__/` do teste existente de `cm.ts`
- Move: `docs/superpowers/evidence/2026-10-23-baseline-20d8a6f.md` (Task 0.1) e este plano para `docs/superpowers/plans/2026-10-23-deploy-profile.md`

**Interfaces:**
- Produces:
  - `export type AgentKey = "max" | "newton"`
  - `export type TransportName = "meta" | "newton-bridge" | "log"`
  - `export interface DeployProfile { agentKey: AgentKey; agentName: string; transport: TransportName; toolPacks: readonly string[] }`
  - `export const PERFIS: Readonly<Record<AgentKey, DeployProfile>>` com `max = { agentKey:"max", agentName:"Max", transport:"meta", toolPacks:[] }` e `newton = { agentKey:"newton", agentName:"Newton", transport:"newton-bridge", toolPacks:[] }`
  - `export function deployProfile(): DeployProfile` (lê a env a cada chamada; sem cache, para os testes trocarem a env)
  - `export function nomeDoAgente(): string` (atalho para `deployProfile().agentName`)

- [ ] **Step 1: Testes que falham.**

```ts
describe("deployProfile", () => {
  it("env ausente → max, idêntico a PERFIS.max", () => { delete process.env.AGENT_DEPLOY_PROFILE; expect(deployProfile()).toEqual(PERFIS.max); });
  it("vazio ou só espaço → max", () => { process.env.AGENT_DEPLOY_PROFILE = "  "; expect(deployProfile().agentKey).toBe("max"); });
  it("normaliza caixa e espaço", () => { process.env.AGENT_DEPLOY_PROFILE = " Newton "; expect(deployProfile().agentKey).toBe("newton"); });
  it("valor desconhecido lança, nunca cai em max", () => { process.env.AGENT_DEPLOY_PROFILE = "remax"; expect(() => deployProfile()).toThrow("deploy_profile_invalido"); });
  it("nomeDoAgente segue o perfil", () => { process.env.AGENT_DEPLOY_PROFILE = "newton"; expect(nomeDoAgente()).toBe("Newton"); });
});
```
No teste de `cm.ts`: com fetch mockado, `fetchProfile` chama URL com `agentKey=max` sem env e `agentKey=newton` com `AGENT_DEPLOY_PROFILE=newton`; o body de `searchKnowledge` leva o mesmo `agentKey`.

- [ ] **Step 2: Rodar e ver falhar.** `npx vitest run src/lib/__tests__/deploy-profile.test.ts` → FAIL, módulo não existe.
- [ ] **Step 3: Implementar** `deploy-profile.ts` com as assinaturas acima e trocar os quatro literais de `cm.ts` por `deployProfile().agentKey`.
- [ ] **Step 4: Rodar e ver passar**, mais o arquivo de teste existente do `cm.ts` inteiro.
- [ ] **Step 5: Commit** `feat(perfil): AGENT_DEPLOY_PROFILE com default max e agentKey do perfil no cliente da plataforma`.

### Task 1.2: Registro de adapters de transporte e capacidades na outbox

**Files:**
- Create: `src/lib/transport/adapters/meta.ts`, `src/lib/transport/adapters/log.ts`
- Modify: `src/lib/transport/types.ts:88`, `src/lib/transport/index.ts` (inteiro), `src/lib/outbox.ts:575`
- Test: `src/lib/__tests__/transport.test.ts` (casos novos), `src/lib/__tests__/outbox.integration.test.ts` (um caso novo, precisa do banco)

**Interfaces:**
- Consumes: `deployProfile()` da Task 1.1.
- Produces:
  - `export type ProviderName = "meta" | "newton-bridge" | "log"` (em `types.ts`)
  - `export interface TransportCapabilities { templates: boolean; window24h: boolean; media: boolean; groups: boolean; status: boolean }`
  - `export interface TransportAdapter { name: ProviderName; capabilities: TransportCapabilities; sendText(p: { to: string; body: string; quoteMessageId?: string }): Promise<SendResult>; sendTemplate?(p: { to: string; name: string; lang: string; bodyParams: string[]; botoes: BotaoEnviado[] }): Promise<SendResult>; connectionStatus(): Promise<ConnectionState>; downloadMedia(ref: string): Promise<{ data: Buffer; contentType: string | null } | null> }`
  - Em `index.ts`: `export function adapter(): TransportAdapter`, `export function capabilities(): TransportCapabilities`; `provider()` passa a devolver `adapter().name`; `sendText`, `sendTemplate`, `connectionStatus`, `downloadMedia` mantêm as assinaturas de hoje e delegam.
  - Capacidades: `meta = { templates:true, window24h:true, media:true, groups:false, status:true }`; `log = { templates:false, window24h:false, media:false, groups:false, status:false }`.
  - Erros: `transport_nao_implementado` (perfil pede `newton-bridge`), `transport_sem_template`, `transport_log_em_producao`.

Regras de `adapter()`:
- `AGENT_TRANSPORT` (trim, minúsculas) vazio ⇒ `deployProfile().transport`; `"log"` ⇒ adapter `log`, salvo `VERCEL_ENV === "production"`, que lança `transport_log_em_producao`; qualquer outro valor lança `transport_invalido`.
- O aviso de `WHATSAPP_PROVIDER` diferente de `"meta"` continua, uma vez por processo, só quando o adapter escolhido é `meta`.
- `MAX_OUTBOUND_KILL` e a trava do playground continuam em `sendText`/`sendTemplate` **antes** de chamar `adapter()`.

- [ ] **Step 1: Testes que falham** em `transport.test.ts` (o arquivo já mocka `../meta`):

```ts
it("default: adapter meta, provider 'meta', janela de 24h ligada", () => { expect(provider()).toBe("meta"); expect(capabilities().window24h).toBe(true); });
it("AGENT_TRANSPORT=log: sendText não chama a Meta e devolve id log-", async () => { process.env.AGENT_TRANSPORT = "log"; const r = await sendText({ to: "5511900000000", body: "x" }); expect(meta.sendText).not.toHaveBeenCalled(); expect(r.messageId).toMatch(/^log-/); });
it("log recusado em produção", () => { process.env.AGENT_TRANSPORT = "log"; process.env.VERCEL_ENV = "production"; expect(() => adapter()).toThrow("transport_log_em_producao"); });
it("kill switch vale antes do adapter log", async () => { process.env.AGENT_TRANSPORT = "log"; process.env.MAX_OUTBOUND_KILL = "true"; await expect(sendText({ to: "5511900000000", body: "x" })).rejects.toThrow("outbound_disabled"); });
it("sendTemplate em adapter sem template lança", async () => { process.env.AGENT_TRANSPORT = "log"; await expect(sendTemplate({ to: "5511900000000", name: "t", lang: "pt_BR", bodyParams: [], botoes: [] })).rejects.toThrow("transport_sem_template"); });
it("perfil newton sem adapter ainda lança", () => { process.env.AGENT_DEPLOY_PROFILE = "newton"; expect(() => adapter()).toThrow("transport_nao_implementado"); });
it("AGENT_TRANSPORT inválido lança", () => { process.env.AGENT_TRANSPORT = "zapi"; expect(() => adapter()).toThrow("transport_invalido"); });
```
Em `outbox.integration.test.ts`: com `AGENT_TRANSPORT=log` e janela de 24h fechada para o telefone, uma linha de `kind` com template no catálogo sai como `sent` por `sendText` e com `template_name` nulo. O mesmo cenário com o default continua indo por template (o caso que já existe cobre).

- [ ] **Step 2: Rodar e ver falhar.** `npx vitest run src/lib/__tests__/transport.test.ts` → FAIL.
- [ ] **Step 3: Implementar.** `adapters/meta.ts` reexpõe as funções de `../../meta` sem mudar lógica. `adapters/log.ts` grava `log.info("transport.log", { to, chars })` sem o corpo e devolve `{ messageId: "log-" + randomUUID() }`; `connectionStatus` devolve `{ connected: true, raw: { adapter: "log" } }`; `downloadMedia` devolve `null`. Em `outbox.ts:575` trocar `provider() === "meta"` por `capabilities().window24h`. Atualizar o comentário do bloco (linhas 560–573), que ainda fala da Z-API.
- [ ] **Step 4: Rodar e ver passar**: `transport.test.ts`, `outbox.integration.test.ts`, `transport-erro.test.ts`, e os testes de `src/app/api/__tests__/` que tocam `/api/admin/status`.
- [ ] **Step 5: Commit** `feat(transporte): adapter escolhido pelo perfil e janela de 24h pela capacidade do provedor`.

### Task 1.3: Nome do agente vem do perfil

**Files:**
- Modify: `src/graph/prompt.ts:203` (o `BASE` vira função), e os literais com "Max" voltados à pessoa em `graph.ts`, `captacao.ts`, `tools.ts`, `gestao.ts`, `fluxos.ts`, `credito.ts`, `atividades.ts`, `continuidade.ts`, `capacidades.ts`, `aceite.ts`, `llm.ts:282`
- Test: `src/graph/__tests__/prompt-perfil.test.ts` (novo), `src/lib/__tests__/sem-nome-fixo.test.ts` (novo)

**Interfaces:**
- Consumes: `nomeDoAgente()` da Task 1.1.
- Produces: nenhuma função pública nova. `buildSystemPrompt` mantém a assinatura.

Inventário em 20d8a6f: 39 literais com `\bMax\b` fora de comentário em 15 arquivos (lista em `/Users/olavo/.claude/jobs/81a64a8c/tmp/max-literals.txt`). Ficam como estão, na lista de permitidos do teste, com o motivo ao lado:
- `templates/catalog.ts:303,569`: texto de template aprovado na Meta; o Newton não usa template.
- `llm.ts:323`: cabeçalho `X-Title` para o OpenRouter, não é voltado à pessoa.
- `custos/meta-analytics.ts:145,183`: mensagens de erro e log do número Meta.
- `runtime/catalog.ts:25,59`: descrições internas do catálogo.
- `graph.ts:1374` (`"Proposta (criada pelo Max)"`): **troca** para o nome do perfil, porque vira título visível na plataforma.

Os demais literais trocam `Max` por `${nomeDoAgente()}`. Um literal em constante de módulo (ex.: `TEXTO_CAPTACAO_SEM_POLITICA`) vira função sem argumento com o mesmo nome em minúscula inicial (`textoCaptacaoSemPolitica()`), e os chamadores e testes são atualizados.

- [ ] **Step 1: Teste de caracterização, no código ainda sem mudança.** Em `prompt-perfil.test.ts`, chamar `buildSystemPrompt` com três entradas fixas (corretor sem tools, gerente com tools de leitura, pessoa desconhecida) e `expect(...).toMatchSnapshot()`. Rodar uma vez para gravar o snapshot. Commitar o snapshot junto com a Task 1.3, gravado **antes** da refatoração.
- [ ] **Step 2: Testes que falham.**

```ts
it("perfil newton: prompt sem 'Max' e com 'Newton'", () => { process.env.AGENT_DEPLOY_PROFILE = "newton"; const p = buildSystemPrompt(ENTRADA_GERENTE); expect(p).not.toMatch(/\bMax\b/); expect(p).toContain("Você é o Newton"); });
```
`sem-nome-fixo.test.ts`: lê todo `src/**/*.ts` fora de `__tests__`, acha literais de string com `\bMax\b` fora de comentário (mesma regra do inventário) e falha para qualquer `arquivo:linha` fora da lista de permitidos acima. A lista mora no próprio teste, uma entrada por linha com o motivo.
- [ ] **Step 3: Rodar e ver falhar.** O primeiro falha no texto; o segundo lista os literais.
- [ ] **Step 4: Implementar.** `BASE` vira `function base(nome: string): string` com o mesmo texto e `${nome}` no lugar de "Max"; `buildSystemPrompt` chama `base(nomeDoAgente())`. Trocar os literais.
- [ ] **Step 5: Rodar e ver passar**: os dois novos, o snapshot sem diff com o perfil default, e todo `src/graph/__tests__/` (os testes que comparam texto com "Max" continuam valendo no default).
- [ ] **Step 6: Commit** `refactor(perfil): nome do agente vem do perfil; prompt do Max idêntico (snapshot)`.

### Task 1.4: Pacotes de tools do perfil

**Files:**
- Create: `src/packs/index.ts`
- Modify: `src/graph/tools.ts:798-812` (`REGISTRO_DE_TOOLS`, `buscarNoRegistro`, `NOMES_DE_TOOL`), `src/graph/tools.ts:906-923` (`ferramentasDoTurno`)
- Test: `src/graph/__tests__/tool-packs.test.ts` (novo)

**Interfaces:**
- Consumes: `deployProfile().toolPacks` da Task 1.1; `EntradaDeTool`, `EntradaDeEscrita`, `ToolDef` de `tools.ts`.
- Produces:
  - `export interface ToolPack { id: string; leitura: readonly ToolDef[]; escrita: readonly EntradaDeEscrita[] }`
  - `export function packsDoPerfil(registro?: Readonly<Record<string, ToolPack>>): ToolPack[]` (resolve os ids de `toolPacks`; id sem pacote registrado lança `tool_pack_desconhecido`)
  - `export const PACKS: Readonly<Record<string, ToolPack>> = {}` (vazio na Fase 1)
  - `ferramentasDoTurno` ganha o parâmetro opcional `packs?: readonly ToolPack[]` (padrão `packsDoPerfil()`); a escrita filtra `REGISTRO_DE_TOOLS` mais as escritas dos pacotes, e a leitura chama `selecionarTools` com `catalogo: [...TOOLS_DE_LEITURA, ...leituras dos pacotes]`.
  - `buscarNoRegistro` e `NOMES_DE_TOOL` passam a incluir as entradas dos pacotes do perfil, para o despachante executar a tool e o sanitizador de `compose.ts` bloqueá-la.

- [ ] **Step 1: Testes que falham.**

```ts
it("sem pacotes: idêntico ao registro de hoje", () => { const a = ferramentasDoTurno(BASE_TURNO); const b = ferramentasDoTurno({ ...BASE_TURNO, packs: [] }); expect(a).toEqual(b); expect(NOMES_DE_TOOL).toEqual(REGISTRO_DE_TOOLS.map((e) => e.nome)); });
it("pacote com leitura entra no turno quando a política permite", () => { const r = ferramentasDoTurno({ ...BASE_TURNO, packs: [PACOTE_FALSO] }); expect(r.entradas.map((e) => e.nome)).toContain("pacote_falso_ler"); });
it("pacote não fura a política", () => { const r = ferramentasDoTurno({ ...BASE_TURNO, policy: [], packs: [PACOTE_FALSO] }); expect(r.entradas.map((e) => e.nome)).not.toContain("pacote_falso_ler"); });
it("perfil sem pacotes: lista vazia", () => { expect(packsDoPerfil()).toEqual([]); });
it("id de pacote desconhecido lança", () => { vi.spyOn(perfil, "deployProfile").mockReturnValue({ ...PERFIS.max, toolPacks: ["inexistente"] }); expect(() => packsDoPerfil({})).toThrow("tool_pack_desconhecido"); });
```
`PACOTE_FALSO` tem uma tool de leitura cuja capability é uma das 27 atuais (ex.: `deal.list`) e cujo gatilho de texto casa com `BASE_TURNO.texto`. `perfil` é `import * as perfil from "@/lib/deploy-profile"`.

- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar** `src/packs/index.ts` e as mudanças em `tools.ts`. O limite de 5 tools por turno de `selecionarTools` continua valendo sobre o catálogo somado.
- [ ] **Step 4: Rodar e ver passar**, mais `policy-parity.test.ts`, `atividades-parity.test.ts` e `catalog-permissions.test.ts` sem mudança.
- [ ] **Step 5: Commit** `feat(perfil): pacotes de tools por perfil (vazios no Max)`.

### Task 1.5: Prova da fase e PR para staging

**Files:**
- Create: `docs/superpowers/evidence/2026-10-23-fase1-deploy-profile.md`
- Create: `docs/deploy-profiles.md` (perfis, envs `AGENT_DEPLOY_PROFILE`/`AGENT_TRANSPORT`, regras de recusa, como adicionar perfil ou pacote)

- [ ] **Step 1: Suíte e replay** com o mesmo comando da Task 0.1, saída em `fase1-suite.json` e `fase1-replay.json`.
Expected: zero falhas; passaram = 2610 + testes novos; replay 3/3; snapshot do prompt sem diff.
- [ ] **Step 2: typecheck, lint e build** verdes.
- [ ] **Step 3: Escrever a evidência e o doc** com a comparação baseline × fase 1 em tabela.
- [ ] **Step 4: Gate.** Agente `orchestrator` (modelo sonnet) com o diff da branch; ele decide se pede code review. Seguir o veredito.
- [ ] **Step 5: PR para `staging`** com o resumo, a tabela da evidência e a frase "sem env nova em nenhum ambiente: comportamento do Max idêntico". Sem auto-merge. O merge e a promoção a prod seguem a ordem do spec (24 h de observação depois de prod).

---

## Execução

Depois do PR da Fase 1 aberto, os próximos planos (Fase 2 no max-agent e Fase 3 no contractmaker) são escritos sobre o código já mesclado. A Trilha B (homologação do Max no playground, frentes 1 e 2) pode correr em paralelo desde que não toque `prompt.ts`, `tools.ts`, `transport/`, `outbox.ts` ou `templates/`.
