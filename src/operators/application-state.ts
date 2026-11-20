export type ApplicationStateValue = null | boolean | number | string | ApplicationStateValue[]
  | { [key: string]: ApplicationStateValue };

interface ApplicationStateOriginDelivery {
  submissionId: string;
  uid: string;
  deliveryDigest: string;
}

export interface ApplicationCoordinationScope {
  operatorId: string;
  repositories: string[];
}
export function sameCoordinationScope(a: ApplicationCoordinationScope | undefined, b: ApplicationCoordinationScope | undefined): boolean {
  return !!a && !!b && a.operatorId === b.operatorId
    && JSON.stringify(a.repositories) === JSON.stringify(b.repositories);
}

/** Root-derived authority; never accept these fields from the application request. */
export interface ApplicationStateBinding {
  readonly sourceId: string;
  readonly installationId: string;
  readonly ownerKey: string;
  readonly activityId: string;
  readonly generation: number;
  /** Unix milliseconds, retaining the original run deadline. */
  readonly deadline: number;
  readonly originDelivery?: ApplicationStateOriginDelivery;
  readonly coordinationScope?: ApplicationCoordinationScope;
}
export type ApplicationStateEntry = { key: string; status: 'absent'; version: null }
  | { key: string; status: 'value'; version: string; value: ApplicationStateValue }
  | { key: string; status: 'coordination'; version: string; coordination: ApplicationStateValue }
  | { key: string; status: 'vacant'; version: string }
  | { key: string; status: 'conflict' };
export interface ApplicationStateExchange {
  expected: Array<{ key: string; version: string | null }>;
  writes: Array<{ key: string; value: ApplicationStateValue; coordination?: ApplicationStateValue }>;
}
export type ApplicationStateExchangeResult = { status: 'committed' } | { status: 'conflict' };
export type ApplicationStateRequest = { operation: 'read'; keys: string[] }
  | ({ operation: 'compare-exchange' } & ApplicationStateExchange);

interface ApplicationStateLegacyAlias {
  storageKey: string;
  /** Local, synchronous inspection of the ACTUAL record. Root must validate its
   * complete layout and prove source/installation plus private ownership or
   * authorized coordination scope. Unknown layouts remain unavailable. No RPC
   * or application-supplied code. */
  validate(record: unknown, binding: Readonly<ApplicationStateBinding>): 'owned' | 'conflict' | 'unavailable';
  coordination?(record: unknown): ApplicationStateValue | undefined;
}
export interface ApplicationStateAuthority {
  /** Live authorization (including remote checks if needed), outside transactions. */
  authorize(binding: Readonly<ApplicationStateBinding>): Promise<void | boolean>;
  /** Local storage reads only. Check cancellation/revocation, original generation,
   * deadline and the authority/configuration snapshot approved by authorize.
   * Never call another actor or perform network I/O from this callback. */
  validateSnapshot(storage: Pick<DurableObjectTransaction, 'get'>,
    binding: Readonly<ApplicationStateBinding>): boolean | Promise<boolean>;
  /** Trusted mechanical compatibility mapping; no caller-controlled prefixes. */
  resolveLegacy?(key: string, binding: Readonly<ApplicationStateBinding>): ApplicationStateLegacyAlias | null;
}
export class ApplicationStateError extends Error {
  readonly status: number;
  constructor(readonly code: 'invalid-request' | 'denied' | 'unavailable') {
    super(`Application state ${code}`);
    this.name = 'ApplicationStateError';
    this.status = code === 'invalid-request' ? 400 : code === 'denied' ? 403 : 503;
  }
}

