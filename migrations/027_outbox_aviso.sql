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
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS aviso jsonb;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS group_key text;

CREATE INDEX IF NOT EXISTS outbox_phone_group_key_sent_idx
  ON outbox (phone, group_key, sent_at);
