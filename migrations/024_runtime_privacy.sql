-- Non-PII tombstone generation fences callbacks captured before erasure.
CREATE TABLE runtime_privacy_epoch (
 person_digest text PRIMARY KEY,
 epoch bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE runtime_task ADD COLUMN person_digest text;
ALTER TABLE runtime_task ADD COLUMN privacy_epoch bigint NOT NULL DEFAULT 0;
CREATE INDEX runtime_task_person ON runtime_task(person_digest);

ALTER TABLE playground_session ADD COLUMN subject_digest text;
ALTER TABLE playground_session ADD COLUMN conversation_id text;
