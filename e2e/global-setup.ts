import { apiRequest } from './setup';

export async function setup() {
  // Clean all sessions before test run
  const res = await apiRequest('/api/sessions');
  if (res.ok) {
    const sessions = await res.json();
    if (Array.isArray(sessions)) {
      await Promise.all(
        sessions.map((s: { id: string }) =>
          apiRequest(`/api/sessions/${s.id}`, { method: 'DELETE' })
        )
      );
    }
  }
}

export async function teardown() {
  // Clean all sessions after test run
  const res = await apiRequest('/api/sessions');
  if (res.ok) {
    const sessions = await res.json();
    if (Array.isArray(sessions)) {
      await Promise.all(
        sessions.map((s: { id: string }) =>
          apiRequest(`/api/sessions/${s.id}`, { method: 'DELETE' })
        )
      );
    }
  }
}
