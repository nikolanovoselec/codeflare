// Browser platform doubles only. The complete served SilverBullet bundle is
// evaluated unchanged and all messages go through its registered listener.
export function nativeWorkerRuntime(worker: string, transport: (input: RequestInfo | URL,
  options?: RequestInit & { credentials?: 'omit' | 'same-origin' | 'include' }) => Promise<Response>) {
  class IDBRequest extends EventTarget {
    result: unknown;
    transaction?: IDBTransaction;
  }
  const request = (value: unknown) => {
    const result = new IDBRequest();
    queueMicrotask(() => { result.result = value; result.dispatchEvent(new Event('success')); });
    return result;
  };
  class IDBCursor {
    private position = 0;
    constructor(readonly request: IDBRequest, readonly entries: Array<[string, unknown]>) {}
    get key() { return this.entries[this.position][0]; }
    get value() { return structuredClone(this.entries[this.position][1]); }
    advance(count: number) {
      this.position += count;
      queueMicrotask(() => {
        this.request.result = this.position < this.entries.length ? this : null;
        this.request.dispatchEvent(new Event('success'));
      });
    }
    continue() { this.advance(1); }
    continuePrimaryKey() { throw new Error('Compound cursors are not used by the native file store'); }
  }
  class IDBIndex {}
  class IDBObjectStore {
    constructor(readonly rows: Map<string, unknown>) {}
    get(key: string) { return request(structuredClone(this.rows.get(key))); }
    put(value: unknown, key: string) { this.rows.set(key, structuredClone(value)); return request(key); }
    delete(key: string) { this.rows.delete(key); return request(undefined); }
    clear() { this.rows.clear(); return request(undefined); }
    openCursor(range: { lower: string; upper: string }) {
      const entries = [...this.rows.entries()]
        .filter(([key]) => key >= range.lower && key <= range.upper)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      const opening = new IDBRequest();
      queueMicrotask(() => {
        opening.result = entries.length ? new IDBCursor(opening, entries) : null;
        opening.dispatchEvent(new Event('success'));
      });
      return opening;
    }
  }
  class IDBTransaction extends EventTarget {
    objectStoreNames = ['data'];
    constructor(readonly rows: Map<string, unknown>) {
      super();
      queueMicrotask(() => queueMicrotask(() => this.dispatchEvent(new Event('complete'))));
    }
    objectStore() { return new IDBObjectStore(this.rows); }
  }
  class IDBDatabase extends EventTarget {
    objectStoreNames = ['data'];
    rows = new Map<string, unknown>();
    createObjectStore() { return new IDBObjectStore(this.rows); }
    transaction() { return new IDBTransaction(this.rows); }
    close() {}
  }
  const databases = new Map<string, IDBDatabase>();
  const indexedDB = {
    databases: async () => [...databases.keys()].map(name => ({ name })),
    open(name: string) {
      const opening = new IDBRequest();
      const isNew = !databases.has(name);
      if (isNew) databases.set(name, new IDBDatabase());
      queueMicrotask(() => {
        opening.result = databases.get(name);
        opening.transaction = new IDBTransaction(databases.get(name)!.rows);
        if (isNew) opening.dispatchEvent(new Event('upgradeneeded'));
        opening.dispatchEvent(new Event('success'));
      });
      return opening;
    },
  };
  type Message = Record<string, unknown>;
  type Listener = (event: unknown) => unknown;
  const listeners = new Map<string, Listener>();
  const intervals: Array<() => unknown> = [];
  const timeouts = new Set<ReturnType<typeof setTimeout>>();
  let registered = true;
  const windows = new Set<{ frameType: string; postMessage(value: Message): void }>();
  const clients = { matchAll: async () => [...windows] };
  const self = {
    clients, registration: { scope: 'https://vault.test/', unregister: async () => { registered = false; return true; } },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: async () => {},
  };
  const quietConsole = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const globals = { crypto, clients };
  const platform = { self, globalThis: globals, location: new URL('https://vault.test/service_worker.js'),
    indexedDB, IDBRequest, IDBDatabase, IDBTransaction, IDBObjectStore, IDBIndex, IDBCursor,
    IDBKeyRange: { bound: (lower: string, upper: string) => ({ lower, upper }) },
    fetch: transport, console: quietConsole,
    caches: { match: async () => undefined },
    setInterval: (callback: () => unknown) => { intervals.push(callback); return intervals.length; },
    setTimeout: (callback: () => unknown, delay = 0) => {
      const id = setTimeout(() => { timeouts.delete(id); callback(); }, delay);
      timeouts.add(id);
      return id;
    },
    clearTimeout: (id: ReturnType<typeof setTimeout>) => { clearTimeout(id); timeouts.delete(id); },
  };
  new Function(...Object.keys(platform), worker)(...Object.values(platform));
  return {
    databases,
    dispose() { for (const id of timeouts) clearTimeout(id); timeouts.clear(); intervals.length = 0; },
    isRegistered: () => registered,
    connectClient(receive: (value: Message) => void) {
      const client = { frameType: 'top-level', postMessage: receive };
      windows.add(client);
      return () => { windows.delete(client); };
    },
    async fetch(request: Request): Promise<Response> {
      const listener = listeners.get('fetch');
      if (!listener) throw new Error('Served worker did not register a fetch handler');
      let response: Promise<Response> | undefined;
      await listener({ request, respondWith(value: Promise<Response>) { response = value; } });
      if (!response) throw new Error('Served worker did not respond to fetch');
      return response;
    },
    async message(data: Message) {
      const listener = listeners.get('message');
      if (!listener) throw new Error('Served worker did not register a message handler');
      const replies: Message[] = [];
      const pending: Promise<unknown>[] = [];
      await listener({ data, source: { postMessage: (value: Message) => replies.push(value) },
        ports: [{ postMessage: (value: Message) => replies.push(value) }],
        waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
      await Promise.all(pending);
      return replies;
    },
    async noClientInterval() {
      for (const callback of intervals) await callback();
      await Promise.resolve();
    },
  };
}
