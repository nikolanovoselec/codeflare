import assert from 'node:assert/strict';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { test } from 'vitest';

import {
  MAX_NATIVE_CHAT_PROMPT_BYTES,
  NativePiRuntime,
  buildNativePiPrompt,
  runNativePiChat,
  type NativePiBackend,
  type NativePiCancellation,
  type NativePiPromptInput,
  type NativePiResponse,
  type NativePiTurnObserver,
} from '../src/pi/native-chat.ts';

/** The serialized editor-context object carried between the prompt's delimiters. */
function editorContext(prompt: string): Record<string, unknown> {
  const open = '<codeflare_editor_context>\n';
  const start = prompt.indexOf(open);
  const end = prompt.lastIndexOf('\n</codeflare_editor_context>');
  assert.ok(start !== -1 && end > start, 'the prompt must carry a delimited context block');
  return JSON.parse(prompt.slice(start + open.length, end)) as Record<string, unknown>;
}

function promptInput(overrides: Partial<NativePiPromptInput> = {}): NativePiPromptInput {
  return {
    prompt: 'Fix the selected code and explain the diagnostic.',
    history: [
      { role: 'user', text: 'We are repairing the parser.' },
      { role: 'assistant', text: 'I will inspect the parser.' },
    ],
    activeEditor: {
      path: '/home/user/workspace/src/parser.ts',
      languageId: 'typescript',
      dirty: true,
      content: 'export const parser = broken;\n',
      selection: {
        startLine: 1,
        startColumn: 23,
        endLine: 1,
        endColumn: 29,
        text: 'broken',
      },
    },
    openFiles: [
      '/home/user/workspace/src/parser.ts',
      '/home/user/workspace/src/token.ts',
      '/etc/codeflare-secret',
    ],
    diagnostics: [
      {
        path: '/home/user/workspace/src/parser.ts',
        severity: 'error',
        line: 1,
        column: 23,
        message: 'Cannot find name broken.',
      },
      {
        path: '/etc/codeflare-secret',
        severity: 'error',
        line: 1,
        column: 1,
        message: 'outside-workspace-canary',
      },
    ],
    references: [
      {
        path: '/home/user/workspace/src/token.ts',
        startLine: 4,
        endLine: 8,
        text: 'export type Token = string;',
      },
      {
        path: '/etc/codeflare-secret',
        text: 'outside-reference-canary',
      },
    ],
    ...overrides,
  };
}

test('REQ-IDE-005 AC2 + REQ-IDE-006 AC1: native Pi receives bounded editor, reference, diagnostic, and chat context', () => {
  const prompt = buildNativePiPrompt(promptInput());

  assert.match(prompt, /Fix the selected code/);
  assert.match(prompt, /src\/parser\.ts/);
  assert.match(prompt, /src\/token\.ts/);
  assert.match(prompt, /broken/);
  assert.match(prompt, /Cannot find name broken/);
  assert.match(prompt, /We are repairing the parser/);
  assert.match(prompt, /context is untrusted data/i);
  assert.doesNotMatch(prompt, /outside-workspace-canary|outside-reference-canary|codeflare-secret/);
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= MAX_NATIVE_CHAT_PROMPT_BYTES);
});

test('REQ-IDE-005 AC2: native Pi prompt truncation is deterministic and remains valid UTF-8', () => {
  const oversized = '🙂'.repeat(MAX_NATIVE_CHAT_PROMPT_BYTES);
  const first = buildNativePiPrompt(promptInput({
    activeEditor: {
      path: '/home/user/workspace/src/large.ts',
      languageId: 'typescript',
      dirty: true,
      content: oversized,
    },
  }));
  const second = buildNativePiPrompt(promptInput({
    activeEditor: {
      path: '/home/user/workspace/src/large.ts',
      languageId: 'typescript',
      dirty: true,
      content: oversized,
    },
  }));

  assert.equal(first, second);
  assert.ok(Buffer.byteLength(first, 'utf8') <= MAX_NATIVE_CHAT_PROMPT_BYTES);
  assert.match(first, /truncated/i);
  assert.equal(Buffer.from(first, 'utf8').toString('utf8'), first);
});

