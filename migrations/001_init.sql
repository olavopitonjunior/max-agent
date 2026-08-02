-- Schema do Max. Idempotente: pode rodar de novo sem estragar nada.
--
-- Este banco é SÓ do Max e vive separado do banco da aplicação de propósito:
-- o serviço não tem (nem deve ter) credencial do Postgres do ImobPro. Todo
-- dado de tenant vem pelas APIs Bearer. Se este serviço for comprometido, o
-- estrago para no que está aqui.
--
-- As tabelas `checkpoints*` do LangGraph são criadas pelo próprio
-- `PostgresSaver.setup()` — não replicar aqui.

-- ── Entregas proativas ────────────────────────────────────────────────────
--
-- É a fila que permite ao ImobPro entregar a QUALQUER hora: os call-sites de
-- lá pararam de segurar a mensagem fora da janela 7h–22h porque esta tabela
-- assumiu o adiamento. Perder uma linha daqui = perder a notificação, porque
-- o motor de deal-events de lá não tem reconciliação.
CREATE TABLE IF NOT EXISTS outbox (
  id               TEXT PRIMARY KEY,
  org_id           TEXT        NOT NULL,
  -- Idempotência ponta a ponta: é o id da linha de log do ImobMax/ImobPro que
  -- originou o envio. UNIQUE é o que faz o reenvio virar 409 em vez de uma
  -- segunda mensagem no celular de alguém.
  dedupe_key       TEXT        NOT NULL UNIQUE,
  audience         TEXT        NOT NULL,
  phone            TEXT        NOT NULL,
  recipient_name   TEXT        NOT NULL DEFAULT '',
  title            TEXT        NOT NULL DEFAULT '',
  body             TEXT        NOT NULL DEFAULT '',
  link_url         TEXT,
  deal_id          TEXT,
  org_name         TEXT        NOT NULL DEFAULT '',
  -- pending | sent | failed | dropped
  status           TEXT        NOT NULL DEFAULT 'pending',
  -- Quando pode sair. Fora da janela, nasce apontando para as 7h seguintes.
  deliver_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts         INT         NOT NULL DEFAULT 0,
  last_error       TEXT,
  -- messageId devolvido pela Z-API. NÃO é prova de entrega: instância
  -- desemparelhada devolve 200 com id válido e não entrega.
  provider_message_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ
);

-- O cron varre por (status, deliver_after); sem isto vira seq scan a cada minuto.
CREATE INDEX IF NOT EXISTS outbox_due_idx
  ON outbox (status, deliver_after)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS outbox_org_created_idx ON outbox (org_id, created_at DESC);

-- ── Dedupe de inbound ─────────────────────────────────────────────────────
--
-- A Z-API reentrega webhook em caso de timeout. Sem esta trava, uma resposta
-- lenta vira duas execuções do grafo para a mesma mensagem — e, se houver
-- write, duas escritas.
CREATE TABLE IF NOT EXISTS inbound_seen (
  message_id TEXT PRIMARY KEY,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbound_seen_at_idx ON inbound_seen (seen_at);

-- ── Cache telefone → org ──────────────────────────────────────────────────
--
-- Resolver exige tentar `GET /api/users/by-phone` com o token de CADA org até
-- achar (User.phone é unique global no ImobPro, então há no máximo um match).
-- Sem cache, seriam N chamadas por mensagem.
CREATE TABLE IF NOT EXISTS phone_org_cache (
  phone      TEXT PRIMARY KEY,
  org_id     TEXT,          -- NULL = resolvido como desconhecido (cacheia o negativo)
  user_id    TEXT,
  user_name  TEXT,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Configuração por org ──────────────────────────────────────────────────
--
-- Um service-user e um token do ImobPro por org RE/MAX: o Bearer de lá deriva
-- a org do DONO do token, não há header de org.
CREATE TABLE IF NOT EXISTS org_config (
  org_id        TEXT PRIMARY KEY,
  org_name      TEXT NOT NULL,
  -- Cifrado (AES-256-GCM) com MAX_ENCRYPTION_KEY. Nunca em claro.
  api_token_enc TEXT NOT NULL,
  -- Deixa a porta aberta para número por tenant sem refactor; NULL = número
  -- único do Max.
  zapi_phone_number TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Fatos aprendidos (memória cross-sessão) ───────────────────────────────
--
-- Alternativa deliberada ao LangMem: a extração roda DEPOIS da resposta, então
-- não entra no caminho crítico. Guarda só fato operacional — documento, CPF e
-- afins vivem no ImobPro, atrás de auth.
CREATE TABLE IF NOT EXISTS memory_facts (
  org_id     TEXT NOT NULL,
  phone      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, phone, key)
);
