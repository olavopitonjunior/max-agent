-- Por que caiu, e há quanto tempo o cron não consegue perguntar.
--
-- ── Por que existe ────────────────────────────────────────────────────────
--
-- Em 2026-09-10 a assinatura da Z-API foi cancelada por cobrança recusada e o
-- `/status` passou a responder 400 "must subscribe". Isso era exceção, e
-- exceção não observava nada: dois dias sem e-mail, com o outbox queimando
-- tentativas e o inbound mudo. A correção distingue três formas de "caiu"
-- (sessão, inoperância com motivo, cegueira) — e as duas novas precisam de
-- estado, pelo mesmo motivo da tabela inteira: cada passada do cron é
-- amnésica.
--
-- ── `motivo` ──────────────────────────────────────────────────────────────
--
-- A causa da QUEDA ATUAL, gravada na transição para baixo e apagada na volta.
-- É daqui que o e-mail tira o conselho ("cartão", "token", "cego" ou "QR"),
-- e não da passada que por acaso reenvia um alerta que falhou — senão um
-- timeout no minuto da retentativa mandaria "inacessível" para uma
-- assinatura cancelada. Vale `assinatura | credencial | inacessivel`; NULL é
-- queda de sessão comum (ou conectada).
--
-- ── `blind_streak` ────────────────────────────────────────────────────────
--
-- Passadas SEGUIDAS em que o cron não conseguiu consultar a Z-API (timeout,
-- 5xx, formato desconhecido). Separado de `miss_streak` de propósito: uma
-- leitura cega não afirma nada, então não pode avançar nem zerar a
-- confirmação de uma leitura definitiva — um timeout no meio de uma
-- reconexão em curso reiniciaria a contagem para sempre, e catorze timeouts
-- seguidos de um único `connected:false` decretariam a queda com uma leitura
-- só. Quinze cegas seguidas viram queda com motivo `inacessivel`.
--
-- Aditiva, com default: o código anterior ignora as duas colunas, então a
-- migration pode (e deve) rodar em produção ANTES do deploy.

ALTER TABLE connection_state
  ADD COLUMN IF NOT EXISTS motivo       text,
  ADD COLUMN IF NOT EXISTS blind_streak int NOT NULL DEFAULT 0;
