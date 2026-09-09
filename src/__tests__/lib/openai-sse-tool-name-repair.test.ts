import { describe, expect, it } from 'vitest';
import { repairRepeatedCompleteToolNames } from '../../lib/openai-sse-tool-name-repair';

async function run(events: string[], names: string[]): Promise<string> {
  const input = new ReadableStream<Uint8Array>({ start(controller) { const encoder = new TextEncoder(); for (const event of events) controller.enqueue(encoder.encode(event)); controller.close(); } });
  return new Response(input.pipeThrough(repairRepeatedCompleteToolNames(names))).text();
}

describe('REQ-ENTERPRISE-050 Bedrock tool-name repair', () => {
  it('REQ-ENTERPRISE-050: suppresses only repeated complete Bedrock tool names', async () => {
    const first = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"lookup","arguments":""}}]}}]}\n\n';
    const repeated = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup","arguments":"{\\"x\\":1}"}}]}}]}\n\n';
    const output = await run([first, repeated, 'data: [DONE]\n\n'], ['lookup']);
    expect(output.match(/lookup/g)).toHaveLength(1);
    expect(output).toContain('{\\"x\\":1}');
    expect(output).toContain('"id":"call"');
  });

  it('REQ-ENTERPRISE-050: leaves ordinary fragmented tool names and Dynamic Route streams unchanged', async () => {
    const fragments = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"look","arguments":"a"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"up","arguments":"b"}}]}}]}\n\n',
    ];
    expect(await run(fragments, ['lookup'])).toBe(fragments.join(''));
    const ambiguous = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"go","arguments":""}}]}}]}\n\n';
    expect((await run([ambiguous, ambiguous], ['good'])).match(/go/g)).toHaveLength(2);
  });

  it('keeps parallel choice and tool-call state independent', async () => {
    const first = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup"}}]}}]}\n\n';
    const parallel = 'data: {"metadata":{"function":{"name":"outside"}},"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"name":""}},{"index":2,"function":{"name":"lookup"}},{"index":0,"metadata":{"function":{"name":"inside"}},"function":{"metadata":{"name":"keep"},"name":"lookup"}}]}}]}\n\n';
    const output = await run([first, parallel], ['lookup']);
    expect(output).toContain('"metadata":{"function":{"name":"outside"}}');
    expect(output).toContain('"metadata":{"function":{"name":"inside"}},"function"');
    expect(output).toContain('{"index":1,"function":{"name":""}}');
    expect(output).toContain('{"index":2,"function":{"name":"lookup"}}');
    expect(output).toContain('{"index":0,"metadata":{"function":{"name":"inside"}},"function":{"metadata":{"name":"keep"},"name":""}}');
  });

  it('passes malformed, truncated, and already-repaired framing through unchanged', async () => {
    const input = ['data: {not-json}\n\n', 'data: {"choices":[]}', '\n\n'];
    expect(await run(input, ['lookup'])).toBe(input.join(''));
    expect(await run([await run(input, ['lookup'])], ['lookup'])).toBe(input.join(''));
  });

  it('preserves unrelated event bytes while suppressing a repeated name', async () => {
    const first = 'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"lookup"}}]}}]}\n';
    const repeated = 'data: { "choices" : [{"delta":{"tool_calls":[{"function":{"name" : "lookup", "arguments":"\\u263a\\/x"},"id":"call"}]}}], "usage" : null }\r\n';
    expect(await run([first, repeated], ['lookup'])).toBe(first + repeated.replace('"lookup",', '"",'));
  });

  it('bounds one incomplete event without rejecting a large chunk of complete events or split UTF-8', async () => {
    const complete = 'data: {"choices":[]}\n\n'.repeat(14_000);
    expect(await run([complete], ['lookup'])).toBe(complete);
    const oversized = `data: ${'x'.repeat(256 * 1024)}🙂`;
    const bytes = new TextEncoder().encode(oversized);
    const input = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.slice(0, bytes.length - 3)); controller.enqueue(bytes.slice(bytes.length - 3)); controller.close();
    } });
    expect(new Uint8Array(await new Response(input.pipeThrough(repairRepeatedCompleteToolNames(['lookup']))).arrayBuffer())).toEqual(bytes);
  });
});
