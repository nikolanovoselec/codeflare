import { randomBytes } from 'node:crypto';

export type AgentEventKind = 'input-required' | 'task-completed' | 'task-failed';
export type AgentEventState =
  | 'pending'
  | 'awaiting-display-confirmation'
  | 'eligible'
  | 'drained'
  | 'cancelled';
export type AgentEventDisposition = 'suppress' | 'display-request';
export type AgentEventClient = object;

export interface HostAgentEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly kind: AgentEventKind;
  readonly createdAt: number;
}

export interface QueuedAgentEvent extends HostAgentEvent {
  state: AgentEventState;
}

export type AgentEventAction =
  | { readonly type: 'announce'; readonly event: HostAgentEvent; readonly clients: readonly AgentEventClient[] }
  | { readonly type: 'grant-display'; readonly eventId: string; readonly kind: AgentEventKind; readonly client: AgentEventClient }
  | { readonly type: 'cancel-display'; readonly eventId: string; readonly clients: readonly AgentEventClient[] };

export interface AgentEventResult {
  readonly accepted: boolean;
  readonly actions: readonly AgentEventAction[];
}

export interface AgentEventDrainResult {
  readonly hostNow: number;
  readonly events: readonly HostAgentEvent[];
}

export const AGENT_EVENT_LIMITS = Object.freeze({
  queueMax: 16,
  clientDispositionWindowMs: 5_000,
  displayConfirmationWindowMs: 5_000,
  eventMaxAgeMs: 15 * 60_000,
  drainMax: 8,
  maxFrameBytes: 512,
});

export const AGENT_EVENT_FRAMES = Object.freeze({
  piInputRequired: '\x1b]777;notify;Pi;Agent needs your input\x07',
  piTaskCompleted: '\x1b]777;notify;Pi;Ready for input\x07',
  piTaskFailed: '\x1b]777;notify;Pi;Task failed\x07',
  claudeInputRequired: '\x1b]777;notify;Claude Code;Claude needs your permission\x07',
});

const AGENT_EVENT_KINDS_BY_FRAME = new Map<string, AgentEventKind>([
  [AGENT_EVENT_FRAMES.piInputRequired, 'input-required'],
  [AGENT_EVENT_FRAMES.piTaskCompleted, 'task-completed'],
  [AGENT_EVENT_FRAMES.piTaskFailed, 'task-failed'],
  [AGENT_EVENT_FRAMES.claudeInputRequired, 'input-required'],
]);

/**
 * Scans an output stream without consuming or rewriting the caller's bytes.
 * Only the bounded, private OSC candidate is retained between pushes.
 */
export class OscAgentEventParser {
  private frame = '';
  private frameBytes = 0;
  private inOsc = false;
  private droppingOversizedOsc = false;
  private previousWasEscape = false;

  push(chunk: string): AgentEventKind[] {
    const kinds: AgentEventKind[] = [];

    for (const char of chunk) {
      if (this.droppingOversizedOsc) {
        if (char === '\x07' || (this.previousWasEscape && char === '\\')) {
          this.reset();
        } else {
          this.previousWasEscape = char === '\x1b';
        }
        continue;
      }

      if (!this.inOsc) {
        if (this.frame === '\x1b') {
          if (char === ']') {
            this.inOsc = true;
            this.frame += char;
            this.frameBytes += 1;
          } else {
            this.frame = char === '\x1b' ? '\x1b' : '';
            this.frameBytes = this.frame.length;
          }
        } else if (char === '\x1b') {
          this.frame = char;
          this.frameBytes = 1;
        }
        continue;
      }

      this.frame += char;
      this.frameBytes += Buffer.byteLength(char, 'utf8');
      const terminated = char === '\x07' || (this.previousWasEscape && char === '\\');

      if (this.frameBytes > AGENT_EVENT_LIMITS.maxFrameBytes) {
        this.frame = '';
        this.frameBytes = 0;
        this.inOsc = false;
        this.droppingOversizedOsc = !terminated;
        this.previousWasEscape = false;
        continue;
      }

      this.previousWasEscape = char === '\x1b';
      if (!terminated) continue;

      const kind = AGENT_EVENT_KINDS_BY_FRAME.get(this.frame);
      if (kind !== undefined) kinds.push(kind);
      this.reset();
    }

    return kinds;
  }