const RECORD_BYTES = 64 * 1024;
const BATCH_BYTES = 1024 * 1024;
const MAX_KEYS = 64;
const encoder = new TextEncoder();
const versionPattern = /^[a-f0-9]{64}$/;
const PREFIX = 'application-state:v1:';
type Failure = ApplicationStateError['code'];
function fail(code: Failure): never { throw new ApplicationStateError(code); }
const bytes = (value: string) => encoder.encode(value).byteLength;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function fields(value: unknown, names: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === names.length
    && names.every(name => Object.hasOwn(value, name));
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && bytes(value) <= 1024;
}
function optionalFields(value: unknown, required: string[], optional: string[]): value is Record<string, unknown> {
  return object(value) && required.every(name => Object.hasOwn(value, name))
    && Object.keys(value).every(name => required.includes(name) || optional.includes(name));
}
function originDeliveryValid(value: unknown): value is ApplicationStateOriginDelivery {
  return fields(value, ['submissionId', 'uid', 'deliveryDigest']) && identity(value.submissionId)
    && identity(value.uid) && typeof value.deliveryDigest === 'string' && versionPattern.test(value.deliveryDigest);
}
function coordinationScopeValid(value: unknown): value is ApplicationCoordinationScope {
  return fields(value, ['operatorId', 'repositories']) && identity(value.operatorId)
    && Array.isArray(value.repositories) && value.repositories.length > 0 && value.repositories.length <= 128
    && value.repositories.every(item => typeof item === 'string' && item.length <= 201
      && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(item) && item.split('/').every(part => part !== '.' && part !== '..'))
    && JSON.stringify(value.repositories) === JSON.stringify([...new Set(value.repositories)].sort());
}
function bindingValid(value: unknown): value is ApplicationStateBinding {
  return optionalFields(value, ['sourceId', 'installationId', 'ownerKey', 'activityId', 'generation', 'deadline'], ['originDelivery', 'coordinationScope'])
    && (!Object.hasOwn(value, 'coordinationScope') || coordinationScopeValid(value.coordinationScope))
    && (!Object.hasOwn(value, 'originDelivery') || originDeliveryValid(value.originDelivery))
    && identity(value.sourceId) && identity(value.installationId) && identity(value.ownerKey)
    && identity(value.activityId) && Number.isSafeInteger(value.generation) && (value.generation as number) >= 1
    && Number.isSafeInteger(value.deadline) && (value.deadline as number) > 0;
}
/** Reject non-JSON values instead of silently dropping or coercing application data. */
function json(value: unknown, limit: number, code: Failure): string {
  try {
    const ancestors = new Set<object>();
    const visit = (item: unknown): void => {
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
      if (typeof item === 'number' && Number.isFinite(item)) return;
      if (typeof item !== 'object' || item === null || !Array.isArray(item) && !object(item)
        || ancestors.has(item)) fail(code);
      ancestors.add(item);
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Object.getOwnPropertySymbols(item).length) fail(code);
      if (Array.isArray(item) && Object.keys(item).length !== item.length) fail(code);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (Array.isArray(item) && key === 'length') continue;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
        visit(descriptor.value);
      }
      ancestors.delete(item);
    };
    visit(value);
    const result = JSON.stringify(value);
    if (typeof result !== 'string' || bytes(result) > limit) fail(code);
    return result;
  } catch { return fail(code); }
}
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
    byte => byte.toString(16).padStart(2, '0')).join('');
}
function keysValid(keys: unknown): asserts keys is string[] {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_KEYS
    || !keys.every(identity) || new Set(keys).size !== keys.length) fail('invalid-request');
}
interface LegacySnapshot { storageKey: string; version: string | null }
export interface StateRecord extends ApplicationStateBinding {
  schemaVersion: 1;
  key: string;
  legacy: LegacySnapshot | null;
  value: ApplicationStateValue;
  coordination?: ApplicationStateValue;
  /** Root-authored reference, never copied from application JSON. */
  recovery?: { auditId: string; phase: 'vacant' | 'claimed' };
}
export interface ApplicationStateRecoveryAudit {
  sourceId: string;
  key: string;
  originalKind: 'record' | 'legacy';
  originalVersion: string;
  originalKey: string;
  requestId: string;
  actorHash: string;
  originalOwnerHash?: string;
  time: number;
  proofDigest: string;
  releasedVersion: string;
  legacy: StateRecord['legacy'];
}
interface LocatedKey { key: string; storageKey: string; alias: ApplicationStateLegacyAlias | null }
interface ObservedKey {
  entry: ApplicationStateEntry;
  legacy: LegacySnapshot | null;
  size: number;
  record?: StateRecord;
}
export function applicationStateRecordValid(value: unknown): value is StateRecord {
  if (!optionalFields(value, ['schemaVersion', 'sourceId', 'installationId', 'ownerKey', 'activityId',
    'generation', 'deadline', 'key', 'legacy', 'value'], ['originDelivery', 'recovery', 'coordination', 'coordinationScope']) || value.schemaVersion !== 1 || !identity(value.key)) return false;
  const { sourceId, installationId, ownerKey, activityId, generation, deadline } = value;
  if (!bindingValid({ sourceId, installationId, ownerKey, activityId, generation, deadline,
    ...(Object.hasOwn(value, 'originDelivery') ? { originDelivery: value.originDelivery } : {}),
    ...(Object.hasOwn(value, 'coordinationScope') ? { coordinationScope: value.coordinationScope } : {}) })) return false;
  if (Object.hasOwn(value, 'recovery') && (!fields(value.recovery, ['auditId', 'phase'])
    || typeof value.recovery.auditId !== 'string' || !versionPattern.test(value.recovery.auditId)
    || !['vacant', 'claimed'].includes(value.recovery.phase as string))) return false;
  return value.legacy === null || fields(value.legacy, ['storageKey', 'version'])
    && typeof value.legacy.storageKey === 'string' && bytes(value.legacy.storageKey) > 0
    && bytes(value.legacy.storageKey) <= 2048 && !value.legacy.storageKey.startsWith(PREFIX)
    && (value.legacy.version === null || typeof value.legacy.version === 'string' && versionPattern.test(value.legacy.version));
}

