import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildPublicExtractionRequest,
  extractionDue,
  extractionTranscriptFacts,
  parseActiveExtractionRequest,
  parseMemoryCaptureRequest,
  parseSessionEntries,
  parseVaultExtractRequest,
  type ExtractionJob,
  type PublicExtractionRequest,
} from '../../../preseed/agents/pi/extensions/memory-vault-helpers';
import {
  registerMemoryVault,
  type MemoryVaultDependencies,
  type MemoryVaultPi,
} from '../../../preseed/agents/pi/extensions/memory-vault';
import { readVaultManifest } from '../../../preseed/agents/pi/extensions/vault-manifest-fs';

const NOW = Date.parse('2026-07-14T10:00:00.000Z');
const UUIDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
];
const roots: string[] = [];
let entrySequence = 0;

interface SentMessage {
  message: {
    customType: string;
    content?: string;
    display?: boolean;
    details?: { items?: Array<Record<string, unknown>> };
  };
  options?: { deliverAs?: 'followUp'; triggerTurn?: boolean };
}

type Handler = (event: unknown, ctx: TestContext) => void | Promise<void>;
interface TestContext {
  cwd: string;
  sessionManager: {
    getSessionFile(): string;
    getSessionId(): string;
    getHeader(): Record<string, unknown>;
  };
}

class FakePi implements MemoryVaultPi {
  readonly handlers = new Map<string, Handler[]>();
  readonly sent: SentMessage[] = [];

  constructor(private readonly sessionFile: string) {}

  on(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  sendMessage(message: SentMessage['message'], options?: SentMessage['options']): void {
    this.sent.push({ message, options });
    appendEntry(this.sessionFile, {
      type: 'custom_message',
      id: nextId('custom'),
      parentId: null,
      timestamp: new Date(NOW).toISOString(),
      ...message,
    });
  }

  async emit(event: string, payload: unknown, ctx: TestContext): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, ctx);
  }
}

interface Harness {
  root: string;
  paths: MemoryVaultDependencies['paths'];
  sessionFile: string;
  sessionId: string;
  pi: FakePi;
  ctx: TestContext;
  setNow(value: number): void;
  emit(event: string, payload?: unknown): Promise<void>;
}

function nextId(prefix: string): string {
  entrySequence += 1;
  return `${prefix}-${entrySequence}`;
}

function appendEntry(path: string, ...entries: Array<Record<string, unknown>>): void {
  appendFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}

function userMessage(content: string, timestamp = '2026-07-14T09:00:00.000Z'): Record<string, unknown> {
  return {
    type: 'message',
    id: nextId('user'),
    parentId: null,
    timestamp,
    message: { role: 'user', content, timestamp: Date.parse(timestamp) },
  };
}

function toolCall(
  toolUseId: string,
  job: ExtractionJob,
  request: PublicExtractionRequest,
  timestamp = '2026-07-14T09:45:00.000Z',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'message',
    id: nextId('assistant'),
    parentId: null,
    timestamp,
    message: {
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: toolUseId,
        name: 'subagent',
        arguments: { ...request, subagent_type: job, ...overrides },
      }],
      timestamp: Date.parse(timestamp),
    },
  };
}

function notification(toolUseId: string, status = 'Done'): Record<string, unknown> {
  return {
    type: 'custom_message',
    id: nextId('notification'),
    parentId: null,
    timestamp: '2026-07-14T09:46:00.000Z',
    customType: 'subagent-notification',
    content: `<task-notification>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n</task-notification>`,
    display: true,
  };
}

function launchEntry(
  requestId: string,
  job: ExtractionJob,
  reminder: number,
  request: PublicExtractionRequest,
): Record<string, unknown> {
  return {
    type: 'custom_message',
    id: nextId('launch'),
    parentId: null,
    timestamp: '2026-07-14T09:20:00.000Z',
    customType: 'background-extraction-launch',
    content: 'launch',
    display: true,
    details: { items: [{ requestId, jobType: job, reminder, request }] },
  };
}

