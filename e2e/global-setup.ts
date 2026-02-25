import { apiRequest } from './setup';
import { SUITE_PREFIX } from './config';

async function deleteAllSessions() {
  try {
    const res = await apiRequest('/api/sessions');
    if (res.ok) {
      const data = await res.json();
      const sessions = data.sessions;
      if (Array.isArray(sessions)) {
        // Only delete sessions with matching prefix (or all if prefix is 'default')
        const toDelete = SUITE_PREFIX === 'default'
          ? sessions
          : sessions.filter((s: { name?: string }) => s.name?.startsWith(SUITE_PREFIX));
        // Delete sequentially with delays and 429 handling
        for (const s of toDelete) {
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

async function deleteAllPresets() {
  try {
    const res = await apiRequest('/api/presets');
    if (res.ok) {
      const data = await res.json();
      const presets = data.presets;
      if (Array.isArray(presets)) {
        for (const p of presets) {
          await apiRequest(`/api/presets/${p.id}`, { method: 'DELETE' }).catch(() => {});
          await new Promise(r => setTimeout(r, 500));
        }
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
