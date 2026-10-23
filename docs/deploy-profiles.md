# Perfis de deploy

O mesmo repo sobe como dois agentes, cada um num projeto Vercel próprio, com Postgres e envs próprios. Nada mistura os dois em runtime.

| Perfil | `AGENT_DEPLOY_PROFILE` | Atende | Transporte | Nome nos textos |
|---|---|---|---|---|
| `max` | ausente, vazio ou `max` | orgs RE/MAX | API oficial da Meta | Max |
| `newton` | `newton` | só Newcore | bridge do Newton (`newton-bridge`, Fase 2) | Newton |

O Max nunca atende a Newcore e o Newton nunca atende RE/MAX. A garantia vem de três camadas: a allowlist de orgs no banco de cada deploy, o perfil e, na plataforma, o endpoint por agente (Fase 3).

## Onde o perfil entra

- `src/lib/deploy-profile.ts`: `deployProfile()` e `nomeDoAgente()`. Um valor desconhecido lança `deploy_profile_invalido`, porque cair em `max` sem aviso poria o Max num tenant que não é dele.
- `src/lib/cm.ts`: o `agentKey` enviado ao ImobPro (perfil, uso, conhecimento, transcrição) vem do perfil.
- `src/lib/transport/`: `adapter()` escolhe pelo perfil.
  - `meta`: o código de antes.
  - `log`: sem rede, todas as capacidades desligadas.
  - `newton-bridge`: lança `transport_nao_implementado` até a Fase 2.

  `AGENT_TRANSPORT=log` força o adapter `log` fora de produção. Com `VERCEL_ENV=production`, lança `transport_log_em_producao`.
- `src/lib/outbox.ts`: a regra da janela de 24h só vale quando o adapter tem `capabilities.window24h`. Sem ela, como no `log` e no bridge, sai texto livre.
- `src/graph/prompt.ts` e os textos fixos: o nome vem de `nomeDoAgente()`.
  - O snapshot `src/graph/__tests__/__snapshots__/prompt-perfil.test.ts.snap` foi gravado antes do refactor e prova que o prompt do Max não mudou.
  - `src/lib/__tests__/sem-nome-fixo.test.ts` barra literal "Max" novo fora da allowlist.
- `src/packs/`: tools exclusivas do perfil.
  - O perfil lista ids em `toolPacks`, e um id desconhecido lança `tool_pack_desconhecido`.
  - As entradas somam ao registro (`entradasDoDeploy`, `buscarNoRegistro`, `ferramentasDoTurno`).
  - As capabilities somam ao catálogo do deploy (`capabilitiesDoDeploy`).
  - `CAPABILITIES` continua sendo o núcleo espelhado no ImobPro pelo teste de paridade.

## Envs

Só `AGENT_DEPLOY_PROFILE` é nova, mais `AGENT_TRANSPORT` para homologação. Os nomes `MAX_*` (kill switches, flags de rollout) são do motor e valem nos dois perfis.

## Ainda não feito (fases seguintes)

- Fase 2: adapter `newton-bridge` (envio e rota de entrada), grupos, porteiro, packs nc-data e memória. A capability de pack ganha tipo próprio quando o primeiro pack chegar.
- Pendências do review da Fase 1 que precisam estar resolvidas antes do Newton subir:
  - allowlist de orgs por perfil, além do banco;
  - `cm.ts` posta em `/api/webhooks/max` com cabeçalhos `x-max-*`;
  - `admin/handoff` consulta `janelaAberta` sem olhar a capacidade;
  - o atalho de capacidades em `capacidades.ts` reconhece "o max", mas não "o newton";
  - as descrições de tool resolvem o nome no import;
  - o scanner `sem-nome-fixo` pula linhas iniciadas por `*`.
- Fase 3: na plataforma (contractmaker), `agentKey` genérico, endpoint por agente e corte por telefone.