/** Verify Root's retained release evidence, not an application reset marker or
 * the mere presence of an audit reference. Reads stay inside the CAS transaction. */
export async function verifyApplicationStateRecovery(storage: Pick<DurableObjectStorage, 'get'>,
  record: StateRecord, legacy: StateRecord['legacy']): Promise<{ size: number } | null> {
  if (!record.recovery) return null;
  const sameLegacy = (a: StateRecord['legacy'], b: StateRecord['legacy']) =>
    a?.storageKey === b?.storageKey && a?.version === b?.version;
  if (!sameLegacy(record.legacy, legacy)) return null;
  const prefix = `${PREFIX}${await digest(record.sourceId)}:`;
  const auditId = record.recovery.auditId;
  const raw = await storage.get<unknown>(`${prefix}audit:${auditId}`);
  if (!optionalFields(raw, ['sourceId', 'key', 'originalKind', 'originalVersion', 'originalKey', 'requestId',
    'actorHash', 'time', 'proofDigest', 'releasedVersion', 'legacy'], ['originalOwnerHash'])) return null;
  const encodedAudit = json(raw, RECORD_BYTES, 'unavailable');
  if (raw.sourceId !== record.sourceId || raw.key !== record.key
    || !['record', 'legacy'].includes(raw.originalKind as string)
    || typeof raw.requestId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(raw.requestId)
    || !['originalVersion', 'actorHash', 'proofDigest', 'releasedVersion'].every(name =>
      typeof raw[name] === 'string' && versionPattern.test(raw[name] as string))
    || Object.hasOwn(raw, 'originalOwnerHash') && (typeof raw.originalOwnerHash !== 'string' || !versionPattern.test(raw.originalOwnerHash))
    || !Number.isSafeInteger(raw.time) || (raw.time as number) <= 0
    || raw.originalKey !== `${prefix}original:${auditId}`
    || auditId !== await digest(JSON.stringify([raw.actorHash, raw.requestId, record.key]))) return null;
  // Validate the snapshot shape before using it as trusted lineage.
  if (!(raw.legacy === null || fields(raw.legacy, ['storageKey', 'version'])
    && typeof raw.legacy.storageKey === 'string'
    && (raw.legacy.version === null || typeof raw.legacy.version === 'string' && versionPattern.test(raw.legacy.version)))) return null;
  const audit = raw as unknown as ApplicationStateRecoveryAudit;
  if (!sameLegacy(audit.legacy, legacy)) return null;
  const original = await storage.get<unknown>(audit.originalKey);
  if (!object(original)) return null;
  const encodedOriginal = json(original, RECORD_BYTES, 'unavailable');
  if (original.ownerKey !== (audit.originalOwnerHash ?? audit.actorHash) || !identity(original.activityId) || !identity(original.installationId)) return null;
  if (audit.originalKind === 'record') {
    if (!applicationStateRecordValid(original) || original.sourceId !== record.sourceId || original.key !== record.key
      || !sameLegacy(original.legacy, legacy)
      || await digest(`record:${encodedOriginal}`) !== audit.originalVersion) return null;
  } else {
    if (!legacy || legacy.version !== await digest(encodedOriginal)
      || record.key !== `renovate:head:${original.repositoryId}:${original.pullRequest}:${original.head}`
      || await digest(JSON.stringify(['legacy', record.sourceId, record.key, legacy])) !== audit.originalVersion) return null;
  }
  if (record.recovery.phase === 'vacant') {
    if (record.ownerKey !== original.ownerKey || record.activityId !== original.activityId
      || record.installationId !== original.installationId
      || audit.originalKind === 'record' && (record.generation !== original.generation || record.deadline !== original.deadline
        || JSON.stringify(record.originDelivery) !== JSON.stringify(original.originDelivery))
      || await digest(`record:${json(record, RECORD_BYTES, 'unavailable')}`) !== audit.releasedVersion) return null;
  }
  return { size: bytes(encodedAudit) + bytes(encodedOriginal) };
}

