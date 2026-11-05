import type { InterceptionHost } from './container-interception';
import { getOrdinarySessionAuthority } from './container-interception';
import { getEnterpriseBrowserCreds } from '../lib/browser-render-token';
import { getOrImportKey } from '../lib/kv-crypto';
import { SETUP_KEYS } from '../lib/kv-keys';
import { readBoundedResponse } from '../lib/bounded-stream';
import { prepareJwtStampedRequest } from '../operators/jwt-stamping';
import { SHUTDOWN_REQUESTED_KEY } from './container-metrics';
import { D1SessionRepository } from '../lib/session-repository';

export const BROWSER_REFERENCE_KEY = '_browserReference';
export interface BrowserOwnerReference {
  bucket: string; sessionId: string; email: string; generation: number; configuration: string;
}
export type BrowserOperation = 'acquire' | 'attach' | 'replace';
interface BrowserRecord extends BrowserOwnerReference { providerId?: string }
export interface BrowserHost extends InterceptionHost { _browserAcquisition?: Promise<string> }

const unavailable = (): Error => new Error('Owned browser unavailable; no automatic fresh-browser replay');
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
export const browserPath = (account: string): string => `/client/v4/accounts/${account}/browser-rendering/devtools/browser`;

async function configuration(host: InterceptionHost, groups: string[]) {
  const { token, accountId } = await getEnterpriseBrowserCreds(host.env, await getOrImportKey(host.env));
  const strictPolicy = await host.env.KV.get(SETUP_KEYS.STRICT_EGRESS);
  if (!token || !accountId || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)
    || (strictPolicy !== null && strictPolicy !== 'active' && strictPolicy !== 'inactive')) throw unavailable();
  const strict = host._strictEgress === true || strictPolicy === 'active';
  // Only relevant credential/policy identity; never persist a token, assertion, or global revision.
  const human = host._jwtAuthority?.human;
  const identity = JSON.stringify([accountId, token, strict, strictPolicy, [...groups].sort(), host._jwtStamping ?? null,
    human ? [human.subject, human.email, human.issuer, [...human.audiences].sort()] : null]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const fingerprint = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return { accountId, token, strict, fingerprint };
}

/** Trusted Worker props, never request-supplied identity or a Pi-provider permission. */
export async function browserOwnerReference(host: InterceptionHost): Promise<{
  browserOwner?: BrowserOwnerReference; browserAccountId?: string; browserToken?: string; strict?: boolean;
}> {
  if (!host._bucketName || !host._sessionId || !host._userEmail || host._operatorPolicy || host._operatorContainerProfile) return {};
  try {
    const ref = { bucket: host._bucketName, sessionId: host._sessionId, email: host._userEmail };
    // Wiring precedes native start/onStart's operational generation handoff. The RPC,
    // unlike prop construction, requires the durable active-generation/shutdown guards.
    const session = await new D1SessionRepository(host.env.USAGE_DB).getSession(ref.bucket, ref.sessionId);
    if (!session || !Number.isSafeInteger(session.lifecycleGeneration) || session.lifecycleGeneration <= 0
      || !['starting', 'running'].includes(session.lifecycleState) || session.terminationIntentId) return {};
    const config = await configuration(host, host._userGroups);
    // Keep the interceptor's forwarding credentials/transport and RPC configuration
    // identity on the SAME snapshot, including rotation during pre-start wiring.
    return { browserOwner: { ...ref, generation: session.lifecycleGeneration, configuration: config.fingerprint },
      browserAccountId: config.accountId, browserToken: config.token, strict: config.strict };
  } catch { return {}; }
}

async function authorize(host: InterceptionHost, ref: BrowserOwnerReference) {
  if (!ref || typeof ref.email !== 'string' || !Number.isSafeInteger(ref.generation) || ref.generation <= 0) throw unavailable();
  const authority = await getOrdinarySessionAuthority(host, ref);
  const config = await configuration(host, authority.groups);
  if (authority.generation !== ref.generation || config.fingerprint !== ref.configuration) throw unavailable();
  return config;
}

function sameSession(a: BrowserRecord, b: BrowserOwnerReference): boolean {
  return a.bucket === b.bucket && a.sessionId === b.sessionId && a.email === b.email && a.generation === b.generation;
}
function sameOwner(a: BrowserRecord, b: BrowserOwnerReference): boolean {
  return sameSession(a, b) && a.configuration === b.configuration;
}

