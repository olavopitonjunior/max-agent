# Fase 1 — perfil de deploy (23/10/2026)

Branch `feat/deploy-profile` sobre `origin/staging` = `20d8a6f`. Mesmo ambiente do baseline (`2026-10-23-baseline-20d8a6f.md`): Node v22.18.0, Postgres 17 local, `.env.test`.

| Commit | Conteúdo |
|---|---|
| 664abc7 | `AGENT_DEPLOY_PROFILE`; `agentKey` do perfil no cliente do ImobPro |
| ae2484e | adapter de transporte pelo perfil; janela de 24h por capacidade; adapter `log` |
| 74f6c42 | nome do agente vem do perfil; snapshot do prompt do Max |
| 0814d01 | tool packs por perfil (registro vazio) |
| (commit 5) | correções do code review e documentação |

| Gate | Baseline 20d8a6f | Fase 1 |
|---|---|---|
| Suíte completa | 2610/2610 | 2644/2644: os 2610 de antes mais 34 testes novos (perfil, transporte, prompt, nome fixo, packs, correções do review) |
| Replay (`vitest.runtime-eval.config.ts`) | 3/3 | 3/3 |
| `tsc --noEmit` | OK | OK |
| `eslint src` | OK | OK |
| `npm run build` | OK | OK |

## Prova de "Max idêntico"

- **Prompt.** Snapshot de 3 cenários (corretor sem tools, gerente com leituras e contexto, desconhecido), gravado com o `prompt.ts` original antes do refactor. Passa sem regravação depois do refactor.
- **Transporte.** Sem `AGENT_DEPLOY_PROFILE`, `adapter()` devolve o `metaAdapter`, que chama `meta.*` como antes. A outbox só troca `provider() === "meta"` por `capabilities().window24h`, que é `true` no Meta.
- **Tools e capabilities.** Sem packs, `entradasDoDeploy()` é igual a `REGISTRO_DE_TOOLS` e `capabilitiesDoDeploy()` é igual a `CAPABILITIES`, com teste. O teste de paridade com o ImobPro segue verde.
- **Nenhum teste preexistente mudou de expectativa.** Os ajustes em testes antigos foram dois: mocks de `@/lib/transport` ganharam `capabilities`, e três testes passaram a chamar como função as quatro constantes de texto que viraram função.

## Code review (Opus, 23/10)

Nada bloqueante. O review confirmou que o caminho padrão é idêntico a 20d8a6f. Corrigido no commit 5:

- **`dispatchDue` lê `capabilities()` uma vez, antes do claim.** Transporte mal configurado lançava só depois que as linhas viravam `sending`, queimando tentativas. Teste: `AGENT_TRANSPORT inválido não reivindica nada`.
- **A trava do `log` agora é fail-closed.** Antes ela só recusava `VERCEL_ENV=production`, e uma execução fora da Vercel com env de produção passava. Agora vale só em `preview`/`development` ou, sem `VERCEL_ENV`, com `NODE_ENV` diferente de `production`.
- **Comentário do adapter `log` corrigido.** O playground nunca chega a ele.
- **Pack com nome de tool repetido lança `tool_nome_duplicado`.** Antes o `find` escolhia uma das duas em silêncio.

Recusado: aceitar `AGENT_TRANSPORT=meta`. Isso permitiria forçar um deploy Newton para o número da Meta.

Fica para as fases seguintes, com registro em `docs/deploy-profiles.md`:

- allowlist de orgs por perfil;
- webhook `/api/webhooks/max` e cabeçalhos `x-max-*` no `cm.ts`;
- `janelaAberta` fixo em `admin/handoff`;
- regex de capacidades com "o max" em `capacidades.ts`;
- descrições de tool com o nome resolvido no import;
- scanner de nome que pula linha iniciada por `*`.
