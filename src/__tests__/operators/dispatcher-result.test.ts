import { describe, expect, it } from 'vitest';
import { readDispatcherUpdates, type DispatcherResultProjection } from '../../operators/dispatcher-result';
import type { DispatcherCapacityPolicy } from '../../operators/dispatcher-capacity-limits';

const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
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
  // Intent4 functional wire: an owned phase checkpoint is neither assessment nor terminal proof.
  const checkpointTarget = { pullRequest: 17, headSha: 'a'.repeat(40) };
  const checkpoint = { version: 1, scope: 'submission', generation: 1, submissionId: 'requested',
    phase: { kind: 'discovery' }, targets: [checkpointTarget], next: { kind: 'target', index: 0, target: checkpointTarget } };
  const progress = (index: number, value: unknown = checkpoint) => event(index, {
    type: 'data-part', messageId: 'answer', name: 'dispatcher-progress', data: value,
  });
  it('REQ-OPERATOR-048: functional progress survives paging without inventing assessment or settlement', async () => {
    const first = await readDispatcherUpdates(response([start, progress(1)], 'first'), initial(), 'requested');
    expect(first).toMatchObject({ progress: checkpoint, progressWrites: 1, writes: 0 });
    expect(first.result).toBeUndefined(); expect(first.outcome).toBeUndefined();
    const final = await readDispatcherUpdates(response([settled], 'terminal'), first, 'requested');
    expect(final).toMatchObject({ progress: checkpoint, progressWrites: 1, writes: 0, outcome: 'completed' });
    expect(final.result).toBeUndefined();
    expect(await readDispatcherUpdates(response([settled], 'terminal'), final, 'requested')).toEqual(final);
  });
  it('REQ-OPERATOR-048: a failed SDK phase retains failed settlement despite its progress checkpoint', async () => {
    const final = await readDispatcherUpdates(response([start, progress(1), event(2, {
      type: 'submission-settled', submissionId: 'requested', outcome: 'failed',
    })]), initial(), 'requested');
    expect(final).toMatchObject({ progress: checkpoint, progressWrites: 1, writes: 0, outcome: 'failed' });
    expect(final.result).toBeUndefined();
  });
  it('REQ-OPERATOR-048: unassociated functional progress cannot authorize the requested phase', async () => {
    const final = await readDispatcherUpdates(response([
      event(0, { type: 'message-started', messageId: 'foreign', submissionId: 'another' }),
      event(1, { type: 'data-part', messageId: 'foreign', name: 'dispatcher-progress', data: checkpoint }),
      settled,
    ]), initial(), 'requested');
    expect(final.progress).toBeUndefined(); expect(final.progressWrites).toBeUndefined();
    expect(final).toMatchObject({ writes: 0, outcome: 'completed' });
  });
  it('REQ-OPERATOR-048: duplicate functional progress refuses phase collection', async () => {
    await expect(readDispatcherUpdates(response([start, progress(1), progress(2)]), initial(), 'requested'))
      .rejects.toThrow('progress duplicated');
  });
  it.each([null, [], 1, 'checkpoint'])('REQ-OPERATOR-048: malformed functional progress %j cannot authorize a phase', async value => {
    await expect(readDispatcherUpdates(response([start, progress(1, value)]), initial(), 'requested'))
      .rejects.toThrow('progress unavailable');
  });
  it('REQ-OPERATOR-048: functional progress after terminal settlement is refused', async () => {
    await expect(readDispatcherUpdates(response([start, settled, progress(5)]), initial(), 'requested'))
      .rejects.toThrow('progress follows terminal');
  });
  it.each([false, true])('REQ-OPERATOR-048: reset progress binds only the exact submission with parts-first=%s', async partsFirst => {
    const ownedParts = [{ type: 'data-dispatcher-progress', data: checkpoint }];
    const foreignParts = [{ data: { PRIVATE_FOREIGN_VALUE: true }, type: 'data-dispatcher-progress' }];
    const owned = partsFirst ? { parts: ownedParts, id: 'answer', submissionId: 'requested' }
      : { id: 'answer', submissionId: 'requested', parts: ownedParts };
    const foreign = partsFirst ? { parts: foreignParts, id: 'foreign', submissionId: 'another' }
      : { id: 'foreign', submissionId: 'another', parts: foreignParts };
    const reset = event(5, { type: 'conversation-reset', snapshot: { conversationId: 'conversation',
      messages: [foreign, owned], settlements: [{ submissionId: 'requested', outcome: 'completed' }],
    } });
    const final = await readDispatcherUpdates(response([reset]), initial(), 'requested');
    expect(final).toMatchObject({ progress: checkpoint, progressWrites: 1, writes: 0, outcome: 'completed' });
    expect(JSON.stringify(final)).not.toContain('PRIVATE_FOREIGN_VALUE');
    expect(final.result).toBeUndefined();
  });
  it('REQ-OPERATOR-048: JSON member order cannot change a witnessed functional checkpoint', async () => {
    const first = await readDispatcherUpdates(response([start, progress(1)]), initial(), 'requested');
    const reordered = { next: { target: { headSha: checkpointTarget.headSha, pullRequest: checkpointTarget.pullRequest },
      index: 0, kind: 'target' }, targets: [{ headSha: checkpointTarget.headSha, pullRequest: checkpointTarget.pullRequest }],
      phase: { kind: 'discovery' }, submissionId: 'requested', generation: 1, scope: 'submission', version: 1 };
    const reset = event(5, { type: 'conversation-reset', snapshot: { conversationId: 'conversation',
      messages: [{ id: 'answer', submissionId: 'requested', parts: [{ type: 'data-dispatcher-progress', data: reordered }] }],
      settlements: [{ submissionId: 'requested', outcome: 'completed' }],
    } });
    const reconstructed = await readDispatcherUpdates(response([reset]), first, 'requested');
    expect(reconstructed.progress).toEqual(checkpoint);
    expect(reconstructed).toMatchObject({ progressWrites: 1, writes: 0, outcome: 'completed' });
  });
  it('REQ-OPERATOR-048: reset cannot change an already observed functional checkpoint', async () => {
    const first = await readDispatcherUpdates(response([start, progress(1)]), initial(), 'requested');
    const reset = event(5, { type: 'conversation-reset', snapshot: { conversationId: 'conversation',
      messages: [{ id: 'answer', submissionId: 'requested', parts: [
        { type: 'data-dispatcher-progress', data: { ...checkpoint, next: { kind: 'final' } } },
      ] }], settlements: [],
    } });
    await expect(readDispatcherUpdates(response([reset]), first, 'requested')).rejects.toThrow('immutable progress changed');
  });
  it('REQ-OPERATOR-048: functional checkpoint obeys the exact encoded UTF8 bound regardless of data member order', async () => {
    const allowance = 512;
    const base = { next: 'target', padding: '' };
    const remaining = allowance - jsonBytes(base);
    const exact = { ...base, padding: 'é'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2) };
    const dataFirst = (value: unknown) => event(1, { data: value, name: 'dispatcher-progress',
      messageId: 'answer', type: 'data-part' });
    expect(jsonBytes(exact)).toBe(allowance);
    const accepted = await readDispatcherUpdates(response([start, dataFirst(exact)]), initial(), 'requested',
      undefined, { assessmentBytes: allowance });
    expect(accepted.progress).toEqual(exact);
    await expect(readDispatcherUpdates(response([start, dataFirst({ ...exact, padding: exact.padding + 'x' })]),
      initial(), 'requested', undefined, { assessmentBytes: allowance })).rejects.toThrow('exceeds limit');
  });
  it.each(['tool-output', 'tool-output-error'])('REQ-OPERATOR-078: observes domain SDK %s outside callback boundaries without private input or error content', async type => {
    const first = await readDispatcherUpdates(response([start, event(1, { type: 'tool-input', messageId: 'answer',
      toolCallId: 'decision-1', toolName: 'decide_renovate', input: { comment: 'PRIVATE_TOOL_INPUT' } })]), initial(), 'requested');
    const final = await readDispatcherUpdates(response([event(2, { type, toolCallId: 'decision-1',
      output: 'PRIVATE_TOOL_OUTPUT', errorText: 'PRIVATE_TOOL_ERROR' }), data, settled], 'later'), first, 'requested');
    expect(final.tools).toEqual({ calls: [{ id: 'decision-1', role: 'decide', outcome: type === 'tool-output' ? 'succeeded' : 'failed' }], truncated: false });
    expect(JSON.stringify(final)).not.toMatch(/PRIVATE_TOOL/);
    expect(final.result).toEqual(result);
  });
  it('REQ-OPERATOR-078: reset observes exact-submission domain failure without retaining foreign tools or private content', async () => {
    const reset = event(1, { type: 'conversation-reset', snapshot: { conversationId: 'conversation',
      messages: [{ id: 'foreign', submissionId: 'another', parts: [{ type: 'dynamic-tool', toolName: 'merge_renovate', toolCallId: 'foreign-call', state: 'output-error' }] },
        { id: 'answer', submissionId: 'requested', parts: [{ type: 'dynamic-tool', toolName: 'decide_renovate', toolCallId: 'decision-1', state: 'output-error', input: 'PRIVATE_INPUT', errorText: 'PRIVATE_ERROR' }] }], settlements: [] } });
    const final = await readDispatcherUpdates(response([reset]), initial(), 'requested');
    expect(final.tools).toEqual({ calls: [{ id: 'decision-1', role: 'decide', outcome: 'failed' }], truncated: false });
    expect(JSON.stringify(final)).not.toMatch(/PRIVATE_|foreign-call|merge/);
    expect(final.result).toBeUndefined();
  });
  it('REQ-OPERATOR-079: requested reset overflow reports tool truncation without consuming completion or result authority', async () => {
    const parts = Array.from({ length: 2049 }, (_, index) => ({ type: 'dynamic-tool', toolName: 'decide_renovate',
      toolCallId: `decision-${index}`, state: index === 2048 ? 'output-error' : 'output-available' }));
    const snapshot = { conversationId: 'conversation', messages: [{ id: 'answer', submissionId: 'requested', parts: [
      ...parts, { type: 'dynamic-tool', toolName: 'finish_dispatcher', toolCallId: 'finish', state: 'output-available' },
      { type: 'data-assessment', data: result }] }], settlements: [{ submissionId: 'requested', outcome: 'completed' }] };
    const final = await readDispatcherUpdates(response([event(1, { type: 'conversation-reset', snapshot })]), initial(), 'requested', undefined, { toolObservationLimit: 2048 });
    expect(final.tools?.calls).toHaveLength(2048);
    expect(final.tools?.truncated).toBe(true);
    expect(final.completion).toEqual({ calls: [{ id: 'finish', outcome: 'succeeded' }], truncated: false });
    expect(final).toMatchObject({ writes: 1, result, outcome: 'completed' });
  });
  it.each([false, true])('REQ-OPERATOR-079: foreign reset overflow with parts-first=%s cannot truncate requested tool observations', async partsFirst => {
    const parts = Array.from({ length: 2049 }, (_, index) => ({ type: 'dynamic-tool', toolName: 'decide_renovate',
      toolCallId: `foreign-${index}`, state: 'output-error' }));
    const foreign = partsFirst ? { parts, id: 'foreign', submissionId: 'another' } : { id: 'foreign', submissionId: 'another', parts };
    const snapshot = { conversationId: 'conversation', messages: [foreign, { id: 'answer', submissionId: 'requested', parts: [
      { type: 'dynamic-tool', toolName: 'research_renovate', toolCallId: 'requested-tool', state: 'output-available' },
      { type: 'data-assessment', data: result }] }], settlements: [{ submissionId: 'requested', outcome: 'completed' }] };
    const final = await readDispatcherUpdates(response([event(1, { type: 'conversation-reset', snapshot })]), initial(), 'requested', undefined, { toolObservationLimit: 2048 });
    expect(final.tools).toEqual({ calls: [{ id: 'requested-tool', role: 'research', outcome: 'succeeded' }], truncated: false });
    expect(final).toMatchObject({ writes: 1, result, outcome: 'completed' });
    expect(final.completion).toBeUndefined();
  });
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
    ].map((item, index) => ({ ...item, position: { batch: 1, index } }))), initial(), 'requested', undefined, { completionObservationLimit: 32 });
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
    } })]), initial(), 'requested', undefined, { completionObservationLimit: 32 });
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
    } })]), initial(), 'requested', undefined, { completionObservationLimit: 32 });
    expect(final.completion).toBeUndefined();
    expect(final).toMatchObject({ result, writes: 1, outcome: 'completed' });
  });
  it.each([32, 40].flatMap(foreignCount => [false, true].flatMap(foreignPartsFirst =>
    [false, true].flatMap(requestedPartsFirst => ['output-available', 'output-error'].map(state =>
      ({ foreignCount, foreignPartsFirst, requestedPartsFirst, state }))))))(
    'REQ-OPERATOR-063: foreign reset calls cannot hide requested completion ($foreignCount/$foreignPartsFirst/$requestedPartsFirst/$state)',
    async ({ foreignCount, foreignPartsFirst, requestedPartsFirst, state }) => {
      const foreignParts = Array.from({ length: foreignCount }, (_, index) => ({
        type: 'dynamic-tool', toolName: 'finish_dispatcher', toolCallId: `foreign-${index}`,
        state: 'output-available', output: 'PRIVATE_TOOL_OUTPUT',
      }));
      const requestedParts = [{ type: 'dynamic-tool', toolName: 'finish_dispatcher',
        toolCallId: 'requested-finish', state, errorText: 'PRIVATE_TOOL_ERROR' }, { type: 'data-result', data: result }];
      const reset = event(5, { type: 'conversation-reset', snapshot: {
        conversationId: 'conversation', messages: [
          foreignPartsFirst ? { id: 'foreign', parts: foreignParts, submissionId: 'foreign' }
            : { id: 'foreign', submissionId: 'foreign', parts: foreignParts },
          requestedPartsFirst ? { id: 'answer', parts: requestedParts, submissionId: 'requested' }
            : { id: 'answer', submissionId: 'requested', parts: requestedParts },
        ], settlements: [{ submissionId: 'requested', outcome: 'completed' }],
      } });
      const final = await readDispatcherUpdates(response([reset]), initial(), 'requested', undefined, { completionObservationLimit: 32 });
      expect(final.completion).toEqual({ calls: [{ id: 'requested-finish',
        outcome: state === 'output-available' ? 'succeeded' : 'failed' }], truncated: false });
      expect(final).toMatchObject({ result, writes: 1, outcome: 'completed', messageIds: ['answer'] });
      expect(JSON.stringify(final)).not.toMatch(/foreign-|PRIVATE_TOOL/);
      expect(await readDispatcherUpdates(response([reset]), final, 'requested', undefined, { completionObservationLimit: 32 })).toEqual(final);
    });
  it.each([false, true])('REQ-OPERATOR-063: reset completion cap remains shared across requested messages (parts first=%s)', async partsFirst => {
    const messages = [0, 1].map(messageIndex => {
      const parts = Array.from({ length: 20 }, (_, index) => ({ type: 'dynamic-tool', toolName: 'finish_dispatcher',
        toolCallId: `requested-${messageIndex * 20 + index}`, state: 'output-available' }));
      return partsFirst ? { id: `answer-${messageIndex}`, parts, submissionId: 'requested' }
        : { id: `answer-${messageIndex}`, submissionId: 'requested', parts };
    });
    const final = await readDispatcherUpdates(response([event(5, { type: 'conversation-reset', snapshot: {
      conversationId: 'conversation', messages: [...messages,
        { id: 'assessment', submissionId: 'requested', parts: [{ type: 'data-result', data: result }] }],
      settlements: [{ submissionId: 'requested', outcome: 'completed' }],
    } })]), initial(), 'requested', undefined, { completionObservationLimit: 32 });
    expect(final.completion).toEqual({ calls: Array.from({ length: 32 }, (_, index) =>
      ({ id: `requested-${index}`, outcome: 'succeeded' })), truncated: true });
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
      event(2, { type: 'tool-output', messageId: 'answer', output: 'y'.repeat(45000) }), data, settled]), initial(), 'requested', undefined, { assessmentBytes: 65536 });
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
    const pending = readDispatcherUpdates(body, initial(), 'requested', controller.signal, { updatePageBytes: 128 });
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
    await expect(readDispatcherUpdates(response([event(0, { type: 'tool-output', output: 'x'.repeat(16 * 1024 * 1024) })]), initial(), 'requested', undefined, { updatePageBytes: 16 * 1024 * 1024, assessmentBytes: 65536 })).rejects.toThrow('Dispatcher update page exceeds limit');
    await expect(readDispatcherUpdates(response([start, { ...data, data: { text: 'x'.repeat(65536) } }]), initial(), 'requested', undefined, { updatePageBytes: 16 * 1024 * 1024, assessmentBytes: 65536 })).rejects.toThrow('Dispatcher projected value exceeds limit');
  });
  // Intentional seal-preflight.v1 closed wire: never an assessment or authority.
  const sealReady = { category: 'ready', targetCount: 1, decisionCount: 1, operationCount: 10,
    operationLimit: 128, requiredOperationCount: 5, sealed: true };
  const sealPart = (index: number, value: unknown = sealReady, messageId = 'answer') =>
    event(index, { type: 'data-part', messageId, name: 'dispatcher-seal-preflight', data: value });
  it.each([1024, 4096])('REQ-OPERATOR-076: seal metadata accepts configured %i capacity without granting assessment authority', async operationLimit => {
    const value = { ...sealReady, operationCount: 129, operationLimit };
    const final = await readDispatcherUpdates(response([start, sealPart(1, value), settled]), initial(), 'requested');
    expect(final.sealPreflight).toEqual({ latest: value, observations: 1, truncated: false });
    expect(final.writes).toBe(0); expect(final.result).toBeUndefined();
  });
  it.each(['ready', 'capacity', 'schema', 'oversized'])('REQ-OPERATOR-076: seal-preflight.v1 projects exact %s metadata without assessment authority', async category => {
    const value = { ...sealReady, category, sealed: category === 'ready' };
    const final = await readDispatcherUpdates(response([start, sealPart(1, value), settled]), initial(), 'requested');
    expect(Reflect.get(final, 'sealPreflight')).toEqual({ latest: value, observations: 1, truncated: false });
    expect(final.writes).toBe(0); expect(final.result).toBeUndefined(); expect(final.outcome).toBe('completed');
  });
  it.each(['undiscovered', 'incomplete-decisions', 'receipt'])('REQ-OPERATOR-076: seal-preflight.v1 %s retains unknown counts as null not fabricated zero', async category => {
    const value = { ...sealReady, category, operationCount: null, operationLimit: null, requiredOperationCount: null, sealed: false };
    const final = await readDispatcherUpdates(response([start, sealPart(1, value), data, settled]), initial(), 'requested');
    expect(Reflect.get(final, 'sealPreflight')).toEqual({ latest: value, observations: 1, truncated: false });
    expect(final).toMatchObject({ writes: 1, result, outcome: 'completed' });
  });
  it('REQ-OPERATOR-076: seal-preflight.v1 keeps latest valid metadata across pages and replay without result accounting', async () => {
    const refused = { ...sealReady, operationCount: 125, category: 'capacity', sealed: false };
    const first = await readDispatcherUpdates(response([start, sealPart(1, refused)], 'first'), initial(), 'requested');
    const second = await readDispatcherUpdates(response([sealPart(1, refused), sealPart(2)]), first, 'requested');
    const final = await readDispatcherUpdates(response([sealPart(2), data, settled]), second, 'requested');
    expect(Reflect.get(final, 'sealPreflight')).toEqual({ latest: sealReady, observations: 2, truncated: false });
    expect(final).toMatchObject({ writes: 1, result, outcome: 'completed' });
  });
  it('REQ-OPERATOR-076: distinct seal records count across resets while replayed positions do not', async () => {
    const reset = event(2, { type: 'conversation-reset', snapshot: {
      conversationId: 'conversation', messages: [{ id: 'answer', submissionId: 'requested',
        parts: [{ type: 'data-dispatcher-seal-preflight', data: sealReady }] }], settlements: [],
    } });
    const first = await readDispatcherUpdates(response([start, sealPart(1)], 'first'), initial(), 'requested');
    const second = await readDispatcherUpdates(response([reset, sealPart(3)], 'second'), first, 'requested');
    expect(Reflect.get(second, 'sealPreflight')).toEqual({ latest: sealReady, observations: 3, truncated: false });
    expect(second.writes).toBe(0); expect(second.result).toBeUndefined();
    const final = await readDispatcherUpdates(response([reset, sealPart(3),
      event(4, { type: 'data-part', messageId: 'answer', name: 'assessment', data: result }),
      event(5, { type: 'submission-settled', submissionId: 'requested', outcome: 'completed' }),
    ]), second, 'requested');
    expect(Reflect.get(final, 'sealPreflight')).toEqual({ latest: sealReady, observations: 3, truncated: false });
    expect(final).toMatchObject({ writes: 1, result, outcome: 'completed' });
  });
  it('REQ-OPERATOR-076: seal-preflight.v1 survives reset omission of earlier metadata', async () => {
    const first = await readDispatcherUpdates(response([start, sealPart(1)]), initial(), 'requested');
    const final = await readDispatcherUpdates(response([event(5, { type: 'conversation-reset', snapshot: {
      conversationId: 'conversation', messages: [{ id: 'answer', submissionId: 'requested', parts: [] }], settlements: [],
    } })]), first, 'requested');
    expect(Reflect.get(final, 'sealPreflight')).toEqual({ latest: sealReady, observations: 1, truncated: false });
    expect(final.result).toBeUndefined(); expect(final.writes).toBe(0);
  });
  it.each(['normal', 'data-first'])('REQ-OPERATOR-076: seal-preflight.v1 exact reset association survives %s member order', async order => {
    const part = order === 'normal' ? { type: 'data-dispatcher-seal-preflight', data: sealReady }
      : { data: sealReady, type: 'data-dispatcher-seal-preflight' };
    const exact = { parts: [part], submissionId: 'requested', id: 'answer' };
    const final = await readDispatcherUpdates(response([event(5, { type: 'conversation-reset', snapshot: {
      conversationId: 'conversation', messages: [{ parts: [{ data: { ...sealReady, category: 'PRIVATE_FOREIGN_CONTENT'.repeat(5000) },
        type: 'data-dispatcher-seal-preflight' }], submissionId: 'foreign', id: 'foreign' }, exact],
      settlements: [{ submissionId: 'requested', outcome: 'completed' }],
    } })]), initial(), 'requested');
    expect(Reflect.get(final, 'sealPreflight')).toEqual({ latest: sealReady, observations: 1, truncated: false });
    expect(final.writes).toBe(0); expect(final.result).toBeUndefined();
  });
  it('REQ-OPERATOR-076: foreign seal-preflight.v1 cannot consume exact observations or alter validated assessment', async () => {
    const final = await readDispatcherUpdates(response([start,
      event(1, { type: 'message-started', messageId: 'other', submissionId: 'foreign' }),
      sealPart(2, { ...sealReady, body: 'PRIVATE_FOREIGN_CONTENT'.repeat(5000) }, 'other'), data, settled,
    ]), initial(), 'requested');
    expect(Reflect.get(final, 'sealPreflight')).toBeUndefined(); expect(final).toMatchObject({ writes: 1, result });
  });
  it.each([
    ['extra-field', { ...sealReady, body: 'PRIVATE_PRODUCER_CONTENT' }],
    ['missing-field', { category: 'ready' }],
    ['wrong-category', { ...sealReady, category: 'PRIVATE_PRODUCER_CONTENT' }],
    ['wrong-flag', { ...sealReady, sealed: 'PRIVATE_PRODUCER_CONTENT' }],
    ['negative-count', { ...sealReady, targetCount: -1 }],
    ['fractional-count', { ...sealReady, decisionCount: 0.5 }],
    ['unsafe-count', { ...sealReady, targetCount: Number.MAX_SAFE_INTEGER + 1 }],
    ['journal-over-limit', { ...sealReady, operationCount: 129 }],
    ['zero-reserve', { ...sealReady, requiredOperationCount: 0 }],
    ['fractional-reserve', { ...sealReady, requiredOperationCount: 4.5 }],
    ['unsafe-reserve', { ...sealReady, requiredOperationCount: Number.MAX_SAFE_INTEGER + 1 }],
    ['zero-limit', { ...sealReady, operationLimit: 0 }],
    ['fractional-limit', { ...sealReady, operationLimit: 1024.5 }],
    ['unsafe-limit', { ...sealReady, operationLimit: Number.MAX_SAFE_INTEGER + 1 }],
    ['oversized', { ...sealReady, category: 'PRIVATE_PRODUCER_CONTENT'.repeat(5000) }],
  ])('REQ-OPERATOR-076: invalid seal-preflight.v1 %s cannot retain content or deny actual assessment', async (_caseName, value) => {
    const final = await readDispatcherUpdates(response([start, sealPart(1, value), data, settled]), initial(), 'requested');
    expect(Reflect.get(final, 'sealPreflight')).toEqual({ observations: 1, truncated: true });
    expect(final).toMatchObject({ writes: 1, result, outcome: 'completed' });
  });
  it('REQ-OPERATOR-076: seal-preflight.v1 retains latest valid observation when later metadata is invalid', async () => {
    const final = await readDispatcherUpdates(response([start, sealPart(1),
      sealPart(2, { ...sealReady, category: 'PRIVATE_PRODUCER_CONTENT' }), data, settled]), initial(), 'requested');
    expect(Reflect.get(final, 'sealPreflight')).toEqual({ latest: sealReady, observations: 2, truncated: true });
    expect(final.result).toEqual(result);
  });
  it('REQ-OPERATOR-076: seal-preflight.v1 limits32 observations separately from valid assessment and readiness', async () => {
    const parts = Array.from({ length: 40 }, (_, index) => sealPart(index + 1, { ...sealReady, operationCount: index + 1 }));
    const final = await readDispatcherUpdates(response([start, ...parts,
      event(41, { type: 'data-part', messageId: 'answer', name: 'assessment', data: result }),
      event(42, { type: 'data-part', messageId: 'answer', name: 'dispatcher-readiness', data: {
        discovered: true, sealed: true, targetCount: 1, decisionCount: 1, resultCount: 1, unknownOperationCount: 0, category: 'ready' } }),
      event(43, { type: 'submission-settled', submissionId: 'requested', outcome: 'completed' }),
    ]), initial(), 'requested', undefined, { preflightObservationLimit: 32 });
    expect(Reflect.get(final, 'sealPreflight')).toEqual({ latest: { ...sealReady, operationCount: 32 }, observations: 32, truncated: true });
    expect(Reflect.get(final, 'readiness')).toMatchObject({ observations: 1, truncated: false });
    expect(final).toMatchObject({ writes: 1, result, outcome: 'completed' });
  });
  it('REQ-OPERATOR-076: seal-preflight.v1 data-before-name overflow truncates only diagnostic work', async () => {
    const final = await readDispatcherUpdates(response([start,
      event(1, { data: sealReady, messageId: 'answer', name: 'dispatcher-seal-preflight', type: 'data-part' }),
      event(2, { data: { ...sealReady, category: 'PRIVATE_PRODUCER_CONTENT'.repeat(5000) },
        messageId: 'answer', name: 'dispatcher-seal-preflight', type: 'data-part' }), data, settled,
    ]), initial(), 'requested');
    expect(Reflect.get(final, 'sealPreflight')).toEqual({ latest: sealReady, observations: 2, truncated: true });
    expect(final).toMatchObject({ writes: 1, result, outcome: 'completed' });
  });
  it('REQ-OPERATOR-076: seal-preflight.v1 never relaxes oversized actual assessment denial', async () => {
    const first = await readDispatcherUpdates(response([start, sealPart(1)]), initial(), 'requested', undefined, { assessmentBytes: 65536 });
    await expect(readDispatcherUpdates(response([event(2, { data: { body: 'x'.repeat(100000) }, messageId: 'answer',
      name: 'assessment', type: 'data-part' })]), first, 'requested', undefined, { assessmentBytes: 65536 })).rejects.toThrow('Dispatcher projected value exceeds limit');
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
    ]), initial(), 'requested', undefined, { readinessObservationLimit: 32 });
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
    const projected = await readDispatcherUpdates(response([reset]), initial(), 'requested', undefined, { assessmentBytes: 65536 });
    expect(Reflect.get(projected, 'readiness')).toEqual({ latest: ready, observations: 1, truncated: false });
    expect(projected.writes).toBe(0); expect(projected.result).toBeUndefined();
    const oversizedAssessment = event(6, { data: { body: 'x'.repeat(100000) }, messageId: 'answer', name: 'assessment', type: 'data-part' });
    await expect(readDispatcherUpdates(response([oversizedAssessment]), projected, 'requested', undefined, { assessmentBytes: 65536 })).rejects.toThrow('Dispatcher projected value exceeds limit');
  });

  it.each([false, true])('admitted assessment bytes accept the complete UTF-8 boundary and fail closed above it (reset=%s)', async reset => {
    const assessment = { repository: 'owner/project', comment: '🙂 quoted " evidence', results: [] };
    const events = reset ? [event(5, { type: 'conversation-reset', snapshot: {
      conversationId: 'conversation', messages: [{ id: 'answer', submissionId: 'requested',
        parts: [{ data: assessment, type: 'data-assessment' }] }],
      settlements: [{ submissionId: 'requested', outcome: 'completed' }],
    } })] : [start, { ...data, data: assessment }, settled];
    const previous = initial();
    const exact = await readDispatcherUpdates(response(events), previous, 'requested', undefined,
      { assessmentBytes: jsonBytes(assessment) });
    expect(exact).toMatchObject({ result: assessment, writes: 1, outcome: 'completed' });
    await expect(readDispatcherUpdates(response(events), previous, 'requested', undefined,
      { assessmentBytes: jsonBytes(assessment) - 1 })).rejects.toThrow('Dispatcher projected value exceeds limit');
    expect(previous).toEqual(initial());
  });
  it('omitted capacity policy collects a complete assessment larger than the former 64 KiB default', async () => {
    const assessment = { ...result, comment: 'x'.repeat(65536) };
    const final = await readDispatcherUpdates(response([start, { ...data, data: assessment }, settled]), initial(), 'requested');
    expect(final).toMatchObject({ result: assessment, writes: 1, outcome: 'completed' });
  });
  it('admitted update-page bytes include discarded history and UTF-8 transport overhead at the exact boundary', async () => {
    const events = [start, event(1, { type: 'tool-output', output: '🙂 private history' }), data, settled];
    const policy = { updatePageBytes: jsonBytes(events) };
    const final = await readDispatcherUpdates(response(events), initial(), 'requested', undefined, policy);
    expect(final).toMatchObject({ result, writes: 1, outcome: 'completed' });
    expect(JSON.stringify(final)).not.toContain('private history');
    const previous = initial();
    await expect(readDispatcherUpdates(response(events), previous, 'requested', undefined,
      { updatePageBytes: policy.updatePageBytes - 1 })).rejects.toThrow('Dispatcher update page exceeds limit');
    expect(previous).toEqual(initial());
  });
  it('admitted projected-record bytes retain the entire assessment or reject without advancing prior evidence', async () => {
    const assessment = { ...result, comment: '🙂'.repeat(40) };
    const assessmentEvent = { ...data, data: assessment };
    const previous = await readDispatcherUpdates(response([start], 'started'), initial(), 'requested');
    const final = await readDispatcherUpdates(response([assessmentEvent, settled]), previous, 'requested', undefined,
      { projectedRecordBytes: jsonBytes(assessmentEvent) });
    expect(final).toMatchObject({ result: assessment, writes: 1, outcome: 'completed' });
    await expect(readDispatcherUpdates(response([assessmentEvent, settled]), previous, 'requested', undefined,
      { projectedRecordBytes: jsonBytes(assessmentEvent) - 1 })).rejects.toThrow('Dispatcher projection exceeds limit');
    expect(previous).toMatchObject({ offset: 'started', writes: 0, messageIds: ['answer'] });
    expect(previous.result).toBeUndefined();
  });
  it.each([false, true].flatMap(reset => [false, true].map(completion => ({ reset, completion }))))(
    'admitted observation count accepts the exact bound, preserves outcomes across pages and marks overflow (reset=$reset/completion=$completion)',
    async ({ reset, completion }) => {
      const toolName = completion ? 'finish_dispatcher' : 'decide_renovate';
      const policy: DispatcherCapacityPolicy = completion
        ? { completionObservationLimit: 2, toolObservationLimit: 4 } : { toolObservationLimit: 2 };
      const call = (index: number) => ({ type: 'tool-input', messageId: 'answer', toolName, toolCallId: `call-${index}` });
      const snapshot = (count: number, complete: boolean) => ({ conversationId: 'conversation',
        messages: [{ parts: [
          ...Array.from({ length: count }, (_, index) => ({ type: 'dynamic-tool', toolName, toolCallId: `call-${index}`,
            state: complete ? index === 1 ? 'output-error' : 'output-available' : 'input-available' })),
          ...(complete ? [{ type: 'data-assessment', data: result }] : []),
        ], submissionId: 'requested', id: 'answer' }],
        settlements: complete ? [{ submissionId: 'requested', outcome: 'completed' }] : [],
      });
      const first = await readDispatcherUpdates(response(reset
        ? [event(1, { type: 'conversation-reset', snapshot: snapshot(2, false) })]
        : [start, event(1, call(0)), event(2, call(1))], 'first'), initial(), 'requested', undefined, policy);
      const observed = completion ? first.completion : first.tools;
      expect(observed?.calls.map(({ id, outcome }) => ({ id, outcome }))).toEqual([
        { id: 'call-0', outcome: 'pending' }, { id: 'call-1', outcome: 'pending' },
      ]);
      expect(observed?.truncated).toBe(false);
      expect(first.result).toBeUndefined();
      expect(first.outcome).toBeUndefined();
      const final = await readDispatcherUpdates(response(reset
        ? [event(6, { type: 'conversation-reset', snapshot: snapshot(3, true) })]
        : [event(3, call(2)), event(4, { type: 'tool-output', toolCallId: 'call-0' }),
          event(5, { type: 'tool-output-error', toolCallId: 'call-1' }),
          { ...data, position: { batch: 1, index: 6 } }, { ...settled, position: { batch: 1, index: 7 } }]),
      first, 'requested', undefined, policy);
      const finalObserved = completion ? final.completion : final.tools;
      expect(finalObserved?.calls.map(({ id, outcome }) => ({ id, outcome }))).toEqual([
        { id: 'call-0', outcome: 'succeeded' }, { id: 'call-1', outcome: 'failed' },
      ]);
      expect(finalObserved?.truncated).toBe(true);
      expect(final).toMatchObject({ result, writes: 1, outcome: 'completed' });
      expect(observed?.truncated).toBe(false);
    },
  );
  it('omitted observation policies retain more than the former 32 completion correlations', async () => {
    const calls = Array.from({ length: 40 }, (_, index) => event(index + 1, { type: 'tool-input',
      messageId: 'answer', toolName: 'finish_dispatcher', toolCallId: `finish-${index}` }));
    const final = await readDispatcherUpdates(response([start, ...calls,
      { ...data, position: { batch: 1, index: 41 } }, { ...settled, position: { batch: 1, index: 42 } }]), initial(), 'requested');
    expect(final.completion?.calls).toHaveLength(40);
    expect(final.completion?.truncated).toBe(false);
    expect(final.tools?.calls).toHaveLength(40);
    expect(final.tools?.truncated).toBe(false);
    expect(final).toMatchObject({ result, writes: 1, outcome: 'completed' });
  });
  it('concurrent projections keep their admitted capacities independent', async () => {
    const calls = Array.from({ length: 3 }, (_, index) => event(index + 1, { type: 'tool-input',
      messageId: 'answer', toolName: 'finish_dispatcher', toolCallId: `finish-${index}` }));
    const events = [start, ...calls, { ...data, position: { batch: 1, index: 4 } },
      { ...settled, position: { batch: 1, index: 5 } }];
    const [small, large] = await Promise.all([1, 3].map(limit => readDispatcherUpdates(response(events), initial(),
      'requested', undefined, { completionObservationLimit: limit, toolObservationLimit: limit })));
    expect(small.completion?.calls).toHaveLength(1);
    expect(small.tools?.calls).toHaveLength(1);
    expect(small.completion?.truncated).toBe(true);
    expect(small.tools?.truncated).toBe(true);
    expect(large.completion?.calls).toHaveLength(3);
    expect(large.tools?.calls).toHaveLength(3);
    expect(large.completion?.truncated).toBe(false);
    expect(large.tools?.truncated).toBe(false);
    for (const final of [small, large]) expect(final).toMatchObject({ result, writes: 1, outcome: 'completed' });
  });
  it.each([256, 257])('completion correlation length remains a 256-character protocol constraint with larger capacities (%i)', async length => {
    const final = await readDispatcherUpdates(response([start, event(1, { type: 'tool-input', messageId: 'answer',
      toolName: 'finish_dispatcher', toolCallId: 'x'.repeat(length) }), data, settled]), initial(), 'requested', undefined,
    { completionObservationLimit: 1024, toolObservationLimit: 1024 });
    expect(final.completion).toEqual({ calls: length === 256 ? [{ id: 'x'.repeat(length), outcome: 'pending' }] : [],
      truncated: length > 256 });
    expect(final).toMatchObject({ result, writes: 1, outcome: 'completed' });
  });

  const metadataCases = [
    { name: 'seal-preflight', wireName: 'dispatcher-seal-preflight', projection: 'sealPreflight', value: sealReady,
      byteKey: 'preflightBytes', countKey: 'preflightObservationLimit' },
    { name: 'readiness', wireName: 'dispatcher-readiness', projection: 'readiness', value: ready,
      byteKey: 'readinessBytes', countKey: 'readinessObservationLimit' },
  ] as const;
  it.each(metadataCases.flatMap(metadata => [false, true].map(reset => ({ ...metadata, reset }))))(
    'small assessment allowance does not cap SDK identities or independent $name data (reset=$reset)',
    async ({ wireName, projection, value, reset }) => {
      const assessment = { ok: true };
      const messageId = 'm'.repeat(128);
      const events = reset ? [event(5, { type: 'conversation-reset', snapshot: {
        conversationId: 'conversation', messages: [{ parts: [
          { data: value, type: `data-${wireName}` }, { data: assessment, type: 'data-assessment' },
        ], submissionId: 'requested', id: messageId }], settlements: [{ submissionId: 'requested', outcome: 'completed' }],
      } })] : [{ ...start, messageId }, event(1, { data: value, messageId, name: wireName, type: 'data-part' }),
        { ...data, messageId, data: assessment }, settled];
      const final = await readDispatcherUpdates(response(events), initial(), 'requested', undefined,
        { assessmentBytes: jsonBytes(assessment) });
      expect(final).toMatchObject({ messageIds: [messageId], result: assessment, writes: 1, outcome: 'completed' });
      expect(final[projection]).toEqual({ latest: value, observations: 1, truncated: false });
    },
  );
  it.each(metadataCases.flatMap(metadata => [false, true].map(reset => ({ ...metadata, reset }))))(
    'admitted $name bytes accept the exact boundary and only truncate diagnostic overflow (reset=$reset)',
    async ({ wireName, projection, value, byteKey, reset }) => {
      const events = reset ? [event(5, { type: 'conversation-reset', snapshot: {
        conversationId: 'conversation', messages: [{ parts: [
          { data: value, type: `data-${wireName}` }, { type: 'data-assessment', data: result },
        ], submissionId: 'requested', id: 'answer' }], settlements: [{ submissionId: 'requested', outcome: 'completed' }],
      } })] : [start, event(1, { data: value, messageId: 'answer', name: wireName, type: 'data-part' }), data, settled];
      const exact = await readDispatcherUpdates(response(events), initial(), 'requested', undefined,
        { [byteKey]: jsonBytes(value) });
      expect(exact[projection]).toEqual({ latest: value, observations: 1, truncated: false });
      const overflow = await readDispatcherUpdates(response(events), initial(), 'requested', undefined,
        { [byteKey]: jsonBytes(value) - 1 });
      expect(overflow[projection]).toEqual({ observations: 1, truncated: true });
      for (const final of [exact, overflow]) expect(final).toMatchObject({ result, writes: 1, outcome: 'completed' });
    },
  );
  it.each(metadataCases.flatMap(metadata => [false, true].map(reset => ({ ...metadata, reset }))))(
    'admitted $name counts stay bounded across pages and resets without granting result authority (reset=$reset)',
    async ({ wireName, projection, value, countKey, reset }) => {
      const policy: DispatcherCapacityPolicy = { [countKey]: 2 };
      const first = await readDispatcherUpdates(response([start,
        event(1, { type: 'data-part', messageId: 'answer', name: wireName, data: value })], 'first'),
      initial(), 'requested', undefined, policy);
      const secondEvents = reset ? [event(2, { type: 'conversation-reset', snapshot: {
        conversationId: 'conversation', messages: [{ parts: [{ data: value, type: `data-${wireName}` }],
          submissionId: 'requested', id: 'answer' }], settlements: [],
      } })] : [event(2, { type: 'data-part', messageId: 'answer', name: wireName, data: value })];
      const second = await readDispatcherUpdates(response(secondEvents, 'second'), first, 'requested', undefined, policy);
      expect(second[projection]).toEqual({ latest: value, observations: 2, truncated: false });
      expect(second.writes).toBe(0);
      expect(second.result).toBeUndefined();
      expect(second.outcome).toBeUndefined();
      const final = await readDispatcherUpdates(response([...secondEvents,
        event(3, { type: 'data-part', messageId: 'answer', name: wireName, data: { ...value, targetCount: 2 } }),
        { ...data, position: { batch: 1, index: 4 } }, { ...settled, position: { batch: 1, index: 5 } }]),
      second, 'requested', undefined, policy);
      expect(final[projection]).toEqual({ latest: value, observations: 2, truncated: true });
      expect(final).toMatchObject({ result, writes: 1, outcome: 'completed' });
      expect(second[projection]).toEqual({ latest: value, observations: 2, truncated: false });
    },
  );

});