function makeHarness(options: { child?: boolean } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'pi-memory-vault-'));
  roots.push(root);
  const vaultRoot = join(root, 'Vault');
  const cacheDir = join(root, 'cache');
  const memoryCounterDir = join(root, 'counters');
  const promptsDir = join(root, 'prompts');
  const sessionFile = join(root, 'session.jsonl');
  const sessionId = 'session-1';
  const paths = {
    vaultRoot,
    cacheDir,
    memoryCounterDir,
    memoryPromptFile: join(promptsDir, 'memory-agent-prompt.md'),
    vaultPromptFile: join(promptsDir, 'vault-extract-prompt.md'),
    vaultManifestFile: join(vaultRoot, 'graphify-out', 'vault-extract-manifest.json'),
    vaultMarkerFile: join(cacheDir, 'vault-extract.last'),
  };
  mkdirSync(join(vaultRoot, 'Notes'), { recursive: true });
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(paths.memoryPromptFile, '# memory fixture\n', 'utf8');
  writeFileSync(paths.vaultPromptFile, '# vault fixture\n', 'utf8');
  writeFileSync(sessionFile, `${JSON.stringify({
    type: 'session',
    id: sessionId,
    cwd: root,
    ...(options.child ? { parentSession: '/tmp/parent.jsonl' } : {}),
  })}\n`, 'utf8');

  let now = NOW;
  let uuidIndex = 0;
  const dependencies: MemoryVaultDependencies = {
    paths,
    now: () => now,
    randomUUID: () => UUIDS[uuidIndex++] ?? UUIDS.at(-1)!,
  };
  const pi = new FakePi(sessionFile);
  const ctx: TestContext = {
    cwd: root,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionId,
      getHeader: () => options.child ? { parentSession: '/tmp/parent.jsonl' } : { id: sessionId },
    },
  };
  registerMemoryVault(pi, dependencies);
  return {
    root,
    paths,
    sessionFile,
    sessionId,
    pi,
    ctx,
    setNow: (value) => { now = value; },
    emit: async (event, payload = {}) => pi.emit(event, payload, ctx),
  };
}

function memoryPointerPath(harness: Harness): string {
  return join(harness.paths.memoryCounterDir, `${harness.sessionId}.vars`);
}

function memoryCounterPath(harness: Harness): string {
  return join(harness.paths.memoryCounterDir, `${harness.sessionId}.count`);
}

function vaultPointerPath(harness: Harness): string {
  return join(harness.paths.cacheDir, 'vault-extract.pi.vars');
}

function vaultChunkPath(harness: Harness, requestId: string): string {
  return join(harness.paths.vaultRoot, 'graphify-out', `.graphify_chunk_${requestId}.json`);
}

