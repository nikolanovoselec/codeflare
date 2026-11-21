import type { Env } from '../types';
import { decryptFromKV, encryptForKV, getOrImportKey } from './kv-crypto';

export interface McpFence { epoch: string; revision: number }
export interface McpSnapshot { fence: McpFence; ciphertext: string | null; legacyImportEligible: boolean }
export interface McpPending { portalName: string; fence: McpFence; ciphertext: string }
export interface McpPendingInput { state: string; portalName: string; expected: McpFence; expiresAt: number; ciphertext: string }
export interface McpCallbackBinding { instance: string; issuer?: string }
interface OwnerState { epoch: string; legacyClosed: boolean; operationId: string | null }
interface GrantState { revision: number; ciphertext: string | null }
interface PendingState extends McpPending { expiresAt: number }
const META = 'mcp:owner';
const GRANT = 'mcp:grant:';
const PENDING = 'mcp:pending:';
const MAX_PENDING_AUTHORIZATIONS = 128;
const CLOSED = 'MCP offboarding in progress';

export function isMcpOffboardingError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(CLOSED);
}
export function mcpRecordContext(owner: string, epoch: string, kind: 'grant' | 'pending', identity: string): string {
  return JSON.stringify(['mcp-portal', owner, epoch, kind, identity]);
}
export async function encryptMcpRecord(env: Env, context: string, value: unknown): Promise<string> {
  const key = await getOrImportKey(env);
  if (!key) throw new Error('MCP portal encryption unavailable');
  return encryptForKV(JSON.stringify(value), key, context);
}
export async function decryptMcpRecord<T>(env: Env, context: string, ciphertext: string): Promise<T | null> {
  const key = await getOrImportKey(env);
  if (!key) throw new Error('MCP portal encryption unavailable');
  if (!ciphertext.startsWith('v1:')) return null;
  try { return JSON.parse(await decryptFromKV(ciphertext.slice(3), key, context)) as T; }
  catch { return null; }
}
function portalName(name: string): void {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid MCP portal name');
}
function stateName(state: string): void {
  if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state)) throw new Error('Invalid MCP state');
}
function ciphertextOnly(value: string): void {
  // Payload authentication belongs to the reader with the record's context.
  // The storage boundary never accepts plaintext, including from internal RPCs.
  if (typeof value !== 'string' || !/^v1:[A-Za-z0-9+/]+={0,2}$/.test(value)
    || value.length < 43) throw new Error('Invalid encrypted MCP record');
}
function sameFence(left: McpFence, right: McpFence): boolean {
  return !!right && typeof right.epoch === 'string' && Number.isSafeInteger(right.revision)
    && left.epoch === right.epoch && left.revision === right.revision;
}

/** Only the verified bucket-owner DO calls this transactional MCP store. */
export class McpPortalState {
  constructor(private readonly storage: DurableObjectStorage) {}

