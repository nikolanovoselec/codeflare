import { describe, expect, it, vi } from 'vitest';
import { adaptBedrockAnthropicResponse, type BedrockReplayState } from '../../lib/bedrock-anthropic-native-adapter';
import { setLogLevel } from '../../lib/logger';
import { bedrockChunkFrame as frame, bedrockEventFrame, bedrockToolResponse, readOpenAiToolTurn } from '../helpers/bedrock-eventstream';

type Event = { module?: string; data?: Record<string, unknown> };
const privateMarker = 'PRIVATE_DIAGNOSTIC_CONTENT';
const capture = async (run: (events: Event[]) => Promise<void>, broken = false) => {
  const events: Event[] = [];
  const spies = ['log', 'warn', 'error'].map(method => vi.spyOn(console, method as 'log').mockImplementation(value => {
    if (broken) throw new Error(privateMarker);
    try { events.push(JSON.parse(String(value))); } catch { /* Only structured diagnostic contract entries. */ }
  }));
  setLogLevel('info');
  try { await run(events); }
  finally { setLogLevel('silent'); spies.forEach(spy => spy.mockRestore()); }
};
const observations = (events: Event[]) => events.filter(event => event.module === 'operator-inference').map(event => event.data!);
const replay = (): BedrockReplayState => {
  const entries = new Map<string, unknown[]>();
  return { load: async id => entries.get(id) ?? null, save: async (id, blocks) => { entries.set(id, blocks); } };
};
const stream = (chunks: Uint8Array[]) => new Response(new ReadableStream<Uint8Array>({
  start(controller) { chunks.forEach(chunk => controller.enqueue(chunk)); controller.close(); },
}));
const start = frame({ type: 'message_start', message: { id: privateMarker, model: privateMarker } });
const stop = frame({ type: 'message_stop' });
const reason = (stop_reason: string) => frame({ type: 'message_delta', delta: { stop_reason } });

