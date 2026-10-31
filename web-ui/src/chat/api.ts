export interface AttachedChatSession {
  /** Bound upstream primary identity, selected by the Host, never by the UI. */
  sessionId: string;
  generation: number;
}

export class ChatAttachError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'ChatAttachError'; }
}

/** Shared explicit primary-entry handshake for Chat and late Terminal entry.
 * Does not open a socket, select a surface, or retain any process/draft state.
 */
export async function attachChatSession(sessionId: string, generation: number, signal?: AbortSignal): Promise<AttachedChatSession> {
  if (!sessionId || !Number.isSafeInteger(generation) || generation < 0) throw new ChatAttachError('Invalid Chat session generation.');
  const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/attach`, {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generation }),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error : `Unable to attach Chat (HTTP ${response.status}).`;
    throw new ChatAttachError(message, response.status);
  }
  const attached: unknown = await response.json();
  if (!attached || typeof attached !== 'object' || !('sessionId' in attached) || typeof attached.sessionId !== 'string'
    || !attached.sessionId.trim() || !('generation' in attached) || attached.generation !== generation) {
    throw new ChatAttachError('Chat binding generation is stale or invalid. Re-enter Chat.');
  }
  return { sessionId: attached.sessionId, generation };
}

/** Protected, no-wake metadata. Missing support never upgrades the old runtime. */
export async function probeChatControls(sessionId: string, generation: number, signal?: AbortSignal): Promise<boolean> {
  const url = new URL(`/api/chat/${encodeURIComponent(sessionId)}/api/capabilities`, window.location.origin);
  url.searchParams.set('generation', String(generation));
  let response: Response;
  try { response = await fetch(url, { credentials: 'same-origin', signal }); }
  catch (cause) {
    if (signal?.aborted) throw cause;
    return false;
  }
  if (signal?.aborted) throw new DOMException('Chat probe cancelled.', 'AbortError');
  if (response.status === 404 || response.status === 503) return false;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error : `Unable to check Chat controls (HTTP ${response.status}).`;
    throw new ChatAttachError(message, response.status);
  }
  return !!body && typeof body === 'object' && 'success' in body && body.success === true
    && 'data' in body && !!body.data && typeof body.data === 'object'
    && 'controls' in body.data && body.data.controls === true;
}

/** Private owner transport: never changes global fetch or Dashboard's API base. */
export function createChatControlApi(sessionId: string, generation: number, onAuthError?: (message: string) => void) {
  const base = `/api/chat/${encodeURIComponent(sessionId)}`;
  const request = async <T>(path: string, init?: RequestInit, signal?: AbortSignal): Promise<T> => {
    if (!path.startsWith('/api/')) throw new Error('Invalid Chat control road.');
    const url = new URL(`${base}${path}`, window.location.origin);
    url.searchParams.set('generation', String(generation));
    const response = await fetch(url, {
      ...init, signal, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (!signal?.aborted && (response.status === 401 || response.status === 403)) onAuthError?.('Chat authorization is unavailable. Sign in or re-enter Chat.');
      const error = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : `Chat action failed (HTTP ${response.status}).`;
      throw new ChatAttachError(error, response.status);
    }
    return body as T;
  };
  return {
    request,
    async envelope<T>(path: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
      const body = await request<{ success: boolean; data: T }>(path, init, signal);
      if (!body || body.success !== true || !('data' in body)) throw new Error('Invalid Chat control response.');
      return body.data;
    },
  };
}
export type ChatControlApi = ReturnType<typeof createChatControlApi>;
