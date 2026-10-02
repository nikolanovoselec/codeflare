// Browser platform doubles only. The complete served SilverBullet bundle is
// evaluated unchanged and all messages go through its registered listener.
export function nativeWorkerRuntime(worker: string, transport: typeof fetch) {
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
    // Only empty range scans are needed by the empty-vault transport fixture.
    advance() {}
    continue() {}
    continuePrimaryKey() {}
  }
  class IDBIndex {}
  class IDBObjectStore {
    constructor(readonly rows: Map<string, unknown>) {}
    get(key: string) { return request(this.rows.get(key)); }
    put(value: unknown, key: string) { this.rows.set(key, value); return request(key); }
    delete(key: string) { this.rows.delete(key); return request(undefined); }
    clear() { this.rows.clear(); return request(undefined); }
    openCursor(range: { lower: string; upper: string }) {
      // Reject fixture expansion rather than inventing cursor behavior.
      if ([...this.rows.keys()].some(key => key >= range.lower && key <= range.upper)) {
        throw new Error('Native-worker fixture supports empty range scans only');
      }
      return request(null);
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
  const timeouts = new Map<number, () => unknown>();
  let registered = true;
  const clients = { matchAll: async () => [] }; // empty-vault/zero-window fixture
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
    setTimeout: (callback: () => unknown) => { const id = timeouts.size + 1; timeouts.set(id, callback); return id; },
    clearTimeout: (id: number) => { timeouts.delete(id); },
  };
  new Function(...Object.keys(platform), worker)(...Object.values(platform));
  return {
    databases,
    isRegistered: () => registered,
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
