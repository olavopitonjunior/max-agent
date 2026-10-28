-- Índice do agrupamento de rajadas (M8): `atrasoDeAgrupamento` roda em TODO
-- enqueue com `group_key` e pergunta "este telefone, neste negócio, já teve
-- algo ENVIADO há menos de 10 min?":
--
--   SELECT max(sent_at) FROM outbox
--    WHERE phone = $1 AND group_key = $2 AND status = 'sent'
--      AND audience <> 'deal_party' AND sent_at > now() - interval '10 minutes'
--
-- O índice é parcial nas linhas que essa consulta enxerga (`group_key` preenchido
-- e já `sent`): fica pequeno, e a ordem (phone, group_key, sent_at DESC) entrega
-- o `max(sent_at)` direto da folha mais recente.
--
-- ORDEM DE DEPLOY: este índice é OPCIONAL para o código funcionar. O código do M8
-- roda igual sem ele (a consulta só fica mais lenta numa outbox grande), então a
-- migration pode entrar antes, junto ou depois do deploy. A 027 (colunas `aviso` e
-- `group_key`) continua sendo pré-requisito do M1, não deste arquivo.
--
-- ATENÇÃO — trava de escrita: o runner (`scripts/migrate.ts`) executa cada arquivo
-- dentro de BEGIN/COMMIT, e o Postgres recusa `CREATE INDEX CONCURRENTLY` em
-- transação. Este CREATE INDEX comum pede SHARE na `outbox`: bloqueia INSERT/UPDATE
-- (enqueue, dispatchDue, webhook de entrega) durante a construção. A tabela é
-- pequena e o índice parcial só varre as linhas `sent` com `group_key`, então são
-- milissegundos a poucos segundos; se a outbox de produção crescer muito antes de
-- este arquivo rodar, crie o índice à mão com CONCURRENTLY (mesmo nome e mesma
-- definição) e deixe o `IF NOT EXISTS` daqui virar no-op.
--
-- `lock_timeout`: se uma transação longa (dispatchDue no meio de um lote) estiver
-- segurando a outbox, falha em 5s em vez de enfileirar todo enqueue atrás dela.
SET LOCAL lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS outbox_grupo_enviado_idx
  ON outbox (phone, group_key, sent_at DESC)
  WHERE group_key IS NOT NULL AND status = 'sent';
