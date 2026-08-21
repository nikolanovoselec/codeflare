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

/**
 * Compile-only Phase 1 seam. Behavioral implementation follows the red CI
 * receipt required by sdd/spec/config.yml enforce_tdd.
 */
export class OscAgentEventParser {
  push(_chunk: string): AgentEventKind[] {
    return [];
  }
}

export interface AgentEventQueueOptions {
  readonly now?: () => number;
  readonly createEventId?: () => string;
}

/**
 * Compile-only Phase 1 seam. It intentionally does not implement queue
 * lifecycle behavior, so the host behavioral suite remains red before Phase 2.
 */
export class AgentEventQueue {
  private readonly events = new Map<string, QueuedAgentEvent>();
  private readonly now: () => number;
  private readonly createEventId: () => string;
  private nextId = 0;
  droppedCount = 0;

  constructor(options: AgentEventQueueOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createEventId = options.createEventId ?? (() => `pending-${++this.nextId}`);
  }

  get size(): number {
    return this.events.size;
  }

  get(eventId: string): QueuedAgentEvent | undefined {
    return this.events.get(eventId);
  }

  enqueue(kind: AgentEventKind, clients: readonly AgentEventClient[]): {
    readonly event: QueuedAgentEvent;
    readonly actions: readonly AgentEventAction[];
  } {
    const event: QueuedAgentEvent = {
      schemaVersion: 1,
      eventId: this.createEventId(),
      kind,
      createdAt: this.now(),
      state: clients.length === 0 ? 'pending' : 'pending',
    };
    this.events.set(event.eventId, event);
    return { event, actions: [] };
  }

  submitDisposition(
    _eventId: string,
    _client: AgentEventClient,
    _disposition: AgentEventDisposition,
  ): AgentEventResult {
    return { accepted: false, actions: [] };
  }

  confirmDisplay(_eventId: string, _client: AgentEventClient): AgentEventResult {
    return { accepted: false, actions: [] };
  }

  advance(_at: number = this.now()): readonly AgentEventAction[] {
    return [];
  }

  cancelForPresence(): { readonly cancelledCount: number; readonly actions: readonly AgentEventAction[] } {
    return { cancelledCount: 0, actions: [] };
  }

  drain(_request: { readonly ackEventIds: readonly string[]; readonly final?: true }): AgentEventDrainResult {
    return { hostNow: this.now(), events: [] };
  }
}