function writePostCommitChunk(harness: Harness, requestId: string): void {
  writeFileSync(vaultChunkPath(harness, requestId), `${JSON.stringify({
    nodes: [],
    edges: [],
    hyperedges: [],
    input_tokens: 0,
    output_tokens: 0,
  })}\n`, 'utf8');
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function activeExecutionPath(harness: Harness, job: ExtractionJob): string {
  const pointerPath = job === 'memory-capture' ? memoryPointerPath(harness) : vaultPointerPath(harness);
  const requestId = String(readJson(pointerPath).requestId);
  return job === 'memory-capture'
    ? join(harness.paths.memoryCounterDir, `${harness.sessionId}.${requestId}.vars`)
    : join(harness.paths.cacheDir, `vault-extract.pi.${requestId}.vars`);
}

function latestLaunch(pi: FakePi, job: ExtractionJob): { requestId: string; reminder: number; request: PublicExtractionRequest } {
  const items = pi.sent
    .filter((sent) => sent.message.customType === 'background-extraction-launch')
    .flatMap((sent) => sent.message.details?.items ?? [])
    .filter((item) => item.jobType === job);
  const item = items.at(-1);
  if (!item) throw new Error(`missing ${job} launch`);
  return item as unknown as { requestId: string; reminder: number; request: PublicExtractionRequest };
}

async function appendPrompt(harness: Harness, ordinal: number): Promise<void> {
  const content = `real prompt ${ordinal}`;
  appendEntry(harness.sessionFile, userMessage(content));
  await harness.emit('before_agent_start', { prompt: content });
}

afterEach(() => {
  delete process.env.CODEFLARE_MEMORY_MODEL;
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('@gotgenes/pi-subagents:service')];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('REQ-MEM-014/REQ-MEM-015: public extraction transcript contracts', () => {
  it('validates active, memory, and Vault request boundaries', () => {
    const memory = {
      version: 1,
      requestId: UUIDS[0],
      sessionId: 'session-1',
      promptCount: 15,
      captureTimestamp: '2026-07-14T10-00-00',
      captureFilename: '2026-07-14T10-00-00-session-1.md',
      transcript: '## user\nhello',
    };
    const vault = {
      version: 1,
      requestId: UUIDS[1],
      changedFiles: ['/vault/a.md', '/vault/b.md'],
      stagedManifestHash: 'a'.repeat(64),
    };

    expect(parseActiveExtractionRequest({ version: 1, requestId: UUIDS[0] })).toEqual({ version: 1, requestId: UUIDS[0] });
    expect(parseMemoryCaptureRequest(memory)).toEqual(memory);
    expect(parseVaultExtractRequest({ ...vault, changedFiles: [...vault.changedFiles].reverse() })).toEqual(vault);
    expect(parseMemoryCaptureRequest({ ...memory, sessionId: '../escape' })).toBeUndefined();
    expect(parseMemoryCaptureRequest({ ...memory, captureFilename: '../capture.md' })).toBeUndefined();
    expect(parseVaultExtractRequest({ ...vault, stagedManifestHash: 'not-a-hash' })).toBeUndefined();
  });

  it('REQ-MEM-016: builds one bounded medium-reasoning public background request', () => {
    const base = {
      job: 'memory-capture' as const,
      requestId: UUIDS[0],
      promptFile: '/prompts/memory.md',
      varsFile: '/vars/request.json',
    };
    expect(buildPublicExtractionRequest(base)).toEqual({
      subagent_type: 'memory-capture',
      description: 'Capture session memory',
      prompt: `CODEFLARE_EXTRACTION_REQUEST=${UUIDS[0]}\nPROMPT_FILE=/prompts/memory.md\nVARS_FILE=/vars/request.json\nVARS_FILE contains the transcript inline; there is no INPUT_FILE or separate transcript file.\nRun the deployed Pi extraction contract end to end.`,
      run_in_background: true,
      inherit_context: false,
      thinking: 'medium',
      max_turns: 4,
    });
    expect(buildPublicExtractionRequest({ ...base, model: '  ' })).not.toHaveProperty('model');
    expect(buildPublicExtractionRequest({ ...base, model: 'provider/model' })).toHaveProperty('model', 'provider/model');
  });

  it('correlates exact public calls and reconstructs running, failed, and successful state', () => {
    const request = buildPublicExtractionRequest({
      job: 'memory-capture',
      requestId: UUIDS[0],
      promptFile: '/prompt',
      varsFile: '/vars',
    });
    const entries = [
      launchEntry(UUIDS[0], 'memory-capture', 0, request),
      toolCall('wrong-background', 'memory-capture', request, undefined, { run_in_background: false }),
      toolCall('wrong-thinking', 'memory-capture', request, undefined, { thinking: 'high' }),
      toolCall('wrong-turn-limit', 'memory-capture', request, undefined, { max_turns: 40 }),
      toolCall('exact-call', 'memory-capture', request),
    ];
    expect(extractionTranscriptFacts({
      entries,
      requestId: UUIDS[0],
      job: 'memory-capture',
      now: NOW,
      successQualifies: () => true,
    })).toMatchObject({ launchCount: 1, attemptCount: 1, state: 'running', giveup: false });

    expect(extractionTranscriptFacts({
      entries,
      requestId: UUIDS[0],
      job: 'memory-capture',
      now: NOW + (30 * 60 * 1000),
      successQualifies: () => true,
    }).state).toBe('failed');

    expect(extractionTranscriptFacts({
      entries: [...entries, notification('exact-call')],
      requestId: UUIDS[0],
      job: 'memory-capture',
      now: NOW,
      successQualifies: () => true,
    }).state).toBe('succeeded');
    expect(extractionTranscriptFacts({
      entries: [...entries, notification('exact-call')],
      requestId: UUIDS[0],
      job: 'memory-capture',
      now: NOW,
      successQualifies: () => false,
    }).state).toBe('failed');

    const turnLimited = [...entries, notification('exact-call', 'Wrapped up (turn limit)')];
    expect(extractionTranscriptFacts({
      entries: turnLimited,
      requestId: UUIDS[0],
      job: 'memory-capture',
      now: NOW,
      successQualifies: () => true,
    }).state).toBe('succeeded');
    expect(extractionTranscriptFacts({
      entries: turnLimited,
      requestId: UUIDS[0],
      job: 'memory-capture',
      now: NOW,
      successQualifies: () => false,
    }).state).toBe('failed');
  });

  it('uses one reducer for reminders zero through five and then latches GIVEUP', () => {
    for (let launchCount = 0; launchCount < 6; launchCount += 1) {
      expect(extractionDue({ launchCount, attemptCount: launchCount, giveup: false, state: 'failed' })).toEqual({
        kind: 'launch',
        reminder: launchCount,
      });
    }
    expect(extractionDue({ launchCount: 6, attemptCount: 6, giveup: false, state: 'failed' })).toEqual({ kind: 'giveup' });
    expect(extractionDue({ launchCount: 6, attemptCount: 6, giveup: true, state: 'failed' })).toEqual({ kind: 'none' });
    expect(extractionDue({ launchCount: 1, attemptCount: 1, giveup: false, state: 'running' })).toEqual({ kind: 'none' });
  });

  it('parses session JSONL without losing custom messages or valid entries around malformed lines', () => {
    const entries = parseSessionEntries(`${JSON.stringify(userMessage('before'))}\nnot-json\n${JSON.stringify(notification('tool-1'))}\n`);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry: any) => entry.type)).toEqual(['message', 'custom_message']);
  });
});

