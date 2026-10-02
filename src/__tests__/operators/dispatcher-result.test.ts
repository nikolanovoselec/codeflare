import { describe, expect, it } from 'vitest';
import { readDispatcherUpdates, type DispatcherResultProjection } from '../../operators/dispatcher-result';

const initial = (): DispatcherResultProjection => ({ offset: 'admission-offset', messageIds: [], writes: 0 });
const event = (index: number, body: Record<string, unknown>) => ({ conversationId: 'conversation', position: { batch: 1, index }, ...body });
const response = (events: unknown[], offset = 'next-offset') => new Response(JSON.stringify(events), {
  headers: { 'content-type': 'application/json', 'stream-next-offset': offset, 'stream-up-to-date': 'true' },
});
const result = { repository: 'owner/project', results: [] };
const start = event(0, { type: 'message-started', messageId: 'answer', submissionId: 'requested' });
const data = event(3, { type: 'data-part', messageId: 'answer', name: 'assessment', data: result });
const settled = event(4, { type: 'submission-settled', submissionId: 'requested', outcome: 'completed' });

describe('Dispatcher exact-submission public Flue updates contract', () => {
  it('accepts pinned SDK page checkpoints and retains immutable stream identity across reads', async () => {
    const checkpoint = { type: 'stream-checkpoint', incarnation: 'original-stream' };
    const first = await readDispatcherUpdates(response([checkpoint, start, data]), initial(), 'requested');
    const second = await readDispatcherUpdates(response([checkpoint, settled]), first, 'requested');
    expect(second).toMatchObject({ incarnation: 'original-stream', result, writes: 1, outcome: 'completed' });
    await expect(readDispatcherUpdates(response([{ ...checkpoint, incarnation: 'replacement-stream' }]), first, 'requested'))
      .rejects.toThrow('Dispatcher stream incarnation changed');
    for (const incarnation of ['', 42, 'x'.repeat(513)]) {
      await expect(readDispatcherUpdates(response([{ ...checkpoint, incarnation }]), initial(), 'requested'))
        .rejects.toThrow('Dispatcher stream incarnation changed');
    }
  });
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
      conversationId: 'conversation', messages: [{ id: 'foreign', submissionId: 'foreign', parts: [{ type: 'data-assessment', data: { private: true } }] },
        { id: 'answer', submissionId: 'requested', parts: [{ type: 'data-assessment', data: result }] }],
      settlements: [{ submissionId: 'requested', outcome: 'completed' }],
    } })]), initial(), 'requested');
    expect(projection).toMatchObject({ messageIds: ['answer'], result, writes: 1, outcome: 'completed' });
  });
  it.each([{ parts: [] }, { parts: [{ type: 'data-result', data: { repository: 'replacement/project', results: [] } }] }])(
    'preserves the observed result fence when an advancing reset omits or replaces it (%j)', async ({ parts }) => {
      const observed = await readDispatcherUpdates(response([start, data], 'observed-page'), initial(), 'requested');
      const reset = event(5, { type: 'conversation-reset', snapshot: {
        conversationId: 'conversation',
        messages: [{ id: 'answer', submissionId: 'requested', parts }], settlements: [],
      } });
      await expect(readDispatcherUpdates(response([reset], 'reset-page'), observed, 'requested'))
        .rejects.toThrow('Dispatcher immutable result changed');
      expect(observed).toMatchObject({ offset: 'observed-page', result, writes: 1 });
      const completed = await readDispatcherUpdates(response([settled], 'settled-page'), observed, 'requested');
      expect(completed).toMatchObject({ result, writes: 1, outcome: 'completed' });
    },
  );
  it('reconstructs an identical observed result once across advancing pages and refuses a later replacement', async () => {
    const observed = await readDispatcherUpdates(response([start, data], 'observed-page'), initial(), 'requested');
    const reset = event(5, { type: 'conversation-reset', snapshot: {
      conversationId: 'conversation', messages: [{ id: 'answer', submissionId: 'requested',
        parts: [{ type: 'data-result', data: result }] }], settlements: [],
    } });
    const reconstructed = await readDispatcherUpdates(response([reset], 'reset-page'), observed, 'requested');
    await expect(readDispatcherUpdates(response([event(6, { type: 'data-part', messageId: 'answer',
      name: 'result', data: { repository: 'replacement/project', results: [] } })], 'replacement-page'), reconstructed, 'requested'))
      .rejects.toThrow('Dispatcher result duplicated');
    const completed = await readDispatcherUpdates(response([event(7, { type: 'submission-settled',
      submissionId: 'requested', outcome: 'completed' })], 'settled-page'), reconstructed, 'requested');
    expect(completed).toMatchObject({ result, writes: 1, outcome: 'completed' });
  });
  it('projects a multi-megabyte compaction snapshot without retaining irrelevant SDK tool data', async () => {
    const snapshot = { conversationId: 'conversation', messages: [
      { id: 'foreign', submissionId: 'foreign', parts: [{ type: 'dynamic-tool', output: 'x'.repeat(2 * 1024 * 1024) }] },
      { id: 'answer', submissionId: 'requested', parts: [
        { type: 'text', text: 'y'.repeat(2 * 1024 * 1024) }, { type: 'data-result', data: result }] },
    ], settlements: [{ submissionId: 'requested', outcome: 'completed' }] };
    const projection = await readDispatcherUpdates(response([event(5, { type: 'conversation-reset', snapshot })]), initial(), 'requested');
    expect(projection).toMatchObject({ result, outcome: 'completed', messageIds: ['answer'] });
    expect(JSON.stringify(projection).length).toBeLessThan(1000);
  });
  it('rejects a changed conversation and contradictory terminal outcomes', async () => {
    await expect(readDispatcherUpdates(response([start, { ...data, conversationId: 'foreign' }]), initial(), 'requested')).rejects.toThrow('conversation changed');
    await expect(readDispatcherUpdates(response([start, data, settled,
      event(5, { type: 'submission-settled', submissionId: 'requested', outcome: 'failed' })]), initial(), 'requested')).rejects.toThrow('terminal settlement changed');
  });
  it('keeps a nonterminal page resumable and refuses a stalled paging cursor', async () => {
    const page = response([start, data], 'page-two');
    page.headers.delete('stream-up-to-date');
    const projection = await readDispatcherUpdates(page, initial(), 'requested');
    expect(projection).toMatchObject({ upToDate: false, offset: 'page-two', result });
    const last = await readDispatcherUpdates(response([settled], 'head'), projection, 'requested');
    expect(last).toMatchObject({ upToDate: true, outcome: 'completed', result });
    const stalled = response([], 'page-two');
    stalled.headers.delete('stream-up-to-date');
    await expect(readDispatcherUpdates(stalled, projection, 'requested')).rejects.toThrow('cursor stalled');
  });
  it('cancels a stalled updates reader rather than continuing after the parent deadline', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('[')); } });
    const body = new Response(stream, { headers: { 'content-type': 'application/json', 'stream-next-offset': 'next' } });
    const controller = new AbortController();
    const pending = readDispatcherUpdates(body, initial(), 'requested', controller.signal);
    controller.abort(new Error('Parent deadline expired'));
    await expect(pending).rejects.toThrow('Parent deadline expired');
    const reader = stream.getReader();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    reader.releaseLock();
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
  it('discards large irrelevant records rather than buffering SDK history', async () => {
    const projection = await readDispatcherUpdates(response([start,
      event(1, { type: 'tool-output', output: 'x'.repeat(1024 * 1024) }), data, settled]), initial(), 'requested');
    expect(projection).toMatchObject({ result, outcome: 'completed' });
    expect(JSON.stringify(projection).length).toBeLessThan(1000);
  });
  it('rejects aggregate pages and final results beyond their distinct byte contracts', async () => {
    await expect(readDispatcherUpdates(response([event(0, { type: 'tool-output', output: 'x'.repeat(16 * 1024 * 1024) })]), initial(), 'requested')).rejects.toThrow('Dispatcher update page exceeds limit');
    await expect(readDispatcherUpdates(response([start, { ...data, data: { text: 'x'.repeat(65536) } }]), initial(), 'requested')).rejects.toThrow('Dispatcher projected value exceeds limit');
  });
});
