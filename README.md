# Max Agent

Agente de WhatsApp dos tenants **RE/MAX** do ImobPro. LangGraph + Z-API, na Vercel.

O Newton (OpenClaw, `agentpro.ia.br`) atende os demais tenants e continua como
está. Documentação do lado da plataforma: [`docs/max.md`](../contractmaker/docs/max.md)
no repositório do Contractmaker.

## O que ele faz

As quatro fases estão **em produção** (a 4 fechou em 2026-08-21):

1. **Canal de notificações** — recebe do ImobPro os avisos já configurados no
   sistema (`POST /notify`) e entrega no WhatsApp, respeitando a janela
   7h–22h. É o objetivo nº 1.
2. **Responde dúvidas de processo** com o RAG do tenant (a busca e o escopo
   vivem no ImobPro; aqui só entra o material, cercado contra injeção).
3. **Cria formulários e propostas por conversa**, com confirmação humana:
   formulário de venda, de locação, e proposta — de compra e venda ou de
   locação (residencial/comercial). O modelo só PROPÕE; quem executa é o `sim`
   da pessoa, no turno seguinte, por caminho determinístico.
4. **Memória cross-sessão e reconciliação de entrega** — fatos por pessoa com
   TTL, notificação enviada semeada no thread (para "o que é isso?" ter
   contexto), e o desfecho de cada notificação (entregue / lida / sem
   confirmação) reconciliado a partir dos callbacks de status da Z-API e
   reportado de volta ao ImobPro.

Também entende **áudio e imagem** (transcritos no ImobPro, com o token da org)
e responde por template quando não consegue — silêncio nunca.

## Por que Vercel, e não VPS

A decisão mudou quando o transporte virou Z-API. O Baileys (que o Max antigo
usava) exige **websocket persistente** — daí precisar de um processo sempre
vivo. Z-API é **webhook**: cada mensagem é um POST independente, que é
exatamente o formato serverless. Somado a isso, a bridge do Newton já roda na
Vercel e a conta já é Pro.

O que precisa de continuidade — histórico de conversa, fila de saída — vive no
Postgres, não na memória do processo.

## Arquitetura

```
                                                      ┌─ semeia o thread
ImobPro ──POST /notify (HMAC)──► outbox ──cron 1/min──┴─► Z-API ──► WhatsApp
                                    │                                  │
                          adia fora de 7h–22h SP                       │
                                    ▲                                  ▼
       POST /api/webhooks/max ◄── reconcile ◄── /api/zapi-status ◄── callback
       (desfecho, pela dedupeKey)   (cron)      (SENT/RECEIVED/READ)

WhatsApp ──webhook──► inbound_queue ──► grafo LangGraph ──► resposta
                      (dedupe messageId)   (checkpointer Postgres)
                             ▲                     │
                      cron 1/min (rede de segurança)
```

**Duas filas, não uma.** A de saída (`outbox`) existe porque o ImobPro entrega
a qualquer hora; a de entrada (`inbound_queue`) existe porque o turn ficou mais
lento que o timeout do webhook quando o grafo passou a chamar modelo — sem ela,
a Z-API reentregava, o dedupe já tinha consumido o `messageId`, e a pessoa
ficava sem resposta e sem rastro. Em ambas o claim MUDA O ESTADO (não é só
`SKIP LOCKED`), e um marcador de "envio iniciado" impede que uma execução
morta entre o envio e a liquidação vire mensagem repetida.

**`sent` não é entregue.** Instância desemparelhada aceita `send-text` com HTTP
200 e um `messageId` que não chega a ninguém — foi assim que quatro mensagens
reais se perderam em 2026-08-04. Por isso a Fase 4: os callbacks de status
alimentam `delivery_status` (upgrade monotônico, `read` nunca regride), o que
fica sem notícia por 15 min vira `unconfirmed`, e o desfecho volta ao ImobPro.

**Notificação proativa não passa por LLM.** O texto já vem pronto do motor de
notificações do ImobPro; pôr um modelo para retransmiti-lo custa token e abre
espaço para ele reescrever o fato ou errar o destinatário — falha já medida em
produção com o Newton.

**A janela 7h–22h é responsabilidade daqui.** Os call-sites do ImobPro pararam
de segurar a mensagem fora da janela quando o agente é o Max, justamente porque
esta fila existe. Perder uma linha do `outbox` = perder a notificação: o motor
de `deal-events` de lá não tem cron de reconciliação.

## Rotas

