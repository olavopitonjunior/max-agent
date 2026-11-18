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
  - `newton-bridge` (`adapters/newton-bridge.ts`): `POST {NEWTON_BRIDGE_URL}/api/send` com `Bearer NEWTON_BRIDGE_TOKEN` (o `BRIDGE_INTERNAL_TOKEN` do bridge). Só texto, até 4096 caracteres, destino DM ou `<id>-group`. Sem template, janela, envio de mídia ou status. Nunca cita id sintético (`newton:`). `downloadMedia` baixa a mídia que o bridge repassou por URL (ver "Mídia do Newton").
- `src/app/api/agents/newton/run/route.ts`: entrada do bridge (`forwardToNewton`), com o mesmo corpo que ia ao sidecar.
  - O bridge chama `/agents/newton/run` na raiz; o rewrite em `next.config.js` leva a `/api/agents/newton/run`.
  - Só responde no perfil `newton`; no Max devolve 404. Exige `Bearer NEWTON_INBOUND_TOKEN` (exclusivo; o `NEWTON_GATEWAY_TOKEN` do sidecar não abre) e, sem ele configurado, devolve 503.
  - Enfileira com o `messageId` da Z-API quando o corpo trouxer; senão, id sintético de (telefone, grupo, texto bruto, anexos, minuto). Roda o turn em `waitUntil` e responde `{text:"", blocked:false}`. O bridge não envia texto vazio; a resposta sai pelo adapter. Falha na fila é logada (`newton.fila_falhou`) e responde 200, porque o bridge não reenvia.
  - O `orgId` do corpo é ignorado, porque a org sai da identidade do telefone. Grupos são ignorados até o PR 2.2.
  - Sem a flag `NEWTON_MEDIA_INBOUND`, ou com o trio de mídia recusado, o marcador do bridge sozinho (`[imagem enviada]`, `[documento: …]`, áudio sem transcrição) não é texto e vira `unknown`; áudio transcrito entra só com a transcrição. Com a flag e o trio válido, a mensagem vira `image`/`document` (ver "Mídia do Newton"). Antes disso saem o aviso do `annotate` (`[suspicious instruction-like content detected · …]`) e a marca de citação (`[respondendo a msg id=…]`), para que "SIM" continue "SIM" nas interceptações determinísticas.
- `src/app/api/notify/route.ts` e `src/lib/outbox.ts`: no perfil `newton`, aviso com `audience: "deal_party"` é recusado (403 `audience_not_allowed` no `/notify`; `enqueue` lança `audience_nao_permitida_no_perfil`). O Newton só fala com usuário interno, e sem template nem janela o aviso sairia como texto livre.
- `src/graph/graph.ts`: no perfil `newton`, número desconhecido fica em silêncio (sem apresentação e sem repasse à equipe), porque o Newton só fala com usuário interno. O convidado sem primeiro acesso continua recebendo o aviso. O `interceptar` do aceite roda antes da identidade, mas só responde a pendência criada por template, que o Newton não tem.
- Limites conhecidos do PR 2.1, para o PR 4.2 do bridge:
  - o bridge precisa mandar `messageId` (o id sintético deixa passar reentrega que cruza o minuto e junta a mesma frase repetida no minuto);
  - o papel do contato (`contacts-gate`) não chega ao motor; o porteiro (PR 2.3) depende disso;
  - ~~o bridge manda os anexos em base64 no corpo, e a Vercel recusa corpo acima de 4,5 MB (413)~~: resolvido para o v2. A ponte manda só `attachments: [{type,mime,filename}]` (metadados) e, com `NEWTON_V2_MEDIA`, a URL da Z-API em `mediaUrl`; nunca bytes;
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

## Admin e playground por agente

Cada deploy tem o próprio `/api/admin/*`, com o próprio `MAX_NOTIFY_SECRET`; a plataforma escolhe o deploy pelo agente (Max ou Newton) e mostra painéis separados.

- `GET /api/admin/status` e `GET /api/admin/catalog` devolvem `agentKey` e `agentName` do perfil. O catálogo do Newton anuncia o agente `newton`, o prompt `newton.system` e o canal `whatsapp.newton-bridge`.
- `POST /api/admin/playground` devolve `agentKey`, e os eventos `run.*` levam o agente do deploy. O playground não envia nada pelo canal (sem `afterReply`).
- O deploy de staging do Newton (`newton-agent`, branch `staging`) roda com `AGENT_DEPLOY_PROFILE=newton`, `MAX_PLAYGROUND=true`, `MAX_OUTBOUND_KILL=true` e sem `NEWTON_BRIDGE_*`: o playground funciona e nenhuma mensagem sai.

## Envs

Só `AGENT_DEPLOY_PROFILE` é nova, mais `AGENT_TRANSPORT` para homologação. Os nomes `MAX_*` (kill switches, flags de rollout) são do motor e valem nos dois perfis.

Só no deploy do Newton, todas vindas do 1Password via `op inject`:
- `NEWTON_BRIDGE_URL`
- `NEWTON_BRIDGE_TOKEN`
- `NEWTON_MEDIA_INBOUND` e `NEWTON_MEDIA_HOSTS`: mídia por URL, desligadas e vazias por padrão (ver "Mídia do Newton"). Não são segredo e ficam fora do `.env.local.tmpl`.
- `NEWTON_INBOUND_TOKEN`: o token que o bridge manda na entrada. Novo, diferente do `NEWTON_GATEWAY_TOKEN` do sidecar. No corte (PR 4.2), o upstream v2 do bridge tem de apontar para o deploy Newton com este valor; com o token do sidecar, toda entrada volta 401.

