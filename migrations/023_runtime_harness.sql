ALTER TABLE conversation_control ADD COLUMN reason text NOT NULL DEFAULT 'requested';
ALTER TABLE conversation_control ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE inbound_queue ADD COLUMN control_org_id text;
ALTER TABLE inbound_queue ADD COLUMN control_version integer;
CREATE TABLE playground_message (
 id uuid PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES playground_session(id) ON DELETE CASCADE,
 task_id uuid NOT NULL REFERENCES runtime_task(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('user','assistant')),
 text text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX playground_message_session ON playground_message(session_id,created_at);
