import '@testing-library/jest-dom/vitest';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] || null,
  };
})();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private _skipAutoOpen = false;

  constructor(url: string) {
    this.url = url;
    // readyState is synchronously OPEN so send() works immediately.
    // onopen callback fires on the next tick (after callers attach handlers).
    setTimeout(() => {
      if (!this._skipAutoOpen && this.onopen) {
        this.onopen(new Event('open'));
      }
    }, 0);
  }

  /**
   * Factory for tests that need readyState to start as CONNECTING
   * and transition to OPEN asynchronously.
   */
  static createWithAsyncOpen(url: string): MockWebSocket {
    const ws = new MockWebSocket(url);
    ws._skipAutoOpen = true;
    ws.readyState = MockWebSocket.CONNECTING;
    setTimeout(() => {
      ws.readyState = MockWebSocket.OPEN;
      if (ws.onopen) {
        ws.onopen(new Event('open'));
      }
    }, 0);
    return ws;
  }

  send(_data: string | ArrayBuffer | Blob | ArrayBufferView): void {
    // Mock send - can be extended to trigger onmessage
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent('close', { code: code || 1000, reason: reason || '' }));
    }
  }

  // Helper to simulate receiving a message
  _simulateMessage(data: string | ArrayBuffer): void {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data }));
    }
  }

  // Helper to simulate an error
  _simulateError(): void {
    if (this.onerror) {
      this.onerror(new Event('error'));
    }
  }
}

Object.defineProperty(globalThis, 'WebSocket', {
  value: MockWebSocket,
  writable: true,
});

// Mock ResizeObserver
class MockResizeObserver {
  callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(_target: Element): void {
    // Could trigger callback with mock entries if needed
  }

  unobserve(_target: Element): void {
    // No-op
  }

  disconnect(): void {
    // No-op
  }
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  value: MockResizeObserver,
  writable: true,
});

// Reset mocks before each test
beforeEach(() => {
  localStorageMock.clear();
});
