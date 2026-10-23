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
  - `newton-bridge` (`adapters/newton-bridge.ts`): `POST {NEWTON_BRIDGE_URL}/api/send` com `Bearer NEWTON_BRIDGE_TOKEN` (o `BRIDGE_INTERNAL_TOKEN` do bridge). Só texto, até 4096 caracteres, destino DM ou `<id>-group`. Sem template, janela, mídia ou status. Nunca cita id sintético (`newton:`).
- `src/app/api/agents/newton/run/route.ts`: entrada do bridge (`forwardToNewton`), com o mesmo corpo que ia ao sidecar.
  - O bridge chama `/agents/newton/run` na raiz; o rewrite em `next.config.js` leva a `/api/agents/newton/run`.
  - Só responde no perfil `newton`; no Max devolve 404. Exige `Bearer NEWTON_INBOUND_TOKEN` (exclusivo; o `NEWTON_GATEWAY_TOKEN` do sidecar não abre) e, sem ele configurado, devolve 503.
  - Enfileira com o `messageId` da Z-API quando o corpo trouxer; senão, id sintético de (telefone, grupo, texto bruto, anexos, minuto). Roda o turn em `waitUntil` e responde `{text:"", blocked:false}`. O bridge não envia texto vazio; a resposta sai pelo adapter. Falha na fila é logada (`newton.fila_falhou`) e responde 200, porque o bridge não reenvia.
  - O `orgId` do corpo é ignorado, porque a org sai da identidade do telefone. Grupos são ignorados até o PR 2.2.
  - Marcador do bridge sozinho (`[imagem enviada]`, `[documento: …]`, áudio sem transcrição) não é texto e vira `unknown`; áudio transcrito entra só com a transcrição. Antes disso saem o aviso do `annotate` (`[suspicious instruction-like content detected · …]`) e a marca de citação (`[respondendo a msg id=…]`), para que "SIM" continue "SIM" nas interceptações determinísticas.
- `src/app/api/notify/route.ts` e `src/lib/outbox.ts`: no perfil `newton`, aviso com `audience: "deal_party"` é recusado (403 `audience_not_allowed` no `/notify`; `enqueue` lança `audience_nao_permitida_no_perfil`). O Newton só fala com usuário interno, e sem template nem janela o aviso sairia como texto livre.
- `src/graph/graph.ts`: no perfil `newton`, número desconhecido fica em silêncio (sem apresentação e sem repasse à equipe), porque o Newton só fala com usuário interno. O convidado sem primeiro acesso continua recebendo o aviso. O `interceptar` do aceite roda antes da identidade, mas só responde a pendência criada por template, que o Newton não tem.
- Limites conhecidos do PR 2.1, para o PR 4.2 do bridge:
  - o bridge precisa mandar `messageId` (o id sintético deixa passar reentrega que cruza o minuto e junta a mesma frase repetida no minuto);
  - o papel do contato (`contacts-gate`) não chega ao motor; o porteiro (PR 2.3) depende disso;
  - o bridge manda os anexos em base64 no corpo, e a Vercel recusa corpo acima de 4,5 MB (413): o bridge deve cortar o base64 para o v2, que não usa mídia;
  - `connectionStatus` do adapter falha aberto (sempre conectado), então a guarda de "transporte fora" não vale no Newton até o bridge expor status;
  - `/api/meta-webhook` continua no deploy do Newton, sem credencial Meta; a remoção fica para a allowlist por perfil.

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

Só no deploy do Newton, todas vindas do 1Password via `op inject`:
- `NEWTON_BRIDGE_URL`
- `NEWTON_BRIDGE_TOKEN`
- `NEWTON_INBOUND_TOKEN`: o token que o bridge manda na entrada. Novo, diferente do `NEWTON_GATEWAY_TOKEN` do sidecar. No corte (PR 4.2), o upstream v2 do bridge tem de apontar para o deploy Newton com este valor; com o token do sidecar, toda entrada volta 401.

## Ainda não feito (fases seguintes)

- Fase 2 (feito no PR 2.1: adapter `newton-bridge` e rota de entrada): grupos, porteiro, packs nc-data e memória. A capability de pack ganha tipo próprio quando o primeiro pack chegar.
- Pendências do review da Fase 1 que precisam estar resolvidas antes do Newton subir:
  - allowlist de orgs por perfil, além do banco;
  - `cm.ts` posta em `/api/webhooks/max` com cabeçalhos `x-max-*`;
  - `admin/handoff` consulta `janelaAberta` sem olhar a capacidade;
  - o atalho de capacidades em `capacidades.ts` reconhece "o max", mas não "o newton";
  - as descrições de tool resolvem o nome no import;
  - o scanner `sem-nome-fixo` pula linhas iniciadas por `*`.
- Fase 3: na plataforma (contractmaker), `agentKey` genérico, endpoint por agente e corte por telefone.