| Rota | Auth | Para quê |
|---|---|---|
| `POST /api/notify` | HMAC (`MAX_NOTIFY_SECRET`) | ImobPro enfileira uma notificação. 202 = assumi; 409 = duplicata |
| `GET /api/cron/outbox` | `Bearer $CRON_SECRET` | Despacha o que venceu. Cron da Vercel, 1×/min |
| `GET /api/cron/inbound` | `Bearer $CRON_SECRET` | Rede de segurança do turn: retoma o que o `waitUntil` não fechou. 1×/min |
| `POST /api/zapi-webhook/[secret]` | segredo no path + `instanceId` | Inbound do WhatsApp — só aceita e enfileira |
| `POST /api/zapi-status/[secret]` | idem | Callbacks de status (SENT/RECEIVED/READ) → reconciliação |
| `POST\|DELETE /api/orgs` | HMAC (mesmo do `/notify`) | Provisiona/desativa tenant (token cifrado em `org_config`) |
| `POST /api/admin/forget` | HMAC (mesmo do `/notify`) | Direito ao esquecimento: apaga tudo sobre um telefone |
| `GET /api/admin/status` | HMAC (`method.path?query` assinados) | Alimenta o Mission Control no admin do ImobPro |
| `GET /api/admin/conversations` | HMAC (method+path+query) | auditoria de conversa por tenant — o que o agente disse, quanto custou e quais ferramentas acionou. Exige `?orgId=` ou `?scope=all`. |
| `GET /api/health` | — | Liveness |

O `/api/cron/outbox` também roda a **reconciliação** na mesma passada: marca
`unconfirmed` o que ficou sem callback e reporta os desfechos ao ImobPro
(`POST /api/webhooks/max`, HMAC com `MAX_WEBHOOK_SECRET` — secret próprio
desta direção; sem ele o report fica desligado, que é o default seguro).

## Setup

```bash
npm install
cp .env.example .env.local     # preencher
npm run db:migrate             # cria as tabelas (ver Migrations)
npm run dev
```

Segredos:

```bash
openssl rand -hex 32      # MAX_NOTIFY_SECRET (o MESMO no Contractmaker)
openssl rand -base64 32   # MAX_ENCRYPTION_KEY (32 bytes)
openssl rand -hex 24      # ZAPI_WEBHOOK_SECRET
```

Cadastrar um tenant é `POST /api/orgs` (o ImobPro faz isso sozinho ao ligar
`vendas.max` na org — o token nasce lá, cifrado aqui). Não há INSERT à mão.

Na Z-API, dois callbacks — o segundo é o que fecha a Fase 4:

| Campo no painel | URL |
|---|---|
| Ao receber | `.../api/zapi-webhook/<ZAPI_WEBHOOK_SECRET>` |
| Ao alterar status da mensagem | `.../api/zapi-status/<ZAPI_WEBHOOK_SECRET>` |

Ambos aceitam configuração por API (`PUT /update-webhook-received` e
`PUT /update-webhook-message-status`). E **"notificar mensagens enviadas por
mim" fica DESLIGADO** — senão cada resposta volta como mensagem nova e o bot
conversa sozinho.

## Armadilhas já pagas (não redescobrir)

1. **Z-API desemparelhada responde HTTP 200 com `messageId` válido e não
   entrega nada.** Status code não é prova de entrega — por isso o painel mostra
   `zapi.connected` em destaque, lido de `/status`.
2. **Menção em grupo chega como LID, não como telefone.** Um gate que compare
   com E.164 nunca dispara.
3. **Uma instância Z-API = um número.** O Max precisa de instância própria; usar
   a do Newton exigiria desemparelhá-lo.
4. **O `phone` do webhook é do GRUPO quando `isGroup`** — quem falou está em
   `participantPhone`.
5. **O JID da Z-API varia no 9º dígito.** O mesmo aparelho pode chegar como
   `5511987654321` ou `551187654321`; quem apaga ou busca por telefone tem que
   cobrir as duas formas (ver `/api/admin/forget`).
6. **Log estruturado, telefone despersonalizado.** Use o helper `lib/log.ts`:
   ele troca o telefone por um pseudônimo estável (`tel_9f3a1c4d2e77`), inclusive
   quando o número aparece no meio de texto de erro do provedor. Log da Vercel é
   retido fora do nosso controle de acesso, então lá não sai dígito nenhum —
   para achar alguém, rode `npx tsx scripts/tel.ts <telefone>` (ele carrega o
   `.env.local` sozinho) e busque o rótulo que ele imprime. Se a saída vier como
   `telx_`, é sinal de que faltou o segredo — o rótulo não vai bater com o log. A tela do super-admin continua com máscara legível
   (`5511***4321`), e a diferença é deliberada: `maskPhone` explica o porquê.
   O `messageId` é a costura — busca por ele devolve a conversa inteira, do
   aceite ao id da resposta enviada.

