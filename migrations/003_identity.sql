-- Identidade por telefone quando ela é AMBÍGUA.
--
-- O telefone não identifica a imobiliária sozinho. Duas fontes de ambiguidade,
-- ambas legítimas e verificadas no ImobPro:
--
--  1. `OrgMembership` não é única por usuário — o mesmo gerente pode ser membro
--     de duas imobiliárias;
--  2. `SplitRecipient.phone` não tem unique NENHUM — o corretor que trabalha
--     com duas casas está cadastrado nas duas.
--
-- Até aqui o Max percorria as orgs e parava na PRIMEIRA que casasse
-- (`cm.ts::identifyByPhone`), o que fazia o desempate sair da ordem de cadastro.
-- Em produção isso atribuiria um usuário da Fincasa ao RE/MAX Trio, com a
-- persona e a base de conhecimento da imobiliária errada.
--
-- A regra passa a ser: um candidato segue; nenhum é desconhecido; dois ou mais
-- o Max PERGUNTA. Nunca escolhe.

CREATE TABLE IF NOT EXISTS phone_org_choice (
  phone         TEXT PRIMARY KEY,
  -- NULL = perguntamos e ainda não houve resposta. Enquanto for NULL, nada de
  -- negócio é respondido.
  chosen_org_id TEXT,
  -- As orgs oferecidas: [{ orgId, orgName, kind }]. A lista mostrada ao usuário
  -- sai SEMPRE daqui, e só contém orgs onde aquele telefone já está vinculado —
  -- oferecer uma lista aberta transformaria a desambiguação em engenharia
  -- social.
  candidates    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  asked_at      TIMESTAMPTZ,
  chosen_at     TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A escolha é revogável: se a vinculação mudar no ImobPro, ela precisa ser
-- reavaliada em vez de valer para sempre.
CREATE INDEX IF NOT EXISTS phone_org_choice_chosen_idx
  ON phone_org_choice (chosen_at)
  WHERE chosen_org_id IS NOT NULL;

-- O cache antigo guardava UMA org por telefone, o que não representa candidatos
-- múltiplos — um telefone ambíguo era gravado como se fosse resolvido. Some;
-- quem resolve identidade agora é `phone_org_choice` + a varredura por org.
DROP TABLE IF EXISTS phone_org_cache;
