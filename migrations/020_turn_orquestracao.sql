-- Observabilidade da orquestração por turn (08/10/2026, plano "jornadas completas").
--
-- O painel sabe o que o Max respondeu e quanto custou, mas não POR ONDE o turn
-- passou nem onde o tempo foi gasto: a latência é um número só, e o p95 de
-- produção (4,9 s) não diz se o peso está no perfil, na política, no modelo ou
-- no checkpoint. Antes de reorganizar o grafo (roteador, jornadas, classificador)
-- é preciso medir cada nó — senão a melhoria é opinião.
--
-- Tudo aditivo e anulável: linhas antigas ficam como estão.
--   route        — rota que o roteador escolheu (ex.: j_proposta, conversa).
--   intent_json  — intenção classificada (sombra ou ativa), sem texto da pessoa.
--   timings_json — [{ no, ms }] por nó do grafo, na ordem em que rodaram.
--   signals_json — sinais implícitos de qualidade (re-pergunta, cancelamento…).
--   degradado    — o turn rodou em modo degradado por teto de custo.
ALTER TABLE conversation_turn
  ADD COLUMN IF NOT EXISTS route        text,
  ADD COLUMN IF NOT EXISTS intent_json  jsonb,
  ADD COLUMN IF NOT EXISTS timings_json jsonb,
  ADD COLUMN IF NOT EXISTS signals_json jsonb,
  ADD COLUMN IF NOT EXISTS degradado    boolean NOT NULL DEFAULT false;

-- O índice (org_id, phone, created_at) do teto por pessoa/dia NÃO entra aqui:
-- o runner roda cada migração dentro de BEGIN, então não dá para usar
-- CONCURRENTLY, e a construção travaria `registrarTurn` numa tabela que só
-- cresce. Ele vai na migração do PR que lê o teto (O4), medido o tamanho da
-- tabela antes.
