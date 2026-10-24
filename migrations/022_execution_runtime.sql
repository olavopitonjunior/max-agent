-- Receptor inerte: MAX_RUNTIME_V1 / MAX_HANDOFF / MAX_MARKETING permanecem OFF.
CREATE TABLE runtime_task (
 id uuid PRIMARY KEY,
 org_id text NOT NULL,
 conversation_id text NOT NULL,
 subject_digest text NOT NULL,
 workflow_version text NOT NULL,
 mode text NOT NULL CHECK (mode IN ('live','simulation','staging')),
 state text NOT NULL CHECK (state IN ('queued','running','waiting_input','waiting_approval','succeeded','failed','cancelled','unknown')),
 lease_until timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runtime_task_org_state ON runtime_task(org_id,state,updated_at);
CREATE TABLE execution_intent (
 id uuid PRIMARY KEY,
 task_id uuid NOT NULL REFERENCES runtime_task(id) ON DELETE CASCADE,
 org_id text NOT NULL,
 idempotency_key text NOT NULL,
 verb text NOT NULL,
 content_digest text NOT NULL,
 subject_digest text NOT NULL,
 state text NOT NULL CHECK (state IN ('running','succeeded','failed','unknown','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,verb,idempotency_key)
);
CREATE TABLE runtime_event (
 id uuid PRIMARY KEY,
 task_id uuid NOT NULL REFERENCES runtime_task(id) ON DELETE CASCADE,
 org_id text NOT NULL,
 kind text NOT NULL,
 name text NOT NULL,
 at timestamptz NOT NULL,
 data jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX runtime_event_task ON runtime_event(org_id,task_id,at);
CREATE TABLE conversation_control (
 org_id text NOT NULL,
 phone text NOT NULL,
 state text NOT NULL DEFAULT 'bot' CHECK (state IN ('bot','waiting_human','human')),
 owner_id text,
 control_version integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,phone),
 CHECK ((state='human' AND owner_id IS NOT NULL) OR (state!='human' AND owner_id IS NULL))
);
CREATE TABLE handoff_send (
 org_id text NOT NULL,
 request_id uuid NOT NULL,
 phone text NOT NULL,
 actor_id text NOT NULL,
 content_digest text NOT NULL,
 control_version integer NOT NULL,
 state text NOT NULL CHECK (state IN ('running','succeeded','unknown')),
 provider_message_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,request_id)
);
CREATE TABLE playground_session (
 id uuid PRIMARY KEY,
 org_id text NOT NULL,
 phone_digest text NOT NULL,
 mode text NOT NULL CHECK(mode IN ('simulation','staging')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
