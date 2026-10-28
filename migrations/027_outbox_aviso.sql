-- Contrato `aviso` v1 (M1): o contractmaker passa a mandar, junto de title/body,
-- a descrição estruturada da notificação (nível, frase, itens, ações). O Max a
-- renderiza em texto (M2) e botões (M5); aqui só a persistência.
--
--  · `aviso`     — o objeto já validado pelo /notify (jsonb). NULL = aviso de
--                  hoje, só title/body. Para `deal_party` é gravado sem ações
--                  e sem imagem.
--  · `group_key` — `dealId` quando há dealId e o nível do aviso não é C; NULL
--                  caso contrário. Serve para agrupar o que sai junto para o
--                  mesmo telefone e negócio.
--
-- Colunas anuláveis e sem DEFAULT: ADD COLUMN assim não reescreve a tabela, e
-- as linhas antigas seguem como estão.
--
-- RODA ANTES DO DEPLOY: o INSERT do enqueue grava `aviso, group_key` sempre;
-- código novo sem esta migration derruba todo /notify.
--
-- Sem índice aqui: nada no PR1 lê `group_key`. O índice de agrupamento entra na
-- migration do agrupamento (M8), medindo antes o tamanho da outbox em prod — o
-- runner roda em transação e CREATE INDEX sem CONCURRENTLY trava escrita.
--
-- `lock_timeout`: o ALTER pede ACCESS EXCLUSIVE na outbox viva; se houver uma
-- transação longa na frente (dispatchDue no meio de um lote), falha em 5s em
-- vez de enfileirar todo enqueue atrás dele.
SET LOCAL lock_timeout = '5s';
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS aviso jsonb;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS group_key text;
