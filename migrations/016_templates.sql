-- Templates da Meta: o tipo da notificação, as variáveis, o template usado,
-- o clique no botão, e o status de aprovação de cada template.
--
-- ── Por que existe ────────────────────────────────────────────────────────
--
-- Na Cloud API da Meta, fora da janela de 24h só sai TEMPLATE aprovado, e cada
-- tipo de notificação tem o seu. O contractmaker passou a mandar no /notify o
-- `kind` (qual notificação é) e os `params` (as variáveis soltas) em
-- 2026-09-22 (cm#887) — até aqui o Max os descartava. Gravá-los na linha do
-- outbox é o que permite, na hora do envio, escolher o template e montar os
-- parâmetros sem desmontar o corpo em português.
--
-- ── outbox ────────────────────────────────────────────────────────────────
--
--  · `kind`          — o tipo da notificação (NULL = emissor antigo → template
--                      genérico);
--  · `params`        — as variáveis do fato (`negocio`, `etapa`, `prazo`);
--  · `template_name` — o template com que a linha SAIU (NULL = texto livre);
--  · `clicked_at`    — o primeiro clique no botão do template, registrado pelo
--                      redirecionador `/r/<id>`. O botão de URL da Meta exige
--                      domínio fixo com a variável no fim, e o link real muda
--                      de host por tenant; o redirecionador resolve isso e,
--                      de quebra, mede o clique.
--
-- ── wa_template ───────────────────────────────────────────────────────────
--
-- O status de aprovação de cada template na Meta, espelhado aqui para o
-- outbox decidir sem chamar a Graph API a cada linha. Fail-closed: template
-- ausente desta tabela, ou com status diferente de APPROVED, não é usado.
--
-- Aditiva, sem NOT NULL sem default: o código anterior ignora tudo, então a
-- migration roda em produção ANTES do deploy (o /notify novo grava nas
-- colunas novas — deploy antes da migration quebraria o /notify).

ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS kind          text,
  ADD COLUMN IF NOT EXISTS params        jsonb,
  ADD COLUMN IF NOT EXISTS template_name text,
  ADD COLUMN IF NOT EXISTS clicked_at    timestamptz;

CREATE TABLE IF NOT EXISTS wa_template (
  name            text        PRIMARY KEY,
  lang            text        NOT NULL DEFAULT 'pt_BR',
  status          text        NOT NULL DEFAULT 'PENDING',
  category        text        NOT NULL DEFAULT 'UTILITY',
  meta_id         text,
  rejected_reason text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