describe('REQ-MEM-001/REQ-MEM-002: root-owned memory delivery lifecycle', () => {
  it('creates work on the fifteenth real prompt and emits a visible reminder without private spawn', async () => {
    const harness = makeHarness();
    let privateSpawnCalls = 0;
    (globalThis as Record<symbol, unknown>)[Symbol.for('@gotgenes/pi-subagents:service')] = {
      spawn: () => { privateSpawnCalls += 1; throw new Error('private spawn forbidden'); },
    };
    await harness.emit('session_start');
    mkdirSync(dirname(memoryCounterPath(harness)), { recursive: true });
    writeFileSync(memoryCounterPath(harness), '0', 'utf8');

    for (let ordinal = 1; ordinal <= 14; ordinal += 1) await appendPrompt(harness, ordinal);
    expect(existsSync(memoryPointerPath(harness))).toBe(false);

    await appendPrompt(harness, 15);
    expect(existsSync(memoryPointerPath(harness))).toBe(true);
    await harness.emit('agent_settled');

    const launch = latestLaunch(harness.pi, 'memory-capture');
    expect(launch.reminder).toBe(0);
    expect(launch.request).toMatchObject({
      subagent_type: 'memory-capture',
      run_in_background: true,
      inherit_context: false,
      thinking: 'medium',
      max_turns: 4,
    });
    expect(launch.request.prompt).toContain(`CODEFLARE_EXTRACTION_REQUEST=${launch.requestId}`);
    expect(privateSpawnCalls).toBe(0);
    expect(harness.pi.sent.at(-1)?.options).toEqual({ deliverAs: 'followUp', triggerTurn: true });
  });

  it('captures only prompts after the root-owned successful counter', async () => {
    const harness = makeHarness();
    await harness.emit('session_start');
    mkdirSync(dirname(memoryCounterPath(harness)), { recursive: true });
    writeFileSync(memoryCounterPath(harness), '15', 'utf8');
    for (let ordinal = 1; ordinal <= 29; ordinal += 1) {
      appendEntry(harness.sessionFile, userMessage(`real prompt ${ordinal}`));
    }

    await appendPrompt(harness, 30);
    const execution = readJson(activeExecutionPath(harness, 'memory-capture'));
    expect(execution.promptCount).toBe(30);
    expect(execution.transcript).not.toContain('real prompt 15\n');
    expect(execution.transcript).toContain('real prompt 16');
    expect(execution.transcript).toContain('real prompt 30');
  });

  it('excludes synthetic task, Agent, prompt-file, and extraction directive entries from the cadence', async () => {
    const harness = makeHarness();
    await harness.emit('session_start');
    mkdirSync(dirname(memoryCounterPath(harness)), { recursive: true });
    writeFileSync(memoryCounterPath(harness), '0', 'utf8');
    for (let ordinal = 1; ordinal <= 14; ordinal += 1) await appendPrompt(harness, ordinal);
    for (const content of [
      '<task-notification>done</task-notification>',
      'Agent({ subagent_type: "memory-capture" })',
      'PROMPT_FILE=/tmp/prompt',
      '[codeflare-extraction] launch',
    ]) appendEntry(harness.sessionFile, userMessage(content));

    await appendPrompt(harness, 15);
    const execution = readJson(activeExecutionPath(harness, 'memory-capture'));
    expect(execution.promptCount).toBe(15);
  });

  it('emits reminders zero through five, one GIVEUP, and derives the latch after re-registration', async () => {
    const harness = makeHarness();
    await harness.emit('session_start');
    mkdirSync(dirname(memoryCounterPath(harness)), { recursive: true });
    writeFileSync(memoryCounterPath(harness), '0', 'utf8');
    for (let ordinal = 1; ordinal <= 15; ordinal += 1) await appendPrompt(harness, ordinal);

    for (let attempt = 0; attempt < 7; attempt += 1) await harness.emit('agent_settled');
    const reminders = harness.pi.sent
      .filter((sent) => sent.message.customType === 'background-extraction-launch')
      .flatMap((sent) => sent.message.details?.items ?? [])
      .map((item) => item.reminder);
    expect(reminders).toEqual([0, 1, 2, 3, 4, 5]);
    expect(harness.pi.sent.filter((sent) => sent.message.customType === 'background-extraction-giveup')).toHaveLength(1);

    const sentBeforeReload = harness.pi.sent.length;
    const reloadedPi = new FakePi(harness.sessionFile);
    registerMemoryVault(reloadedPi, {
      paths: harness.paths,
      now: () => NOW,
      randomUUID: () => UUIDS[1],
    });
    await reloadedPi.emit('agent_settled', {}, harness.ctx);
    expect(reloadedPi.sent).toHaveLength(0);
    expect(harness.pi.sent).toHaveLength(sentBeforeReload);
  });

  it('requires the post-commit note and chunk before exact success advances the frozen counter', async () => {
    const harness = makeHarness();
    await harness.emit('session_start');
    mkdirSync(dirname(memoryCounterPath(harness)), { recursive: true });
    writeFileSync(memoryCounterPath(harness), '0', 'utf8');
    for (let ordinal = 1; ordinal <= 15; ordinal += 1) await appendPrompt(harness, ordinal);
    await harness.emit('agent_settled');
    const launch = latestLaunch(harness.pi, 'memory-capture');
    appendEntry(harness.sessionFile, toolCall('memory-call', 'memory-capture', launch.request), notification('memory-call'));

    await harness.emit('agent_settled');
    expect(readFileSync(memoryCounterPath(harness), 'utf8')).toBe('0');
    expect(latestLaunch(harness.pi, 'memory-capture').reminder).toBe(1);

    const execution = readJson(activeExecutionPath(harness, 'memory-capture'));
    const target = join(harness.paths.vaultRoot, 'Raw', 'Sessions', execution.captureFilename);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '# capture\n', 'utf8');
    await harness.emit('agent_settled');
    expect(readFileSync(memoryCounterPath(harness), 'utf8')).toBe('0');
    expect(existsSync(memoryPointerPath(harness))).toBe(true);

    writePostCommitChunk(harness, execution.requestId);
    await harness.emit('agent_settled');

    expect(readFileSync(memoryCounterPath(harness), 'utf8')).toBe('15');
    expect(existsSync(memoryPointerPath(harness))).toBe(false);
    expect(existsSync(vaultChunkPath(harness, execution.requestId))).toBe(false);
    expect(existsSync(join(harness.paths.memoryCounterDir, `${harness.sessionId}.${launch.requestId}.vars`))).toBe(false);
  });

  it('re-arms only after fifteen later real prompts and isolates the replacement from the old request', async () => {
    const harness = makeHarness();
    await harness.emit('session_start');
    mkdirSync(dirname(memoryCounterPath(harness)), { recursive: true });
    writeFileSync(memoryCounterPath(harness), '0', 'utf8');
    for (let ordinal = 1; ordinal <= 15; ordinal += 1) await appendPrompt(harness, ordinal);
    for (let attempt = 0; attempt < 7; attempt += 1) await harness.emit('agent_settled');
    const oldPointer = readJson(memoryPointerPath(harness));
    const oldExecution = activeExecutionPath(harness, 'memory-capture');

    for (let ordinal = 16; ordinal <= 29; ordinal += 1) await appendPrompt(harness, ordinal);
    expect(readJson(memoryPointerPath(harness)).requestId).toBe(oldPointer.requestId);
    await appendPrompt(harness, 30);

    const replacement = readJson(memoryPointerPath(harness));
    expect(replacement.requestId).not.toBe(oldPointer.requestId);
    expect(activeExecutionPath(harness, 'memory-capture')).not.toBe(oldExecution);
    expect(existsSync(oldExecution)).toBe(false);

    appendEntry(harness.sessionFile, notification('late-old-call'));
    await harness.emit('agent_settled');
    expect(readJson(memoryPointerPath(harness)).requestId).toBe(replacement.requestId);
    expect(readFileSync(memoryCounterPath(harness), 'utf8')).toBe('0');
  });
});

