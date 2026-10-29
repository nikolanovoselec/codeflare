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
