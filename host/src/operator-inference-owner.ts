/** Ordinary-Host composition for configured Pi inference (REQ-OPERATOR-003/007/047/048).
 * Only local paths are captured at startup. The container-bound parent derives
 * authority from its server-bound owner/session and performs the live checks.
 */
import path from 'node:path';
import { OperatorInferenceRefusal, type OperatorInferenceOwner,
  type OperatorInferenceOwnerResolver } from './operator-inference.js';

const OWNER_CONTEXT_URL = 'https://operator.internal/v1/dispatcher/owner-context';
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_CONTEXT_BYTES = 16 * 1024;
const CONTEXT_TIMEOUT_MS = 10_000;

/** Nonsecret direct JSON response from the fixed container-bound parent route.
 * activityId/generation are the request's lookup binding, not caller authority.
 */
export type OperatorInferenceOwnerContext = Pick<OperatorInferenceOwner,
  'ownerKey' | 'sessionId' | 'sessionGeneration' | 'deadline' | 'maxRequestBytes' | 'maxResponseBytes'
  | 'selection' | 'reasoningOverride' | 'managed'>;

export interface OperatorInferenceOwnerResolverOptions {
  cwd?: string;
  agentDir?: string;
  sdkRoot?: string;
  /** Trusted transport seam only. The destination is always the fixed URL. */
  fetch?: typeof globalThis.fetch;
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const allowed = (value: RecordValue, names: string[]) => Object.keys(value).every(key => names.includes(key));

function parseContext(value: unknown): OperatorInferenceOwnerContext {
  if (!record(value) || !allowed(value, ['ownerKey', 'sessionId', 'sessionGeneration', 'deadline',
    'maxRequestBytes', 'maxResponseBytes', 'selection', 'reasoningOverride', 'managed'])
    || !text(value.ownerKey, 512) || !id(value.sessionId) || !positive(value.sessionGeneration)
    || !positive(value.deadline) || value.deadline <= Date.now()
    || !positive(value.maxRequestBytes) || !positive(value.maxResponseBytes)
    || value.reasoningOverride !== undefined && !text(value.reasoningOverride, 128)) {
    throw new OperatorInferenceRefusal(403);
  }
  let selection: OperatorInferenceOwner['selection'];
  if (value.selection !== undefined) {
    const selected = value.selection;
    if (!record(selected) || !allowed(selected, ['source', 'routeId', 'provider', 'model', 'api', 'reasoningLevel', 'profileDigest'])
      || selected.source !== undefined && selected.source !== 'pi-native' && selected.source !== 'managed'
      || !text(selected.provider, 512) || !text(selected.model, 512) || !text(selected.api, 512)
      || selected.reasoningLevel !== null && !text(selected.reasoningLevel, 128) || typeof selected.profileDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(selected.profileDigest)) throw new OperatorInferenceRefusal(403);
    selection = { provider: selected.provider, model: selected.model, api: selected.api,
      reasoningLevel: selected.reasoningLevel, profileDigest: selected.profileDigest };
  }
  let managed: OperatorInferenceOwner['managed'];
  if (value.managed !== undefined) {
    const item = value.managed;
    if (!record(item) || !allowed(item, ['provider', 'model', 'reasoningLevel']) || !text(item.provider, 512)
      || !text(item.model, 512) || item.reasoningLevel !== null && !text(item.reasoningLevel, 128)) throw new OperatorInferenceRefusal(403);
    managed = { provider: item.provider, model: item.model, reasoningLevel: item.reasoningLevel as string | null };
  }
  // Project only the public contract, in stable order for exact recheck equality.
  return { ownerKey: value.ownerKey, sessionId: value.sessionId, sessionGeneration: value.sessionGeneration,
    deadline: value.deadline, maxRequestBytes: value.maxRequestBytes, maxResponseBytes: value.maxResponseBytes,
    selection, managed, reasoningOverride: value.reasoningOverride as string | undefined };
}

async function readContext(response: Response): Promise<OperatorInferenceOwnerContext> {
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new OperatorInferenceRefusal(403);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_CONTEXT_BYTES) throw new OperatorInferenceRefusal(403);
      chunks.push(part.value);
    }
    return parseContext(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Install only on an ordinary Host, never the restricted Conductor composition.
 * Requests provide only lookup metadata; parent egress binds the actual owner.
 * No parent response, stale context or transport error can fall back to defaults.
 */
export function createOperatorInferenceOwnerResolver(options: OperatorInferenceOwnerResolverOptions = {}): OperatorInferenceOwnerResolver {
  const cwd = path.resolve(options.cwd ?? process.env.WORKSPACE ?? '/home/user/workspace');
  const agentDir = path.resolve(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? '/home/user/.pi/agent');
  const send = options.fetch ?? globalThis.fetch;
  return async (bytes, callerSignal) => {
    if (bytes.byteLength > MAX_METADATA_BYTES) throw new OperatorInferenceRefusal(413);
    let input: unknown;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new OperatorInferenceRefusal(400); }
    if (!record(input) || !id(input.activityId) || !positive(input.generation)) throw new OperatorInferenceRefusal(400);
    // Deliberately do not forward schema, paths, principal, session, selection,
    // options, transcript, URL or any other HTTP input to the authority service.
    const metadata = { activityId: input.activityId, generation: input.generation };
    const lookup = async (deadline?: number): Promise<OperatorInferenceOwnerContext> => {
      const remaining = deadline === undefined ? CONTEXT_TIMEOUT_MS : Math.min(CONTEXT_TIMEOUT_MS, deadline - Date.now());
      if (callerSignal.aborted || remaining <= 0) throw new OperatorInferenceRefusal(403);
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(remaining)]);
      try {
        const response = await send(OWNER_CONTEXT_URL, { method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(metadata) });
        const context = await readContext(response);
        signal.throwIfAborted();
        return context;
      } catch { throw new OperatorInferenceRefusal(403); }
    };
    const original = await lookup();
    const snapshot = JSON.stringify(original);
    return { ...original, cwd, agentDir, ...(options.sdkRoot ? { sdkRoot: options.sdkRoot } : {}),
      current: async binding => {
        if (binding.ownerKey !== original.ownerKey || binding.sessionId !== original.sessionId
          || binding.sessionGeneration !== original.sessionGeneration || binding.activityId !== metadata.activityId
          || binding.generation !== metadata.generation || Date.now() >= original.deadline || callerSignal.aborted) return false;
        try {
          // Never treat the initial context as startup authority: the parent
          // re-verifies current human, Activity generation and policy each time.
          const current = await lookup(original.deadline);
          return !callerSignal.aborted && Date.now() < original.deadline && JSON.stringify(current) === snapshot;
        } catch { return false; }
      },
    };
  };
}