// Structured logs are an intentional privacy/diagnostic wire contract. Every
// diagnostic assertion is paired with the actual unchanged provider-wire outcome.
describe('REQ-OPERATOR-063: complete native inference diagnostic wire', () => {
  it.each([
    ['missing-stop', () => [start], 'missing-stop'],
    ['truncated-frame', () => [start, stop.subarray(0, 9)], 'truncated-frame'],
    ['invalid-stop-reason', () => [start, reason(privateMarker), stop], 'stop-reason'],
    ['provider-exception', () => [bedrockEventFrame('modelStreamErrorException', { message: privateMarker }, 'exception')], 'provider-exception'],
    ['provider-error', () => [frame({ type: 'error', error: { message: privateMarker } })], 'provider-error'],
    ['invalid-base64', () => [bedrockEventFrame('chunk', { bytes: '%%%PRIVATE_DIAGNOSTIC_CONTENT%%%' })], 'frame-payload'],
    ['invalid-utf8', () => [bedrockEventFrame('chunk', { bytes: '/w==' })], 'frame-payload'],
    ['invalid-json', () => [bedrockEventFrame('chunk', { bytes: btoa(privateMarker) })], 'frame-payload'],
    ['invalid-sequence', () => [frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: privateMarker } })], 'event-sequence'],
    ['replay-limit', () => [start, frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: privateMarker.repeat(4096) } })], 'replay-limit'],
    ['invalid-tool-arguments', () => [start, frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'fixture_call', name: 'lookup', input: {} } }),
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: privateMarker } }),
      frame({ type: 'content_block_stop', index: 0 }), reason('tool_use'), stop], 'tool-arguments'],
  ] as Array<[string, () => Uint8Array[], string]>)('identifies %s while preserving failed completion and private content', async (_name, chunks, failureClass) => capture(async events => {
    const response = await adaptBedrockAnthropicResponse(stream(chunks()), 'eventstream', replay());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('NATIVE_BEDROCK_STREAM_ERROR');
    expect(text).not.toMatch(/"finish_reason":"[^"]+"/);
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(observations(events)).toContainEqual(expect.objectContaining({ stage: 'native-stream', outcome: 'failed', transport: 'eventstream', failureClass }));
    expect(JSON.stringify(events)).not.toContain(privateMarker);
  }));

  it('distinguishes frame integrity from payload rejection without exposing bytes', async () => capture(async events => {
    const corrupt = frame({ type: 'message_start', message: { id: privateMarker } });
    corrupt[corrupt.length - 1] ^= 1;
    const response = await adaptBedrockAnthropicResponse(stream([corrupt]), 'eventstream', replay());
    expect(await response.text()).toContain('NATIVE_BEDROCK_STREAM_ERROR');
    expect(observations(events)).toContainEqual(expect.objectContaining({ outcome: 'failed', failureClass: 'frame-integrity' }));
    expect(JSON.stringify(events)).not.toContain(privateMarker);
  }));

  it('distinguishes replay persistence failure from incomplete upstream EOF', async () => capture(async events => {
    const storage: BedrockReplayState = { load: async () => null, save: async () => { throw new Error(privateMarker); } };
    const upstream = await bedrockToolResponse([{ type: 'tool_use', id: 'fixture_call', name: 'lookup', input: { value: privateMarker } }], 'eventstream');
    const text = await (await adaptBedrockAnthropicResponse(upstream, 'eventstream', storage)).text();
    expect(text).toContain('NATIVE_BEDROCK_STREAM_ERROR');
    expect(text).not.toMatch(/"finish_reason":"[^"]+"/);
    expect(observations(events)).toContainEqual(expect.objectContaining({ stage: 'native-replay', outcome: 'failed', failureClass: 'replay-persistence' }));
    expect(JSON.stringify(events)).not.toContain(privateMarker);
  }));

  it('observes upstream read failure without replacing the original thrown failure', async () => capture(async events => {
    let first = true;
    const originalFailure = new Error(privateMarker);
    const upstream = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (first) { first = false; controller.enqueue(start); } else controller.error(originalFailure);
    } }));
    const response = await adaptBedrockAnthropicResponse(upstream, 'eventstream', replay());
    await expect(response.text()).rejects.toBe(originalFailure);
    expect(observations(events)).toContainEqual(expect.objectContaining({ outcome: 'failed', failureClass: 'stream-read' }));
    expect(JSON.stringify(events)).not.toContain(privateMarker);
  }));

  it('observes consumer cancellation without retaining its private reason', async () => capture(async events => {
    let canceled = false;
    const upstream = new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } }));
    const response = await adaptBedrockAnthropicResponse(upstream, 'eventstream', replay());
    await response.body!.cancel(privateMarker);
    expect(canceled).toBe(true);
    expect(observations(events)).toContainEqual(expect.objectContaining({ outcome: 'canceled', transport: 'eventstream' }));
    expect(JSON.stringify(events)).not.toContain(privateMarker);
  }));

  it.each(['invoke', 'eventstream'] as const)('records successful %s replay and completion without signed state or tool identifiers', async transport => capture(async events => {
    const storage = replay();
    const blocks = [{ type: 'thinking', thinking: privateMarker, signature: `${privateMarker}_SIGNATURE` },
      { type: 'tool_use', id: 'fixture_private_tool_id', name: 'lookup', input: { secret: privateMarker } }];
    const response = await adaptBedrockAnthropicResponse(await bedrockToolResponse(blocks, transport), transport, storage, true);
    const turn = await readOpenAiToolTurn(response);
    expect(turn.finishes).toEqual(['tool_calls']);
    expect(turn.message.tool_calls[0].function.arguments).toBe(JSON.stringify({ secret: privateMarker }));
    expect(await storage.load('fixture_private_tool_id')).toEqual(blocks);
    const logs = observations(events);
    expect(logs).toContainEqual(expect.objectContaining({ stage: 'native-replay', outcome: 'completed', transport }));
    expect(logs).toContainEqual(expect.objectContaining({ stage: 'native-response', outcome: 'completed', transport, stopReason: 'tool_calls' }));
    const wire = JSON.stringify(events);
    expect(wire).not.toContain(privateMarker);
    expect(wire).not.toContain('fixture_private_tool_id');
  }));

  it.each(['invoke', 'eventstream'] as const)('logging outage cannot invalidate successful %s completion or replay', async transport => capture(async () => {
    const storage = replay();
    const block = { type: 'tool_use', id: 'fixture_call', name: 'lookup', input: { value: 'ok' } };
    const response = await adaptBedrockAnthropicResponse(await bedrockToolResponse([block], transport), transport, storage, true);
    expect((await readOpenAiToolTurn(response)).finishes).toEqual(['tool_calls']);
    expect(await storage.load('fixture_call')).toEqual([block]);
  }, true));
});
