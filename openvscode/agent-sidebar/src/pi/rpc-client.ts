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
  | 'PENDING_LIMIT'
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
  readonly #pending = new Set<string>();
  readonly #settled = new Set<string>();
  #buffer = Buffer.alloc(0);
  #closed = false;

  constructor(limits: PiJsonlLimits) {
    if (
      !positiveInteger(limits.maxLineBytes) ||
      !positiveInteger(limits.maxBufferBytes) ||
      !positiveInteger(limits.maxPendingRequests) ||
      limits.maxBufferBytes < limits.maxLineBytes
    ) {
      throw new TypeError('Invalid Pi JSONL limits');
    }
    this.#limits = limits;
  }

  registerRequest(id: string): void {
    if (this.#closed) throw new PiProtocolError('TRANSPORT_CLOSED');
    if (!validId(id) || this.#pending.has(id) || this.#settled.has(id)) {
      throw new PiProtocolError('INVALID_ENVELOPE');
    }
    if (this.#pending.size >= this.#limits.maxPendingRequests) {
      throw new PiProtocolError('PENDING_LIMIT');
    }
    this.#pending.add(id);
  }

  feed(chunk: Uint8Array): readonly PiRpcEnvelope[] {
    if (this.#closed) throw new PiProtocolError('TRANSPORT_CLOSED');
    if (!(chunk instanceof Uint8Array)) throw new PiProtocolError('INVALID_ENVELOPE');

    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const envelopes: PiRpcEnvelope[] = [];
    let newline = this.#buffer.indexOf(0x0a);
    while (newline !== -1) {
      let line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.byteLength > this.#limits.maxLineBytes) {
        throw new PiProtocolError('RECORD_TOO_LARGE');
      }
      envelopes.push(this.#parseLine(line));
      newline = this.#buffer.indexOf(0x0a);
    }

    if (this.#buffer.byteLength > this.#limits.maxLineBytes) {
      throw new PiProtocolError('RECORD_TOO_LARGE');
    }
    if (this.#buffer.byteLength > this.#limits.maxBufferBytes) {
      throw new PiProtocolError('BUFFER_TOO_LARGE');
    }
    return envelopes;
  }

  end(): readonly PiRpcEnvelope[] {
    if (this.#closed) throw new PiProtocolError('TRANSPORT_CLOSED');
    this.#closed = true;
    if (this.#buffer.byteLength !== 0) {
      this.#buffer = Buffer.alloc(0);
      this.#pending.clear();
      throw new PiProtocolError('UNTERMINATED_JSONL');
    }
    this.#pending.clear();
    return [];
  }

  markExited(): void {
    this.#closed = true;
    this.#buffer = Buffer.alloc(0);
    this.#pending.clear();
  }

  #parseLine(line: Uint8Array): PiRpcEnvelope {
    if (line.byteLength === 0) throw new PiProtocolError('MALFORMED_JSONL');
    let value: unknown;
    try {
      const json = new TextDecoder('utf-8', { fatal: true }).decode(line);
      value = JSON.parse(json);
    } catch {
      throw new PiProtocolError('MALFORMED_JSONL');
    }
    if (!isEnvelope(value)) throw new PiProtocolError('INVALID_ENVELOPE');

    if (value.type === 'response') {
      if (!validId(value.id)) throw new PiProtocolError('INVALID_ENVELOPE');
      if (this.#settled.has(value.id)) throw new PiProtocolError('DUPLICATE_RESPONSE');
      if (!this.#pending.delete(value.id)) throw new PiProtocolError('UNSOLICITED_RESPONSE');
      this.#settled.add(value.id);
    }
    return value;
  }
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isEnvelope(value: unknown): value is PiRpcEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.type === 'string' && record.type.length > 0 && record.type.length <= 128;
}
