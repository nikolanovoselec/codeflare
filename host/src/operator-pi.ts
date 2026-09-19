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
  tasks: Record<string, { digest: string; mode: 'prompt' | 'follow-up' | 'steer' | 'tool'; status: string }>;
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
  executeTool(input: { toolCallId: string; name: string; arguments: Record<string, unknown>; signal: AbortSignal }): Promise<void>;
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

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const EVENT_LIMIT = 1024;
const EVENT_BYTES = 1024 * 1024;
const PAGE_LIMIT = 100;
const PAGE_BYTES = 64 * 1024;

interface SequencedEvent { sequence: number; event: unknown; bytes: number }

type OperatorPiTaskInput = { taskId: string; digest: string } & (
  { mode: 'prompt' | 'follow-up' | 'steer'; text: string }
  | { mode: 'tool'; toolName: string; arguments: Record<string, unknown> }
);

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class OperatorPiConversation {
  private readonly activityId: string;
  private readonly sessionId: string;
  private readonly store: OperatorPiStore;
  private readonly factory: OperatorPiFactory;
  private session: OperatorPiSession | null = null;
  private metadata: OperatorPiMetadata | null = null;
  private unsubscribe: (() => void) | null = null;
  private events: SequencedEvent[] = [];
  private eventBytes = 0;
  private nextSequence = 1;
  private activePrompt: Promise<void> | null = null;
  private activeToolAbort: AbortController | null = null;
  private pendingFollowUp = false;
  private pendingSteer = false;
  private saveChain: Promise<void> = Promise.resolve();
  private ensureInFlight: Promise<{ conversationId: string; sessionFile: string }> | null = null;
  private admissionChain: Promise<void> = Promise.resolve();

  constructor(options: { activityId: string; sessionId: string; store: OperatorPiStore; factory: OperatorPiFactory }) {
    if (!ID.test(options.activityId) || !ID.test(options.sessionId)) throw new Error('Invalid owned Pi identity');
    this.activityId = options.activityId;
    this.sessionId = options.sessionId;
    this.store = options.store;
    this.factory = options.factory;
  }

  /** Create once or reopen only the persisted file and conversation identity. */
  async ensure(): Promise<{ conversationId: string; sessionFile: string }> {
    if (this.session && this.metadata) return this.identity();
    if (!this.ensureInFlight) {
      this.ensureInFlight = this.initialize().finally(() => { this.ensureInFlight = null; });
    }
    return this.ensureInFlight;
  }

  private async initialize(): Promise<{ conversationId: string; sessionFile: string }> {
    const stored = await this.store.load();
    let session: OperatorPiSession;
    if (stored) {
      if (stored.schemaVersion !== 1 || stored.activityId !== this.activityId || stored.sessionId !== this.sessionId
        || !stored.sessionFile || !stored.conversationId) throw new Error('Owned Pi metadata mismatch');
      session = await this.factory.open(stored.sessionFile);
      if (session.sessionId !== stored.conversationId || session.sessionFile !== stored.sessionFile) {
        session.dispose();
        throw new Error('Owned Pi conversation is lost; replacement is forbidden');
      }
      this.metadata = structuredClone(stored);
    } else {
      session = await this.factory.create();
      if (!session.sessionId || !session.sessionFile) {
        session.dispose();
        throw new Error('Owned Pi conversation identity unavailable');
      }
      this.metadata = { schemaVersion: 1, activityId: this.activityId, sessionId: this.sessionId,
        conversationId: session.sessionId, sessionFile: session.sessionFile, tasks: {} };
      await this.persist();
    }
    this.session = session;
    this.unsubscribe = session.subscribe(event => this.captureEvent(event));
    return this.identity();
  }

  /** Persist stable intent before invoking the SDK; same ID/digest only reconciles. */
  async send(input: OperatorPiTaskInput): Promise<{ status: string }> {
    const payload = input.mode === 'tool' ? JSON.stringify(input.arguments) : input.text;
    if (!ID.test(input.taskId) || !DIGEST.test(input.digest)
      || (input.mode === 'tool' && (!ID.test(input.toolName) || !plain(input.arguments)))
      || (input.mode !== 'tool' && !input.text.trim())
      || new TextEncoder().encode(payload).byteLength > 32 * 1024) throw new Error('Invalid Pi task');
    return this.admit(() => this.sendAdmitted(input));
  }

  private async sendAdmitted(input: OperatorPiTaskInput): Promise<{ status: string }> {
    await this.ensure();
    const metadata = this.metadata!;
    const existing = metadata.tasks[input.taskId];
    if (existing) {
      if (existing.digest !== input.digest || existing.mode !== input.mode) throw new Error('Pi task conflict');
      return { status: existing.status };
    }
    const active = this.activePrompt !== null || this.session!.isStreaming;
    if ((input.mode === 'prompt' || input.mode === 'tool') && active) throw new Error('Pi conversation is busy');
    if (input.mode === 'follow-up' && !active) throw new Error('Follow-up requires an active run');
    if (input.mode === 'steer' && !active) throw new Error('Steering requires an active run');
    if (input.mode === 'follow-up' && this.pendingFollowUp) throw new Error('Pi follow-up queue is full');
    if (input.mode === 'steer' && this.pendingSteer) throw new Error('Pi steering input is pending');

    const status = input.mode === 'prompt' || input.mode === 'tool'
      ? 'running' : input.mode === 'follow-up' ? 'queued' : 'accepted';
    metadata.tasks[input.taskId] = { digest: input.digest, mode: input.mode, status };
    await this.persist();
    if (input.mode === 'prompt' || input.mode === 'tool') {
      let operation: Promise<void>;
      try {
        if (input.mode === 'tool') {
          this.activeToolAbort = new AbortController();
          operation = this.session!.executeTool({ toolCallId: input.taskId, name: input.toolName,
            arguments: input.arguments, signal: this.activeToolAbort.signal });
        } else operation = this.session!.prompt(input.text);
      } catch (error) {
        this.activeToolAbort = null;
        metadata.tasks[input.taskId].status = 'failed';
        await this.persist();
        throw error;
      }
      this.activePrompt = this.settlePrompt(input.taskId, operation);
    } else if (input.mode === 'follow-up') {
      this.pendingFollowUp = true;
      try { await this.session!.followUp(input.text); }
      catch (error) { this.pendingFollowUp = false; metadata.tasks[input.taskId].status = 'failed'; await this.persist(); throw error; }
    } else {
      this.pendingSteer = true;
      try { await this.session!.steer(input.text); }
      catch (error) { this.pendingSteer = false; metadata.tasks[input.taskId].status = 'failed'; await this.persist(); throw error; }
    }
    return { status };
  }

  /** Cursor pages are bounded independently from the bounded in-memory event buffer. */
  observe(cursor = 0): { events: Array<{ sequence: number; event: unknown }>; nextCursor: number; gap: boolean } {
    const oldest = this.events[0]?.sequence ?? this.nextSequence;
    const gap = cursor < oldest - 1;
    const selected: Array<{ sequence: number; event: unknown }> = [];
    let bytes = 0;
    for (const entry of this.events) {
      if (entry.sequence <= cursor) continue;
      if (selected.length >= PAGE_LIMIT || bytes + entry.bytes > PAGE_BYTES) break;
      selected.push({ sequence: entry.sequence, event: entry.event });
      bytes += entry.bytes;
    }
    return { events: selected, nextCursor: selected.at(-1)?.sequence ?? Math.max(cursor, oldest - 1), gap };
  }

  /** Await SDK cancellation and current prompt settlement before recording cancellation. */
  async abort(taskId: string): Promise<{ status: string }> {
    if (!ID.test(taskId)) throw new Error('Invalid Pi task');
    await this.ensure();
    const task = this.metadata!.tasks[taskId];
    if (!task) throw new Error('Pi task not found');
    if (task.status === 'cancelled') return { status: 'cancelled' };
    this.activeToolAbort?.abort();
    await this.session!.abort();
    if (this.activePrompt) await this.activePrompt;
    task.status = 'cancelled';
    await this.persist();
    return { status: 'cancelled' };
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session?.dispose();
    this.session = null;
  }

  private async admit<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.admissionChain;
    let release!: () => void;
    this.admissionChain = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  private identity(): { conversationId: string; sessionFile: string } {
    return { conversationId: this.metadata!.conversationId, sessionFile: this.metadata!.sessionFile };
  }

  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.metadata!);
    this.saveChain = this.saveChain.then(() => this.store.save(snapshot));
    await this.saveChain;
  }

  private async settlePrompt(taskId: string, operation: Promise<void>): Promise<void> {
    try {
      await operation;
      const task = this.metadata?.tasks[taskId];
      if (task && task.status === 'running') task.status = 'completed';
    } catch {
      const task = this.metadata?.tasks[taskId];
      if (task && task.status === 'running') task.status = 'failed';
    } finally {
      this.pendingFollowUp = false;
      this.pendingSteer = false;
      this.activeToolAbort = null;
      this.activePrompt = null;
      await this.persist();
    }
  }

  private captureEvent(event: unknown): void {
    let bytes: number;
    try { bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength; }
    catch { return; }
    if (bytes > PAGE_BYTES) return;
    this.events.push({ sequence: this.nextSequence++, event, bytes });
    this.eventBytes += bytes;
    while (this.events.length > EVENT_LIMIT || this.eventBytes > EVENT_BYTES) {
      this.eventBytes -= this.events.shift()!.bytes;
    }
  }
}
