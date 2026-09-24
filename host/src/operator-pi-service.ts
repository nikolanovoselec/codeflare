/**
 * Trusted startup composition for the host's operator Pi service.
 * Configuration comes only from parent-set process environment before the
 * restricted session starts; candidate requests cannot choose identities,
 * directories, model, tools or resources.
 */
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OperatorPiConversation, type OperatorPiMetadata, type OperatorPiStore } from './operator-pi.js';
import { OperatorPiHttpController } from './operator-pi-http.js';
import { createProvisionedOperatorPiFactory, type OperatorPiSdkProfile } from './operator-pi-sdk.js';
import type { OperatorPiReviewConfig } from './operator-pi-review.js';

const MAX_METADATA = 256 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TASK_STATUS = new Set(['running', 'queued', 'accepted', 'completed', 'failed', 'cancelled', 'unknown']);

function parseMetadata(value: unknown): OperatorPiMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Pi metadata');
  const record = value as Record<string, unknown>;
  const tasks = record.tasks;
  if (record.schemaVersion !== 1 || typeof record.activityId !== 'string' || !ID.test(record.activityId)
    || typeof record.sessionId !== 'string' || !ID.test(record.sessionId)
    || typeof record.conversationId !== 'string' || !ID.test(record.conversationId)
    || typeof record.sessionFile !== 'string' || !path.isAbsolute(record.sessionFile)
    || !tasks || typeof tasks !== 'object' || Array.isArray(tasks) || Object.keys(tasks).length > 1024) {
    throw new Error('Invalid Pi metadata');
  }
  for (const [taskId, task] of Object.entries(tasks)) {
    if (!ID.test(taskId) || !task || typeof task !== 'object' || Array.isArray(task)) throw new Error('Invalid Pi metadata');
    const item = task as Record<string, unknown>;
    if (Object.keys(item).length !== 3 || typeof item.digest !== 'string' || !DIGEST.test(item.digest)
      || (item.mode !== 'prompt' && item.mode !== 'follow-up' && item.mode !== 'steer' && item.mode !== 'tool')
      || typeof item.status !== 'string' || !TASK_STATUS.has(item.status)) throw new Error('Invalid Pi metadata');
  }
  return structuredClone(record) as unknown as OperatorPiMetadata;
}

export class FileOperatorPiStore implements OperatorPiStore {
  private readonly file: string;

  constructor(file: string) {
    if (!path.isAbsolute(file)) throw new Error('Pi metadata path must be absolute');
    this.file = path.resolve(file);
  }

  async load(): Promise<OperatorPiMetadata | null> {
    let info;
    try { info = await stat(this.file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!info.isFile() || info.size > MAX_METADATA) throw new Error('Pi metadata is too large or invalid');
    const encoded = await readFile(this.file);
    if (encoded.byteLength > MAX_METADATA) throw new Error('Pi metadata is too large');
    let value: unknown;
    try { value = JSON.parse(encoded.toString('utf8')); } catch { throw new Error('Invalid Pi metadata'); }
    return parseMetadata(value);
  }

  async save(metadata: OperatorPiMetadata): Promise<void> {
    const encoded = Buffer.from(JSON.stringify(parseMetadata(metadata)));
    if (encoded.byteLength > MAX_METADATA) throw new Error('Pi metadata is too large');
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${path.basename(this.file)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try { await rename(temporary, this.file); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  }
}

interface SerializedConfig {
  schemaVersion: 1;
  activityId: string;
  sessionId: string;
  root: string;
  profile: OperatorPiSdkProfile;
  mode?: 'review';
  review?: OperatorPiReviewConfig;
}

function parseReviewConfig(value: unknown): OperatorPiReviewConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid operator Pi configuration');
  const review = value as Record<string, unknown>;
  if (Object.keys(review).length !== 3 || typeof review.packetDigest !== 'string' || !DIGEST.test(review.packetDigest)
    || typeof review.head !== 'string' || !/^[0-9a-f]{40}$/.test(review.head)
    || typeof review.generation !== 'number' || !Number.isSafeInteger(review.generation) || review.generation <= 0) {
    throw new Error('Invalid operator Pi configuration');
  }
  return { packetDigest: review.packetDigest, head: review.head, generation: review.generation };
}

function parseConfig(serialized: string, allowedRoot: string): SerializedConfig {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new Error('Invalid operator Pi configuration'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid operator Pi configuration');
  const record = value as Record<string, unknown>;
  const profile = record.profile;
  const root = typeof record.root === 'string' ? path.resolve(record.root) : '';
  const boundary = path.resolve(allowedRoot);
  const keys = Object.keys(record);
  const standard = keys.length === 5 && record.mode === undefined && record.review === undefined;
  const reviewMode = keys.length === 7 && record.mode === 'review';
  if ((!standard && !reviewMode) || record.schemaVersion !== 1
    || typeof record.activityId !== 'string' || !ID.test(record.activityId)
    || typeof record.sessionId !== 'string' || !ID.test(record.sessionId)
    || typeof record.root !== 'string' || !path.isAbsolute(record.root)
    || (root !== boundary && !root.startsWith(`${boundary}${path.sep}`))
    || !profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('Invalid operator Pi configuration');
  }
  const p = profile as Record<string, unknown>;
  if (Object.keys(p).some(key => !['provider', 'model', 'thinkingLevel', 'systemPrompt', 'tools'].includes(key))
    || typeof p.provider !== 'string' || typeof p.model !== 'string' || typeof p.thinkingLevel !== 'string'
    || typeof p.systemPrompt !== 'string' || !Array.isArray(p.tools) || p.tools.some(tool => typeof tool !== 'string')) {
    throw new Error('Invalid operator Pi configuration');
  }
  return { schemaVersion: 1, activityId: record.activityId, sessionId: record.sessionId, root,
    profile: { provider: p.provider, model: p.model, thinkingLevel: p.thinkingLevel,
      systemPrompt: p.systemPrompt, tools: p.tools as string[] },
    ...(reviewMode ? { mode: 'review' as const, review: parseReviewConfig(record.review) } : {}) };
}

export function createOperatorPiService(options: {
  serializedConfig?: string;
  allowedRoot: string;
  importSdk?: () => Promise<Record<string, unknown>>;
  importPiAi?: () => Promise<Record<string, unknown>>;
}): OperatorPiHttpController | undefined {
  if (!options.serializedConfig) return undefined;
  const config = parseConfig(options.serializedConfig, options.allowedRoot);
  const conversation = new OperatorPiConversation({
    activityId: config.activityId,
    sessionId: config.sessionId,
    store: new FileOperatorPiStore(path.join(config.root, '.codeflare/operator-pi.json')),
    factory: createProvisionedOperatorPiFactory({
      cwd: path.join(config.root, 'work'), agentDir: path.join(config.root, 'agent'),
      sessionDir: path.join(config.root, 'sessions'), profile: config.profile,
      ...(config.review ? { review: config.review } : {}),
      ...(options.importSdk ? { importSdk: options.importSdk } : {}),
      ...(options.importPiAi ? { importPiAi: options.importPiAi } : {}),
    }),
  });
  return new OperatorPiHttpController(conversation);
}
