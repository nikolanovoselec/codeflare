import { apiRequest } from './setup';

async function deleteAllSessions() {
  try {
    const res = await apiRequest('/api/sessions');
    if (res.ok) {
      const data = await res.json();
      const sessions = data.sessions;
      if (Array.isArray(sessions)) {
        await Promise.all(
          sessions.map((s: { id: string }) =>
            apiRequest(`/api/sessions/${s.id}`, { method: 'DELETE' }).catch(() => {})
          )
        );
      }
    }
  } catch {
    // Cleanup is best-effort — don't fail the test run
    console.warn('E2E global setup: failed to clean sessions (non-fatal)');
  }
}

export async function setup() {
  await deleteAllSessions();
}

export async function teardown() {
  await deleteAllSessions();
}
