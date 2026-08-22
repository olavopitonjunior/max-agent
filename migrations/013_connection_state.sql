-- Estado da conexão com a Z-API, para a TRANSIÇÃO ser detectável.
--
-- ── Por que existe ────────────────────────────────────────────────────────
--
-- Em 2026-08-04 quatro mensagens reais se perderam porque a instância caiu e
-- ninguém soube. A causa técnica já está corrigida (o outbox e o inbound
-- checam a conexão antes de despachar e represam a fila em vez de mentir
-- "enviado"), mas o AVISO faltava: a fila fica parada em silêncio até alguém
-- abrir o painel.
--
-- Cada execução de cron é amnésica. Sem estado gravado, só dá para alertar por
-- ESTADO — e alertar por estado, com o cron rodando a cada minuto, são 1.440
-- e-mails por dia. É esta tabela que torna "caiu agora" distinguível de
-- "continua caído".
--
-- ── Uma linha, e por quê ──────────────────────────────────────────────────
--
-- A instância Z-API é UMA, compartilhada pelos três tenants RE/MAX (uma
-- instância = um número). Não há o que particionar por org. O `id bool` com
-- CHECK torna isso estrutural em vez de convenção: a segunda linha é
-- impossível de inserir, então nenhum código precisa lembrar de filtrar.
--
-- ── Sem semeadura, de propósito ───────────────────────────────────────────
--
-- Um INSERT aqui com `connected = true` afirmaria um estado que ninguém
-- observou. A primeira observação insere a linha com o que ela viu de verdade.

CREATE TABLE IF NOT EXISTS connection_state (
  id           bool        PRIMARY KEY DEFAULT true CHECK (id),
  connected    bool        NOT NULL,
  -- Quando entrou no estado ATUAL.
  changed_at   timestamptz NOT NULL DEFAULT now(),
  -- Quando caiu. Sobrevive à volta, porque é dele que sai o "ficou fora por
  -- 2h13m" do e-mail de reconexão — `changed_at` já terá sido sobrescrito
  -- pela transição de volta quando esse e-mail for montado.
  down_since   timestamptz,
  -- INVARIANTE: true = "já anunciei uma queda cuja volta eu ainda não
  -- anunciei". É o que dá retry de graça — o carimbo só acontece quando o
  -- e-mail SAI, então um POST que falha é reenviado na passada seguinte, sem
  -- fila nova e sem código de retry. E é o que impede o e-mail de reconexão
  -- de anunciar a volta de uma queda que ninguém soube que houve.
  alerted_down bool        NOT NULL DEFAULT false,
  -- "Houve uma queda que o debounce segurou e que ninguém ainda soube."
  --
  -- Sem isto existe um buraco: queda → volta → queda de novo dentro da janela
  -- de 1h (segurada pelo debounce) → volta de novo. Como `alerted_down` nunca
  -- chegou a ser marcado, o alerta de reconexão também não sai — e uma queda
  -- inteira, com a fila represada e o inbound morto, não é anunciada a
  -- ninguém. Com a marca, a reconexão avisa que houve queda e quanto tempo
  -- durou: uma mensagem em vez de duas, mas nunca zero.
  queda_pendente bool      NOT NULL DEFAULT false,
  -- Último e-mail que SAIU (qualquer um dos dois). Base do debounce de 1h
  -- contra flapping: cai/volta/cai em dez minutos manda um e-mail, não três.
  notified_at  timestamptz,
  -- Passadas do CRON discordando do estado gravado. O push da Z-API age na
  -- primeira (o callback É o evento); o cron exige duas, porque uma leitura
  -- solitária discordando pode ser hiccup da API — e um alerta falso ensina
  -- quem recebe a ignorar o verdadeiro.
  miss_streak  int         NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
