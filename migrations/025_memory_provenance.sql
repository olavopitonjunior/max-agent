-- Add provenance without assigning historical preferences to a possibly reassigned phone.
-- NULL means legacy/unknown provenance; runtime reads require an exact subject digest.
ALTER TABLE memory_facts ADD COLUMN source_task_id uuid;
ALTER TABLE memory_facts ADD COLUMN workflow_version text;
ALTER TABLE memory_facts ADD COLUMN subject_digest text;
CREATE INDEX memory_facts_subject ON memory_facts(org_id,phone,subject_digest,updated_at DESC);
