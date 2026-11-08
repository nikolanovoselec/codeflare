import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { DurableObject as NativeDurableObject } from 'cloudflare:workers';

vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn().mockResolvedValue({ accountId: 'test-account', endpoint: 'https://r2.test' }),
}));

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('@cloudflare/containers', () => ({
  Container: class MockContainer {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
    async fetch(): Promise<Response> { return new Response('base fetch', { status: 200 }); }
    async destroy(): Promise<void> {}
    async getState(): Promise<{ status: string }> { return { status: 'running' }; }
    async getActivityInfo(): Promise<null> { return null; }
    async schedule(seconds: number, method: string, payload?: unknown) {
      return { taskId: 'mock-schedule', callback: method, payload, type: 'delayed' as const,
        time: Math.floor(Date.now() / 1000) + seconds, delayInSeconds: seconds };
    }
    async listSchedules(): Promise<unknown[]> { return []; }
    deleteSchedules(): void {}
    renewActivityTimeout(): void {}
    async stop(): Promise<void> {}
    onStart(): void {}
    onStop(): void {}
    onError(): void {}
    onActivityExpired(): void {}
    async startAndWaitForPorts(): Promise<void> {}
  },
}));

import { container as ContainerClass } from '../../container/index';

const CONTAINER_TOKEN = 'existing-token';

type PortBehaviour = 'answers-with-socket' | 'throws';

type ContainerSide = {
  readonly send: (data: string | ArrayBuffer | ArrayBufferView) => Promise<void>;
  readonly close: (code?: number, reason?: string) => Promise<void>;
  readonly raiseError: () => Promise<void>;
  readonly reportAbnormalClose: () => Promise<void>;
  readonly deliverOnHandedOverSocket: (data: string) => Promise<void>;
  readonly received: unknown[];
  readonly closes: { code: number; reason: string }[];
};

type RelayFixture = {
  readonly response: Response;
  readonly client: WebSocket;
  readonly container: ContainerSide;
  readonly wasStarted: () => boolean;
  readonly lifecycleGeneration: () => unknown;
};

type RecordedEvents = {
  readonly messages: unknown[];
  readonly closes: { code: number; reason: string }[];
};

function recordEvents(socket: WebSocket): RecordedEvents {
  const messages: unknown[] = [];
  const closes: { code: number; reason: string }[] = [];
  socket.addEventListener('message', event => { messages.push(event.data); });
  socket.addEventListener('close', event => { closes.push({ code: event.code, reason: event.reason }); });
  return { messages, closes };
}

