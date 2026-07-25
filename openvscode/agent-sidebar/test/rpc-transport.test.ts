import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  PiProtocolError,
  StrictPiJsonlTransport,
  type PiRpcEnvelope,
} from '../src/pi/rpc-client.ts';

function transport(): StrictPiJsonlTransport {
  return new StrictPiJsonlTransport({
    maxLineBytes: 128,
    maxBufferBytes: 256,
    maxPendingRequests: 2,
  });
}

test('Pi JSONL preserves split and coalesced LF-delimited records', () => {
  const rpc = transport();
  const first = rpc.feed(Buffer.from('{"type":"agent_start"}\n{"type":"agent_'));
  const second = rpc.feed(Buffer.from('settled"}\r\n'));

  assert.deepEqual(first, [{ type: 'agent_start' }]);
  assert.deepEqual(second, [{ type: 'agent_settled' }]);
});

test('Pi JSONL treats Unicode separators as payload rather than record delimiters', () => {
  const rpc = transport();
  const beforeLf = rpc.feed(Buffer.from('{"type":"notice","text":"left\u2028right\u2029end"}'));
  const afterLf = rpc.feed(Buffer.from('\n'));

  assert.deepEqual(beforeLf, []);
  assert.deepEqual(afterLf, [{ type: 'notice', text: 'left\u2028right\u2029end' }]);
});

test('Pi JSONL rejects malformed records as protocol errors', () => {
  const rpc = transport();

  assert.throws(
    () => rpc.feed(Buffer.from('{not-json}\n')),
    (error: unknown) => error instanceof PiProtocolError && error.code === 'MALFORMED_JSONL',
  );
});

test('Pi JSONL rejects an unterminated final record', () => {
  const rpc = transport();

  rpc.feed(Buffer.from('{"type":"agent_start"}'));
  assert.throws(
    () => rpc.end(),
    (error: unknown) => error instanceof PiProtocolError && error.code === 'UNTERMINATED_JSONL',
  );
});

test('Pi JSONL rejects records beyond the fixed byte limit', () => {
  const rpc = transport();
  const oversized = Buffer.from(`{"type":"notice","text":"${'x'.repeat(150)}"}\n`);

  assert.throws(
    () => rpc.feed(oversized),
    (error: unknown) => error instanceof PiProtocolError && error.code === 'RECORD_TOO_LARGE',
  );
});

test('Pi JSONL rejects an unterminated buffer beyond the fixed byte limit', () => {
  const rpc = transport();

  assert.throws(
    () => rpc.feed(Buffer.alloc(257, 0x78)),
    (error: unknown) => error instanceof PiProtocolError && error.code === 'BUFFER_TOO_LARGE',
  );
});

test('Pi JSONL accepts each correlated response exactly once', () => {
  const rpc = transport();
  rpc.registerRequest('request-1');

  const accepted = rpc.feed(
    Buffer.from('{"id":"request-1","type":"response","command":"prompt","success":true}\n'),
  );
  assert.deepEqual(accepted, [
    { id: 'request-1', type: 'response', command: 'prompt', success: true },
  ] satisfies PiRpcEnvelope[]);

  assert.throws(
    () =>
      rpc.feed(
        Buffer.from('{"id":"request-1","type":"response","command":"prompt","success":true}\n'),
      ),
    (error: unknown) => error instanceof PiProtocolError && error.code === 'DUPLICATE_RESPONSE',
  );
});

test('Pi JSONL rejects an unsolicited response ID', () => {
  const rpc = transport();

  assert.throws(
    () =>
      rpc.feed(
        Buffer.from('{"id":"unknown","type":"response","command":"prompt","success":true}\n'),
      ),
    (error: unknown) => error instanceof PiProtocolError && error.code === 'UNSOLICITED_RESPONSE',
  );
});

test('Pi JSONL rejects responses after process exit', () => {
  const rpc = transport();

  rpc.registerRequest('request-2');
  rpc.markExited();
  assert.throws(
    () =>
      rpc.feed(
        Buffer.from('{"id":"request-2","type":"response","command":"prompt","success":true}\n'),
      ),
    (error: unknown) => error instanceof PiProtocolError && error.code === 'TRANSPORT_CLOSED',
  );
});