## Testes

```bash
npm test          # vitest
npm run typecheck
npm run lint
npm run build     # pega erro de bundle que typecheck não vê
```

Sem `DATABASE_URL`, os testes de integração (e os três de `multimodal` que
chegam ao checkpointer) são **pulados** — `npm test` tem que terminar com
`0 failed` mesmo assim; é esse modo que o CI roda. Para rodá-los, crie um
**`.env.test`** (gitignorado) com `DATABASE_URL` apontando para um **branch
Neon dedicado a teste** — nunca o banco de produção: o cron do outbox roda a
cada minuto lá e despacharia as linhas criadas pelos testes com o `sendText`
real (ver comentário em `vitest.config.ts`). As demais vars não são
necessárias nos testes.

O contrato do HMAC é testado dos **dois lados**: aqui em
`src/lib/__tests__/hmac.test.ts` e no Contractmaker em
`apps/web/src/lib/max/__tests__/notify-trigger.test.ts`. Se um lado mudar o que
entra na assinatura, toda notificação é recusada em produção — e nenhum dos dois
repositórios quebra sozinho.

## Deploy

Projeto na Vercel: `max-agent` (`prj_yaG4UFnvaRnLjRCGLKtLKv43cSRl`). Push na
`master` dispara deploy de produção.

**Migrations não rodam no deploy** — `npm run db:migrate` é manual e tem que ir
ANTES do merge quando a migration é lida no caminho quente (foi o caso da 007 e
da 008): a Vercel deploya sozinha no merge, e código novo contra schema velho
derruba o inbound inteiro.

### Migrations

**Arquivo aplicado não roda de novo.** O `scripts/migrate.ts` guarda o que já
aplicou em `schema_migrations` (nome, checksum, quando).

Isso não era assim, e a mudança nasceu de um incidente: até 21/08 o script
reaplicava TODOS os arquivos a cada execução, apostando em `IF NOT EXISTS`.
Essa aposta cobre DDL e não cobre migração de dados — o backfill da 009
carimbava `reported_at` em toda linha pendente de report, e como o `reconcile()`
só olha `WHERE reported_at IS NULL`, cada rodada descartava em silêncio os
desfechos de entrega que ainda não tinham chegado ao Contractmaker. Atingiu 2
de 2 linhas com desfecho.

O que esperar em cada situação:

| Situação | O que acontece |
|---|---|
| Banco novo | aplica tudo e registra |
| Banco em dia, registro vazio (1ª vez nesta versão) | **adota** — registra sem executar, listando o que adotou |
| Banco incompleto (tem `outbox`, falta `outbox.report_attempts`) | **aborta** com instrução; adotar aqui faria o registro mentir sobre o schema |
| Arquivo mudou depois de aplicado | avisa e **não** executa |
| Nada novo | "0 aplicada(s)" |

Duas saídas de emergência, verbosas de propósito:

```bash
MIGRATE_REPLAY=009_reconcile_hardening.sql npm run db:migrate  # reaplica UM arquivo
MIGRATE_ADOPT=off npm run db:migrate                           # executa em vez de adotar
```

Antes de qualquer replay, leia o arquivo. Reaplicar migração de **dado** pode
destruir estado — foi exatamente assim que a 009 apagou desfechos de entrega. E
a 006 devolve a `pending` toda linha em `processing`: com a fila viva, isso pode
fazer uma conversa ser processada duas vezes.

**Migration de dados nova precisa ser idempotente em DADO**, não só em DDL. O
registro protege contra reexecução acidental, mas o `MIGRATE_REPLAY` existe — e
uma migration segura é a que sobrevive aos dois.

**Domínio de produção: `https://max-agent-olive.vercel.app`.**

Use SEMPRE este, e não a URL gerada `max-agent-<hash>-<team>.vercel.app`. A
*Deployment Protection* fica ligada em **Standard Protection**, que protege as
URLs geradas e os previews mas **não** o alias de produção — testar na URL
gerada dá 302 e leva a concluir, errado, que a proteção precisa ser desligada.
Ela não precisa: o alias de produção responde 200 com ela ligada, e é por ele
que o webhook da Z-API e o `/notify` do Contractmaker entram.

O rollout foi concluído: instância Z-API pareada (número próprio), banco Neon
migrado, envs preenchidas, tenants provisionados e os dois callbacks
apontados. Os dois interruptores que restam são de PRODUTO, no ImobPro: a
feature `vendas.max`/`locacao.max` por org e o `AgentProfile.enabled` — nenhum
exige deploy daqui.
