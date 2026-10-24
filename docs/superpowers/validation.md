# Max — evidência da entrega

Esta é uma entrega de código em PRs coordenados, com recursos novos desligados. Não é evidência de implantação, render pago ou habilitação para clientes.

## Revisões e verificações

| Verificação | Resultado |
|---|---|
| Max — código validado | `9eab4b38079350f1782e37e3ccab6f9335886af0` |
| ImobPro — código validado | `7c8e6500520a5817aeb21e0c6a1aa4bc187c7f94` |
| Max — suíte completa | 2.363 passaram /109 arquivos;35,76s |
| ImobPro — suíte completa | 35.178 passaram /3 skips;3.040 arquivos passaram /1 skip;523,54s |
| Typecheck/build Max + web ImobPro + MCP | Todos passaram; ImobPro com heap12GB e valores fictícios equivalentes ao CI para build |
| Replay do grafo sem efeitos | 3/3 passaram; rede e efeitos bloqueados |
| PostgreSQL marketing | 28 testes; três migrações reais em base nova; pg_dump/pg_restore em base local nova e 28 testes novamente |
| PostgreSQL Max | 26 migrações em base nova; backup/restauração local e migrador sem pendências |
| Revisão independente | Revisão independente de ambos os repos +revisão das correções:0 pendências; seis findings importantes e dois menores corrigidos com regressões RED/GREEN |
| Archify | validate/deliver/check/browser-check passaram; inspeção perceptual e abertura no Chrome não realizadas por bloqueio da política de URLs locais |

Os testes usam fixtures sintéticas. A suíte geral ImobPro mantém os skips explícitos; a bateria de isolamento PostgreSQL exige opt-in e foi executada separadamente. Os avisos preexistentes do Vite/Next não foram descritos como ausência de warnings.

## Verificação adicional em banco vazio

O primeiro CI do PR #93 revelou que a limpeza da auditoria de crédito dependia de tabelas do checkpointer já existentes. As 26 migrações da aplicação não criam essas tabelas, que pertencem ao saver do LangGraph. O helper de teste agora inicializa o checkpointer antes da limpeza, mantendo todas as verificações de dados sensíveis.

As quatro falhas foram reproduzidas em uma base local nova; os cinco casos da auditoria passaram após a correção. Em outra base nova, migrada do zero, os 2.363 testes passaram, assim como typecheck e lint. A correção altera apenas a preparação dos testes, sem mudar runtime, migrações ou workflow do CI.

## Contratos compartilhados

- `max-runtime-v1.json`: SHA256 `8a90b17d41f8d30e6413002af4a333442ba58f4a93ac17db622886ab073002f7`.
- `max-marketing-v1.json`: SHA256 `5413d6b2eeb1bab72aeb497dc9aae953d2a2b5ba66b611fc0baf3527a118dc37`.

Ambos são byte a byte idênticos nos dois repositórios. Max parte de `26b4a4f`; ImobPro incorpora staging até `34fe857a`. Atualizações posteriores da base exigem reconciliação antes do eventual merge.

## Limites da validação

O replay sintético mede controles, roteamento e proibição de efeitos. Qualidade conversacional, estética, narração, custo real e comportamento de Creatomate/Blob precisam do smoke autorizado e da avaliação humana descritos em [evaluation-gates.md](evaluation-gates.md). Arte inicial é SVG com fotos reais referenciadas; workers de marketing são determinísticos e informam `model:null`.

Produção, credenciais, migrações remotas e promoção não foram alteradas. Seguir [runtime-operations.md](runtime-operations.md) para receptor inerte, ativação por organização, acompanhamento de unknown e rollback sem repetir efeitos. A conclusão proativa inicial de marketing usa o sino do ImobPro.
