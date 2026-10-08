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

-- Teto de custo por pessoa e dia: "quanto esta pessoa gastou hoje" varre a
-- thread dela por data. O índice por org já existe (org_id, created_at); este
-- restringe pelo telefone.
CREATE INDEX IF NOT EXISTS conversation_turn_pessoa_dia_idx
  ON conversation_turn (org_id, phone, created_at DESC);
