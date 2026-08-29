import net from 'node:net';

export const HERDR_COMPLETION_DELAY_MS = 4 * 60_000;
const RECONNECT_DELAY_MS = 1_000;
const SNAPSHOT_TIMEOUT_MS = 5_000;
const MAX_BUFFER_BYTES = 1024 * 1024;

type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
type TimerHandle = ReturnType<typeof setTimeout>;

interface CompletionDelayOptions {
  readonly onComplete: () => void;
  readonly onWorking?: () => void;
  readonly delayMs?: number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimeout?: (handle: TimerHandle) => void;
}

export class HerdrCompletionDelay {
  private status: HerdrAgentStatus = 'unknown';
  private workObserved = false;
  private timer: TimerHandle | undefined;
  private readonly onComplete: () => void;
  private readonly onWorking: () => void;
  private readonly delayMs: number;
  private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly cancel: (handle: TimerHandle) => void;

  constructor(options: CompletionDelayOptions) {
    this.onComplete = options.onComplete;
    this.onWorking = options.onWorking ?? (() => {});
    this.delayMs = options.delayMs ?? HERDR_COMPLETION_DELAY_MS;
    this.schedule = options.setTimeout ?? setTimeout;
    this.cancel = options.clearTimeout ?? clearTimeout;
  }

  initialize(status: HerdrAgentStatus): void {
    this.clear();
    this.status = status;
    this.workObserved = status === 'working';
    if (status === 'working') this.onWorking();
  }

  update(status: HerdrAgentStatus): void {
    this.status = status;

    if (status === 'working') {
      this.workObserved = true;
      this.clear();
      this.onWorking();
      return;
    }
    if (status !== 'idle' && status !== 'done') {
      this.clear();
      return;
    }
    if (!this.workObserved || this.timer !== undefined) return;

    this.timer = this.schedule(() => {
      this.timer = undefined;
      if (this.status === 'idle' || this.status === 'done') {
        this.workObserved = false;
        this.onComplete();
      }
    }, this.delayMs);
    (this.timer as TimerHandle & { unref?: () => void }).unref?.();
  }

  dispose(): void {
    this.clear();
    this.status = 'unknown';
    this.workObserved = false;
  }

  private clear(): void {
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
  }
}

interface AgentStatusSession {
  readonly terminalId: string;
  enqueueAgentEvent(kind: 'task-completed'): unknown;
  cancelAgentEvents(kind: 'task-completed'): unknown;
}

export function createHerdrAgentStatusCallbacks(sessions: () => Iterable<AgentStatusSession>): {
  readonly onComplete: () => void;
  readonly onWorking: () => void;
} {
  const primary = (): AgentStatusSession | undefined => [...sessions()]
    .find((session) => session.terminalId === '1');
  return Object.freeze({
    onComplete: () => { primary()?.enqueueAgentEvent('task-completed'); },
    onWorking: () => { primary()?.cancelAgentEvents('task-completed'); },
  });
}

interface HerdrAgentStatusMonitorOptions {
  readonly socketPath: string;
  readonly onComplete: () => void;
  readonly onWorking?: () => void;
  readonly delayMs?: number;
  readonly reconnectDelayMs?: number;
  readonly snapshotTimeoutMs?: number;
}

function agentStatus(value: unknown): HerdrAgentStatus | undefined {
  return value === 'idle' || value === 'working' || value === 'blocked'
    || value === 'done' || value === 'unknown'
    ? value
    : undefined;
}

