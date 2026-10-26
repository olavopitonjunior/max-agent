# Max — operação e rollout do runtime v1

Esta entrega é código preparado para revisão. Flags, catálogo e HTML não comprovam habilitação em produção. O desenho em `workflow/max-superpoderes.html` inclui também a expansão futura, identificada no catálogo como `planned`.

## Responsabilidades

Max: grafo LangGraph atual, conversa, contexto de execução, intent, controle humano, transporte e histórico isolado. ImobPro: identidade e RBAC frescos, dados oficiais, cotas, marca, templates, snapshots aprovados, biblioteca e serviços de domínio. Um agente não recebe privilégios extras por delegar a um especialista. HTTP/MCP devem chegar ao mesmo serviço autorizado; este rollout não instala servidor MCP externo nem Deep Agents.

O catálogo executável é `GET /api/admin/catalog`, apresentado em `/admin/max/catalog` no ImobPro. `installed`, `enabled` e `planned` têm significados distintos. Instruções exibidas são resumos versionados; prompts privados permanecem no servidor. Adicionar tool exige schema, executor, autorização, projeção, classificação de efeito, timeout, idempotência, reconciliação e casos de avaliação. Acrescentar somente um nome ao catálogo não a habilita.

## Ordem de implantação

O playground isolado é exposto em `POST/GET /api/admin/playground/v1`. O ImobPro usa somente essa versão, sem fallback: em backend legado, 404 bloqueia turno e reset antes de qualquer efeito. A rota sem versão não serve como prova de compatibilidade durante deploy parcial ou rollback.

1. Aplicar migração aditiva ImobPro de marketing e Max022–026 no ambiente de staging, com backup e teste de restauração prévios. Executar o migrador versionado; não “adotar” schema incompleto.
2. Implantar receptores ImobPro e Max com comportamentos novos OFF. O contrato HMAC deve passar com `docs/contracts/max-runtime-v1.json` idêntico nos dois repos.
3. Ligar playground simulado nos dois serviços. Ele usa o mesmo grafo com adaptadores sintéticos, sem rede/modelo pago/banco de negócio. Uma sessão nunca é uma conversa WhatsApp.
4. Para staging real: habilitar `MAX_PLAYGROUND_STAGING_ENABLED` no ImobPro; no Max, habilitar `MAX_PLAYGROUND` e permitir explicitamente o par organização/telefone sintético em `MAX_PLAYGROUND_STAGING_IDENTITIES`. Nunca cadastrar um contato de cliente real como fixture. Separar credenciais e dados de staging.
5. Canary de uma organização: configurar `MAX_ROLLOUT_ORGS` com o ID canônico e a lista de recursos permitidos, por exemplo `{"org-id":["runtime","queries"]}`. Habilitar `MAX_RUNTIME_V1`; depois `MAX_EXTENDED_QUERIES` e somente as capabilities aprovadas no `maxPolicy`. Flag global e seleção da organização são obrigatórias em conjunto; JSON ausente/inválido, chave curinga ou organização fora da seleção não habilitam recursos novos. Validar fluxo atual de proposta/formulário, consultas e negações por papel.
6. Handoff exige `handoff` na seleção da organização e `MAX_HANDOFF=true` no Max, `MAX_HANDOFF_ENABLED=true` no ImobPro, módulo Max e permissões `max.conversations.view` + `max.conversations.manage`. Testar dois operadores, takeover durante resposta e handback explícito.
7. Marketing exige `marketing` na seleção da organização e `MAX_MARKETING=true`, permissões e política `marketing.read/generate`, marca/templates/cota do tenant. Escolha de imóveis no WhatsApp também precisa `MAX_EXTENDED_QUERIES` e `property.list`. Vídeo depende do contrato de template Creatomate e armazenamento privado descritos na documentação de marketing. Sem configuração/cota, não gerar pago.
8. Só ampliar canary depois dos smokes e da revisão humana. Não combinar upgrade de LangGraph com estas mudanças. Tasks gravam `workflowVersion`; código antigo não deve reassumir tarefas de uma versão que não conhece.

O catálogo aceita `GET /api/admin/catalog?orgId=…`, com a query inteira coberta pelo HMAC. Sem organização selecionada, recursos novos não aparecem como habilitados. Catálogo, runtime e inbox retornam o estado efetivo das flags e da seleção para essa organização; isso não substitui permissões de sujeito, cotas ou configuração dos provedores. Playground usa a mesma seleção, inclusive na simulação, e continua sem transporte WhatsApp.

## Superfícies de operação

| Tela ImobPro | Responsabilidade |
|---|---|
| `/admin/max` | Canal, provisionamento e política de capabilities |
| `/admin/max/runtime?orgId=…` | Tarefas, intents incertos, prazo, alertas e estado dos kill switches |
| `/admin/max/catalog` | Agentes, tools, skills, adaptadores, versões e disponibilidade reais |
| `/admin/max/playground` | Sessão isolada, histórico, rastros e export sanitizado |
| `/admin/max/custos` e painel de IA existente | Custos técnicos; não são a cota comercial do corretor |
| `/settings/max/atendimento` | Inbox humana do tenant; nenhuma permissão de domínio é ampliada |
| `/marketing` | Marca/templates governados, cota e biblioteca do corretor |

