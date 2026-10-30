# Contrato Google Workspace com ContractMaker


## Google Workspace — agenda e tarefas individuais (opt-in)

O receptor entra antes do emissor. `GET /api/agents/profile` acrescenta
`googleMaxEnabled?: boolean`: ausente/false desliga o módulo no Max. As capabilities
`google.calendar.read`, `google.calendar.write`, `google.tasks.write` são acrescentadas
**nessa ordem depois de `prefs.self`**, sem concessão implícita. Exigem também flags
por organização e vínculo ativo de usuário. Sujeito broker recebe
`USER_IDENTITY_REQUIRED`, mesmo que tenha strings de capability. O servidor resolve
ator/org pelo transporte autenticado existente; argumentos não podem escolher tenant,
usuário, calendário ou credenciais. Assinatura HMAC/vetor fixo permanecem iguais.

Transporte: `POST /api/agents/scope-action`, mesmo envelope autenticado de verbos
existentes, com estes `verb`/`args` (datas ISO com offset):

| Verbo | Args | Capability | Resposta |
|---|---|---|---|
| `google.availability` | `{startAt,endAt}` | `google.calendar.read` | `{busy:[{start,end}]}` |
| `google.activities` | `{startAt,endAt}` | `google.calendar.read` | `{items:[{id,title,dealId,startAt,endAt,timeZone,status,version,updatedAt}]}` |
| `google.propose` | `{kind,input}` | calendar.write ou tasks.write conforme kind | proposta abaixo |
| `google.confirm` | `{proposalId,digest}` | mesma capability da proposta armazenada | `{jobId,status:"queued"}` |

Intervalo máximo 31 dias; até 50 atividades profissionais autorizadas, criadas pelo
usuário ou atribuídas a ele. Não há títulos/participantes/descrições de agendas
pessoais. `version` é do vínculo Calendar (0 sem vínculo), `updatedAt` da atividade.
O emissor exibe até cinco referências numeradas com expiração e identidade fixada.
Uma referência antiga é invalidada quando outro menu ocupa a numeração.

Kinds permitidos ao Max:

- `calendar.schedule`: `{activityId,startAt,endAt,timeZone?,participants?,createMeet?,expectedVersion}`;
  defaults `America/Sao_Paulo`, `[]`, `false`; duração positiva até 24h. Criação do
  evento exige atividade manual aberta já existente; usar proposta de atividade
  existente do Max para criar/concluir a atividade do negócio.
- `calendar.cancel`: `{activityId,expectedVersion}` (versão positiva).
- `tasks.sync`: `{activityId,expectedUpdatedAt}` para atividade sem horário. O
  emissor obtém timestamp da projeção do servidor, nunca do modelo.

Resposta da proposta:
`{proposalId,digest,expiresAt,kind,preview,summary:{title,dueAt},reviewedAttachments:[]}`.
`preview` contém input canônico, com defaults; `summary` é lido da atividade atual
pelo servidor e deve ser exibido antes da confirmação. O digest corresponde à
versão imutável, incluindo conexão/revisão e snapshot da atividade. TTL 15 minutos.

O Max só confirma após um **novo turno humano**, imediatamente seguinte, contendo
exatamente `SIM`. Não existe tool de confirmação disponível ao modelo. Alteração,
expiração, troca de identidade, mídia/bloqueio e outro menu descartam a proposta.
O servidor revalida permissão, flag, conexão, atividade, disponibilidade e consome
atomicamente a proposta junto com a criação de um único job. Replay retorna
`PROPOSAL_ALREADY_CONSUMED` (409); o emissor não gera outra escrita em retry.
Resultado queued não significa que o Google já concluiu o efeito.

Erros: 403 `USER_IDENTITY_REQUIRED`, `POLICY_DENIED`, `GOOGLE_FEATURE_DISABLED`,
`GOOGLE_ACCESS_DENIED`; 409 `GOOGLE_RECONNECT_REQUIRED`, `ACTIVITY_CHANGED`,
`CONNECTION_CHANGED`, `PROPOSAL_EXPIRED_OR_CHANGED`, `PROPOSAL_ALREADY_CONSUMED`,
`TIME_UNAVAILABLE`; entrada inválida 400; falha de provedor 502. Não incluir tokens,
conteúdo OAuth nem detalhes pessoais nas respostas/erros/prompts.

Gmail continua no compositor web com revisão explícita de destinatários, assunto,
corpo e anexos. `gmail.*` é recusado pelo gateway do Max. Conteúdo de e-mail/anexos
é dado não confiável. Drive/Docs continuam nas projeções de negócio já autorizadas;
esta integração não concede acesso a Drive pessoal nem altera permissões.
Lembretes/resumo usam notificações estruturadas existentes, sem chamada de modelo.
Resumo diário inicia desligado; preferências do usuário e horários são respeitados.

Arquivos: ContractMaker `lib/google-workspace/*`, `api/me/google/*`; emissor
`src/graph/google-workspace.ts`, integração em `graph.ts`, catálogo e política.
Runbook receptor: `docs/google-workspace.md` no repositório ContractMaker. Validar HMAC/capability
nos dois repositórios e habilitar piloto somente após deploy do receptor.
