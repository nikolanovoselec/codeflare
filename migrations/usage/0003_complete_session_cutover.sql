UPDATE session_cutover
SET state = 'complete',
    updated_at = CURRENT_TIMESTAMP,
    completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
WHERE id = 1 AND state = 'pending';