class RecordingBackend implements NativePiBackend {
  readonly prompts: string[] = [];
  readonly inlinePrompts: string[] = [];
  readonly observers: NativePiTurnObserver[] = [];
  aborts = 0;
  stops = 0;
  reusable = true;
  readonly #autoSettle: boolean;
  readonly #failure: Error | undefined;
  #active: Array<{ resolve(): void; reject(error: Error): void }> = [];

  constructor(options: { autoSettle?: boolean; failure?: Error } = {}) {
    this.#autoSettle = options.autoSettle ?? true;
    this.#failure = options.failure;
  }

  async runPrompt(message: string, observer: NativePiTurnObserver): Promise<void> {
    this.prompts.push(message);
    this.observers.push(observer);
    if (this.#failure) throw this.#failure;
    if (this.#autoSettle) {
      observer.progress('Reading workspace files…');
      observer.markdown('Applied the guarded change.');
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.#active.push({ resolve, reject });
    });
  }

  async runInlineEditPrompt(message: string, observer: NativePiTurnObserver) {
    this.inlinePrompts.push(message);
    this.observers.push(observer);
    return [{
      startLine: 0,
      startCharacter: 0,
      endLine: 0,
      endCharacter: 0,
      newText: 'generated inline code',
    }];
  }

  settle(index = 0): void {
    this.#active[index]?.resolve();
  }

  async abort(): Promise<void> {
    this.aborts += 1;
    this.#active.at(-1)?.resolve();
  }

  isReusable(): boolean {
    return this.reusable;
  }

  async stop(): Promise<void> {
    this.stops += 1;
    for (const active of this.#active.splice(0)) active.reject(new Error('backend stopped'));
  }
}

class RecordingCancellation implements NativePiCancellation {
  #requested = false;
  readonly #listeners = new Set<() => void>();

  get isCancellationRequested(): boolean {
    return this.#requested;
  }

