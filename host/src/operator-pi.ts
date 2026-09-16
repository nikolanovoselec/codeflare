/**
 * Owned structured Pi conversation adapter for restricted operator sessions.
 *
 * This module sits beside the PTY SessionManager; it neither renders terminals
 * nor discovers candidate resources. The caller binds activity/session ownership,
 * approved SDK resources and durable metadata. Stable task IDs reconcile accepted
 * work; uncertain effects are never turned into a fresh prompt automatically.
 */

export interface OperatorPiMetadata {
  schemaVersion: 1;
  activityId: string;
  sessionId: string;
  conversationId: string;
  sessionFile: string;
  tasks: Record<string, { digest: string; mode: 'prompt' | 'follow-up' | 'steer'; status: string }>;
}

export interface OperatorPiStore {
  load(): Promise<OperatorPiMetadata | null>;
  save(metadata: OperatorPiMetadata): Promise<void>;
}

export interface OperatorPiSession {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly isStreaming: boolean;
  prompt(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
}

export interface OperatorPiFactory {
  create(): Promise<OperatorPiSession>;
  open(sessionFile: string): Promise<OperatorPiSession>;
}

export class OperatorPiConversation {
  constructor(_options: { activityId: string; sessionId: string; store: OperatorPiStore; factory: OperatorPiFactory }) {}
  async ensure(): Promise<{ conversationId: string; sessionFile: string }> { throw new Error('Not implemented'); }
  async send(_input: { taskId: string; digest: string; text: string; mode: 'prompt' | 'follow-up' | 'steer' }): Promise<{ status: string }> {
    throw new Error('Not implemented');
  }
  observe(_cursor = 0): { events: Array<{ sequence: number; event: unknown }>; nextCursor: number; gap: boolean } {
    throw new Error('Not implemented');
  }
  async abort(_taskId: string): Promise<{ status: string }> { throw new Error('Not implemented'); }
  dispose(): void {}
}
