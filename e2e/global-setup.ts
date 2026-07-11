import { apiRequest } from './setup';

async function deleteAllSessions() {
  try {
    const res = await apiRequest('/api/sessions');
    if (res.ok) {
      const data = await res.json();
      const sessions = data.sessions;
      if (Array.isArray(sessions)) {
        // Delete ALL sessions — suites run sequentially so this is safe.
        // Prevents stale sessions from accumulating across runs.
        for (const s of sessions) {
          for (let retry = 0; retry < 3; retry++) {
            try {
              const res = await apiRequest(`/api/sessions/${s.id}`, { method: 'DELETE' });
              if (res.status === 429) {
                await new Promise(r => setTimeout(r, 5000));
                continue;
              }
            } catch { /* ignore */ }
            break;
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
  } catch {
    console.warn('E2E global setup: failed to clean sessions (non-fatal)');
  }
}

export async function setup() {
  await deleteAllSessions();
}

export async function teardown() {
  await deleteAllSessions();
}
