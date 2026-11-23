-- Keep shutdown progress independent of formal runtime termination authority.
ALTER TABLE runtime_sessions ADD COLUMN shutdown_json TEXT;
ALTER TABLE runtime_sessions ADD COLUMN shutdown_order INTEGER;
ALTER TABLE runtime_sessions ADD COLUMN hermes_merged_snapshot TEXT;
CREATE INDEX runtime_sessions_shutdown_order ON runtime_sessions(owner_key, shutdown_order) WHERE shutdown_order IS NOT NULL;
