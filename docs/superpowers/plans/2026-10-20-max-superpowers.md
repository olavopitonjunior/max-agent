# Max — plano de execução aprovado (2026-10-20)

## Spec e restrições globais
Fonte vinculante: conversa do Olavo nesta sessão, consolidada antes de “Implement the plan”.
Objetivo: preservar e melhorar propostas, formulários, crédito, captação, consultas e notificações; habilitar marketing com estúdio ImobPro e WhatsApp; preparar expansão de tools sem liberar recursos incompletos.
LangGraph permanece orquestrador; subgraphs especializados, sem microserviço por agente. Deep Agents reservado a pesquisa futura. Max possui conversas/tarefas/checkpoints/transporte; ImobPro possui dados oficiais, identidade, RBAC, marcas, cotas e aprovações. Nenhuma chave ou base Rankd compartilhada.
Registro versionado comum a runtime, admin, playground e documentação; capacidade nova desligada por padrão. Leituras com projeção por sujeito no servidor; escrita proposta e confirmação vinculada ao conteúdo. MCP usa os mesmos executores. Notificações determinísticas. Todos os modelos registram custos.
Memória isolada por organização, pessoa, conversa e tarefa; preferências com TTL e proveniência; dado oficial consultado ao vivo. Crédito sensível não vira memória geral. Revogação/apagamento invalida derivados e callbacks tardios.
Inbox/outbox duráveis, intent persistido antes de efeito, idempotência, leases e reconciliação de unknown sem repetir cobrança. Máximo 3 subtarefas concorrentes e orçamento compartilhado. Marketing no máximo 2 revisões automáticas.
Handoff: bot → waiting_human → human → bot; owner único, controlVersion no envio, sem retorno por inatividade; rascunho privado durante atendimento; notificações transacionais separadas. Permissão de assumir não concede permissão de domínio.
Marketing inicial: textos, artes e vídeo com fotos reais + roteiro + narração; templates editáveis e design system governado pelo gerente; cota mensal por corretor/modalidade e exceções do gerente. Creatomate assíncrono, succeeded confirmado, sem fotos padrão. Sem publicação social, editor livre, avatar ou imóvel inventado. Reuso Rankd com proveniência e fixtures; OpenMontage/Remotion apenas candidatos posteriores.
Playground: mesma execução, namespaces próprios; simulação sem efeitos e staging com contatos sintéticos. Eventos reais de agente/tool/skill/modelo/prompt, custos, artefatos, export de eval sanitizado e replay sem efeitos.
Deploy: receptor inerte primeiro; novo comportamento OFF; upgrade framework separado; tasks fixam workflowVersion; rollback não repete efeitos; promoção humana após smoke.

### Task 0: Archify e plano rastreável
Entregar HTML único standalone + JSON editável, fluxo completo com catálogo/instruções por agente/subagente e indicação existente/adaptar/novo/futuro. Validar com Archify showcase, inspecionar e abrir Chrome. O desenho é alvo proposto, não prova de deploy.

### Task 1: Baseline e inventário
Fixar commits Max/ImobPro/Rankd, testes baseline e matriz do que já existe. Preservar mudanças locais com duas worktrees. Registrar lacunas e versões.

### Task 2: Contratos e harness
Schemas ExecutionContext, ConversationControl, Task, ExecutionIntent, Approval, HandoffCase, RunEvent, ResponseEnvelope, ReleaseManifest. Estados queued/running/waiting_input/waiting_approval/succeeded/failed/cancelled/unknown. Catálogo agentes/tools/skills/APIs/MCP/modelos/prompt; guards executáveis, flags, orçamento, aprovação, persistência e eventos. Vetores comuns nos dois repos.

### Task 3: Fluxos existentes e consultas
Integrar registry no runtime preservando atuais fluxos transacionais e capacidades; ampliar leitura segura do que ImobPro já tem, com paginação, fresh data e ausência de campos proibidos por sujeito. Notificações reutilizam event-registry, destinatários, preferências, dedupe e dono do envio; distinguir accepted/sent/delivered/read/failed.

### Task 4: Atendimento humano
Inbox ImobPro no mesmo WhatsApp, claims atômicos, fencing no dispatch, contexto redigido, send humano e handback explícito. Jobs autorizados podem terminar silenciosamente; acompanhar efeitos em voo.

### Task 5: Marketing
Engine versionado independente extraído/adaptado do Rankd; brand/template/brief/source snapshots, cotas reserve/settle/unknown e biblioteca. Copy → layout/vídeo → QA, estúdio ImobPro com edição permitida pela marca; canal WhatsApp mesmo executor. Sem cota definida: geração paga indisponível.

### Task 6: Admin e playground
Admin: saúde, inbox, tarefas/unknown, catálogo, versões/canary, quotas/custo, branding, qualidade e memória. Kill switches separados chat/escritas/pagos/outbound não bloqueiam callbacks. Alertas oldest inbound>2min, fail>5%/15min com mínimo20, deadline/heartbeat/unknown/casos sem owner, orçamento80%/100%, violação tenant. Playground simulation/staging isolado, histórico, trace e evals.

### Task 7: Validação e entrega
Testes tenant/role/revogação, aprovação alterada/expirada, duplicados/out-of-order/lost ack, takeover mid-reply/two owners, paginação, deletion+job, stale brand/preço/foto, cota concorrente, restore/migrate/rollback. Evals determinísticos + qualidade humana calibrada, holdout por conversa/entidade. Typecheck/test/build. Revisão independente final, docs contratos/ADRs/runbooks/manifesto/canary/rollback; PRs coordenados se validação verde. Não promover produção sem gate humano.

### Task 8: Expansão posterior (catálogo planejado, não habilitar)
Atividades/CRM, documentos, locação ampliada, financeiro leitura, agenda externa, estudos/pesquisas com Deep Agents. Contratos/schema extensíveis agora; features permanecem planned.

## Interfaces e ordem
E0 deriva do plano; E2 fornece registry/contratos consumidos por E3–E6; E4 consome controle+intents; E5 consome quota/approved intent/context; E6 exibe eventos reais E2–E5. ImobPro valida subject/org/permission; não aceitar autorização do LLM. Dependências LangGraph não atualizar com comportamento. Nenhum dado real ou efeito externo nos testes.

## Review Focus
Revisar bypass de autorização, cross-tenant, namespace de playground, redaction, replay com efeito, intent desconhecido, autorização expirada em voo, dedupe/quota concorrente, fencing takeover e rollback. Diferenciar capability declarada de implementada. Nenhum endpoint expõe segredo/prompts privados a sujeito não autorizado. Compatibilidade contratos HMAC/fluxos existentes.
