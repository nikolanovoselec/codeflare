import { notImplemented } from '../not-implemented.ts';

export interface PiRpcEnvelope {
  readonly type: string;
  readonly id?: string;
  readonly [key: string]: unknown;
}

export interface PiJsonlLimits {
  readonly maxLineBytes: number;
  readonly maxBufferBytes: number;
  readonly maxPendingRequests: number;
}

export type PiProtocolErrorCode =
  | 'MALFORMED_JSONL'
  | 'UNTERMINATED_JSONL'
  | 'RECORD_TOO_LARGE'
  | 'BUFFER_TOO_LARGE'
  | 'INVALID_ENVELOPE'
  | 'DUPLICATE_RESPONSE'
  | 'UNSOLICITED_RESPONSE'
  | 'TRANSPORT_CLOSED';

export class PiProtocolError extends Error {
  readonly code: PiProtocolErrorCode;

  constructor(code: PiProtocolErrorCode) {
    super(`Pi RPC protocol error: ${code}`);
    this.name = 'PiProtocolError';
    this.code = code;
  }
}

export class StrictPiJsonlTransport {
  readonly #limits: PiJsonlLimits;

  constructor(limits: PiJsonlLimits) {
    this.#limits = limits;
  }

  registerRequest(id: string): void {
    void id;
    void this.#limits;
    return notImplemented('Pi RPC pending-request registration');
  }

  feed(chunk: Uint8Array): readonly PiRpcEnvelope[] {
    void chunk;
    return notImplemented('strict LF-delimited Pi JSONL transport');
  }

  end(): readonly PiRpcEnvelope[] {
    return notImplemented('Pi RPC end-of-stream validation');
  }

  markExited(): void {
    return notImplemented('Pi RPC post-exit settlement');
  }
}
