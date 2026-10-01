import { describe, expect, it } from 'vitest';
import { readDispatcherUpdates, type DispatcherResultProjection } from '../../operators/dispatcher-result';

const initial = (): DispatcherResultProjection => ({ offset: 'admission-offset', messageIds: [], writes: 0 });
const event = (index: number, body: Record<string, unknown>) => ({ conversationId: 'conversation', position: { batch: 1, index }, ...body });
const response = (events: unknown[], offset = 'next-offset') => new Response(JSON.stringify(events), {
  headers: { 'content-type': 'application/json', 'stream-next-offset': offset },
});
const result = { repository: 'owner/project', results: [] };
const start = event(0, { type: 'message-started', messageId: 'answer', submissionId: 'requested' });
const data = event(3, { type: 'data-part', messageId: 'answer', name: 'assessment', data: result });
const settled = event(4, { type: 'submission-settled', submissionId: 'requested', outcome: 'completed' });

describe('Dispatcher exact-submission public Flue updates contract', () => {
  it('collects compact result despite more than 64 KiB of unrelated SDK tool history', async () => {
    const projection = await readDispatcherUpdates(response([start,
      event(1, { type: 'tool-output', messageId: 'answer', output: 'x'.repeat(45000) }),
      event(2, { type: 'tool-output', messageId: 'answer', output: 'y'.repeat(45000) }), data, settled]), initial(), 'requested');
    expect(projection.result).toEqual(result);
    expect(projection.outcome).toBe('completed');
    expect(JSON.stringify(projection).length).toBeLessThan(1000);
  });
  it('resumes from durable projection and ignores replayed positions', async () => {
    const first = await readDispatcherUpdates(response([start, data], 'opaque-first'), initial(), 'requested');
    const second = await readDispatcherUpdates(response([data, settled], 'opaque-second'), first, 'requested');
    expect(second).toMatchObject({ offset: 'opaque-second', result, writes: 1, outcome: 'completed' });
    expect(first.outcome).toBeUndefined();
  });
  it('does not collect another submission result or settlement', async () => {
    const projection = await readDispatcherUpdates(response([
      event(0, { type: 'message-started', messageId: 'other', submissionId: 'foreign' }),
      event(1, { type: 'data-part', messageId: 'other', name: 'assessment', data: result }),
      event(2, { type: 'submission-settled', submissionId: 'foreign', outcome: 'completed' }),
    ]), initial(), 'requested');
    expect(projection.result).toBeUndefined();
    expect(projection.outcome).toBeUndefined();
  });
  it('rebuilds only requested submission state at a documented compaction reset', async () => {
    const projection = await readDispatcherUpdates(response([event(5, { type: 'conversation-reset', snapshot: {
      messages: [{ id: 'foreign', submissionId: 'foreign', parts: [{ type: 'data-assessment', data: { private: true } }] },
        { id: 'answer', submissionId: 'requested', parts: [{ type: 'data-assessment', data: result }] }],
      settlements: [{ submissionId: 'requested', outcome: 'completed' }],
    } })]), initial(), 'requested');
    expect(projection).toMatchObject({ messageIds: ['answer'], result, writes: 1, outcome: 'completed' });
  });
  it('rejects duplicate final writes rather than choosing a fabricated last result', async () => {
    await expect(readDispatcherUpdates(response([start, data, { ...data, position: { batch: 1, index: 4 } }]), initial(), 'requested'))
      .rejects.toThrow('Dispatcher result duplicated');
  });
  it.each(['[{},]', '[,]', '[{}{}]', '[', '[]garbage'])('rejects malformed update wire %s without advancing durable state', async body => {
    const previous = initial();
    await expect(readDispatcherUpdates(new Response(body, { headers: { 'content-type': 'application/json', 'stream-next-offset': 'next' } }), previous, 'requested')).rejects.toThrow();
    expect(previous).toEqual(initial());
  });
  it('handles UTF-8 and quoted delimiters split across transport reads', async () => {
    const special = { comment: '🙂 quoted " } ] and slash \\ end' };
    const bytes = new TextEncoder().encode(JSON.stringify([start, { ...data, data: special }, settled]));
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3));
      controller.close();
    } });
    const projection = await readDispatcherUpdates(new Response(stream, { headers: { 'content-type': 'application/json', 'stream-next-offset': 'next' } }), initial(), 'requested');
    expect(projection.result).toEqual(special);
  });
  it('rejects oversized individual SDK records and oversized final results', async () => {
    await expect(readDispatcherUpdates(response([event(0, { type: 'tool-output', output: 'x'.repeat(1024 * 1024) })]), initial(), 'requested')).rejects.toThrow('Dispatcher update exceeds limit');
    await expect(readDispatcherUpdates(response([start, { ...data, data: { text: 'x'.repeat(65536) } }]), initial(), 'requested')).rejects.toThrow('Dispatcher result unavailable');
  });
});