  private reset(): void {
    this.frame = '';
    this.frameBytes = 0;
    this.inOsc = false;
    this.droppingOversizedOsc = false;
    this.previousWasEscape = false;
  }
}

export interface AgentEventQueueOptions {
  readonly now?: () => number;
  readonly createEventId?: () => string;
}

interface AgentEventRecord {
  readonly event: QueuedAgentEvent;
  readonly clients: AgentEventClient[];
  readonly dispositions: Map<AgentEventClient, AgentEventDisposition>;
  confirmationDeadline?: number;
  grantedClient?: AgentEventClient;
}

const AGENT_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export class AgentEventQueue {
  private readonly events = new Map<string, AgentEventRecord>();
  private readonly now: () => number;
  private readonly createEventId: () => string;
  droppedCount = 0;

  constructor(options: AgentEventQueueOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createEventId = options.createEventId
      ?? (() => randomBytes(18).toString('base64url'));
  }

  get size(): number {
    return this.events.size;
  }

  get(eventId: string): QueuedAgentEvent | undefined {
    return this.events.get(eventId)?.event;
  }

  enqueue(kind: AgentEventKind, clients: readonly AgentEventClient[]): {
    readonly event: QueuedAgentEvent;
    readonly actions: readonly AgentEventAction[];
  } {
    const createdAt = this.now();
    const actions = [...this.advance(createdAt)];
    const snapshot = [...new Set(clients)];
    const event: QueuedAgentEvent = {
      schemaVersion: 1,
      eventId: this.nextEventId(),
      kind,
      createdAt,
      state: snapshot.length === 0 ? 'eligible' : 'pending',
    };

    if (this.events.size >= AGENT_EVENT_LIMITS.queueMax) {
      const oldest = this.events.entries().next().value as [string, AgentEventRecord] | undefined;
      if (oldest !== undefined) {
        const [oldestId, oldestRecord] = oldest;
        this.events.delete(oldestId);
        this.droppedCount += 1;
        if (oldestRecord.event.state !== 'cancelled') {
          const cancellation = this.cancelAction(oldestRecord);
          if (cancellation !== undefined) actions.push(cancellation);
        }
      }
    }

    const record: AgentEventRecord = {
      event,
      clients: snapshot,
      dispositions: new Map(),
    };
    this.events.set(event.eventId, record);
    if (snapshot.length > 0) {
      actions.push({ type: 'announce', event: this.hostEvent(event), clients: snapshot });
    }
    return { event, actions };
  }

  reconcileClient(client: AgentEventClient): AgentEventResult {
    const actions = [...this.advance(this.now())];
    let accepted = false;

    for (const record of this.events.values()) {
      if (record.event.state === 'cancelled' || record.clients.includes(client)) continue;
      record.clients.push(client);
      accepted = true;
      actions.push({
        type: 'announce',
        event: this.hostEvent(record.event),
        clients: [client],
      });
    }

    return { accepted, actions };
  }

  submitDisposition(
    eventId: string,
    client: AgentEventClient,
    disposition: AgentEventDisposition,
  ): AgentEventResult {
    const dispositionAt = this.now();
    const actions = [...this.advance(dispositionAt)];
    const record = this.events.get(eventId);
    if ((disposition !== 'suppress' && disposition !== 'display-request')
        || record === undefined
        || !record.clients.includes(client)
        || record.event.state === 'cancelled') {
      return { accepted: false, actions };
    }

    if (disposition === 'suppress') {
      record.event.state = 'cancelled';
      const cancellation = this.cancelAction(record);
      if (cancellation !== undefined) actions.push(cancellation);
      return { accepted: true, actions };
    }

    if (record.event.state !== 'pending') {
      if (!record.dispositions.has(client)) record.dispositions.set(client, disposition);
      return { accepted: true, actions };
    }

    if (record.dispositions.has(client)) {
      return { accepted: false, actions };
    }

    record.dispositions.set(client, disposition);
    if (record.dispositions.size === record.clients.length) {
      const grantedClient = record.clients.find(
        (candidate) => record.dispositions.get(candidate) === 'display-request',
      );
      if (grantedClient !== undefined) {
        record.grantedClient = grantedClient;
        record.confirmationDeadline = dispositionAt + AGENT_EVENT_LIMITS.displayConfirmationWindowMs;
        record.event.state = 'awaiting-display-confirmation';
        actions.push({
          type: 'grant-display',
          eventId: record.event.eventId,
          kind: record.event.kind,
          client: grantedClient,
        });
      }
    }

    return { accepted: true, actions };
  }

  confirmDisplay(eventId: string, client: AgentEventClient): AgentEventResult {
    const actions = [...this.advance(this.now())];
    const record = this.events.get(eventId);
    if (record === undefined
        || record.event.state !== 'awaiting-display-confirmation'
        || record.grantedClient !== client) {
      return { accepted: false, actions };
    }

    record.event.state = 'cancelled';
    return { accepted: true, actions };
  }

  advance(at: number = this.now()): readonly AgentEventAction[] {
    const actions: AgentEventAction[] = [];

    for (const [eventId, record] of this.events) {
      if (at - record.event.createdAt > AGENT_EVENT_LIMITS.eventMaxAgeMs) {
        this.events.delete(eventId);
        if (record.event.state !== 'cancelled') {
          const cancellation = this.cancelAction(record);
          if (cancellation !== undefined) actions.push(cancellation);
        }
        continue;
      }

      if (record.event.state === 'pending'
          && at - record.event.createdAt >= AGENT_EVENT_LIMITS.clientDispositionWindowMs) {
        record.event.state = 'eligible';
        const cancellation = this.cancelAction(record);
        if (cancellation !== undefined) actions.push(cancellation);
      } else if (record.event.state === 'awaiting-display-confirmation'
          && record.confirmationDeadline !== undefined
          && at >= record.confirmationDeadline) {
        record.event.state = 'eligible';
      }
    }

    return actions;
  }

  cancelForPresence(): { readonly cancelledCount: number; readonly actions: readonly AgentEventAction[] } {
    const actions = [...this.advance(this.now())];
    let cancelledCount = 0;

    for (const record of this.events.values()) {
      if (record.event.state === 'cancelled') continue;
      record.event.state = 'cancelled';
      cancelledCount += 1;
      const cancellation = this.cancelAction(record);
      if (cancellation !== undefined
          && !actions.some((action) => action.type === 'cancel-display'
            && action.eventId === record.event.eventId)) {
        actions.push(cancellation);
      }
    }

    return { cancelledCount, actions };
  }

  drain(request: { readonly ackEventIds: readonly string[]; readonly final?: true }): AgentEventDrainResult {
    const hostNow = this.now();

    for (const eventId of new Set(request.ackEventIds.slice(0, AGENT_EVENT_LIMITS.drainMax))) {
      const record = this.events.get(eventId);
      if (record?.event.state === 'drained') this.events.delete(eventId);
    }

    this.advance(hostNow);
    if (request.final === true) {
      for (const record of this.events.values()) {
        if (record.event.state === 'pending'
            || record.event.state === 'awaiting-display-confirmation') {
          record.event.state = 'eligible';
        }
      }
    }

    const events: HostAgentEvent[] = [];
    for (const record of this.events.values()) {
      if (record.event.state !== 'eligible' && record.event.state !== 'drained') continue;
      if (events.length >= AGENT_EVENT_LIMITS.drainMax) break;
      record.event.state = 'drained';
      events.push(this.hostEvent(record.event));
    }

    return { hostNow, events };
  }

  private nextEventId(): string {
    for (let attempt = 0; attempt < AGENT_EVENT_LIMITS.queueMax; attempt += 1) {
      const eventId = this.createEventId();
      if (typeof eventId === 'string'
          && AGENT_EVENT_ID_PATTERN.test(eventId)
          && !this.events.has(eventId)) return eventId;
    }
    throw new Error('Unable to create a unique bounded agent event ID');
  }

  private hostEvent(event: QueuedAgentEvent): HostAgentEvent {
    return {
      schemaVersion: event.schemaVersion,
      eventId: event.eventId,
      kind: event.kind,
      createdAt: event.createdAt,
    };
  }

  private cancelAction(record: AgentEventRecord): AgentEventAction | undefined {
    if (record.clients.length === 0) return undefined;
    return {
      type: 'cancel-display',
      eventId: record.event.eventId,
      clients: record.clients,
    };
  }
}