function snapshotAgentStatuses(snapshot: unknown): ReadonlyMap<string, HerdrAgentStatus> | undefined {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined;
  const agents = (snapshot as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return undefined;
  const statuses = new Map<string, HerdrAgentStatus>();
  for (const value of agents) {
    if (typeof value !== 'object' || value === null) continue;
    const agent = value as Record<string, unknown>;
    const status = agentStatus(agent.agent_status);
    if (typeof agent.pane_id === 'string'
        && agent.pane_id.length > 0
        && (agent.agent === 'pi' || agent.agent === 'claude')
        && status) statuses.set(agent.pane_id, status);
  }
  return statuses;
}

function aggregateAgentStatus(statuses: Iterable<HerdrAgentStatus>): HerdrAgentStatus {
  const values = [...statuses];
  if (values.includes('working')) return 'working';
  if (values.includes('blocked')) return 'blocked';
  if (values.includes('unknown') || values.length === 0) return 'unknown';
  return values.every((status) => status === 'done') ? 'done' : 'idle';
}

export class HerdrAgentStatusMonitor {
  private readonly socketPath: string;
  private readonly reconnectDelayMs: number;
  private readonly snapshotTimeoutMs: number;
  private readonly delay: HerdrCompletionDelay;
  private socket: net.Socket | undefined;
  private reconnectTimer: TimerHandle | undefined;
  private snapshotTimer: TimerHandle | undefined;
  private buffer = Buffer.alloc(0);
  private paneStatuses: ReadonlyMap<string, HerdrAgentStatus> = new Map();
  private stopped = true;

  constructor(options: HerdrAgentStatusMonitorOptions) {
    this.socketPath = options.socketPath;
    this.reconnectDelayMs = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
    this.snapshotTimeoutMs = options.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS;
    this.delay = new HerdrCompletionDelay({
      onComplete: options.onComplete,
      onWorking: options.onWorking,
      delayMs: options.delayMs,
    });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    if (this.snapshotTimer !== undefined) clearTimeout(this.snapshotTimer);
    this.reconnectTimer = undefined;
    this.snapshotTimer = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.delay.dispose();
  }

  private connect(): void {
    if (this.stopped
        || !this.socketPath.startsWith('/')
        || this.socketPath.includes('\0')
        || Buffer.byteLength(this.socketPath) > 107) return;
    this.buffer = Buffer.alloc(0);
    this.paneStatuses = new Map();
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    this.snapshotTimer = setTimeout(() => this.retry(socket), this.snapshotTimeoutMs);
    this.snapshotTimer.unref?.();
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({
        id: 'codeflare-agent-status-snapshot', method: 'session.snapshot', params: {},
      })}\n`);
    });
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.once('error', () => this.retry(socket));
    socket.once('end', () => this.retry(socket));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.retry(this.socket);
      return;
    }
    let newline = this.buffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = this.buffer.subarray(0, newline).toString('utf8');
      this.buffer = this.buffer.subarray(newline + 1);
      this.onLine(line);
      newline = this.buffer.indexOf(0x0a);
    }
  }

  private onLine(line: string): void {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.retry(this.socket);
      return;
    }

    if (value.id === 'codeflare-agent-status-snapshot') {
      const result = value.result as Record<string, unknown> | undefined;
      const statuses = result?.type === 'session_snapshot'
        ? snapshotAgentStatuses(result.snapshot)
        : undefined;
      if (!statuses || !this.socket) {
        this.retry(this.socket);
        return;
      }
      this.paneStatuses = statuses;
      this.delay.initialize(aggregateAgentStatus(statuses.values()));
      if (this.snapshotTimer !== undefined) clearTimeout(this.snapshotTimer);
      this.snapshotTimer = undefined;
      this.socket.write(`${JSON.stringify({
        id: 'codeflare-agent-status-subscribe',
        method: 'events.subscribe',
        params: { subscriptions: [
          ...[...statuses.keys()].flatMap((paneId) => (
            ['idle', 'working', 'blocked', 'done', 'unknown'] as const
          ).map((status) => ({
            type: 'pane.agent_status_changed', pane_id: paneId, agent_status: status,
          }))),
          { type: 'pane.closed' },
          { type: 'pane.agent_detected' },
        ] },
      })}\n`);
      return;
    }

    if (value.event === 'pane.agent_status_changed') {
      const data = typeof value.data === 'object' && value.data !== null
        ? value.data as Record<string, unknown>
        : undefined;
      const status = agentStatus(data?.agent_status);
      if (typeof data?.pane_id !== 'string' || !this.paneStatuses.has(data.pane_id) || !status) {
        this.retry(this.socket);
        return;
      }
      const statuses = new Map(this.paneStatuses);
      statuses.set(data.pane_id, status);
      this.paneStatuses = statuses;
      this.delay.update(aggregateAgentStatus(statuses.values()));
      return;
    }

    if (value.event === 'pane.closed' || value.event === 'pane.agent_detected') {
      const data = value.data as Record<string, unknown> | undefined;
      if (value.event === 'pane.agent_detected'
          || (typeof data?.pane_id === 'string' && this.paneStatuses.has(data.pane_id))) {
        this.retry(this.socket);
      }
    }
  }

  private retry(socket: net.Socket | undefined): void {
    if (socket && this.socket !== socket) return;
    socket?.destroy();
    this.socket = undefined;
    if (this.snapshotTimer !== undefined) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = undefined;
    this.delay.dispose();
    if (this.stopped || this.reconnectTimer !== undefined) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref?.();
  }
}