async function upgrade(options: {
  readonly path: string;
  readonly sdkRunning: boolean;
  readonly port: PortBehaviour;
}): Promise<{ response: Response; fixture: Omit<RelayFixture, 'response' | 'client'> }> {
  const persisted = new Map<string, unknown>([['containerAuthToken', CONTAINER_TOKEN], ['lifecycleGeneration', 7]]);
  let started = false;
  // Sockets must be created inside the Durable Object's own I/O context, so the
  // fake private port builds the pair and the test drives the container end
  // through the same Durable Object context.
  let containerEnd: WebSocket | null = null;
  let containerOwnClientFacingEnd: WebSocket | null = null;
  const received: unknown[] = [];
  const closes: { code: number; reason: string }[] = [];

  const portFetch = vi.fn(async (): Promise<Response> => {
    if (options.port === 'throws') throw new Error('no existing process');
    const pair = new WebSocketPair();
    containerOwnClientFacingEnd = pair[0];
    containerEnd = pair[1];
    pair[1].accept();
    pair[1].addEventListener('message', event => { received.push(event.data); });
    pair[1].addEventListener('close', event => { closes.push({ code: event.code, reason: event.reason }); });
    return new Response(null, { status: 101, webSocket: pair[0] });
  });
  const ctx = {
    storage: {
      get: vi.fn(async (key: string) => persisted.get(key) ?? null),
      put: vi.fn(async (key: string, value: unknown) => { persisted.set(key, value); }),
      delete: vi.fn().mockResolvedValue(undefined),
      deleteAll: vi.fn().mockResolvedValue(undefined),
      setAlarm: vi.fn().mockResolvedValue(undefined),
      deleteAlarm: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(async (fn: (txn: unknown) => Promise<unknown>) => fn({})),
    },
    id: { toString: () => 'test-do-id-hex' },
    blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => fn()),
    container: {
      running: options.sdkRunning,
      getTcpPort: vi.fn().mockReturnValue({ fetch: portFetch }),
      start: vi.fn(() => { started = true; throw new Error('replacement started'); }),
      destroy: vi.fn(),
      monitor: vi.fn(() => new Promise<void>(() => {})),
      signal: vi.fn(),
    },
  };
  const environment = {
    R2_ACCOUNT_ID: 'test-account',
    R2_ENDPOINT: 'https://r2.test',
    R2_ACCESS_KEY_ID: 'test-key',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    KV: { get: vi.fn().mockResolvedValue(null) },
  };
  // The harness fakes the Cloudflare platform collaborators with partial stand-ins.
  const instance = new ContainerClass(ctx as never, environment as never);
  const namespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  const nativeStub = namespace.getByName(`terminal-relay-fixture-${crypto.randomUUID()}`);
  // The fixture namespace is a native Durable Object; runInDurableObject needs that typing.
  const nativeObjectStub = nativeStub as DurableObjectStub<NativeDurableObject>;
  await runInDurableObject<NativeDurableObject, void>(nativeObjectStub, async nativeInstance => {
    nativeInstance.fetch = (request: Request) => instance.fetch(request);
  });
  const response = await nativeStub.fetch(new Request(`https://codeflare.ch${options.path}?reconnect=a%2Fb`, {
    headers: { Upgrade: 'websocket' },
  }));
  const inDurableObject = (act: (end: WebSocket) => void): Promise<void> =>
    runInDurableObject<NativeDurableObject, void>(nativeObjectStub, async () => {
      if (!containerEnd) throw new Error('the container end does not exist: the private port was never reached');
      act(containerEnd);
    });
  return {
    response,
    fixture: {
      container: {
        send: data => inDurableObject(end => end.send(data)),
        close: (code, reason) => inDurableObject(end => end.close(code, reason)),
        // Delivers a frame to whoever listens on the socket the container handed
        // over: only a Durable Object relay is listening there.
        deliverOnHandedOverSocket: data => inDurableObject(() => {
          if (!containerOwnClientFacingEnd) throw new Error('the container handed over no socket');
          containerOwnClientFacingEnd.dispatchEvent(new MessageEvent('message', { data }));
        }),
        // A WebSocket cannot be made to fail natively; an error event raised on
        // the socket the container handed over is what a transport failure
        // delivers to whoever listens on it.
        raiseError: () => inDurableObject(() => {
          if (!containerOwnClientFacingEnd) throw new Error('the container handed over no socket');
          containerOwnClientFacingEnd.dispatchEvent(new Event('error'));
        }),
        // An abnormal close (1006) cannot be sent natively either; the closing
        // handshake is reported to listeners as a close event.
        reportAbnormalClose: () => inDurableObject(() => {
          if (!containerOwnClientFacingEnd) throw new Error('the container handed over no socket');
          containerOwnClientFacingEnd.dispatchEvent(new CloseEvent('close', { code: 1006, reason: '' }));
        }),
        received,
        closes,
      },
      wasStarted: () => started,
      lifecycleGeneration: () => persisted.get('lifecycleGeneration'),
    },
  };
}

async function openRelay(path = '/terminal', sdkRunning = true): Promise<RelayFixture> {
  const { response, fixture } = await upgrade({ path, sdkRunning, port: 'answers-with-socket' });
  expect(response.status, 'upgrade to a running container must answer 101').toBe(101);
  const client = response.webSocket;
  if (!client) throw new Error('101 response carried no webSocket: the client has nothing to talk to; return the relayed client end');
  client.accept();
  return { response, client, ...fixture };
}

async function eventually<T>(read: () => T | undefined, what: string): Promise<T> {
  const value = await vi.waitFor(() => {
    const found = read();
    if (found === undefined) throw new Error(what);
    return found;
  }, { timeout: 1000 });
  return value;
}

async function withRelay(
  options: { path?: string; sdkRunning?: boolean },
  body: (relay: RelayFixture) => Promise<void>,
): Promise<void> {
  const relay = await openRelay(options.path, options.sdkRunning);
  try {
    await body(relay);
  } finally {
    try { relay.client.close(1000); } catch { /* already closed by the scenario */ }
  }
}

function bytesOf(frame: unknown): Uint8Array {
  if (!(frame instanceof ArrayBuffer)) throw new Error('expected a binary frame (ArrayBuffer)');
  return new Uint8Array(frame);
}