## Mídia do Newton

A foto e o PDF que o corretor manda pelo Z-API chegam ao motor como `InboundMessage` de mídia (`kind` `image`/`document`, `mediaUrl`, `mimeType`) e são baixáveis por `downloadMedia`. É só o transporte: leitura (OCR) e fluxo de conversa são de outro plano, e hoje o grafo responde a frase fixa "não leio anexo" para mídia sem texto.

**Por que URL e não bytes.** O corpo da Vercel é de 4,5 MB, e `inbound_queue` guarda só `media_url` e `mime_type` (texto), sem documento de cliente no banco. A Z-API mantém o arquivo por 30 dias, muito além de qualquer retentativa da fila (`MAX_ATTEMPTS = 3`), que baixa de novo.

**Campos novos** no nível raiz do corpo de `POST /agents/newton/run`, só quando a ponte manda mídia por URL. O restante do corpo e o array `attachments` (só metadados, usado para contar) não mudam.

| Campo | Tipo | Regra |
|---|---|---|
| `mediaUrl` | `string` | `https://` do storage da Z-API, até 2048 caracteres, sem usuário, senha ou porta, host IGUAL a um item de `NEWTON_MEDIA_HOSTS` (subdomínio só com `*.dominio` explícito); IP literal e `localhost` são recusados |
| `mediaKind` | `"image" \| "document"` | `image` aceita `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif`; `document` aceita `application/pdf` |
| `mimeType` | `string` | o da Z-API, em minúsculas e sem parâmetros (`;...`) |

Tamanho: 3 MB (`MAX_MEDIA_BYTES`), conferido no `Content-Length` e nos bytes lidos. Na fila: `kind = mediaKind`, `media_url = "zapi:" + mediaUrl`, `mime_type = mimeType`, `text` = a legenda, ou `null` (o marcador `[imagem enviada]` não vira texto). Grupo nunca carrega mídia (segue ignorado). Sem `messageId` da ponte, a URL entra no hash do id sintético: duas fotos sem legenda no mesmo minuto não colidem.

**Download** (`newtonBridgeAdapter.downloadMedia`): recusa ref sem `zapi:`; `https` e host da allowlist; `redirect: "manual"` (3xx devolve `null`); sem credencial no pedido; teto de 3 MB; o tipo é o dos **bytes** (`sniffMime`: JPEG, PNG, WebP, PDF, HEIC/HEIF), não o cabeçalho (`application/octet-stream` com JPEG válido passa; HTML com `application/pdf` não). Todo tropeço (404, 410, tamanho, tipo, host, rede) devolve `null`, e o log traz só o `host` e o motivo. **A URL é link não adivinhável para documento de cliente: nunca vai para log, erro ou `last_error`.**

**Flags**, ambas desligadas por padrão e lidas a cada chamada:
- `NEWTON_MEDIA_INBOUND`: `true` (texto exato) liga a rota a aceitar `mediaUrl`. Ausente ou outro valor: o corpo de mídia é ignorado e o comportamento é idêntico ao de antes.
- `NEWTON_MEDIA_HOSTS`: hosts permitidos, separados por vírgula. Vale o host exato; subdomínio só com entrada `*.dominio` (que não cobre o apex). Listar só hosts do storage da Z-API, nunca um domínio de nuvem compartilhado (`s3.amazonaws.com` ou `*.amazonaws.com` abririam qualquer bucket de terceiro). Vazia recusa tudo, mesmo com a flag ligada.
- `NEWTON_V2_MEDIA` é a flag espelho **na ponte** (`whatsapp-newton-bridge`); só vale para telefones em `NEWTON_V2_PHONES`.

Fixture do corpo, idêntico nos dois repos (faz o papel do teste de paridade, já que entre a ponte e a rota não há HMAC, só `Bearer NEWTON_INBOUND_TOKEN`): `src/app/api/__tests__/__fixtures__/newton-run-midia.json` aqui, `__fixtures__/newton-run-midia.json` na ponte.

**Ordem de ligação** (receptor primeiro, inerte):
1. `max-agent` em `staging` e deploy do `newton-agent` de staging com as duas envs **vazias**. Verificar: `curl` com o fixture devolve 200 `{text:"",blocked:false}` e a linha da fila tem `kind='unknown'` (inerte).
2. Ponte em `master`, com `NEWTON_V2_MEDIA` ausente. Verificar nos logs da Vercel: mandar uma foto do 3228 e ler a linha `[zapi] mídia host=...` para saber o host real da Z-API.
3. Preencher `NEWTON_MEDIA_HOSTS` com esse host (staging do `newton-agent`) e ligar `NEWTON_MEDIA_INBOUND=true` ali. Só então `NEWTON_V2_MEDIA=true` na ponte (hoje só o 3228 está em `NEWTON_V2_PHONES`).
4. Verificar com o valor observado, não o pretendido: foto e PDF do 3228 geram linha na fila com `kind='image'`/`'document'` e `media_url` começando em `zapi:`, e `downloadMedia` devolve bytes (linha de log com host e tamanho, sem URL).
5. **Produção do `newton-agent` (`master`) não faz parte deste plano.** Fica para depois do plano de OCR e do fluxo, porque o grafo responde a frase fixa de "não leio anexo" (G5) para mídia sem texto.

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
