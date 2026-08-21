> **ARQUIVADO — a Fase 3 foi entregue (PRs #1, #2, #3, e a proposta de locação
> no #9).** Este briefing fica como registro do RACIOCÍNIO de origem; onde ele
> diverge do que existe hoje, o código venceu. Os três desvios deliberados:
>
> 1. **`interrupt()` foi RECUSADO.** A pendência mora em `pendingAction`, campo
>    comum do estado, porque conversa de WhatsApp não é "grafo bloqueado
>    esperando um valor" — a pessoa muda de assunto, e um grafo pausado
>    obrigaria todo turn a perguntar "esta thread está pausada?", criando a
>    segunda verdade que a `inbound_seen` ensinou a não criar.
> 2. **Uma ferramenta com enum, não três ferramentas.** Medido: três descrições
>    vizinhas confundem o nano mais que um enum. O eval está em
>    `scripts/eval-tool-choice.ts`.
> 3. **`POST /api/forms` já existia** e serviu para venda — nenhuma rota nova
>    foi criada do lado da plataforma.
>
> A frase "por enquanto isso é pelo sistema", que este briefing mandava remover
> ao ligar as ferramentas, foi removida no mesmo commit — como combinado aqui.

# Fase 3 do Max — criar formulário e proposta por conversa

Briefing para a sessão que vai atacar isto. Escrito em 2026-08-04, no fim da
sessão que entregou multimodal + memória, quando ficou claro que a Fase 3 não
cabia no rabo de uma sessão longa.

**Leia isto antes de escrever código.** As quatro peças abaixo se puxam, e a
ordem em que elas entram muda o desenho.

---

## O que existe hoje

O grafo (`src/graph/graph.ts`) **não tem ferramenta nenhuma**. Ele é
`gate → retrieve → answer → compact`, e o próprio prompt admite a limitação:

> "Não executa ação (criar formulário, proposta, cobrança). Ainda não é sua
> atribuição — se pedirem, diga que por enquanto isso é pelo sistema."

Essa frase é contrato com o usuário: enquanto a Fase 3 não existir, o Max
recusa. **Se você ligar as ferramentas, tire a frase no mesmo commit** — um
agente que executa e diz que não executa é pior que os dois estados puros.

---

## Peça 1 — Tool-calling no grafo

Nada disso existe. É trabalho de arquitetura, não de plumbing.

Considerar ao desenhar:

- O modelo é `openai/gpt-5.4-nano` via OpenRouter (`src/lib/llm.ts`), escolhido
  por CUSTO. Nano-tier erra escolha de ferramenta com mais frequência que os
  modelos grandes — vale medir antes de assumir que dá, e considerar subir só
  os turns que envolvem escrita.
- A cerca contra injeção já existe no prompt (`fenceKnowledge`) porque a base de
  conhecimento vem de material que a imobiliária sobe, parte com origem em
  formulário público **anônimo**. Com ferramentas de ESCRITA no grafo, essa cerca
  deixa de ser sobre resposta errada e passa a ser sobre ação indevida. Reavaliar.

## Peça 2 — `interrupt()` e a fila de inbound

**A peça mais delicada, e a razão de este documento existir.**

O `interrupt()` do LangGraph pausa o grafo esperando confirmação humana e retoma
no turno seguinte. Mas a fila de entrada (`src/lib/inbound.ts`, em produção
desde 2026-08-04) trata um turn como **uma coisa só**:

- `runQueued` chama `runTurn`, envia a resposta e marca a linha `done`;
- `reply_text` é gravado antes do envio para que a retentativa **não** re-invoque
  o grafo (senão o checkpointer duplicaria a fala da pessoa na thread).

Um grafo pausado quebra as duas premissas. A próxima mensagem da pessoa precisa
**retomar o mesmo grafo**, não abrir turn novo. O `thread_id` é estável
(`orgId:phone`) e o LangGraph checkpoint o interrupt, então o mecanismo existe —
o que falta é a fila saber distinguir "entrada nova" de "resposta a uma pergunta
pendente", e não tratar a segunda como um turn independente.

Perguntas a responder antes de codar:

- Onde mora o estado "há um interrupt pendente para esta thread"? No checkpoint
  (fonte da verdade do LangGraph) ou numa coluna da fila (barato de consultar)?
  Duas verdades aqui reproduzem exatamente o bug que `inbound_seen` causou.
- O que acontece se a pessoa some no meio de uma confirmação? Um interrupt sem
  expiração deixa a thread travada para sempre.
- Uma confirmação pode chegar por **áudio**. A transcrição já roda antes do
  grafo, então isso funciona de graça — mas confirmar uma ESCRITA por voz
  transcrita merece decisão explícita, não herança silenciosa.

## Peça 3 — Escopo `users:delegate` e reemissão dos tokens

`MAX_SCOPES_FASE2` (`apps/web/src/lib/max/provisioning.ts`) exclui
`users:delegate` **de propósito**, e o comentário explica: enquanto
`X-Act-As-User` aceitasse delegar para o `owner`, o token do bot valeria o poder
do dono do tenant.

Esse pré-requisito **já foi entregue** (#249, trava de delegação). Então o
caminho está aberto — mas ligar o escopo exige **reemitir os quatro tokens**,
porque escopo é gravado na emissão.

Use `POST /api/admin/orgs/[orgId]/max/reprovision` (super_admin, entregue em
#260). Ela existe justamente para isto. **Não** desligue e religue a feature no
painel de módulos: aquele caminho passa por revogação e deixa uma janela com o
tenant sem credencial nenhuma.

## Peça 4 — Endpoint de criação de formulário

**Não existe.** `/forms/new` é tela, não API. Para locação há
`POST /api/locacao/forms` (via `ensureLocacaoApiAccess`); para vendas, nada
equivalente por bearer.

Do plano original: **formBuilder é LEVE** — o form nasce vazio, só metadados e o
link `/f/[token]`. **proposalBuilder é o slot-filling pesado.** Comece pelo leve:
"corretor pede um link de formulário no WhatsApp e recebe" é valor real com
superfície contida, e exercita as peças 1 a 3 sem o peso da peça 4 completa.

---

## Ordem sugerida

1. **Peça 2 primeiro, em papel.** Ela redesenha código que já está em produção;
   decidir depois de ter ferramentas prontas seria decidir sob pressão.
2. Peça 4 no formato leve (criar form + devolver link).
3. Peça 1 com UMA ferramenta só, a do item 2.
4. Peça 3 quando houver o que autorizar.
5. `proposalBuilder` por último — é o maior, e o que mais se beneficia de o
   agente já estar em uso real.

## O bloqueio que atravessa tudo

A instância Z-API do Max está **desemparelhada** desde 2026-08-04 (ver a memória
`project_max_zapi_repareamento_pendente`). Enquanto isso não for resolvido,
**nada da Fase 3 é testável ponta a ponta** — nem as features entregues antes
dela. Dá para desenvolver e cobrir com teste de integração; não dá para dizer
"funciona".