  private async metadata(txn: DurableObjectTransaction): Promise<OwnerState> {
    const saved = await txn.get<OwnerState>(META);
    if (saved) return saved;
    const initial = { epoch: crypto.randomUUID(), legacyClosed: false, operationId: null };
    await txn.put(META, initial);
    return initial;
  }
  private async snapshot(txn: DurableObjectTransaction, meta: OwnerState, name: string): Promise<McpSnapshot> {
    if (meta.operationId) throw new Error(CLOSED);
    const grant = await txn.get<GrantState>(GRANT + name);
    return { fence: { epoch: meta.epoch, revision: grant?.revision ?? 0 }, ciphertext: grant?.ciphertext ?? null,
      legacyImportEligible: !meta.legacyClosed && !grant };
  }
  read(name: string): Promise<McpSnapshot> {
    portalName(name);
    return this.storage.transaction(async txn => this.snapshot(txn, await this.metadata(txn), name));
  }
  private replace(name: string, expected: McpFence, ciphertext: string, importing: boolean): Promise<McpSnapshot | null> {
    portalName(name); ciphertextOnly(ciphertext);
    return this.storage.transaction(async txn => {
      const meta = await this.metadata(txn);
      if (meta.operationId) return null;
      const before = await this.snapshot(txn, meta, name);
      if (!sameFence(before.fence, expected) || (importing && !before.legacyImportEligible)) return null;
      await txn.put(GRANT + name, { revision: before.fence.revision + 1, ciphertext });
      return this.snapshot(txn, meta, name);
    });
  }
  import(name: string, expected: McpFence, ciphertext: string): Promise<McpSnapshot | null> {
    return this.replace(name, expected, ciphertext, true);
  }
  publish(name: string, expected: McpFence, ciphertext: string): Promise<McpSnapshot | null> {
    return this.replace(name, expected, ciphertext, false);
  }
  private async prunePending(txn: DurableObjectTransaction): Promise<number> {
    const now = Date.now();
    const pending = await txn.list<PendingState>({ prefix: PENDING });
    const expired = [...pending].filter(([, value]) => value.expiresAt <= now).map(([key]) => key);
    for (let offset = 0; offset < expired.length; offset += 128) await txn.delete(expired.slice(offset, offset + 128));
    return pending.size - expired.length;
  }
  savePending(input: McpPendingInput): Promise<boolean> {
    stateName(input.state); portalName(input.portalName); ciphertextOnly(input.ciphertext);
    if (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 300_000) {
      throw new Error('Invalid MCP pending expiry');
    }
    return this.storage.transaction(async txn => {
      const meta = await this.metadata(txn);
      if (meta.operationId) return false;
      const retained = await this.prunePending(txn);
      if (retained >= MAX_PENDING_AUTHORIZATIONS || input.expiresAt <= Date.now()
        || !sameFence((await this.snapshot(txn, meta, input.portalName)).fence, input.expected)) return false;
      if (await txn.get(PENDING + input.state)) return false;
      await txn.put(PENDING + input.state, { portalName: input.portalName, fence: input.expected,
        ciphertext: input.ciphertext, expiresAt: input.expiresAt } satisfies PendingState);
      return true;
    });
  }
  consumePending(state: string, accepts?: (pending: McpPending) => Promise<boolean>): Promise<McpPending | null> {
    stateName(state);
    return this.storage.transaction(async txn => {
      const meta = await this.metadata(txn);
      if (meta.operationId) return null;
      await this.prunePending(txn);
      const pending = await txn.get<PendingState>(PENDING + state);
      if (!pending) return null;
      if (pending.expiresAt <= Date.now() || !sameFence((await this.snapshot(txn, meta, pending.portalName)).fence, pending.fence)) {
        await txn.delete(PENDING + state);
        return null;
      }
      // Wrong callback bindings cannot consume the genuine owner's authorization.
      if (accepts && !await accepts(pending)) return null;
      await txn.delete(PENDING + state);
      return { portalName: pending.portalName, fence: pending.fence, ciphertext: pending.ciphertext };
    });
  }
  disconnect(name: string): Promise<{ previous: McpSnapshot; current: McpSnapshot }> {
    portalName(name);
    return this.storage.transaction(async txn => {
      const meta = await this.metadata(txn);
      const previous = await this.snapshot(txn, meta, name);
      await txn.put(GRANT + name, { revision: previous.fence.revision + 1, ciphertext: null });
      return { previous, current: await this.snapshot(txn, meta, name) };
    });
  }
  beginOffboarding(): Promise<{ operationId: string; epoch: string }> {
    return this.storage.transaction(async txn => {
      const next = { epoch: crypto.randomUUID(), operationId: crypto.randomUUID(), legacyClosed: true };
      for (const prefix of [GRANT, PENDING]) {
        const records = await txn.list({ prefix });
        const keys = [...records.keys()];
        // Durable Object multi-key deletion accepts at most 128 keys per call.
        for (let offset = 0; offset < keys.length; offset += 128) await txn.delete(keys.slice(offset, offset + 128));
      }
      await txn.put(META, next);
      return { operationId: next.operationId, epoch: next.epoch };
    });
  }
  completeOffboarding(operationId: string): Promise<boolean> {
    if (typeof operationId !== 'string' || !operationId) return Promise.resolve(false);
    return this.storage.transaction(async txn => {
      const meta = await this.metadata(txn);
      if (meta.operationId !== operationId) return false;
      await txn.put(META, { ...meta, operationId: null });
      return true;
    });
  }
}
