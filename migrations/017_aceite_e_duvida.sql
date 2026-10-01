-- Régua final do Max (01/10/2026): o aceite por "OK" e o repasse de dúvida.
--
-- ── inbound_queue.button_payload ──────────────────────────────────────────
-- O payload do botão de resposta rápida que a pessoa tocou (`ok:<id da linha
-- do outbox>`, `duvida:<id>`). O texto visível do botão continua em `text`;
-- é o payload que diz a QUAL mensagem o toque responde.
--
-- ── outbox.released_at ────────────────────────────────────────────────────
-- Mensagem que só é entregue depois de um aceite (a mensagem da imobiliária,
-- o repasse de dúvida): o template sai com "responda OK", e o texto guardado
-- em `body` é entregue quando o OK chega. `released_at` marca a entrega — o
-- UPDATE que o seta é a trava contra entregar duas vezes.
-- `released_by` é a mensagem (wamid) cujo OK a liberou: se o turn morrer
-- depois de liberar e antes de a resposta sair, a RETENTATIVA da mesma
-- mensagem reencontra a linha e entrega — sem isso o texto se perdia com a
-- linha marcada como entregue (achado do code review).
--
-- ── pending_handoff ───────────────────────────────────────────────────────
-- Quem tocou em "Tenho uma dúvida" no lembrete de configuração: a PRÓXIMA
-- mensagem dessa pessoa é a dúvida, e vai para o time. Uma linha por
-- telefone, com validade curta. `consumed_by` é a mensagem que virou a
-- dúvida — pela mesma razão do `released_by`: a retentativa reencontra o
-- pedido em vez de mandar a dúvida para o modelo.
--
-- Aditiva, sem NOT NULL sem default: o código anterior ignora tudo, então
-- roda em produção ANTES do deploy (e PRECISA rodar antes: o código novo
-- grava `button_payload` em todo inbound).
--
-- `lock_timeout`: o ALTER pede ACCESS EXCLUSIVE em tabelas vivas. Com uma
-- transação longa na frente, ele esperaria na fila travando todo INSERT do
-- webhook atrás de si; melhor falhar em 5s e rodar de novo.

SET LOCAL lock_timeout = '5s';

ALTER TABLE inbound_queue
  ADD COLUMN IF NOT EXISTS button_payload text;

ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_by text;

CREATE TABLE IF NOT EXISTS pending_handoff (
  phone          text        PRIMARY KEY,
  org_id         text        NOT NULL,
  org_name       text        NOT NULL DEFAULT '',
  requester_name text        NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  consumed_by    text
);