describe('REQ-VAULT-027: transactional Pi Vault extraction delivery', () => {
  it('coalesces edits before launch and freezes the request after its first exact call', async () => {
    const harness = makeHarness();
    await harness.emit('session_start');
    const first = join(harness.paths.vaultRoot, 'Notes', 'first.md');
    writeFileSync(first, 'first\n', 'utf8');
    await harness.emit('agent_settled');

    const pointer = readJson(vaultPointerPath(harness));
    const executionPath = activeExecutionPath(harness, 'vault-extract');
    const second = join(harness.paths.vaultRoot, 'Notes', 'second.md');
    writeFileSync(second, 'second\n', 'utf8');
    appendEntry(harness.sessionFile, userMessage('coalesce pending vault edits'));
    await harness.emit('before_agent_start', { prompt: 'coalesce pending vault edits' });

    const coalesced = readJson(executionPath);
    expect(readJson(vaultPointerPath(harness)).requestId).toBe(pointer.requestId);
    expect(coalesced.changedFiles).toEqual([first, second]);

    await harness.emit('agent_settled');
    const launch = latestLaunch(harness.pi, 'vault-extract');
    expect(launch.request).toMatchObject({
      subagent_type: 'vault-extract',
      run_in_background: true,
      inherit_context: false,
      thinking: 'medium',
      max_turns: 4,
    });
    appendEntry(harness.sessionFile, toolCall('vault-call', 'vault-extract', launch.request));
    const frozenBytes = readFileSync(executionPath, 'utf8');
    writeFileSync(join(harness.paths.vaultRoot, 'Notes', 'third.md'), 'third\n', 'utf8');
    appendEntry(harness.sessionFile, userMessage('do not mutate launched work'));
    await harness.emit('before_agent_start', { prompt: 'do not mutate launched work' });
    expect(readFileSync(executionPath, 'utf8')).toBe(frozenBytes);
  });

  it('keeps the committed manifest byte-identical on failure and emits the next reminder', async () => {
    const harness = makeHarness();
    await harness.emit('session_start');
    const committedBefore = readFileSync(harness.paths.vaultManifestFile, 'utf8');
    writeFileSync(join(harness.paths.vaultRoot, 'Notes', 'failure.md'), 'changed\n', 'utf8');
    await harness.emit('agent_settled');
    const launch = latestLaunch(harness.pi, 'vault-extract');
    appendEntry(harness.sessionFile, toolCall('failed-vault', 'vault-extract', launch.request), notification('failed-vault', 'Failed'));

    await harness.emit('agent_settled');
    expect(readFileSync(harness.paths.vaultManifestFile, 'utf8')).toBe(committedBefore);
    expect(latestLaunch(harness.pi, 'vault-extract').reminder).toBe(1);
    expect(existsSync(vaultPointerPath(harness))).toBe(true);
  });

  it('requires a post-commit chunk before native completion can promote the manifest', async () => {
    const harness = makeHarness();
    await harness.emit('session_start');
    const committedBefore = readFileSync(harness.paths.vaultManifestFile, 'utf8');
    writeFileSync(join(harness.paths.vaultRoot, 'Notes', 'incomplete.md'), 'changed\n', 'utf8');
    await harness.emit('agent_settled');
    const launch = latestLaunch(harness.pi, 'vault-extract');
    appendEntry(
      harness.sessionFile,
      toolCall('incomplete-vault', 'vault-extract', launch.request),
      notification('incomplete-vault'),
    );

    await harness.emit('agent_settled');
    expect(readFileSync(harness.paths.vaultManifestFile, 'utf8')).toBe(committedBefore);
    expect(existsSync(vaultPointerPath(harness))).toBe(true);
    expect(latestLaunch(harness.pi, 'vault-extract').reminder).toBe(1);
  });

  it('promotes matching staged bytes and creates one follow-up request for during-run edits', async () => {
    const harness = makeHarness();
    await harness.emit('session_start');
    const first = join(harness.paths.vaultRoot, 'Notes', 'first.md');
    writeFileSync(first, 'first\n', 'utf8');
    await harness.emit('agent_settled');
    const firstPointer = readJson(vaultPointerPath(harness));
    const firstExecutionPath = activeExecutionPath(harness, 'vault-extract');
    const launch = latestLaunch(harness.pi, 'vault-extract');
    appendEntry(harness.sessionFile, toolCall('successful-vault', 'vault-extract', launch.request));
    writePostCommitChunk(harness, firstPointer.requestId);

    const duringRun = join(harness.paths.vaultRoot, 'Notes', 'during-run.md');
    writeFileSync(duringRun, 'later\n', 'utf8');
    appendEntry(harness.sessionFile, notification('successful-vault'));
    await harness.emit('agent_settled');

    const committed = readVaultManifest(harness.paths.vaultManifestFile);
    expect(committed.files['Notes/first.md']).toBeTypeOf('string');
    expect(committed.files['Notes/during-run.md']).toBeUndefined();
    expect(existsSync(harness.paths.vaultMarkerFile)).toBe(true);
    expect(existsSync(firstExecutionPath)).toBe(false);
    expect(existsSync(vaultChunkPath(harness, firstPointer.requestId))).toBe(false);

    const replacement = readJson(vaultPointerPath(harness));
    expect(replacement.requestId).not.toBe(firstPointer.requestId);
    expect(readJson(activeExecutionPath(harness, 'vault-extract')).changedFiles).toEqual([duringRun]);
  });

  it('recovers a missing or corrupt successful stage with a new full-delta request', async () => {
    const harness = makeHarness();
    await harness.emit('session_start');
    const changed = join(harness.paths.vaultRoot, 'Notes', 'changed.md');
    writeFileSync(changed, 'changed\n', 'utf8');
    await harness.emit('agent_settled');
    const original = readJson(vaultPointerPath(harness));
    const launch = latestLaunch(harness.pi, 'vault-extract');
    const staged = join(harness.paths.vaultRoot, 'graphify-out', `vault-extract-manifest.${original.requestId}.pending.json`);
    writeFileSync(staged, 'corrupt', 'utf8');
    writePostCommitChunk(harness, original.requestId);
    appendEntry(harness.sessionFile, toolCall('corrupt-stage', 'vault-extract', launch.request), notification('corrupt-stage'));

    await harness.emit('agent_settled');
    const replacement = readJson(vaultPointerPath(harness));
    expect(replacement.requestId).not.toBe(original.requestId);
    expect(readJson(activeExecutionPath(harness, 'vault-extract')).changedFiles).toEqual([changed]);
  });

  it('keeps GIVEUP latched for unchanged work, re-arms new content, and clears a full revert', async () => {
    const unchanged = makeHarness();
    await unchanged.emit('session_start');
    writeFileSync(join(unchanged.paths.vaultRoot, 'Notes', 'unchanged.md'), 'changed\n', 'utf8');
    for (let attempt = 0; attempt < 7; attempt += 1) await unchanged.emit('agent_settled');
    const unchangedPointer = readJson(vaultPointerPath(unchanged));
    appendEntry(unchanged.sessionFile, userMessage('check unchanged giveup'));
    await unchanged.emit('before_agent_start', { prompt: 'check unchanged giveup' });
    expect(readJson(vaultPointerPath(unchanged)).requestId).toBe(unchangedPointer.requestId);

    const added = join(unchanged.paths.vaultRoot, 'Notes', 'added.md');
    writeFileSync(added, 'new after giveup\n', 'utf8');
    appendEntry(unchanged.sessionFile, userMessage('re-arm changed giveup'));
    await unchanged.emit('before_agent_start', { prompt: 're-arm changed giveup' });
    expect(readJson(vaultPointerPath(unchanged)).requestId).not.toBe(unchangedPointer.requestId);

    const reverted = makeHarness();
    await reverted.emit('session_start');
    const revertedFile = join(reverted.paths.vaultRoot, 'Notes', 'reverted.md');
    writeFileSync(revertedFile, 'temporary\n', 'utf8');
    for (let attempt = 0; attempt < 7; attempt += 1) await reverted.emit('agent_settled');
    rmSync(revertedFile, { force: true });
    appendEntry(reverted.sessionFile, userMessage('clear reverted giveup'));
    await reverted.emit('before_agent_start', { prompt: 'clear reverted giveup' });
    expect(existsSync(vaultPointerPath(reverted))).toBe(false);
  });

  it('keeps an empty prelaunch coalescing result as a valid no-op request', async () => {
    const harness = makeHarness();
    await harness.emit('session_start');
    const changed = join(harness.paths.vaultRoot, 'Notes', 'reverted-before-launch.md');
    writeFileSync(changed, 'temporary\n', 'utf8');
    await harness.emit('agent_settled');
    const pointer = readJson(vaultPointerPath(harness));
    rmSync(changed, { force: true });
    appendEntry(harness.sessionFile, userMessage('coalesce the revert'));
    await harness.emit('before_agent_start', { prompt: 'coalesce the revert' });

    expect(readJson(vaultPointerPath(harness)).requestId).toBe(pointer.requestId);
    expect(readJson(activeExecutionPath(harness, 'vault-extract')).changedFiles).toEqual([]);
  });

  it('keeps all handlers inert in child sessions', async () => {
    const harness = makeHarness({ child: true });
    await harness.emit('session_start');
    appendEntry(harness.sessionFile, userMessage('child prompt'));
    await harness.emit('before_agent_start', { prompt: 'child prompt' });
    await harness.emit('agent_end', { messages: [{ role: 'user', content: 'child prompt' }] });
    await harness.emit('agent_settled');

    expect(harness.pi.sent).toHaveLength(0);
    expect(existsSync(harness.paths.vaultManifestFile)).toBe(false);
    expect(existsSync(memoryPointerPath(harness))).toBe(false);
    expect(existsSync(vaultPointerPath(harness))).toBe(false);
  });
});