/** One adapter over the existing Registry storage. It creates no DO namespace,
 * mutates no legacy records, and knows nothing about application policy. */
export class ApplicationStateStore {
  private readonly binding: Readonly<ApplicationStateBinding>;
  private readonly authority: ApplicationStateAuthority;
  constructor(private readonly storage: Pick<DurableObjectStorage, 'transaction'>,
    binding: ApplicationStateBinding, authority: ApplicationStateAuthority) {
    if (!bindingValid(binding)) fail('denied');
    this.binding = Object.freeze({ ...binding,
      ...(binding.coordinationScope ? { coordinationScope: { operatorId: binding.coordinationScope.operatorId,
        repositories: [...binding.coordinationScope.repositories] } } : {}),
      ...(binding.originDelivery ? { originDelivery: Object.freeze({ ...binding.originDelivery }) } : {}) });
    this.authority = { ...authority };
  }

  private active(): void { if (Date.now() >= this.binding.deadline) fail('denied'); }
  private async authorize(): Promise<void> {
    this.active();
    if (await this.authority.authorize(this.binding) === false) fail('denied');
    this.active();
  }
  private async validate(tx: DurableObjectTransaction): Promise<void> {
    this.active();
    // Only expose a read capability, not the transaction's mutation methods.
    const reads: Pick<DurableObjectTransaction, 'get'> = { get: tx.get.bind(tx) };
    if (await this.authority.validateSnapshot(reads, this.binding) !== true) fail('denied');
    this.active();
  }
  private async locate(keys: string[]): Promise<LocatedKey[]> {
    const prefix = `${PREFIX}${await digest(this.binding.sourceId)}:`;
    const result = await Promise.all(keys.map(async key => {
      const alias = this.authority.resolveLegacy?.(key, this.binding) ?? null;
      if (alias && (typeof alias.storageKey !== 'string' || !alias.storageKey
        || bytes(alias.storageKey) > 2048 || alias.storageKey.startsWith(PREFIX)
        || typeof alias.validate !== 'function')) fail('unavailable');
      return { key, storageKey: `${prefix}${await digest(key)}`,
        alias: alias ? { storageKey: alias.storageKey, validate: alias.validate, coordination: alias.coordination } : null };
    }));
    const aliases = result.flatMap(item => item.alias ? [item.alias.storageKey] : []);
    if (new Set(aliases).size !== aliases.length) fail('unavailable');
    return result;
  }
  private async observe(tx: DurableObjectTransaction, located: LocatedKey): Promise<ObservedKey> {
    const { key, storageKey, alias } = located;
    const raw = await tx.get<unknown>(storageKey);
    let legacy: LegacySnapshot | null = alias ? { storageKey: alias.storageKey, version: null } : null;
    let legacyValue: ApplicationStateValue | undefined;
    let legacyCoordination: ApplicationStateValue | undefined;
    let size = 0;
    let encodedRecord: string | undefined;
    if (raw !== undefined) {
      encodedRecord = json(raw, RECORD_BYTES, 'unavailable');
      size += bytes(encodedRecord);
      if (!applicationStateRecordValid(raw) || raw.key !== key || raw.sourceId !== this.binding.sourceId) fail('unavailable');
      if (raw.ownerKey !== this.binding.ownerKey && raw.recovery?.phase !== 'vacant'
        && !(Object.hasOwn(raw, 'coordination') && sameCoordinationScope(raw.coordinationScope, this.binding.coordinationScope))) {
        return { entry: { key, status: 'conflict' }, legacy, size };
      }
    }
    const record = encodedRecord === undefined ? undefined : JSON.parse(encodedRecord) as StateRecord;
    if (alias) {
      const prior = await tx.get<unknown>(alias.storageKey);
      if (prior !== undefined) {
        const encoded = json(prior, RECORD_BYTES, 'unavailable');
        size += bytes(encoded);
        legacy = { storageKey: alias.storageKey, version: await digest(encoded) };
        // A verified Root release carries the unchanged alias as history, not
        // as the fresh claimant's identity. Ordinary records retain every gate.
        const sharedRecord = record && Object.hasOwn(record, 'coordination')
          && sameCoordinationScope(record.coordinationScope, this.binding.coordinationScope);
        if (!record?.recovery && !sharedRecord) {
          const permission = alias.validate(prior, this.binding);
          if (permission === 'conflict') return { entry: { key, status: 'conflict' }, legacy, size };
          if (permission !== 'owned') fail('unavailable');
          legacyValue = JSON.parse(encoded) as ApplicationStateValue;
          legacyCoordination = alias.coordination?.(prior);
        }
      }
    }
    if (record) {
      // Once an overlay records an alias, losing/changing its mapping is not absence.
      if (record.legacy?.storageKey !== legacy?.storageKey) fail('unavailable');
      if (record.legacy?.version !== legacy?.version) return { entry: { key, status: 'conflict' }, legacy, size };
      if (record.recovery) {
        const proof = await verifyApplicationStateRecovery(tx, record, legacy);
        if (!proof) fail('unavailable');
        size += proof.size;
      }
      const version = await digest(`record:${encodedRecord}`);
      if (record.coordinationScope && !sameCoordinationScope(record.coordinationScope, this.binding.coordinationScope)) {
        return { entry: { key, status: 'conflict' }, legacy, size };
      }
      if (record.recovery?.phase === 'vacant' && (record.ownerKey !== this.binding.ownerKey
        || Object.hasOwn(record, 'coordination') && sameCoordinationScope(record.coordinationScope, this.binding.coordinationScope))) {
        return { entry: { key, status: 'vacant', version }, legacy, size, record };
      }
      if (record.ownerKey !== this.binding.ownerKey) {
        return { entry: { key, status: 'coordination', version, coordination: record.coordination! }, legacy, size, record };
      }
      return { entry: { key, status: 'value', version, value: record.value }, legacy, size, record };
    }
    if (legacyCoordination !== undefined) return { entry: { key, status: 'coordination',
      version: await digest(JSON.stringify(['legacy', this.binding.sourceId, key, legacy])), coordination: legacyCoordination }, legacy, size };
    if (legacyValue !== undefined) return { entry: { key, status: 'value',
      version: await digest(JSON.stringify(['legacy', this.binding.sourceId, key, legacy])), value: legacyValue }, legacy, size };
    return { entry: { key, status: 'absent', version: null }, legacy, size };
  }
  private async run<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof ApplicationStateError) throw error;
      return fail('unavailable');
    }
  }

  async read(keys: string[]): Promise<ApplicationStateEntry[]> {
    return this.run(async () => {
      keysValid(keys);
      const requested = [...keys];
      const located = await this.locate(requested);
      await this.authorize();
      return this.storage.transaction(async tx => {
        await this.validate(tx);
        const entries: ApplicationStateEntry[] = [];
        let size = 0;
        for (const key of located) {
          const observed = await this.observe(tx, key);
          size += observed.size;
          if (size > BATCH_BYTES) fail('unavailable');
          entries.push(observed.entry);
        }
        json(entries, BATCH_BYTES, 'unavailable');
        await this.validate(tx);
        return entries;
      });
    });
  }

  async compareExchange(input: ApplicationStateExchange): Promise<ApplicationStateExchangeResult> {
    return this.run(async () => {
      // Snapshot before the first await; the caller cannot change a validated batch.
      const request = JSON.parse(json(input, BATCH_BYTES, 'invalid-request')) as ApplicationStateExchange;
      if (!fields(request, ['expected', 'writes']) || !Array.isArray(request.expected)
        || !Array.isArray(request.writes)) fail('invalid-request');
      if (!request.expected.every(item => fields(item, ['key', 'version'])
        && (item.version === null || typeof item.version === 'string' && versionPattern.test(item.version)))
        || !request.writes.every(item => optionalFields(item, ['key', 'value'], ['coordination']))) fail('invalid-request');
      keysValid(request.expected.map(item => item.key));
      keysValid(request.writes.map(item => item.key));
      const expected = new Map(request.expected.map(item => [item.key, item.version]));
      if (request.writes.some(item => !expected.has(item.key))) fail('invalid-request');
      const located = await this.locate([...expected.keys()]);
      await this.authorize();
      return this.storage.transaction<ApplicationStateExchangeResult>(async tx => {
        await this.validate(tx);
        const observations = new Map<string, ObservedKey>();
        let readSize = 0;
        let conflict = false;
        for (const item of located) {
          const observed = await this.observe(tx, item);
          readSize += observed.size;
          if (readSize > BATCH_BYTES) fail('unavailable');
          observations.set(item.key, observed);
          if (observed.entry.status === 'conflict' || observed.entry.status === 'coordination' || observed.entry.version !== expected.get(item.key)) conflict = true;
        }
        if (conflict) return { status: 'conflict' };
        const records: Record<string, StateRecord> = {};
        let writeSize = 0;
        for (const write of request.writes) {
          const observed = observations.get(write.key)!;
          const prior = observed.record;
          const sameAttempt = prior?.ownerKey === this.binding.ownerKey
            && prior.installationId === this.binding.installationId && prior.activityId === this.binding.activityId
            && prior.generation === this.binding.generation;
          const originDelivery = sameAttempt && prior?.originDelivery ? prior.originDelivery : this.binding.originDelivery;
          const { coordinationScope, ...binding } = this.binding;
          const record: StateRecord = { schemaVersion: 1, ...binding, key: write.key,
            ...(coordinationScope && (Object.hasOwn(write, 'coordination') || prior?.recovery) ? { coordinationScope } : {}),
            legacy: observed.legacy, value: write.value,
            ...(Object.hasOwn(write, 'coordination') ? { coordination: write.coordination! } : {}),
            ...(originDelivery ? { originDelivery } : {}),
            ...(prior?.recovery ? { recovery: { auditId: prior.recovery.auditId, phase: 'claimed' } } : {}) };
          writeSize += bytes(json(record, RECORD_BYTES, 'invalid-request'));
          if (writeSize > BATCH_BYTES) fail('invalid-request');
          records[located.find(item => item.key === write.key)!.storageKey] = record;
        }
        await this.validate(tx);
        await tx.put(records);
        // A failed deadline/local fence rolls back the whole transaction.
        await this.validate(tx);
        return { status: 'committed' };
      });
    });
  }
}