Operação detalhada e cancelamento são exclusivos de `super_admin`. O painel deriva indicadores de tabelas reais e limita listas a100 com aviso. A idade da fila inbound é da instância, pois a identidade ainda pode estar pendente; não é um indicador isolado por tenant. O alerta de falhas exige pelo menos20 turnos em15min e taxa superior a5%; inbound>2min, prazo vencido e resultado incerto também são sinalizados. Orçamento é medido por execução; limiares80/100% não são uma cotação antecipada do próximo modelo.

`MAX_CHAT_KILL`, `MAX_WRITES_KILL`, `MAX_PAID_KILL`, `MAX_OUTBOUND_KILL` são independentes, no ambiente Max. Interrupção de escrita não apaga intents nem impede callbacks/reconciliação. Preferir desligar a categoria afetada a interromper os serviços que registram desfechos.

## Resultado incerto e atendimento humano

Perda de ACK não prova falha. Conservar chave idempotente, intent e reserva comercial. Consultar o provedor/domínio com os identificadores existentes; nunca reenviar uma operação paga com nova chave para “destravar”. A reconciliação de vídeo faz apenas GET após submissão; resultado confirmado liquida a reserva. Os demais intents desconhecidos e envio humano desconhecido exigem investigação operacional; esta entrega não oferece um botão genérico “forçar sucesso”.

Cancelamento administrativo só aceita `queued`, com bloqueio de linha e nova checagem da ausência de efeito. Não rebaixa `running/unknown` e não cancela uma aprovação só alterando estado. Uma conversa humana não volta ao bot por inatividade. O atendente assume com versão de controle, redige localmente e envia pela mesma infraestrutura. Jobs autorizados em voo podem concluir; evitar uma nova resposta conversacional durante posse humana.

Apagamento incrementa epoch e elimina derivados do runtime, sessões e checkpoints. Callbacks capturados antes do apagamento falham com revogação e não recriam memória. Tombstone contém digest técnico, sem dados de crédito. Alteração de identidade/papel é revalidada no ImobPro antes de acesso e efeito.

## Avaliação reproduzível

`npx vitest run --config vitest.runtime-eval.config.ts` executa a bateria sintética versionada sem efeitos. Para replay exportado: substituir texto-placeholder por mensagem sintética revisada, declarar expectativas, fixar versões e mudar `reviewRequired` para `false`; executar `MAX_EVAL_FIXTURE=/caminho/fixture.json npx vitest run --config vitest.runtime-eval.config.ts`. O runner recusa live, exports não revisados e IDs duplicados. Não importar conversas reais diretamente.

O modelo da simulação é sintético: o replay valida roteamento, tools, estados e proibição de efeitos, não mede qualidade do modelo em produção. Avaliação com modelo real fica na bateria existente `vitest.eval.config.ts`, tem custo, é separada e não foi executada contra provedores nesta entrega. Antes de ampliar canary, avaliar linguagem, completude, factualidade e confirmação com holdout por conversa/imóvel e rubrica humana comum; nunca usar a mesma conversa no ajuste e na aprovação.

## Rollback

Remover o recurso da seleção da organização ou desligar sua flag global; manter receptores, migrações aditivas e cron de reconciliação para efeitos já aceitos. Consultas de inbox e devolução explícita ao bot permanecem disponíveis após desligar handoff; novos pedidos, claims e envios são bloqueados. Um pedido ainda sem dono também pode ser devolvido ao bot por operador autorizado com a versão de controle correta. Não apagar intents, reservas, tombstones ou checkpoints para recuperar fila. Comparar workflowVersion antes de retomar. Restaurar backup apenas em procedimento coordenado com pausa de transporte: restaurar uma fila antiga sem dedupe pode repetir mensagens. Nenhum rollback executa automaticamente uma operação com resultado incerto.

## Memória e trace remoto após a migração025

Preferências novas do runtime carregam `source_task_id`, `workflow_version` e `subject_digest`, derivados somente do ExecutionContext confiável. A chave física recebe namespace por sujeito para que duas identidades no mesmo telefone possam manter a mesma preferência sem sobrescrever uma à outra; o prompt recebe apenas a chave lógica. Leitura no runtime exige o sujeito exato e não consome preferências legadas com proveniência NULL. Chamadores antigos sem contexto preservam suas linhas legadas. TTL, teto por pessoa/sujeito, filtros de dado sensível e esquecimento continuam aplicáveis; callback com epoch antigo não recria preferências.

O catálogo usa os nomes reais dos workers remotos ImobPro: `marketing.brief`, `marketing.copy-script`, `marketing.template-layout`, `marketing.qa` e `marketing.video`. O gateway importa `snapshot.events` e `job.events` por allowlist de worker/versão/skill/outcome/revisão e códigos conhecidos de QA. Fonte, argumentos, URLs e metadados de texto livre não entram no trace local. Workers continuam determinísticos ou de provedor, com `model:null`, e permanecem desligados até habilitação explícita.