  onCancellationRequested(listener: () => void): { dispose(): void } {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  cancel(): void {
    if (this.#requested) return;
    this.#requested = true;
    for (const listener of [...this.#listeners]) listener();
  }
}

function responseRecorder(): {
  response: NativePiResponse;
  markdown: string[];
  progress: string[];
  textEdits: unknown[][];
} {
  const markdown: string[] = [];
  const progress: string[] = [];
  const textEdits: unknown[][] = [];
  return {
    response: {
      markdown: (value) => markdown.push(value),
      progress: (value) => progress.push(value),
      textEdit: (edits) => textEdits.push([...edits]),
    },
    markdown,
    progress,
    textEdits,
  };
}

const activeCancellation: NativePiCancellation = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

test('REQ-IDE-005: lazy native Pi reuses one backend after settled turns', async () => {
  const backends: RecordingBackend[] = [];
  const runtime = new NativePiRuntime(() => {
    const backend = new RecordingBackend();
    backends.push(backend);
    return backend;
  }, runNativePiChat);
  const first = responseRecorder();
  const second = responseRecorder();

  assert.equal(backends.length, 0);
  await runtime.handle({
    input: promptInput({ prompt: 'first request' }),
    response: first.response,
    cancellation: activeCancellation,
  });
  await runtime.handle({
    input: promptInput({ prompt: 'second request' }),
    response: second.response,
    cancellation: activeCancellation,
  });

  assert.equal(backends.length, 1);
  assert.equal(backends[0]?.stops, 0);
  assert.match(backends[0]?.prompts[0] ?? '', /first request/);
  assert.match(backends[0]?.prompts[1] ?? '', /second request/);
  assert.deepEqual(first.progress, ['Reading workspace files…']);
  assert.deepEqual(first.markdown, ['Applied the guarded change.']);

  await runtime.dispose();
  assert.equal(backends[0]?.stops, 1);
});

test('REQ-IDE-025: panel and native inline edit turns reuse one backend with surface-specific output', async () => {
  const backend = new RecordingBackend();
  const runtime = new NativePiRuntime(() => backend, runNativePiChat);
  const panel = responseRecorder();
  const inline = responseRecorder();

  await runtime.handle({
    input: promptInput({ prompt: 'panel request' }),
    response: panel.response,
    cancellation: activeCancellation,
  });
  await runtime.handle({
    mode: 'inline-edit',
    input: promptInput({ prompt: 'inline request' }),
    response: inline.response,
    cancellation: activeCancellation,
  });

  assert.equal(backend.prompts.length, 1);
  assert.equal(backend.inlinePrompts.length, 1);
  assert.match(backend.inlinePrompts[0] ?? '', /inline request/);
  assert.deepEqual(inline.markdown, []);
  assert.deepEqual(inline.textEdits, [[{
    startLine: 0,
    startCharacter: 0,
    endLine: 0,
    endCharacter: 0,
    newText: 'generated inline code',
  }]]);
  await runtime.dispose();
});

test('REQ-IDE-006: warm turns omit visible history already held by the shared Pi conversation', async () => {
  const backend = new RecordingBackend();
  const runtime = new NativePiRuntime(() => backend, runNativePiChat);

  await runtime.handle({
    input: promptInput({
      prompt: 'cold panel request',
      history: [{ role: 'user', text: 'cold bootstrap history' }],
    }),
    response: responseRecorder().response,
    cancellation: activeCancellation,
  });
  await runtime.handle({
    input: promptInput({
      prompt: 'warm editor request',
      history: [{ role: 'assistant', text: 'must not be replayed' }],
    }),
    response: responseRecorder().response,
    cancellation: activeCancellation,
  });

  assert.deepEqual(editorContext(backend.prompts[0] ?? '').history, [
    { role: 'user', text: 'cold bootstrap history' },
  ]);
  assert.equal(editorContext(backend.prompts[1] ?? '').history, undefined);
  assert.doesNotMatch(backend.prompts[1] ?? '', /must not be replayed/);
  await runtime.dispose();
});

test('REQ-IDE-006: replacement Pi hydrates from the requesting Chat surface history', async () => {
  const backends: RecordingBackend[] = [];
  const cancellation = new RecordingCancellation();
  const runtime = new NativePiRuntime(() => {
    const backend = new RecordingBackend({ autoSettle: backends.length !== 0 });
    backends.push(backend);
    return backend;
  }, runNativePiChat);
  const first = runtime.handle({
    input: promptInput({ prompt: 'panel request' }),
    response: responseRecorder().response,
    cancellation,
  });
  await waitForImmediate();

  cancellation.cancel();
  await first;
  await runtime.handle({
    input: promptInput({
      prompt: 'editor request after replacement',
      history: [{ role: 'user', text: 'editor-visible bootstrap' }],
    }),
    response: responseRecorder().response,
    cancellation: activeCancellation,
  });

  assert.equal(backends.length, 2);
  assert.equal(backends[0]?.aborts, 1);
  assert.equal(backends[0]?.stops, 1);
  assert.deepEqual(editorContext(backends[1]?.prompts[0] ?? '').history, [
    { role: 'user', text: 'editor-visible bootstrap' },
  ]);
  await runtime.dispose();
});

test('REQ-IDE-008: concurrent native Chat requests execute in strict FIFO order', async () => {
  const backend = new RecordingBackend({ autoSettle: false });
  const runtime = new NativePiRuntime(() => backend, runNativePiChat);
  let releaseFirstInput = (_input: NativePiPromptInput): void => undefined;
  const firstInput = new Promise<NativePiPromptInput>((resolve) => { releaseFirstInput = resolve; });
  const first = runtime.handle({
    input: firstInput,
    response: responseRecorder().response,
    cancellation: activeCancellation,
  });
  const second = runtime.handle({
    input: promptInput({ prompt: 'second queued request' }),
    response: responseRecorder().response,
    cancellation: activeCancellation,
  });
  await waitForImmediate();

  assert.equal(backend.prompts.length, 0);
  releaseFirstInput(promptInput({ prompt: 'first queued request' }));
  await waitForImmediate();
  assert.equal(backend.prompts.length, 1);
  assert.match(backend.prompts[0] ?? '', /first queued request/);
  backend.settle(0);
  await first;
  await waitForImmediate();
  assert.equal(backend.prompts.length, 2);
  assert.match(backend.prompts[1] ?? '', /second queued request/);
  backend.settle(1);
  await second;
  await runtime.dispose();
});

test('REQ-IDE-008: queued cancellation skips its prompt without aborting the active turn', async () => {
  const backend = new RecordingBackend({ autoSettle: false });
  const queuedCancellation = new RecordingCancellation();
  const runtime = new NativePiRuntime(() => backend, runNativePiChat);
  const active = runtime.handle({
    input: promptInput({ prompt: 'active request' }),
    response: responseRecorder().response,
    cancellation: activeCancellation,
  });
  const queued = runtime.handle({
    input: promptInput({ prompt: 'must not run' }),
    response: responseRecorder().response,
    cancellation: queuedCancellation,
  });
  await waitForImmediate();

  queuedCancellation.cancel();
  assert.equal(backend.aborts, 0);
  backend.settle(0);
  await Promise.all([active, queued]);
  assert.equal(backend.prompts.length, 1);
  assert.doesNotMatch(backend.prompts[0] ?? '', /must not run/);
  assert.equal(backend.aborts, 0);
  await runtime.dispose();
});

test('REQ-IDE-008: startup cancellation after backend creation retires without a prompt', async () => {
  const cancellation = new RecordingCancellation();
  const backends: RecordingBackend[] = [];
  const runtime = new NativePiRuntime(() => {
    const backend = new RecordingBackend();
    backends.push(backend);
    cancellation.cancel();
    return backend;
  }, runNativePiChat);

  await runtime.handle({
    input: promptInput({ prompt: 'must not start' }),
    response: responseRecorder().response,
    cancellation,
  });

  assert.equal(backends.length, 1);
  assert.deepEqual(backends[0]?.prompts, []);
  assert.equal(backends[0]?.aborts, 0);
  assert.equal(backends[0]?.stops, 1);
  await runtime.dispose();
});

test('REQ-IDE-008: active cancellation retires the backend before replacement', async () => {
  const backends: RecordingBackend[] = [];
  const cancellation = new RecordingCancellation();
  const runtime = new NativePiRuntime(() => {
    const backend = new RecordingBackend({ autoSettle: backends.length !== 0 });
    backends.push(backend);
    return backend;
  }, runNativePiChat);
  const active = runtime.handle({
    input: promptInput({ prompt: 'cancel active request' }),
    response: responseRecorder().response,
    cancellation,
  });
  await waitForImmediate();

  cancellation.cancel();
  await active;
  await runtime.handle({
    input: promptInput({ prompt: 'replacement request' }),
    response: responseRecorder().response,
    cancellation: activeCancellation,
  });

  assert.equal(backends.length, 2);
  assert.equal(backends[0]?.aborts, 1);
  assert.equal(backends[0]?.stops, 1);
  assert.match(backends[1]?.prompts[0] ?? '', /replacement request/);
  await runtime.dispose();
});

test('REQ-IDE-008: an unexpected idle process exit is reaped before transparent replacement', async () => {
  const backends: RecordingBackend[] = [];
  const runtime = new NativePiRuntime(() => {
    const backend = new RecordingBackend();
    backends.push(backend);
    return backend;
  }, runNativePiChat);

  await runtime.handle({
    input: promptInput({ prompt: 'request before idle exit' }),
    response: responseRecorder().response,
    cancellation: activeCancellation,
  });
  const exited = backends[0];
  assert.ok(exited);
  exited.reusable = false;
  await runtime.handle({
    input: promptInput({
      prompt: 'request after idle exit',
      history: [{ role: 'user', text: 'replacement bootstrap' }],
    }),
    response: responseRecorder().response,
    cancellation: activeCancellation,
  });

  assert.equal(backends.length, 2);
  assert.equal(exited.stops, 1);
  assert.match(backends[1]?.prompts[0] ?? '', /request after idle exit/);
  assert.deepEqual(editorContext(backends[1]?.prompts[0] ?? '').history, [
    { role: 'user', text: 'replacement bootstrap' },
  ]);
  await runtime.dispose();
});

test('REQ-IDE-008: protocol or process failure retires the backend before replacement', async () => {
  const backends: RecordingBackend[] = [];
  const runtime = new NativePiRuntime(() => {
    const backend = new RecordingBackend(backends.length === 0
      ? { failure: new Error('Pi RPC process exited') }
      : undefined);
    backends.push(backend);
    return backend;
  }, runNativePiChat);

  await assert.rejects(runtime.handle({
    input: promptInput({ prompt: 'failing request' }),
    response: responseRecorder().response,
    cancellation: activeCancellation,
  }), /process exited/);
  await runtime.handle({
    input: promptInput({ prompt: 'request after failure' }),
    response: responseRecorder().response,
    cancellation: activeCancellation,
  });

  assert.equal(backends.length, 2);
  assert.equal(backends[0]?.stops, 1);
  assert.match(backends[1]?.prompts[0] ?? '', /request after failure/);
  await runtime.dispose();
});

test('REQ-IDE-008: queued cancellation releases a never-resolving input slot without spawning', async () => {
  const cancellation = new RecordingCancellation();
  let created = 0;
  const runtime = new NativePiRuntime(() => {
    created += 1;
    return new RecordingBackend();
  }, runNativePiChat);
  const pending = runtime.handle({
    input: new Promise<NativePiPromptInput>(() => undefined),
    response: responseRecorder().response,
    cancellation,
  });

  cancellation.cancel();
  await pending;
  assert.equal(created, 0);
  await runtime.dispose();
});

test('REQ-IDE-008: repeated disposal releases never-resolving input without spawning', async () => {
  let created = 0;
  const runtime = new NativePiRuntime(() => {
    created += 1;
    return new RecordingBackend();
  }, runNativePiChat);
  const pending = runtime.handle({
    input: new Promise<NativePiPromptInput>(() => undefined),
    response: responseRecorder().response,
    cancellation: activeCancellation,
  });
  await waitForImmediate();

  const first = runtime.dispose();
  const repeated = runtime.dispose();
  assert.equal(repeated, first);
  await Promise.all([first, pending]);
  assert.equal(created, 0);
});

test('REQ-IDE-008: deactivation reaps once and prevents queued or later work from spawning', async () => {
  const backends: RecordingBackend[] = [];
  const runtime = new NativePiRuntime(() => {
    const backend = new RecordingBackend({ autoSettle: false });
    backends.push(backend);
    return backend;
  }, runNativePiChat);
  const active = runtime.handle({
    input: promptInput({ prompt: 'active at deactivation' }),
    response: responseRecorder().response,
    cancellation: activeCancellation,
  });
  const queued = runtime.handle({
    input: promptInput({ prompt: 'queued at deactivation' }),
    response: responseRecorder().response,
    cancellation: activeCancellation,
  });
  await waitForImmediate();

  const outcomes = await Promise.allSettled([runtime.dispose(), runtime.dispose(), active, queued]);
  await runtime.handle({
    input: promptInput({ prompt: 'request after deactivation' }),
    response: responseRecorder().response,
    cancellation: activeCancellation,
  });

  assert.equal(outcomes[0]?.status, 'fulfilled');
  assert.equal(outcomes[1]?.status, 'fulfilled');
  assert.equal(outcomes[2]?.status, 'rejected');
  assert.equal(outcomes[3]?.status, 'fulfilled');
  assert.equal(backends.length, 1);
  assert.equal(backends[0]?.stops, 1);
  assert.equal(backends[0]?.prompts.length, 1);
  assert.doesNotMatch(backends[0]?.prompts[0] ?? '', /queued at deactivation|request after deactivation/);
});

test('REQ-IDE-006 AC6: an over-budget history replay keeps the newest turns and drops the oldest', () => {
  // Each entry is large enough that only a handful fit the history budget, so
  // the boundary is crossed well inside the list rather than at its edge.
  const entries = Array.from({ length: 40 }, (_, index) => ({
    role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `turn-${index} ${'x'.repeat(32 * 1024)}`,
  }));

  const prompt = buildNativePiPrompt(promptInput({ history: entries }));

  // The replay must be a suffix of the conversation: the last turn is present,
  // the first is not. Asserting both directions is what makes this fail if the
  // budget is ever spent front-first again.
  assert.ok(prompt.includes('turn-39'), 'the newest turn must survive truncation');
  assert.ok(!prompt.includes('turn-0 '), 'the oldest turn must be dropped first');

  // And what survives stays in conversation order — walking newest-first to
  // decide what fits must not leave the replay reversed.
  const positions = entries
    .map((entry, index) => ({ index, at: prompt.indexOf(`turn-${index} `) }))
    .filter((entry) => entry.at !== -1);
  assert.ok(positions.length >= 2, 'expected several turns to survive the budget');
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(
      (positions[i]?.at ?? 0) > (positions[i - 1]?.at ?? 0),
      'surviving turns must appear oldest-first in the replay',
    );
  }

  // A suffix, not an arbitrary subset: nothing may be dropped out of the middle.
  // (`positions` is derived in entry order, so comparing indices pairwise would
  // hold no matter what survived — this comparison against the expected run is
  // what actually constrains the shape.)
  const kept = positions.map((entry) => entry.index);
  const oldestKept = kept[0] ?? 0;
  assert.deepEqual(
    kept,
    entries.map((_, index) => index).filter((index) => index >= oldestKept),
    'surviving turns must be a contiguous suffix of the conversation',
  );

  assert.ok(Buffer.byteLength(prompt, 'utf8') <= MAX_NATIVE_CHAT_PROMPT_BYTES);
});

test('REQ-IDE-006 AC6: a context over the envelope drops whole sections and stays parseable', () => {
  // Every per-section budget is respected here, yet the rendered envelope still
  // overflows: the active editor's content is measured raw, and each control
  // character costs six bytes once JSON-escaped. Clamping the rendered string
  // would cut the serialized context mid-object, so whole units go instead --
  // and the file the user is looking at outlives the replay of older turns.
  const conversation = [
    { role: 'user' as const, text: 'first turn' },
    { role: 'assistant' as const, text: 'h'.repeat(400 * 1000) },
  ];
  const prompt = buildNativePiPrompt(promptInput({
    prompt: 'x'.repeat(200 * 1000),
    history: conversation,
    activeEditor: {
      path: '/home/user/workspace/src/parser.ts',
      languageId: 'typescript',
      dirty: true,
      content: '\u0001'.repeat(200 * 1000),
    },
  }));

  const context = editorContext(prompt);
  // Parsing at all is half the contract: the old clamp emitted a truncated object.
  assert.equal((context.activeEditor as { path?: string } | undefined)?.path, 'src/parser.ts');
  assert.equal(context.openFiles, undefined);
  assert.equal(context.diagnostics, undefined);
  assert.equal(context.references, undefined);
  // The replay is what gives way, and it gives way by shrinking rather than by
  // being cut mid-value: what remains is still a well-formed list of turns.
  assert.ok(Array.isArray(context.history), 'the replay survives in reduced form');
  assert.ok(
    JSON.stringify(context.history).length < JSON.stringify(conversation).length,
    'the replay must be the section that shrinks, not the editor state',
  );
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= MAX_NATIVE_CHAT_PROMPT_BYTES);
});