async function fence(host: BrowserHost, txn: DurableObjectTransaction, ref: BrowserOwnerReference): Promise<void> {
  if (host._shutdownStartedAt || host._operatorPolicy || host._operatorContainerProfile
    || host._bucketName !== ref.bucket || host._sessionId !== ref.sessionId || host._userEmail !== ref.email
    || await txn.get('bucketName') !== ref.bucket || await txn.get('_sessionId') !== ref.sessionId
    || await txn.get('lifecycleGeneration') !== ref.generation || await txn.get(SHUTDOWN_REQUESTED_KEY)) throw unavailable();
}

/** Existing container DO owns this operation. Unknown POST outcomes remain durably non-retriable. */
export async function ownedBrowser(host: BrowserHost, ref: BrowserOwnerReference, operation: BrowserOperation): Promise<string> {
  if (!['acquire', 'attach', 'replace'].includes(operation)) throw unavailable();
  const config = await authorize(host, ref);
  if (host._browserAcquisition) {
    // An explicit fresh-create must not accidentally acknowledge an older attach/acquire.
    if (operation === 'replace') throw unavailable();
    const id = await host._browserAcquisition;
    await authorize(host, ref);
    const record = await host.ctx.storage.get<BrowserRecord>(BROWSER_REFERENCE_KEY);
    if (!record || !sameOwner(record, ref) || record.providerId !== id) throw unavailable();
    await host.ctx.storage.transaction(txn => fence(host, txn, ref));
    return id;
  }
  const run = async (): Promise<string> => {
    const record = await host.ctx.storage.get<BrowserRecord>(BROWSER_REFERENCE_KEY);
    if (record && !(operation === 'replace' ? sameSession(record, ref) : sameOwner(record, ref))) throw unavailable();
    if (operation !== 'replace' && record) {
      if (!validId(record.providerId)) throw unavailable();
      await authorize(host, ref);
      await host.ctx.storage.transaction(txn => fence(host, txn, ref));
      return record.providerId;
    }
    if (operation === 'attach') throw unavailable();
    if (config.strict && !host.env.EGRESS) throw unavailable();
    const signal = AbortSignal.timeout(360_000);
    let request = new Request(`https://api.cloudflare.com${browserPath(config.accountId)}?keep_alive=1200000`, {
      method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: '{}', redirect: 'manual', signal,
    });
    if (host._jwtStamping) request = prepareJwtStampedRequest(request, host._jwtStamping, host._jwtAuthority);
    await authorize(host, ref);
    // Persist uncertainty BEFORE any provider I/O. Reconstruction must not replay an ambiguous create.
    await host.ctx.storage.transaction(async txn => {
      await fence(host, txn, ref);
      await txn.put(BROWSER_REFERENCE_KEY, { ...ref } satisfies BrowserRecord);
    });
    const response = config.strict ? await host.env.EGRESS!.fetch(request) : await fetch(request);
    if (!response.ok || !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      void response.body?.cancel().catch(() => undefined);
      throw unavailable();
    }
    const data: unknown = JSON.parse(new TextDecoder().decode(await readBoundedResponse(response, 8192, 'Browser acquisition', signal)));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw unavailable();
    const { sessionId, webSocketDebuggerUrl } = data as { sessionId?: unknown; webSocketDebuggerUrl?: unknown };
    if (!validId(sessionId) || (webSocketDebuggerUrl !== undefined
      && (typeof webSocketDebuggerUrl !== 'string' || webSocketDebuggerUrl.length > 4096))) throw unavailable();
    // Never follow the provider URL. Only its validated opaque ID can leave this operation.
    await authorize(host, ref);
    await host.ctx.storage.transaction(async txn => {
      await fence(host, txn, ref);
      const pending = await txn.get<BrowserRecord>(BROWSER_REFERENCE_KEY);
      if (!pending || !sameOwner(pending, ref) || pending.providerId) throw unavailable();
      await txn.put(BROWSER_REFERENCE_KEY, { ...ref, providerId: sessionId } satisfies BrowserRecord);
    });
    return sessionId;
  };
  // Assigned synchronously before run's first asynchronous continuation; one acquisition per DO.
  const pending = run();
  host._browserAcquisition = pending;
  try { return await pending; }
  finally { if (host._browserAcquisition === pending) host._browserAcquisition = undefined; }
}
