import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  MAX_NATIVE_CHAT_PROMPT_BYTES,
  buildNativePiPrompt,
  runNativePiChat,
  type NativePiBackend,
  type NativePiCancellation,
  type NativePiPromptInput,
  type NativePiResponse,
  type NativePiTurnObserver,
} from '../src/pi/native-chat.ts';

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
  stopped = false;

  async runPrompt(message: string, observer: NativePiTurnObserver): Promise<void> {
    this.prompts.push(message);
    observer.progress('Reading workspace files…');
    observer.markdown('Applied the guarded change.');
  }

  async abort(): Promise<void> {}

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

function responseRecorder(): { response: NativePiResponse; markdown: string[]; progress: string[] } {
  const markdown: string[] = [];
  const progress: string[] = [];
  return {
    response: {
      markdown: (value) => markdown.push(value),
      progress: (value) => progress.push(value),
    },
    markdown,
    progress,
  };
}

const activeCancellation: NativePiCancellation = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

test('REQ-IDE-005 AC4 + REQ-IDE-006 AC3: each native Chat request uses and reaps a fresh isolated Pi backend', async () => {
  const backends: RecordingBackend[] = [];
  const first = responseRecorder();
  const second = responseRecorder();
  const createBackend = (): NativePiBackend => {
    const backend = new RecordingBackend();
    backends.push(backend);
    return backend;
  };

  await runNativePiChat({
    input: promptInput({ prompt: 'first request' }),
    response: first.response,
    cancellation: activeCancellation,
    createBackend,
  });
  await runNativePiChat({
    input: promptInput({ prompt: 'second request', history: [] }),
    response: second.response,
    cancellation: activeCancellation,
    createBackend,
  });

  assert.equal(backends.length, 2);
  assert.equal(backends[0]?.stopped, true);
  assert.equal(backends[1]?.stopped, true);
  assert.match(backends[0]?.prompts[0] ?? '', /first request/);
  assert.doesNotMatch(backends[1]?.prompts[0] ?? '', /first request/);
  assert.deepEqual(first.progress, ['Reading workspace files…']);
  assert.deepEqual(first.markdown, ['Applied the guarded change.']);
});

test('REQ-IDE-008 AC1+AC3: native Chat cancellation is registered before the Pi request and cleanup still runs', async () => {
  const events: string[] = [];
  let cancel = (): void => undefined;
  const cancellation: NativePiCancellation = {
    isCancellationRequested: false,
    onCancellationRequested: (listener) => {
      events.push('listen');
      cancel = listener;
      return { dispose: () => events.push('dispose-listener') };
    },
  };
  let finishPrompt = (): void => undefined;
  const backend: NativePiBackend = {
    runPrompt: async () => {
      events.push('prompt');
      const pending = new Promise<void>((resolve) => { finishPrompt = resolve; });
      cancel();
      await pending;
    },
    abort: async () => {
      events.push('abort');
      finishPrompt();
    },
    stop: async () => { events.push('stop'); },
  };

  await runNativePiChat({
    input: promptInput(),
    response: responseRecorder().response,
    cancellation,
    createBackend: () => backend,
  });

  assert.deepEqual(events, ['listen', 'prompt', 'abort', 'dispose-listener', 'stop']);
});

test('REQ-IDE-006 AC1: an over-budget history replay keeps the newest turns and drops the oldest', () => {
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
    assert.ok(
      (positions[i]?.index ?? 0) > (positions[i - 1]?.index ?? 0),
      'surviving turns must be a contiguous suffix in conversation order',
    );
  }

  assert.ok(Buffer.byteLength(prompt, 'utf8') <= MAX_NATIVE_CHAT_PROMPT_BYTES);
});
