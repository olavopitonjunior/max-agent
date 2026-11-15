-- Índice da varredura de fichas seladas (I5, PR-C1 rodada 2): `limparCorposSelados` zera o
-- corpo selado das linhas que já não vão sair:
--
--   SELECT id FROM outbox
--    WHERE status IN ('sent', 'dropped', 'failed')
--      AND starts_with(body, 'ficha-selada:v1:') LIMIT 200
--
-- O índice é parcial exatamente nesse predicado (literal idêntico ao da consulta, senão o
-- planner não prova a implicação): só indexa as poucas linhas seladas ainda não zeradas
-- e fica vazio no dia a dia. Sem ele a consulta varre a outbox inteira por minuto.
--
-- ORDEM DE DEPLOY: OPCIONAL para o código funcionar (a varredura só fica mais lenta numa
-- outbox grande, e nem roda sem a feature `formularios_v2` ligada), então pode entrar antes,
-- junto ou depois do deploy.
--
-- Mesma ressalva da 029: o runner executa o arquivo em BEGIN/COMMIT (sem CONCURRENTLY); o
-- índice parcial nasce vazio e a construção varre a tabela uma vez, em milissegundos a poucos
-- segundos. `lock_timeout` evita enfileirar todo enqueue atrás de uma transação longa. Se a
-- outbox de produção crescer muito, crie à mão com CONCURRENTLY (mesmo nome e definição).
SET LOCAL lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS outbox_ficha_selada_idx
  ON outbox (id)
  WHERE status IN ('sent', 'dropped', 'failed') AND starts_with(body, 'ficha-selada:v1:');
