ALTER TABLE inbound_queue ADD COLUMN dispatch_fence jsonb;
ALTER TABLE outbox ADD COLUMN dispatch_fence jsonb;
CREATE TABLE live_conversation_binding (
 org_id text NOT NULL,
 phone text NOT NULL,
 subject_digest text NOT NULL,
 thread_id text NOT NULL UNIQUE,
 bound_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,phone,subject_digest)
);
