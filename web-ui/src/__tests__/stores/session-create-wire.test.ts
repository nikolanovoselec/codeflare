import { expect, it, vi } from 'vitest';
import { sessionStore } from '../../stores/session';

it('REQ-GITHUB-327 AC3: POST /api/sessions sends the selected clone repo and Chat surface', async () => {
  const repo = 'team/newest';
  const session = {
    id: 'abcdef0123456789',
    name: 'newest',
    agentType: 'pi',
    createdAt: '2026-03-01T00:00:00Z',
    lastAccessedAt: '2026-03-01T00:00:00Z',
  };
  const requests: Request[] = [];
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(
      input instanceof Request ? input : new URL(input, window.location.href).href,
      init,
    );
    requests.push(request);
    return Response.json({ session }, { status: 201 });
  });

  try {
    const created = await sessionStore.createSession('newest', 'pi', undefined, { repo }, 'chat');

    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST ${window.location.origin}/api/sessions`,
    ]);
    expect(await requests[0].json()).toEqual({
      name: 'newest', agentType: 'pi', clone: { repo }, surface: 'chat',
    });
    expect(created).toMatchObject({ id: session.id, status: 'stopped' });
  } finally {
    fetchMock.mockRestore();
  }
});