O rollback compatível mantém o leitor de preferências consciente de sujeito da025. Se for necessário voltar a código anterior a essa fronteira, o procedimento humano deve primeiro bloquear chat/memória e remover ou isolar as preferências com `subject_digest IS NOT NULL`; um leitor antigo não reconhece esse isolamento. Nenhuma migração atribui linhas NULL históricas ao usuário atual de um telefone.

## Revogação e conversa ao vivo após a migração026

A fila inbound e a outbox persistem o digest da pessoa e o epoch de privacidade capturados no recebimento. A resposta derivada preserva também sujeito e versão de controle. Persistência da resposta e envio final verificam o epoch e a existência da linha, sob bloqueios na ordem privacidade → controle → fila/checkpoint. Apagamento que conclui antes do envio invalida inclusive respostas já calculadas ou persistidas e callbacks de uma linha capturada anteriormente. Transporte que já iniciou sob o bloqueio conclui antes do apagamento; isso não representa cancelamento de mensagem já entregue ao provedor.

Checkpoints ao vivo usam namespace por organização, telefone canônico e sujeito; a migração não transfere histórico nem aprovações legadas ao novo sujeito. `live_conversation_binding` permite que handback remova pendências dos namespaces vinculados e que forget remova todos eles. Linhas de fila antigas sem epoch só são aceitas se a pessoa nunca tiver sido apagada; após apagamento, são suprimidas de forma conservadora. Os kill switches de chat e escrita valem também com as flags novas desligadas. O alerta de atendimento sem dono conta `waiting_human` sem operador e cessa após claim.

O contrato público de marketing usa `snapshot.quotaUnits` na confirmação e `job.state` no acompanhamento, conforme `docs/contracts/max-marketing-v1.json`. A confirmação informa unidades da cota da modalidade; não inventa preço em dólar quando o serviço não fornece um custo técnico.

Após aceite do provedor, falha de COMMIT local é registrada como `transport_accepted_commit_unknown`; os marcadores duráveis de envio não são apagados e replay não chama o transporte novamente. Falha conhecida do transporte antes do aceite mantém a retentativa anterior. A outbox mantém a reserva para a recuperação de órfãs; a fila inbound conclui com a ressalva, sem prometer entrega final do provedor.

Chamadas diretas de `runTurn`, inclusive o harness com flags novas OFF, registram o namespace por sujeito sob o mesmo epoch, sem criar task durável. O aceite de templates continua antes da consulta de identidade. `scripts/turn.ts --novo` limpa o namespace do sujeito resolvido que o próximo turno usará.

O preâmbulo de aceite mantém um escopo de pessoa/epoch antes de resolver identidade ou organização. Cada consulta/gravação compara o epoch sob o lock compartilhado com forget, e `afterReply` conserva esse mesmo escopo. Repasses ao telefone da equipe verificam origem e destino em ordem de digest, pois a linha do time contém dados da pessoa de origem. Apagar a origem entre a leitura do lembrete e a gravação seguinte impede a recriação desses derivados.

## Preservação das notificações no rollout

`MAX_ROLLOUT_ORGS` não participa de `/api/notify`, outbox, templates ou reconciliação. `MAX_CHAT_KILL` e `MAX_WRITES_KILL` não interrompem entrega proativa; `MAX_OUTBOUND_KILL` interrompe. As migrações022–026 continuam obrigatórias ANTES do novo código, mesmo com recursos novos OFF: a proteção de privacidade altera a fila compartilhada. Medir aceites/erros, backlog vencido/idade, falhas e confirmação de entrega, templates represados, report pendente e locks/conexões do banco. O piloto de produção exige pelo menos24h de observação efetiva e baseline comparável, não apenas24h transcorridas.

### Recovery after admission disable (2026-10-21 review)

- `marketing.status` is a read-only recovery tool for an existing job, independent of new-generation rollout. A selected organization and live ImobPro subject/RBAC are still required; no prepare/generate bypass. Accepted tracking survives disable; unconfirmed approvals are discarded.
- Handoff read/handback remains available after module deprovision. Recovery uses the org-scoped existing thread/control/bindings, HMAC, owner/version and privacy fence rather than requiring the bot's now-disabled identity. ImobPro navigation remains visible to authorized operators. Operator permission revocation is still enforced; it does not grant another operator takeover.
- Runtime lease expiry runs regardless of admission flags, including handoff-only and all-off deployments. No cron schedule was added or changed. Reconciliation never retries an uncertain effect automatically.
- Use a direct Neon connection for the normal migration runner because it holds a session advisory lock; derive the direct endpoint from the existing authorized pooled connection without exposing credentials. [Neon connection pooling limitations](https://neon.com/docs/connect/connection-pooling).
- Staging backup was restored to an isolated local database and all17 table digests matched. Template database already contains public schema: restore excludes only the TOC CREATE SCHEMA public entry, without dropping or ignoring table errors. The ordinary migrator then applied exactly022–026 and preserved all old-column values of the16 existing data tables; the ledger is expected to gain five rows. Remote staging received the same migration sequence on2026-10-21, preserving the same data digests. Evidence is recorded outside source control; never commit database dumps or backup keys.
