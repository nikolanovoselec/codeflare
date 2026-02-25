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
    console.warn('E2E global setup: failed to clean sessions (non-fatal)');
  }
}

async function deleteAllPresets() {
  try {
    const res = await apiRequest('/api/presets');
    if (res.ok) {
      const data = await res.json();
      const presets = data.presets;
      if (Array.isArray(presets)) {
        await Promise.all(
          presets.map((p: { id: string }) =>
            apiRequest(`/api/presets/${p.id}`, { method: 'DELETE' }).catch(() => {})
          )
        );
      }
    }
  } catch {
    console.warn('E2E global setup: failed to clean presets (non-fatal)');
  }
}

export async function setup() {
  await deleteAllSessions();
  await deleteAllPresets();
}

export async function teardown() {
  await deleteAllSessions();
  await deleteAllPresets();
}
