# Max Agent

Agente de WhatsApp dos tenants **RE/MAX** do ImobPro. LangGraph + Z-API, na Vercel.

O Newton (OpenClaw, `agentpro.ia.br`) atende os demais tenants e continua como
está. Documentação do lado da plataforma: [`docs/max.md`](../contractmaker/docs/max.md)
no repositório do Contractmaker.

## O que ele faz

1. **Canal de notificações** — recebe do ImobPro os avisos já configurados no
   sistema (`POST /notify`) e entrega no WhatsApp. É o objetivo nº 1 e o único
   que está implementado.
2. *(Fase 2)* Responde dúvidas de processo com o RAG do tenant.
3. *(Fase 3)* Cria formulários e propostas por conversa, com confirmação humana.
4. *(Fase 4)* Memória cross-sessão e reconciliação de entrega.

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
ImobPro ──POST /notify (HMAC)──► outbox ──cron 1/min──► Z-API ──► WhatsApp
                                    │
                          adia fora de 7h–22h SP

WhatsApp ──webhook──► dedupe(messageId) ──► grafo LangGraph ──► resposta
                                              (checkpointer Postgres)
```

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
| `POST /api/zapi-webhook/[secret]` | segredo no path + `instanceId` | Inbound do WhatsApp |
| `GET /api/admin/status` | HMAC (mesmo do `/notify`) | Alimenta o Mission Control no admin do ImobPro |
| `GET /api/health` | — | Liveness |

## Setup

```bash
npm install
cp .env.example .env.local     # preencher
npm run db:migrate             # cria as tabelas (idempotente)
npm run dev
```

Segredos:

```bash
openssl rand -hex 32      # MAX_NOTIFY_SECRET (o MESMO no Contractmaker)
openssl rand -base64 32   # MAX_ENCRYPTION_KEY (32 bytes)
openssl rand -hex 24      # ZAPI_WEBHOOK_SECRET
```

Cadastrar um tenant (o token vem de `imobpro.ia.br/settings/api-tokens`, no
service-user daquela org):

```sql
INSERT INTO org_config (org_id, org_name, api_token_enc)
VALUES ('cm...', 'RE/MAX Trio', '<saída de encrypt()>');
```

No painel da Z-API: webhook "Ao receber" →
`https://max-agent-olive.vercel.app/api/zapi-webhook/<ZAPI_WEBHOOK_SECRET>`, e
**"notificar mensagens enviadas por mim" DESLIGADO** — senão cada resposta
volta como mensagem nova e o bot conversa sozinho.

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

## Testes

```bash
npm test          # vitest
npm run typecheck
npm run build     # pega erro de bundle que typecheck não vê
```

O contrato do HMAC é testado dos **dois lados**: aqui em
`src/lib/__tests__/hmac.test.ts` e no Contractmaker em
`apps/web/src/lib/max/__tests__/notify-trigger.test.ts`. Se um lado mudar o que
entra na assinatura, toda notificação é recusada em produção — e nenhum dos dois
repositórios quebra sozinho.

## Deploy

Projeto na Vercel: `max-agent` (`prj_yaG4UFnvaRnLjRCGLKtLKv43cSRl`).

Deploy de produção feito em 2026-08-02; banco Neon (`quiet-sunset-47581096`)
criado e migrado; env de produção preenchidas — menos as da Z-API.

**Passos manuais pendentes**, nesta ordem:

**Domínio de produção: `https://max-agent-olive.vercel.app`.**

Use SEMPRE este, e não a URL gerada `max-agent-<hash>-<team>.vercel.app`. A
*Deployment Protection* fica ligada em **Standard Protection**, que protege as
URLs geradas e os previews mas **não** o alias de produção — testar na URL
gerada dá 302 e leva a concluir, errado, que a proteção precisa ser desligada.
Ela não precisa: o alias de produção responde 200 com ela ligada, e é por ele
que o webhook da Z-API e o `/notify` do Contractmaker entram.

1. ~~Conectar o GitHub à conta Vercel~~ — **feito** em 2026-08-02. Push na
   `master` dispara deploy.
2. **Contratar a instância Z-API e parear o número do Max** por QR. Uma
   instância atende um número; a instância atual (`3F2F70D1…`) está no chip do
   Newton e não pode ser dividida.
3. **Criar o database do Max no Neon** e rodar `npm run db:migrate`.
4. **Preencher as env** na Vercel (ver `.env.example`). `MAX_NOTIFY_SECRET`
   precisa ser **idêntico** ao do Contractmaker, senão toda notificação é
   recusada com 401.
5. **Cadastrar as orgs** em `org_config`, com um token de API por tenant.
6. **Apontar o webhook** no painel da Z-API e desligar "notificar mensagens
   enviadas por mim".
7. No Contractmaker, setar `MAX_NOTIFY_URL`/`MAX_NOTIFY_SECRET` e ligar
   `vendas.max` no primeiro tenant.

Até o passo 4, `/admin/max` no ImobPro mostra "serviço não configurado" — que é
o estado correto, não um erro.
