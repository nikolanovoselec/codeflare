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
  // Intentional SDK diagnostic wire: closed outcomes, never tool inputs/outputs/errors.
  it.each(['tool-output', 'tool-output-error'])('REQ-OPERATOR-063: observes completion %s across pages without retaining private payloads', async type => {
    const requested = event(1, { type: 'tool-input', messageId: 'answer', toolCallId: 'finish-1',
      toolName: 'finish_dispatcher', input: { secret: 'PRIVATE_TOOL_INPUT' } });
    const first = await readDispatcherUpdates(response([start, requested], 'first'), initial(), 'requested');
    expect(Reflect.get(first, 'completion')).toEqual({ calls: [{ id: 'finish-1', outcome: 'pending' }], truncated: false });
    const outcome = event(2, { type, toolCallId: 'finish-1', output: 'PRIVATE_TOOL_OUTPUT', errorText: 'PRIVATE_TOOL_ERROR' });
    const final = await readDispatcherUpdates(response([outcome, data, settled]), first, 'requested');
    expect(Reflect.get(final, 'completion')).toEqual({ calls: [{ id: 'finish-1',
      outcome: type === 'tool-output' ? 'succeeded' : 'failed' }], truncated: false });
    expect(final).toMatchObject({ result, writes: 1, outcome: 'completed' });
    expect(JSON.stringify(final)).not.toContain('PRIVATE_TOOL');
    const repeated = await readDispatcherUpdates(response([outcome, data, settled]), final, 'requested');
    expect(repeated).toEqual(final);
  });
  it('REQ-OPERATOR-063: reconstructs completion metadata only for the requested submission at an SDK reset', async () => {
    const reset = event(5, { type: 'conversation-reset', snapshot: { conversationId: 'conversation', messages: [
      { id: 'foreign', submissionId: 'foreign', parts: [{ type: 'dynamic-tool', toolName: 'finish_dispatcher',
        toolCallId: 'foreign-finish', state: 'output-error', errorText: 'PRIVATE_TOOL_ERROR' }] },
      { id: 'answer', submissionId: 'requested', parts: [{ type: 'dynamic-tool', toolName: 'finish_dispatcher',
        toolCallId: 'finish-1', state: 'output-available', output: 'PRIVATE_TOOL_OUTPUT' }, { type: 'data-result', data: result }] },
    ], settlements: [{ submissionId: 'requested', outcome: 'completed' }] } });
    const final = await readDispatcherUpdates(response([reset]), initial(), 'requested');
    expect(Reflect.get(final, 'completion')).toEqual({ calls: [{ id: 'finish-1', outcome: 'succeeded' }], truncated: false });
    expect(final).toMatchObject({ result, writes: 1, outcome: 'completed' });
    expect(JSON.stringify(final)).not.toMatch(/PRIVATE_TOOL|foreign-finish/);
  });
  it('REQ-OPERATOR-063: later compaction cannot erase a previously observed completion outcome', async () => {
    const first = await readDispatcherUpdates(response([start,
      event(1, { type: 'tool-input', messageId: 'answer', toolCallId: 'finish-1', toolName: 'finish_dispatcher' }),
      event(2, { type: 'tool-output-error', toolCallId: 'finish-1', errorText: 'PRIVATE_TOOL_ERROR' }),
    ]), initial(), 'requested');
    const final = await readDispatcherUpdates(response([event(5, { type: 'conversation-reset', snapshot: {
      conversationId: 'conversation', messages: [{ id: 'answer', submissionId: 'requested', parts: [] }], settlements: [],
    } })]), first, 'requested');
    expect(Reflect.get(final, 'completion')).toEqual({ calls: [{ id: 'finish-1', outcome: 'failed' }], truncated: false });
    expect(final.result).toBeUndefined();
  });
  it('REQ-OPERATOR-063: caps completion observations without denying valid result collection', async () => {
    const inputs = Array.from({ length: 40 }, (_, index) => event(index + 1, { type: 'tool-input', messageId: 'answer',
      toolName: 'finish_dispatcher', toolCallId: `finish-${index}` }));
    const final = await readDispatcherUpdates(response([start, ...inputs,
      event(41, { ...data, position: undefined }), event(42, { ...settled, position: undefined }),
    ].map((item, index) => ({ ...item, position: { batch: 1, index } }))), initial(), 'requested');
    const diagnostics = Reflect.get(final, 'completion') as { calls: unknown[]; truncated: boolean };
    expect(diagnostics.calls).toHaveLength(32);
    expect(diagnostics.truncated).toBe(true);
    expect(final).toMatchObject({ result, writes: 1, outcome: 'completed' });
  });
  it('REQ-OPERATOR-063: oversized diagnostic metadata cannot deny an otherwise valid assessment', async () => {
    const final = await readDispatcherUpdates(response([start,
      event(1, { type: 'tool-input', messageId: 'answer', toolName: 'finish_dispatcher', toolCallId: 'x'.repeat(100000) }),
      event(2, { type: 'tool-input', messageId: 'answer', toolName: 'x'.repeat(100000), toolCallId: 'unrelated' }),
      data, settled,
    ]), initial(), 'requested');
    expect(final).toMatchObject({ result, writes: 1, outcome: 'completed' });
    expect(final.completion).toEqual({ calls: [], truncated: true });
    expect(JSON.stringify(final).length).toBeLessThan(1000);
  });
  it.each(['overflow', 'invalid-state'] as const)('REQ-OPERATOR-063: requested reset %s preserves truthful truncation and valid collection', async mode => {
    const parts = Array.from({ length: mode === 'overflow' ? 40 : 1 }, (_, index) => ({
      type: 'dynamic-tool', toolName: 'finish_dispatcher', toolCallId: `finish-${index}`,
      state: mode === 'overflow' ? 'output-available' : false,
    }));
    const final = await readDispatcherUpdates(response([event(5, { type: 'conversation-reset', snapshot: {
      conversationId: 'conversation', messages: [{ id: 'answer', submissionId: 'requested',
        parts: [...parts, { type: 'data-result', data: result }] }],
      settlements: [{ submissionId: 'requested', outcome: 'completed' }],
    } })]), initial(), 'requested');
    expect(final.completion).toEqual({ calls: parts.slice(0, 32).map(part => ({ id: part.toolCallId,
      outcome: mode === 'overflow' ? 'succeeded' : 'pending' })), truncated: true });
    expect(final).toMatchObject({ result, writes: 1, outcome: 'completed' });
  });
  it.each(['oversized', 'overflow'] as const)('REQ-OPERATOR-063: foreign reset %s and unrelated invalid metadata cannot mark completion truncation', async mode => {
    const foreignParts = Array.from({ length: mode === 'overflow' ? 40 : 1 }, (_, index) => ({
      type: 'dynamic-tool', toolName: 'finish_dispatcher',
      toolCallId: mode === 'oversized' ? 'x'.repeat(257) : `foreign-${index}`, state: 'output-available',
    }));
    const final = await readDispatcherUpdates(response([event(5, { type: 'conversation-reset', snapshot: {
      conversationId: 'conversation', messages: [
        // JSON member order must not grant foreign observations current-submission attribution.
        { id: 'foreign', parts: foreignParts, submissionId: 'foreign' },
        { id: 'answer', submissionId: 'requested', parts: [{ type: 'dynamic-tool', toolName: 'other_tool',
          toolCallId: null, state: false }, { type: 'data-result', data: result }] },
      ], settlements: [{ submissionId: 'requested', outcome: 'completed' }],
    } })]), initial(), 'requested');
    expect(final.completion).toBeUndefined();
    expect(final).toMatchObject({ result, writes: 1, outcome: 'completed' });
  });
  it('REQ-OPERATOR-063: unassociated assessment is observable but cannot authorize a result', async () => {
    const final = await readDispatcherUpdates(response([start,
      event(1, { type: 'data-part', messageId: 'unknown-message', name: 'assessment', data: { private: 'PRIVATE_ASSESSMENT' } }),
      settled,
    ]), initial(), 'requested');
    expect(Reflect.get(final, 'unmatchedAssessment')).toBe(true);
    expect(final).toMatchObject({ writes: 0, outcome: 'completed' });
    expect(final.result).toBeUndefined();
    expect(JSON.stringify(final)).not.toContain('PRIVATE_ASSESSMENT');
  });
  it.each(['short', 'oversized', 'invalid'] as const)('REQ-OPERATOR-063: foreign and unrelated tools cannot create completion observations (%s)', async mode => {
    const foreignId = mode === 'short' ? 'foreign-finish' : mode === 'oversized' ? 'x'.repeat(257) : null;
    const unrelatedId = mode === 'short' ? 'other-tool' : mode === 'oversized' ? 'y'.repeat(257) : null;
    const final = await readDispatcherUpdates(response([start,
      event(1, { type: 'tool-input', messageId: 'foreign', toolCallId: foreignId, toolName: 'finish_dispatcher' }),
      event(2, { type: 'tool-output', toolCallId: foreignId, output: 'PRIVATE_TOOL_OUTPUT' }),
      event(3, { type: 'tool-input', messageId: 'answer', toolCallId: unrelatedId, toolName: 'PRIVATE_TOOL_NAME' }),
      event(4, { type: 'tool-output-error', toolCallId: unrelatedId, errorText: 'PRIVATE_TOOL_ERROR' }),
      event(5, { type: 'data-part', messageId: 'answer', name: 'assessment', data: result }),
      event(6, { type: 'submission-settled', submissionId: 'requested', outcome: 'completed' }),
    ]), initial(), 'requested');
    expect(Reflect.get(final, 'completion')).toBeUndefined();
    expect(final).toMatchObject({ result, writes: 1, outcome: 'completed' });
    expect(JSON.stringify(final)).not.toContain('PRIVATE_TOOL');
  });
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
  // Intentional readiness.v1 wire: closed producer metadata is not an assessment or authority.
  const ready = { discovered: true, sealed: true, targetCount: 1, decisionCount: 1,
    resultCount: 1, unknownOperationCount: 0, category: 'ready' };
  const readinessPart = (index: number, value: unknown = ready, messageId = 'answer') =>
    event(index, { type: 'data-part', messageId, name: 'dispatcher-readiness', data: value });
  it('REQ-OPERATOR-063: readiness.v1 projects an exact producer snapshot without granting assessment authority', async () => {
    const projected = await readDispatcherUpdates(response([start, readinessPart(1), settled]), initial(), 'requested');
    expect(Reflect.get(projected, 'readiness')).toEqual({ latest: ready, observations: 1, truncated: false });
    expect(projected.writes).toBe(0); expect(projected.result).toBeUndefined(); expect(projected.outcome).toBe('completed');
  });
  it('REQ-OPERATOR-063: readiness.v1 carries the latest exact snapshot across pages', async () => {
    const incomplete = { ...ready, resultCount: 0, category: 'incomplete-results' };
    const first = await readDispatcherUpdates(response([start, readinessPart(1, incomplete)], 'first'), initial(), 'requested');
    const final = await readDispatcherUpdates(response([readinessPart(2), data, settled]), first, 'requested');
    expect(Reflect.get(final, 'readiness')).toEqual({ latest: ready, observations: 2, truncated: false });
    expect(final).toMatchObject({ writes: 1, result, outcome: 'completed' });
  });
  it('REQ-OPERATOR-063: readiness.v1 replay cannot consume the observation allowance twice', async () => {
    const first = await readDispatcherUpdates(response([start, readinessPart(1)]), initial(), 'requested');
    const final = await readDispatcherUpdates(response([readinessPart(1), data, settled]), first, 'requested');
    expect(Reflect.get(final, 'readiness')).toEqual({ latest: ready, observations: 1, truncated: false });
    expect(final.result).toEqual(result);
  });
  it('REQ-OPERATOR-063: readiness.v1 survives compaction which omits earlier producer metadata', async () => {
    const first = await readDispatcherUpdates(response([start, readinessPart(1)]), initial(), 'requested');
    const final = await readDispatcherUpdates(response([event(5, { type: 'conversation-reset', snapshot: {
      conversationId: 'conversation', messages: [{ id: 'answer', submissionId: 'requested', parts: [] }], settlements: [],
    } })]), first, 'requested');
    expect(Reflect.get(final, 'readiness')).toEqual({ latest: ready, observations: 1, truncated: false });
    expect(final.result).toBeUndefined();
  });
  it.each(['normal', 'member-order'])('REQ-OPERATOR-063: readiness.v1 selects exact reset metadata with %s ordering', async ordering => {
    const part = { type: 'data-dispatcher-readiness', data: ready };
    const exact = ordering === 'normal' ? { id: 'answer', submissionId: 'requested', parts: [part] }
      : { parts: [part], submissionId: 'requested', id: 'answer' };
    const final = await readDispatcherUpdates(response([event(5, { type: 'conversation-reset', snapshot: {
      conversationId: 'conversation', messages: [{ id: 'foreign', submissionId: 'foreign', parts: [
        { type: 'data-dispatcher-readiness', data: { ...ready, category: 'PRIVATE_FOREIGN_VALUE' } },
      ] }, exact], settlements: [{ submissionId: 'requested', outcome: 'completed' }],
    } })]), initial(), 'requested');
    expect(Reflect.get(final, 'readiness')).toEqual({ latest: ready, observations: 1, truncated: false });
    expect(final.writes).toBe(0); expect(JSON.stringify(final)).not.toContain('PRIVATE_FOREIGN_VALUE');
  });
  it('REQ-OPERATOR-063: foreign readiness.v1 records cannot create metadata or truncate exact metadata', async () => {
    const final = await readDispatcherUpdates(response([start,
      event(1, { type: 'message-started', messageId: 'other', submissionId: 'foreign' }),
      readinessPart(2, { ...ready, category: 'PRIVATE_FOREIGN_VALUE'.repeat(1000) }, 'other'), data, settled,
    ]), initial(), 'requested');
    expect(Reflect.get(final, 'readiness')).toBeUndefined(); expect(final.result).toEqual(result);
    expect(JSON.stringify(final)).not.toContain('PRIVATE_FOREIGN_VALUE');
  });
  it.each([
    ['extra-field', { ...ready, body: 'PRIVATE_PRODUCER_CONTENT' }],
    ['missing-field', { category: 'ready' }],
    ['wrong-category', { ...ready, category: 'PRIVATE_PRODUCER_CONTENT' }],
    ['wrong-flag', { ...ready, discovered: 'PRIVATE_PRODUCER_CONTENT' }],
    ['negative-count', { ...ready, resultCount: -1 }],
    ['fractional-count', { ...ready, resultCount: 0.5 }],
    ['unsafe-count', { ...ready, resultCount: Number.MAX_SAFE_INTEGER + 1 }],
    ['oversized', { ...ready, category: 'PRIVATE_PRODUCER_CONTENT'.repeat(5000) }],
  ])('REQ-OPERATOR-063: invalid readiness.v1 %s cannot retain content or deny a valid assessment', async (_caseName, value) => {
    const final = await readDispatcherUpdates(response([start, readinessPart(1, value), data, settled]), initial(), 'requested');
    expect(Reflect.get(final, 'readiness')).toEqual({ observations: 1, truncated: true });
    expect(final).toMatchObject({ writes: 1, result, outcome: 'completed' });
    expect(JSON.stringify(final)).not.toContain('PRIVATE_PRODUCER_CONTENT');
  });
  it('REQ-OPERATOR-063: readiness.v1 keeps latest valid metadata when a later record is invalid', async () => {
    const final = await readDispatcherUpdates(response([start, readinessPart(1),
      readinessPart(2, { ...ready, category: 'PRIVATE_PRODUCER_CONTENT' }), data, settled]), initial(), 'requested');
    expect(Reflect.get(final, 'readiness')).toEqual({ latest: ready, observations: 2, truncated: true });
    expect(final.result).toEqual(result);
  });
  it('REQ-OPERATOR-063: readiness.v1 caps observation work at32 without consuming result allowance', async () => {
    const parts = Array.from({ length: 40 }, (_, index) => readinessPart(index + 1,
      { ...ready, resultCount: index, category: 'incomplete-results' }));
    const final = await readDispatcherUpdates(response([start, ...parts,
      event(41, { type: 'data-part', messageId: 'answer', name: 'assessment', data: result }),
      event(42, { type: 'submission-settled', submissionId: 'requested', outcome: 'completed' }),
    ]), initial(), 'requested');
    expect(Reflect.get(final, 'readiness')).toEqual({ latest: { ...ready, resultCount: 31, category: 'incomplete-results' },
      observations: 32, truncated: true });
    expect(final).toMatchObject({ writes: 1, result, outcome: 'completed' });
  });

  it('REQ-OPERATOR-063: readiness.v1 classifies data before name without retaining oversized content', async () => {
    const first = await readDispatcherUpdates(response([start,
      event(1, { data: ready, messageId: 'answer', name: 'dispatcher-readiness', type: 'data-part' }),
      event(2, { data: { ...ready, category: 'PRIVATE_PRODUCER_CONTENT'.repeat(5000) },
        messageId: 'answer', name: 'dispatcher-readiness', type: 'data-part' }), data, settled,
    ]), initial(), 'requested');
    expect(Reflect.get(first, 'readiness')).toEqual({ latest: ready, observations: 2, truncated: true });
    expect(first).toMatchObject({ writes: 1, result, outcome: 'completed' });
    expect(JSON.stringify(first)).not.toContain('PRIVATE_PRODUCER_CONTENT');
  });
  it('REQ-OPERATOR-063: readiness.v1 reset classifies data before type without changing assessment denial', async () => {
    const reset = event(5, { type: 'conversation-reset', snapshot: { conversationId: 'conversation', messages: [
      { parts: [{ data: ready, type: 'data-dispatcher-readiness' }], submissionId: 'requested', id: 'answer' },
    ], settlements: [] } });
    const projected = await readDispatcherUpdates(response([reset]), initial(), 'requested');
    expect(Reflect.get(projected, 'readiness')).toEqual({ latest: ready, observations: 1, truncated: false });
    expect(projected.writes).toBe(0); expect(projected.result).toBeUndefined();
    const oversizedAssessment = event(6, { data: { body: 'x'.repeat(100000) }, messageId: 'answer', name: 'assessment', type: 'data-part' });
    await expect(readDispatcherUpdates(response([oversizedAssessment]), projected, 'requested')).rejects.toThrow('Dispatcher projected value exceeds limit');
  });

});
