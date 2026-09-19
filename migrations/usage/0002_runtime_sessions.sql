CREATE TABLE runtime_sessions (
  owner_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  agent_type TEXT,
  workspace TEXT NOT NULL CHECK (workspace IN ('terminal', 'vscode')),
  terminal_mode TEXT NOT NULL CHECK (terminal_mode IN ('classic', 'herdr')),
  tab_config_json TEXT,
  clone_json TEXT,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('stopped', 'starting', 'running', 'unreachable', 'stopping')),
  lifecycle_generation INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle_generation >= 0),
  response_revision INTEGER NOT NULL DEFAULT 0 CHECK (response_revision >= 0),
  observation_sequence INTEGER NOT NULL DEFAULT -1 CHECK (observation_sequence >= -1),
  last_started_at TEXT,
  last_active_at TEXT,
  transitioned_at TEXT NOT NULL,
  lifecycle_reason TEXT,
  editor_ready INTEGER NOT NULL DEFAULT 0 CHECK (editor_ready IN (0, 1)),
  editor_ready_error INTEGER NOT NULL DEFAULT 0 CHECK (editor_ready_error IN (0, 1)),
  readiness_observed_at TEXT,
  cpu TEXT,
  memory TEXT,
  disk TEXT,
  sync_status TEXT,
  metrics_observed_at TEXT,
  last_input_at TEXT,
  unreachable_incident_id TEXT,
  unreachable_first_observed_at TEXT,
  unreachable_deadline_ms INTEGER,
  termination_intent_id TEXT,
  termination_generation INTEGER CHECK (termination_generation IS NULL OR termination_generation >= 0),
  termination_claimed_at TEXT,
  termination_signal_accepted_at TEXT,
  PRIMARY KEY (owner_key, session_id),
  CHECK ((unreachable_incident_id IS NULL AND unreachable_first_observed_at IS NULL AND unreachable_deadline_ms IS NULL)
      OR (unreachable_incident_id IS NOT NULL AND unreachable_first_observed_at IS NOT NULL AND unreachable_deadline_ms IS NOT NULL)),
  CHECK ((termination_intent_id IS NULL AND termination_generation IS NULL AND termination_claimed_at IS NULL)
      OR (termination_intent_id IS NOT NULL AND termination_generation IS NOT NULL AND termination_claimed_at IS NOT NULL))
);

CREATE INDEX runtime_sessions_owner_activity
  ON runtime_sessions (owner_key, last_accessed_at, session_id);

CREATE TABLE session_cutover (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'complete')),
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

INSERT INTO session_cutover (id, state, updated_at, completed_at)
VALUES (1, 'pending', CURRENT_TIMESTAMP, NULL);