describe('terminal and IDE WebSocket relay owned by the Container Durable Object', () => {
  const expectDurableObjectOwnsRelay = async (relay: RelayFixture) => {
    const seen = recordEvents(relay.client);
    await relay.container.deliverOnHandedOverSocket('owned-probe');
    await eventually(
      () => seen.messages[0],
      'WHAT: nothing listens on the socket the container handed over. WHY: the client holds the container\'s own unaccepted socket, which dies when the Durable Object shuts down at an alarm boundary. HOW: accept both ends and relay through a Durable Object-owned WebSocketPair.',
    );
    expect(seen.messages[0]).toBe('owned-probe');
  };

  it.each(['/terminal', '/api/vscode/abcdef1234567890/ws'])(
    'a %s upgrade to a running container answers 101 with a socket the Durable Object owns, not the container socket',
    path => withRelay({ path }, expectDurableObjectOwnsRelay),
  );

  it('a container frame reaches the client through a relay the Durable Object owns', () =>
    withRelay({}, async relay => {
      const seen = recordEvents(relay.client);
      await relay.container.send('hello from container');
      await eventually(() => seen.messages[0], 'client must receive the container frame');
      expect(seen.messages).toEqual(['hello from container']);
      await expectDurableObjectOwnsRelay(relay);
    }));

  it('frames flow both ways, including a binary frame', () =>
    withRelay({}, async relay => {
      const atClient = recordEvents(relay.client);
      const binary = Uint8Array.from({ length: 4096 }, (_, index) => index % 251);

      relay.client.send('keystroke');
      relay.client.send(binary);
      await relay.container.send('prompt');
      await relay.container.send(binary);

      await eventually(() => relay.container.received[1], 'container must receive both client frames');
      await eventually(() => atClient.messages[1], 'client must receive both container frames');
      expect(relay.container.received[0]).toBe('keystroke');
      expect(bytesOf(relay.container.received[1])).toEqual(binary);
      expect(atClient.messages[0]).toBe('prompt');
      expect(bytesOf(atClient.messages[1])).toEqual(binary);
      expect(relay.wasStarted()).toBe(false);
    }));

  it('a container close with code 1012 and reason "restart" reaches the client unchanged', () =>
    withRelay({}, async relay => {
      const seen = recordEvents(relay.client);
      await relay.container.close(1012, 'restart');
      await eventually(() => seen.closes[0], 'client must see a close');
      expect(seen.closes[0]).toEqual({ code: 1012, reason: 'restart' });
    }));

  it.each<{ how: string; closeContainer: (container: ContainerSide) => Promise<void> }>([
    { how: 'with 1000', closeContainer: container => container.close(1000) },
    { how: 'without a status (1005)', closeContainer: container => container.close() },
    { how: 'abnormally (1006)', closeContainer: container => container.reportAbnormalClose() },
  ])(
    'a container close $how reaches the client as a final 1000',
    ({ closeContainer }) => withRelay({}, async relay => {
      const seen = recordEvents(relay.client);
      await closeContainer(relay.container);
      await eventually(() => seen.closes[0], 'client must see a close');
      expect(
        seen.closes[0].code,
        'WHAT: the client did not see the final close code 1000. WHY: a 1005 or 1006 close would otherwise be treated differently by the client reconnect policy. HOW: map 1005 and 1006 to 1000 when forwarding close.',
      ).toBe(1000);
    }),
  );

  it('a container socket error closes the client with 1011 so the client reconnects', () =>
    withRelay({}, async relay => {
      const seen = recordEvents(relay.client);
      await relay.container.raiseError();
      await eventually(() => seen.closes[0], 'WHAT: the client socket stayed open after the container socket reported an error. WHY: the client cannot reconnect. HOW: close the client end with 1011 on container error.');
      expect(seen.closes[0].code).toBe(1011);
    }));

  it('a client close ends the container socket as well', () =>
    withRelay({}, async relay => {
      relay.client.close(1000, 'bye');
      await eventually(() => relay.container.closes[0], 'container end must be closed after the client closes');
      expect(relay.container.closes).toHaveLength(1);
    }));

  it('an upgrade is relayed without starting the container while the SDK running flag is false', () =>
    withRelay({ sdkRunning: false }, async relay => {
      const seen = recordEvents(relay.client);
      await relay.container.send('still alive');
      await eventually(() => seen.messages[0], 'client must receive the container frame');
      expect(seen.messages).toEqual(['still alive']);
      expect(relay.wasStarted()).toBe(false);
      expect(relay.lifecycleGeneration()).toBe(7);
    }));

  it('an upgrade to a container whose private port does not answer returns 503 and never starts it', async () => {
    const { response, fixture } = await upgrade({ path: '/terminal', sdkRunning: false, port: 'throws' });
    expect(response.status).toBe(503);
    expect(response.webSocket).toBeNull();
    expect(fixture.wasStarted()).toBe(false);
    expect(fixture.lifecycleGeneration()).toBe(7);
  });
});
