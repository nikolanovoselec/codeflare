import { z } from 'zod';
import type { Env } from '../types';
import { ForbiddenError } from '../lib/error-types';
import { isEnterpriseMode } from '../lib/subscription';
import { SETUP_KEYS } from '../lib/kv-keys';
import { requireOperatorHumanContext, operatorAccessSessionCurrent, resolveUserFromKV,
  resolveAdminAccessGroup, parseAccessGroups } from '../lib/access';
import { operatorOwnerKey } from './browser-activity';
import { discoverRawCaptures, exportRawCapture, type RawCaptureBinding, type RawCaptureStorage } from './raw-capture-storage';

export type OwnerRawReadCredential = { email: string; accessJwt: string };
export type OwnerRawReadRequest = { view: 'discover' | 'export'; scope: RawCaptureBinding['scope']; cursor?: string; captureId?: string };

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('observation'), observationId: identity }),
  z.strictObject({ kind: z.literal('activity'), activityId: identity, generation: z.number().int().positive().safe() }),
]);
const cursor = z.string().regex(/^[a-f0-9]{64}$/).optional();
const requestSchema = z.discriminatedUnion('view', [
  z.strictObject({ view: z.literal('discover'), scope, cursor }),
  z.strictObject({ view: z.literal('export'), scope, cursor, captureId: identity }),
]);
const credentialSchema = z.strictObject({ email: z.string().email().max(320), accessJwt: z.string().min(1).max(65536) });

export function parseOwnerRawReadRequest(input: OwnerRawReadRequest): OwnerRawReadRequest {
  return requestSchema.parse(input);
}

/** One signed principal per read. Closures are local to the parent request, never RPC values. */
export async function requireOwnerRawReader(env: Env, credential: OwnerRawReadCredential): Promise<{
  ownerKey: string; authorize: () => Promise<void>; guard: () => Promise<void>;
}> {
  try {
    if (!isEnterpriseMode(env)) throw new ForbiddenError();
    const parsed = credentialSchema.parse(credential);
    const request = new Request('https://codeflare.invalid/', {
      headers: { 'cf-access-jwt-assertion': parsed.accessJwt },
    });
    const verified = await requireOperatorHumanContext(request, env, parsed.email);
    if (verified.accessJwt !== parsed.accessJwt
      || verified.human.email.trim().toLowerCase() !== parsed.email.trim().toLowerCase()) throw new ForbiddenError();
    const human = { ...verified.human, audiences: [...verified.human.audiences],
      ...(verified.human.groups ? { groups: [...verified.human.groups] } : {}) };
    const ownerKey = await operatorOwnerKey(human);
    let adminGroups: string[] = [];
    const current = () => {
      if (!Number.isSafeInteger(human.expiresAt) || human.expiresAt * 1000 <= Date.now()) throw new ForbiddenError();
    };
    // Namespace guards run repeatedly per encrypted frame. They do not repeat JWT
    // verification or network identity lookups; current role/configuration and expiry still fence every I/O.
    const guard = async () => {
      try {
        current();
        const user = await resolveUserFromKV(env.KV, human.email);
        if (user?.role !== 'admin') {
          const configured = parseAccessGroups(await env.KV.get(SETUP_KEYS.ENTERPRISE_ADMIN_ACCESS_GROUP));
          if (!adminGroups.some(group => configured.includes(group))) throw new ForbiddenError();
        }
        current();
      } catch { throw new ForbiddenError(); }
    };
    // Refresh live Access and group grants at discovery and export pass/completion boundaries.
    // Never fall back to a previously observed group when its refresh fails or returns empty.
    const authorize = async () => {
      try {
        current();
        adminGroups = [];
        if (!await operatorAccessSessionCurrent(human, parsed.accessJwt)) throw new ForbiddenError();
        const user = await resolveUserFromKV(env.KV, human.email);
        if (user?.role !== 'admin') adminGroups = await resolveAdminAccessGroup(request, env);
        await guard();
      } catch { adminGroups = []; throw new ForbiddenError(); }
    };
    await authorize();
    return { ownerKey, authorize, guard };
  } catch { throw new ForbiddenError(); }
}

export function ownerRawReadUnavailable(): Response {
  return Response.json({ code: 'RAW_CAPTURE_UNAVAILABLE' }, { status: 404, headers: { 'cache-control': 'no-store' } });
}

function sameScope(a: RawCaptureBinding['scope'], b: RawCaptureBinding['scope']): boolean {
  return a.kind === 'observation' ? b.kind === 'observation' && a.observationId === b.observationId
    : b.kind === 'activity' && a.activityId === b.activityId && a.generation === b.generation;
}

/** A single authenticated locator page; no caller binding, archive collection or cross-page search. */
export async function readOwnerRawCapturePage(input: {
  request: OwnerRawReadRequest; ownerKey: string;
  storage: RawCaptureStorage & { authorizePass: () => Promise<void> };
  bindingPins?: Pick<RawCaptureBinding, 'installationId' | 'releaseId'>;
}): Promise<Response> {
  const { request, ownerKey, storage, bindingPins } = input;
  await storage.authorizePass();
  const page = await discoverRawCaptures({ scope: { ownerKey, scope: request.scope }, storage, cursor: request.cursor,
    authorize: async requested => {
      if (requested.ownerKey !== ownerKey || !sameScope(requested.scope, request.scope)) throw new ForbiddenError();
      await storage.authorize();
    } });
  if (page.status !== 'complete') return ownerRawReadUnavailable();
  for (const binding of page.bindings) {
    if (binding.ownerKey !== ownerKey || !sameScope(binding.scope, request.scope)
      || bindingPins && (binding.installationId !== bindingPins.installationId || binding.releaseId !== bindingPins.releaseId)) {
      return ownerRawReadUnavailable();
    }
  }
  if (request.view === 'discover') {
    await storage.authorizePass();
    await storage.authorize();
    return Response.json(page, { headers: { 'cache-control': 'no-store' } });
  }
  const binding = page.bindings.find(value => value.captureId === request.captureId);
  if (!binding) return ownerRawReadUnavailable();
  return exportRawCapture({ binding, storage });
}
