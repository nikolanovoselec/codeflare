import { describe, it, expect, afterEach } from 'vitest';
import { apiRequest } from '../setup';

describe('Sessions API', () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    for (const id of createdIds) {
      await apiRequest(`/api/sessions/${id}`, { method: 'DELETE' });
    }
    createdIds.length = 0;
  });

  it('GET /api/sessions returns sessions array', async () => {
    const res = await apiRequest('/api/sessions');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.sessions).toBeDefined();
    expect(Array.isArray(data.sessions)).toBe(true);
  });

  it('POST /api/sessions with empty body creates Terminal session', async () => {
    const res = await apiRequest('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    const session = data.session;
    expect(session.name).toBe('Terminal');
    expect(session.id).toBeDefined();
    expect(session.createdAt).toBeDefined();
    createdIds.push(session.id);
  });

  it('POST /api/sessions with custom name uses that name', async () => {
    const res = await apiRequest('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My Test Session' }),
    });
    const data = await res.json();
    expect(data.session.name).toBe('My Test Session');
    createdIds.push(data.session.id);
  });

  it('POST /api/sessions with agentType sets agent type', async () => {
    const res = await apiRequest('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'bash' }),
    });
    const data = await res.json();
    expect(data.session.agentType).toBe('bash');
    createdIds.push(data.session.id);
  });

  it('GET /api/sessions/:id returns specific session', async () => {
    const createRes = await apiRequest('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Fetch Test' }),
    });
    const created = await createRes.json();
    createdIds.push(created.session.id);

    const res = await apiRequest(`/api/sessions/${created.session.id}`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.session.id).toBe(created.session.id);
    expect(data.session.name).toBe('Fetch Test');
  });

  it('PATCH /api/sessions/:id renames session', async () => {
    const createRes = await apiRequest('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Before Rename' }),
    });
    const created = await createRes.json();
    createdIds.push(created.session.id);

    const patchRes = await apiRequest(`/api/sessions/${created.session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'After Rename' }),
    });
    expect(patchRes.ok).toBe(true);

    const getRes = await apiRequest(`/api/sessions/${created.session.id}`);
    const data = await getRes.json();
    expect(data.session.name).toBe('After Rename');
  });

  it('DELETE /api/sessions/:id removes session', async () => {
    const createRes = await apiRequest('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const created = await createRes.json();

    const deleteRes = await apiRequest(`/api/sessions/${created.session.id}`, { method: 'DELETE' });
    expect(deleteRes.ok).toBe(true);

    const getRes = await apiRequest(`/api/sessions/${created.session.id}`);
    expect(getRes.status).toBe(404);
  });

  it('DELETE nonexistent session returns 404', async () => {
    const res = await apiRequest('/api/sessions/nonexistent999', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('GET /api/sessions/batch-status returns statuses and maxSessions', { retry: 2 }, async () => {
    const res = await apiRequest('/api/sessions/batch-status');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.statuses).toBeDefined();
    expect(data.maxSessions).toBeGreaterThan(0);
  });

  it('POST /api/sessions/:id/touch returns 200', async () => {
    const createRes = await apiRequest('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const created = await createRes.json();
    createdIds.push(created.session.id);

    const touchRes = await apiRequest(`/api/sessions/${created.session.id}/touch`, { method: 'POST' });
    expect(touchRes.ok).toBe(true);
  });
});
