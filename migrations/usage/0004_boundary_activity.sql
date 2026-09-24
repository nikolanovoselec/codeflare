-- Retain the exact Action activity across Stop until its durable cancellation is acknowledged.
ALTER TABLE runtime_sessions ADD COLUMN boundary_activity_id TEXT;
