/**
 * REQ-ENTERPRISE-016 / REQ-ENTERPRISE-023 / REQ-ENTERPRISE-026: EgressController — strict Gateway egress proxy.
 *
 * A WorkerEntrypoint the container DO wires as a catch-all when the strict-egress toggle is
 * ON (the DO passes account, bucket, scoped R2 credentials, and strict state via ctx.props,
 * resolved once at wiring). For most hosts it is a transparent proxy (no credential added,
 * caller authorization/cookie/set-cookie preserved) forcing traffic through env.EGRESS. This
 * user's own R2 bucket is the exception: its placeholder Authorization is stripped and the
 * request is RE-SIGNED with that user's bucket-scoped key.
 * WebSocket upgrades are BRIDGED (a fresh WebSocketPair accepted on both ends), not returned
 * as-is. `strict` comes from props (no per-request KV read).
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../types';
import type { PersonalPiProps } from '../lib/personal-pi-forwarding';
import { SETUP_KEYS } from '../lib/kv-keys';
import { EgressController } from '../egress-controller';
import type { OperatorPolicy } from '../operators/policy';
import type { JwtStampingAuthority, JwtStampingPolicy } from '../operators/jwt-stamping';
import { pendingRecipient, within } from './helpers/pending-recipient';

const policyLogs = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ ...policyLogs, child: vi.fn() }),
}));

const STRICT_KEY = 'setup:strict_egress';
const jwtAuthority: JwtStampingAuthority = { human: { subject: 'human', email: 'human@example.test',
  issuer: 'https://access.example.test', audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 10,
  expiresAt: Math.floor(Date.now() / 1000) + 300 }, accessJwt: 'verified.jwt' };
const operatorPolicy: OperatorPolicy = { schemaVersion: 1, networkHosts: ['allowed.example.test'],
  github: { repositories: [], methods: [] }, storage: { readPrefixes: ['inputs/'], writePrefixes: ['outputs/activity/'] },
  inference: { routeIds: [], defaultRouteId: null, reasoningLevels: [], defaultReasoningLevel: null,
    inheritUserDefaults: false } };

function makeController(
  envOverrides: Partial<Env> & { __kv?: Record<string, string> } = {},
  props: {
    accountId?: string;
    bucket?: string;
    r2AccessKeyId?: string;
    r2SecretAccessKey?: string;
    resourcePolicy?: 'mutable' | 'immutable' | 'exclusive';
    releaseDigest?: string;
    pathsDigest?: string;
    r2SseDisabled?: boolean;
    strict?: boolean;
    operatorPolicy?: OperatorPolicy;
    operatorDispatcherNative?: { activityId: string; generation: number; profileDigest: string };
    operatorNative?: PersonalPiProps['operatorNative'];
    personalPi?: PersonalPiProps['personalPi'];
    operatorSync?: { activityId: string; outputPrefix: string; manifestPrefix: string };
    ownedMultipart?: boolean;
    jwtStamping?: JwtStampingPolicy;
    jwtAuthority?: JwtStampingAuthority;
  } = { accountId: 'acc' },
) {
  const kvStore = envOverrides.__kv ?? { [STRICT_KEY]: 'active' };
  const egressFetch = vi.fn(
    async (_req: Request) =>
      new Response('upstream', {
        status: 200,
        headers: { 'set-cookie': 'sess=abc', connection: 'keep-alive' },
      }),
  );
  const env = {
    ENTERPRISE_MODE: 'active',
    // Deployment-wide credentials must never sign intercepted per-user R2 traffic.
    R2_ACCESS_KEY_ID: 'admin-r2-key',
    R2_SECRET_ACCESS_KEY: 'admin-r2-secret',
    KV: { get: async (k: string) => kvStore[k] ?? null },
    EGRESS: { fetch: egressFetch },
    ...envOverrides,
  } as unknown as Env;
  // Strict and scoped user-bucket values default here unless a test overrides them.
  const ctx = {
    props: {
      strict: true,
      bucket: 'bucket',
      r2AccessKeyId: 'user-r2-key',
      r2SecretAccessKey: 'user-r2-secret',
      ...props,
    },
  } as unknown as ExecutionContext;
  return { controller: new EgressController(ctx, env), egressFetch };
}

beforeEach(() => {
  policyLogs.debug.mockClear();
  policyLogs.info.mockClear();
  policyLogs.warn.mockClear();
  policyLogs.error.mockClear();
});

describe('REQ-OPERATOR-007/047: Activity-bound Dispatcher native egress', () => {
  const scope = { activityId: 'native-activity', generation: 4, profileDigest: 'a'.repeat(64) };
  const selection = { source: 'pi-native', provider: 'openai-codex', model: 'gpt-6.1-sol',
    api: 'openai-codex-responses', reasoningLevel: 'low', profileDigest: scope.profileDigest };
  const url = 'https://chatgpt.com/backend-api/codex/responses';
  it('uses strict Gateway without a container and preserves private error bytes for Activity commitment', async () => {
    const destinations: string[] = [];
    const privateError = JSON.stringify({ error: { code: 'invalid_api_key', message: 'private-provider-detail' } });
    let forwarded: Request | undefined;
    const { controller } = makeController({
      OPERATOR_ACTIVITY: { getByName: () => ({ dispatcherNativeEgressCurrent: async () => selection }) } as never,
      EGRESS: { fetch: async (request: Request) => { destinations.push(request.url); forwarded = request;
        return new Response(privateError, { status: 401 }); } } as unknown as Fetcher,
    }, { operatorDispatcherNative: scope });
    const response = await controller.fetch(new Request(url, { method: 'POST', body: 'opaque actor-inspected bytes',
      headers: { authorization: 'Bearer private-native-auth', 'chatgpt-account-id': 'private-account',
        'x-codeflare-native-inference': 'private-handle', 'cf-access-jwt-assertion': 'must-strip' } }));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(privateError);
    expect(destinations).toEqual([url]);
    expect(forwarded?.headers.get('authorization')).toBe('Bearer private-native-auth');
    expect(forwarded?.headers.get('chatgpt-account-id')).toBe('private-account');
    expect(forwarded?.headers.get('x-codeflare-native-inference')).toBeNull();
    expect(forwarded?.headers.get('cf-access-jwt-assertion')).toBeNull();
    expect(await forwarded?.text()).toBe('opaque actor-inspected bytes');
    expect(forwarded?.redirect).toBe('manual');
  });
  it.each(['revoked', 'foreign-profile', 'unrelated-destination', 'websocket', 'missing-gateway'] as const)(
    'denies %s without a protected send or global-fetch fallback', async denied => {
      const destinations: string[] = [];
      const direct = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
        destinations.push(String(input)); return new Response('unexpected direct send');
      });
      try {
        const { controller } = makeController({
          OPERATOR_ACTIVITY: { getByName: () => ({ dispatcherNativeEgressCurrent: async () => denied === 'revoked'
            ? null : { ...selection, profileDigest: denied === 'foreign-profile' ? 'b'.repeat(64) : scope.profileDigest } }) } as never,
          EGRESS: denied === 'missing-gateway' ? undefined : { fetch: async (request: Request) => {
            destinations.push(request.url); return new Response('unexpected send'); } } as unknown as Fetcher,
        }, { operatorDispatcherNative: scope });
        const response = await controller.fetch(new Request(denied === 'unrelated-destination'
          ? 'https://example.test/unrelated' : url, { method: 'POST', body: '{}',
          ...(denied === 'websocket' ? { headers: { upgrade: 'websocket' } } : {}) }));
        expect(response.status).toBe(denied === 'missing-gateway' ? 503 : 403);
        expect(destinations).toEqual([]);
      } finally { direct.mockRestore(); }
    });
  it('discards a private upstream response when Activity authority changes during the send', async () => {
    let active = true;
    let cancelled = false;
    const { controller } = makeController({
      OPERATOR_ACTIVITY: { getByName: () => ({ dispatcherNativeEgressCurrent: async () => active ? selection : null }) } as never,
      EGRESS: { fetch: async () => { active = false;
        return new Response(new ReadableStream({ cancel() { cancelled = true; } })); } } as unknown as Fetcher,
    }, { operatorDispatcherNative: scope });
    const response = await controller.fetch(new Request(url, { method: 'POST', body: '{}' }));
    expect(response.status).toBe(403);
    expect(cancelled).toBe(true);
  });
});

describe('REQ-OPERATOR-047: Conductor native egress retains only structured safe auth evidence', () => {
  it.each([{ status: 401, coded: true }, { status: 403, coded: true },
    { status: 401, coded: false }, { status: 403, coded: false }])(
    'HTTP $status coded=$coded never exposes private provider errors or infers login from status', async ({ status, coded }) => {
      const kv = { [STRICT_KEY]: 'active', [SETUP_KEYS.ENTERPRISE_ACCESS_GROUP]: 'native-group',
        [SETUP_KEYS.GROUP_ROUTING]: JSON.stringify({ 'native-group': { routes: [], defaultRoute: '', reasoning: 'off',
          allowPersonalPiProviders: true, piDefaultSource: 'pi-native' } }),
        [SETUP_KEYS.REASONING_CONFIGURATION]: JSON.stringify({ schemaVersion: 1, customProfileRevisions: [], routeAssignments: {},
          fallbackRouting: { enabled: false } }) };
      const { controller } = makeController({ __kv: kv,
        CONTAINER: { getByName: () => ({ getPersonalPiSession: async () => ({ generation: 1, groups: ['native-group'] }) }) } as never,
        EGRESS: { fetch: async () => Response.json({ error: { code: coded ? 'invalid_api_key' : 'unrelated_failure',
          message: 'private-upstream-detail synthetic-native-access' } }, { status }) } as unknown as Fetcher,
      }, { personalPi: { bucket: 'owner-bucket', sessionId: 'native-session', user: 'owner@example.test', generation: 1 },
        operatorPolicy: { ...operatorPolicy, inference: { ...operatorPolicy.inference,
          allowedSources: ['pi-native'], reasoningLevels: ['low'] } },
        operatorNative: { provider: 'openai-codex', model: 'gpt-6.1-sol', api: 'openai-codex-responses', reasoningLevel: 'low', binding: {
          ownerKey: 'a'.repeat(64), activityId: 'native-activity', sessionId: 'native-session', generation: 1,
          profileDigest: 'b'.repeat(64), selectionDigest: 'c'.repeat(64), deadline: Date.now() + 60_000 } } });
      const response = await controller.fetch(new Request('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-native-access' },
        body: JSON.stringify({ model: 'gpt-6.1-sol', reasoning: { effort: 'low' } }),
      }));
      expect(response.status).toBe(status);
      const value = await response.json() as { authFailure?: unknown };
      expect(value.authFailure).toEqual(coded ? { code: 'PI_LOGIN_REQUIRED', reason: 'rejected', provider: 'openai-codex' } : undefined);
      expect(JSON.stringify(value)).not.toMatch(/private-upstream-detail|synthetic-native-access/);
    });
});

describe('REQ-OPERATOR-047: protected egress cancellation continuity', () => {
  it.each(['EGRESS', 'JWT EGRESS', 'account-scoped direct'])(
    'REQ-OPERATOR-047: AC2 %s egress preserves effective cancellation without changing transport policy', async path => {
      const recipient = pendingRecipient(); const controller = new AbortController();
      const direct = path === 'account-scoped direct'; const stamped = path === 'JWT EGRESS';
      const gatewayUrls: string[] = []; const directUrls: string[] = [];
      const directFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
        const request = input as Request; directUrls.push(request.url); return recipient.fetch(request);
      });
      const egress = { fetch: (request: Request) => { gatewayUrls.push(request.url); return recipient.fetch(request); } };
      const { controller: transport } = makeController({ EGRESS: egress as Fetcher }, { accountId: 'acc',
        ...(!direct ? { operatorPolicy } : {}),
        ...(stamped ? { jwtStamping: { mode: 'list' as const, destinations: ['allowed.example.test'] }, jwtAuthority } : {}),
      });
      const url = direct ? 'https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts' : 'https://allowed.example.test/path';
      const result = transport.fetch(new Request(url, { method: 'POST', body: 'streamed input', signal: controller.signal,
        headers: { authorization: 'Bearer specialized', connection: 'keep-alive',
          ...(stamped ? { 'cf-access-jwt-assertion': 'spoof' } : {}) } }));
      try {
        const forwarded = await within(recipient.entered, 'egress recipient entry'); controller.abort();
        await expect.poll(recipient.aborted, { timeout: 300 }).toBe(true);
        const response = await within(result, 'egress abort response');
        expect(response.status).toBe(502);
        expect(await response.json()).toMatchObject({ code: 'EGRESS_FETCH_FAILED' });
        expect(forwarded.headers.get('authorization')).toBe('Bearer specialized');
        expect(forwarded.headers.get('cf-access-jwt-assertion')).toBe(stamped ? 'verified.jwt' : null);
        expect(forwarded.headers.has('connection')).toBe(false);
        expect(forwarded.redirect).toBe('manual');
        // Observable transport isolation, paired with the refusal: no Gateway bypass or replacement.
        expect({ gatewayUrls, directUrls }).toEqual(direct ? { gatewayUrls: [], directUrls: [url] } : { gatewayUrls: [url], directUrls: [] });
      } finally {
        controller.abort(); recipient.release(); await within(result, 'egress cleanup').catch(() => undefined); directFetch.mockRestore();
      }
    });
});

describe('REQ-OPERATOR-019: verified Access stamping in generic egress', () => {
  it('stamps an eligible request after network authorization while preserving Authorization', async () => {
    const { controller, egressFetch } = makeController({}, { accountId: 'acc', operatorPolicy,
      jwtStamping: { mode: 'list', destinations: ['allowed.example.test'] }, jwtAuthority });
    const response = await controller.fetch(new Request('https://allowed.example.test/path', {
      headers: { authorization: 'Bearer specialized', 'cf-access-jwt-assertion': 'spoof' },
    }));
    expect(response.status).toBe(200);
    const forwarded = egressFetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get('cf-access-jwt-assertion')).toBe('verified.jwt');
    expect(forwarded.headers.get('authorization')).toBe('Bearer specialized');
  });

  it('strips spoofed assertions when stamping is Off', async () => {
    const { controller, egressFetch } = makeController({}, { accountId: 'acc', operatorPolicy,
      jwtStamping: { mode: 'off', destinations: [] }, jwtAuthority });
    expect((await controller.fetch(new Request('https://allowed.example.test/path', {
      headers: { 'cf-access-jwt-assertion': 'spoof' },
    }))).status).toBe(200);
    expect((egressFetch.mock.calls[0][0] as Request).headers.get('cf-access-jwt-assertion')).toBeNull();
  });
});

describe('REQ-OPERATOR-004: operator restrictions precede egress and R2 credentials', () => {
  it('denies undeclared general egress and specialized GitHub without forwarding', async () => {
    for (const url of ['https://denied.example.test/path', 'https://api.github.com/repos/octo/repo']) {
      const { controller, egressFetch } = makeController({}, { accountId: 'acc', operatorPolicy });
      const response = await controller.fetch(new Request(url));
      expect(response.status).toBe(403);
      expect((await response.json() as { code?: string }).code).toBe('OPERATOR_EGRESS_DENIED');
      expect(egressFetch).not.toHaveBeenCalled();
    }
  });

  it('forwards declared general egress through the existing Gateway path', async () => {
    const { controller, egressFetch } = makeController({}, { accountId: 'acc', operatorPolicy });
    expect((await controller.fetch(new Request('https://allowed.example.test/path'))).status).toBe(200);
    expect(egressFetch).toHaveBeenCalledTimes(1);
  });

  it('asks the parent activity before writing an owned sync operation and denies sealed writes before signing', async () => {
    const authorizeSyncWrite = vi.fn(async () => ({ ok: false as const, reason: 'sealed' as const }));
    const activityNamespace = { getByName: vi.fn(() => ({ authorizeSyncWrite })) };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('r2', { status: 200 }));
    try {
      const { controller } = makeController({ OPERATOR_ACTIVITY: activityNamespace as never }, {
        accountId: 'acc', operatorPolicy: { ...operatorPolicy,
          storage: { ...operatorPolicy.storage, writePrefixes: ['outputs/activity/'] } },
        operatorSync: { activityId: 'activity', outputPrefix: 'outputs/activity/',
          manifestPrefix: '.codeflare/operators/activity/' },
      });
      const response = await controller.fetch(new Request(
        'https://acc.r2.cloudflarestorage.com/bucket/outputs/activity/report.txt',
        { method: 'PUT', body: 'late', headers: { 'x-codeflare-operator-sync-operation': 'sync-1' } },
      ));
      expect(response.status).toBe(403);
      expect((await response.json() as { code?: string }).code).toBe('OPERATOR_SYNC_SEALED');
      expect(activityNamespace.getByName).toHaveBeenCalledWith('activity');
      expect(authorizeSyncWrite).toHaveBeenCalledWith('sync-1', 'outputs/activity/report.txt');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  it('authorizes exact visible and private sync writes with parent-owned SSE-C before signing', async () => {
    const authorizeSyncWrite = vi.fn(async () => ({ ok: true as const }));
    const activityNamespace = { getByName: vi.fn(() => ({ authorizeSyncWrite })) };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('r2', { status: 200 }));
    const operatorSync = { activityId: 'activity', outputPrefix: 'Operators/',
      manifestPrefix: '.codeflare/operators/activity/' };
    const encryptionKey = btoa('a'.repeat(32));
    try {
      for (const key of ['Operators/Gate%201/report.txt', '.codeflare/operators/activity/sync-1/manifest.json']) {
        const { controller } = makeController({ OPERATOR_ACTIVITY: activityNamespace as never,
          ENCRYPTION_KEY: encryptionKey }, {
          accountId: 'acc', operatorPolicy: { ...operatorPolicy, storage: { readPrefixes: [], writePrefixes: [] } },
          operatorSync, r2SseDisabled: false,
        });
        const response = await controller.fetch(new Request(`https://acc.r2.cloudflarestorage.com/bucket/${key}`, {
          method: 'PUT', body: 'value', headers: {
            'x-codeflare-operator-sync-operation': 'sync-1',
            'x-amz-server-side-encryption-customer-algorithm': 'spoof',
            'x-amz-server-side-encryption-customer-key': 'spoof',
            'x-amz-server-side-encryption-customer-key-md5': 'spoof',
          },
        }));
        expect(response.status).toBe(200);
      }
      expect(authorizeSyncWrite).toHaveBeenNthCalledWith(1, 'sync-1', 'Operators/Gate 1/report.txt');
      expect(authorizeSyncWrite).toHaveBeenNthCalledWith(2, 'sync-1', '.codeflare/operators/activity/sync-1/manifest.json');
      for (const call of fetchSpy.mock.calls) {
        const request = call[0] as Request;
        expect(request.headers.get('x-codeflare-operator-sync-operation')).toBeNull();
        expect(request.headers.get('x-amz-server-side-encryption-customer-algorithm')).toBe('AES256');
        expect(request.headers.get('x-amz-server-side-encryption-customer-key')).toBe(encryptionKey);
        expect(request.headers.get('x-amz-server-side-encryption-customer-key-md5')).not.toBe('spoof');
        expect(request.headers.get('authorization')).toContain(
          'x-amz-server-side-encryption-customer-algorithm;x-amz-server-side-encryption-customer-key;'
          + 'x-amz-server-side-encryption-customer-key-md5',
        );
      }

      for (const value of [null, '../spoof']) {
        const headers = value === null ? undefined : { 'x-codeflare-operator-sync-operation': value };
        const { controller } = makeController({ OPERATOR_ACTIVITY: activityNamespace as never }, {
          accountId: 'acc', operatorPolicy, operatorSync,
        });
        const denied = await controller.fetch(new Request(
          'https://acc.r2.cloudflarestorage.com/bucket/Operators/Gate%201/report.txt',
          { method: 'PUT', body: 'value', headers },
        ));
        expect(denied.status).toBe(403);
        expect((await denied.json() as { code?: string }).code).toBe('OPERATOR_SYNC_SCOPE_DENIED');
      }
      expect(authorizeSyncWrite).toHaveBeenCalledTimes(2);
    } finally { fetchSpy.mockRestore(); }
  });

  it('enforces read/write and destructive operation scopes before R2 signing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('r2', { status: 200 }));
    const cases = [
      [new Request('https://acc.r2.cloudflarestorage.com/bucket/inputs/file.txt'), 200],
      [new Request('https://acc.r2.cloudflarestorage.com/bucket/outputs/activity/result.txt', { method: 'PUT', body: 'ok' }), 200],
      [new Request('https://acc.r2.cloudflarestorage.com/bucket/outputs/activity/result.txt'), 403],
      [new Request('https://acc.r2.cloudflarestorage.com/bucket/inputs/file.txt', { method: 'PUT', body: 'bad' }), 403],
      [new Request('https://acc.r2.cloudflarestorage.com/bucket/outputs/activity/result.txt', { method: 'DELETE' }), 403],
    ] as const;
    try {
      for (const [request, status] of cases) {
        const { controller } = makeController({}, { accountId: 'acc', operatorPolicy });
        expect((await controller.fetch(request)).status).toBe(status);
      }
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally { fetchSpy.mockRestore(); }
  });
});

describe('REQ-ENTERPRISE-016: EgressController fail-closed guards', () => {
  it('returns 403 EGRESS_TARGET_BLOCKED for an SSRF target and never forwards', async () => {
    const { controller, egressFetch } = makeController();
    const res = await controller.fetch(new Request('https://169.254.169.254/latest/meta-data'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('EGRESS_TARGET_BLOCKED');
    expect(egressFetch).not.toHaveBeenCalled();
  });

  it('returns 503 EGRESS_UNAVAILABLE when strict is ON but EGRESS is unbound', async () => {
    const { controller } = makeController({ EGRESS: undefined } as Partial<Env>);
    const res = await controller.fetch(new Request('https://example.com/'));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code?: string }).code).toBe('EGRESS_UNAVAILABLE');
  });

  it('reads strict from props (not KV): 503 EGRESS_NOT_CONFIGURED when props.strict is false, and never reads KV', async () => {
    const kvGet = vi.fn(async () => 'active'); // KV would say active — the controller must ignore it
    const env = { ENTERPRISE_MODE: 'active', KV: { get: kvGet }, EGRESS: { fetch: vi.fn() } } as unknown as Env;
    const controller = new EgressController(
      { props: { accountId: 'acc', strict: false } } as unknown as ExecutionContext,
      env,
    );
    const res = await controller.fetch(new Request('https://example.com/'));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code?: string }).code).toBe('EGRESS_NOT_CONFIGURED');
    expect(kvGet).not.toHaveBeenCalled();
  });
});

describe('REQ-ENTERPRISE-029: protected own-R2 enforcement', () => {
  async function protectedFixture(digestCharacter = 'd') {
    const releaseDigest = digestCharacter.repeat(64);
    const value = {
      schemaVersion: 1,
      releaseDigest,
      resourcePolicy: 'immutable',
      paths: ['.codeflare/managed-extensions.json', '.codeflare/managed-paths.json'],
      resourceRoots: [],
    } as const;
    const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    const pathsDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { releaseDigest, pathsDigest, bytes };
  }

  it('loads policy with scoped credentials and denies protected mutation before user forwarding', async () => {
    const fixture = await protectedFixture();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = input as Request;
      if (request.url.endsWith('/bucket/.codeflare/managed-paths.json')) return new Response(fixture.bytes, { status: 200 });
      return new Response('unexpected user forward', { status: 200 });
    });
    const { controller, egressFetch } = makeController({ R2_ACCOUNT_ID: 'acc' }, {
      accountId: 'acc', bucket: 'bucket', resourcePolicy: 'immutable',
      releaseDigest: fixture.releaseDigest, pathsDigest: fixture.pathsDigest,
    });

    const response = await controller.fetch(new Request('https://acc.r2.cloudflarestorage.com/bucket/.codeflare/managed-paths.json', { method: 'DELETE' }));

    expect(response.status).toBe(403);
    expect(await response.text()).toContain('<Code>AccessDenied</Code>');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const policyRequest = fetchSpy.mock.calls[0][0] as Request;
    expect(policyRequest.headers.get('authorization')).toContain('Credential=user-r2-key/');
    expect(policyRequest.headers.get('authorization')).not.toContain('admin-r2-key');
    expect(egressFetch).not.toHaveBeenCalled();
    expect(policyLogs.warn).toHaveBeenCalledWith('Managed R2 policy decision', expect.objectContaining({
      operation: 'delete-object',
      policyDigest: fixture.pathsDigest.slice(0, 12),
      pathHash: expect.stringMatching(/^[0-9a-f]{12}$/),
      bucketHash: expect.stringMatching(/^[0-9a-f]{12}$/),
      requestId: expect.any(String),
      reason: 'access-denied',
    }));
    const denialLog = policyLogs.warn.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(Object.keys(denialLog).sort()).toEqual([
      'bucketHash', 'operation', 'pathHash', 'policyDigest', 'reason', 'requestId',
    ]);
    expect(JSON.stringify(policyLogs.warn.mock.calls)).not.toContain('managed-paths.json');
    fetchSpy.mockRestore();
  });

  it('signs approved adjacent mutation only with the scoped user key', async () => {
    const fixture = await protectedFixture();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = input as Request;
      if (request.url.endsWith('/bucket/.codeflare/managed-paths.json')) return new Response(fixture.bytes, { status: 200 });
      return new Response('stored', { status: 200 });
    });
    const { controller } = makeController({ R2_ACCOUNT_ID: 'acc' }, {
      accountId: 'acc', bucket: 'bucket', resourcePolicy: 'immutable',
      releaseDigest: fixture.releaseDigest, pathsDigest: fixture.pathsDigest,
    });

    const response = await controller.fetch(new Request('https://acc.r2.cloudflarestorage.com/bucket/Vault/personal.md', { method: 'PUT', body: 'ok' }));

    expect(response.status).toBe(200);
    expect(policyLogs.debug).toHaveBeenCalledWith('Managed R2 policy decision', expect.objectContaining({
      operation: 'put-object', reason: 'allowed',
    }));
    expect(JSON.stringify(policyLogs.debug.mock.calls)).not.toContain('Vault/personal.md');
    const userRequest = fetchSpy.mock.calls.map(call => call[0] as Request).find(request => request.url.endsWith('/Vault/personal.md'))!;
    expect(userRequest.headers.get('authorization')).toContain('Credential=user-r2-key/');
    expect(userRequest.headers.get('authorization')).not.toContain('admin-r2-key');
    fetchSpy.mockRestore();
  });

  it('returns S3 503 and never forwards mutation when policy loading fails', async () => {
    const fixture = await protectedFixture('c');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('missing', { status: 404 }));
    const { controller } = makeController({ R2_ACCOUNT_ID: 'acc' }, {
      accountId: 'acc', bucket: 'bucket', resourcePolicy: 'immutable',
      releaseDigest: fixture.releaseDigest, pathsDigest: fixture.pathsDigest,
    });

    const response = await controller.fetch(new Request('https://acc.r2.cloudflarestorage.com/bucket/Vault/personal.md', { method: 'PUT', body: 'ok' }));

    expect(response.status).toBe(503);
    expect(await response.text()).toContain('<Code>ServiceUnavailable</Code>');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(policyLogs.warn).toHaveBeenCalledWith('Managed R2 policy decision', expect.objectContaining({
      operation: 'put-object', reason: 'policy-unavailable', requestId: expect.any(String),
    }));
    expect(JSON.stringify(policyLogs.warn.mock.calls)).not.toContain('Vault/personal.md');
    fetchSpy.mockRestore();
  });
});

describe('REQ-ENTERPRISE-016 / AD86: EgressController account-scoped exemption (own account direct, all else Gateway) / REQ-ENTERPRISE-026', () => {
  it('forwards THIS account R2 DIRECT via global fetch — never env.EGRESS', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('r2', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { accountId: 'acc' });
    const res = await controller.fetch(new Request('https://acc.r2.cloudflarestorage.com/bucket/key'));
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('re-signs the bound bucket with scoped credentials and trusted parent SSE-C while preserving streaming', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('r2', { status: 200 }));
    const encryptionKey = btoa('a'.repeat(32));
    const encryptionKeyMd5 = createHash('md5').update(new TextEncoder().encode('a'.repeat(32))).digest('base64');
    const { controller, egressFetch } = makeController({ ENCRYPTION_KEY: encryptionKey }, { accountId: 'acc' });
    await controller.fetch(
      new Request('https://acc.r2.cloudflarestorage.com/bucket/key', {
        method: 'PUT',
        headers: {
          authorization: 'AWS4-HMAC-SHA256 Credential=PLACEHOLDER-KEY/20260101/auto/s3/aws4_request, Signature=deadbeef',
          'x-amz-content-sha256': 'fixedhash123',
          'x-amz-server-side-encryption-customer-algorithm': 'spoof',
          'x-amz-server-side-encryption-customer-key': 'spoof',
          'x-amz-server-side-encryption-customer-key-md5': 'spoof',
          'content-type': 'application/octet-stream',
        },
        body: 'payload-bytes',
      }),
    );
    expect(fetchSpy).toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    const signed = fetchSpy.mock.calls[0][0] as Request;
    const auth = signed.headers.get('authorization') ?? '';
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(auth).not.toContain('PLACEHOLDER-KEY'); // container placeholder stripped
    expect(auth).toContain('Credential=user-r2-key/');
    expect(auth).not.toContain('admin-r2-key');
    // rclone's precomputed payload hash is REUSED (not recomputed / UNSIGNED) — body streams unbuffered.
    expect(signed.headers.get('x-amz-content-sha256')).toBe('fixedhash123');
    // Parent-owned SSE-C headers replace caller values and are covered by the new signature.
    expect(signed.headers.get('x-amz-server-side-encryption-customer-algorithm')).toBe('AES256');
    expect(signed.headers.get('x-amz-server-side-encryption-customer-key')).toBe(encryptionKey);
    expect(signed.headers.get('x-amz-server-side-encryption-customer-key-md5')).toBe(encryptionKeyMd5);
    expect(auth).toContain('x-amz-server-side-encryption-customer-algorithm');
    expect(auth).toContain('x-amz-server-side-encryption-customer-key');
    expect(auth).toContain('x-amz-server-side-encryption-customer-key-md5');
    fetchSpy.mockRestore();
  });

  it('accepts the bound bucket in virtual-hosted R2 form and signs with its scoped key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('r2', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { accountId: 'acc', bucket: 'bound-bucket' });
    const res = await controller.fetch(new Request('https://bound-bucket.acc.r2.cloudflarestorage.com/key'));
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
    const signed = fetchSpy.mock.calls[0][0] as Request;
    expect(signed.headers.get('authorization')).toContain('Credential=user-r2-key/');
    expect(egressFetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects another virtual-hosted bucket in the same account before signing or forwarding', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { accountId: 'acc', bucket: 'bound-bucket' });
    const res = await controller.fetch(new Request('https://other-bucket.acc.r2.cloudflarestorage.com/key'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('EGRESS_R2_BUCKET_FORBIDDEN');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects another path-style bucket in the same account before signing or forwarding', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { accountId: 'acc', bucket: 'bound-bucket' });
    const res = await controller.fetch(new Request('https://acc.r2.cloudflarestorage.com/other-bucket/key'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('EGRESS_R2_BUCKET_FORBIDDEN');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('fails closed when scoped credentials are missing instead of falling back to deployment credentials', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }));
    const { controller, egressFetch } = makeController({}, {
      accountId: 'acc',
      bucket: 'bucket',
      r2AccessKeyId: undefined,
      r2SecretAccessKey: undefined,
    });
    const res = await controller.fetch(new Request('https://acc.r2.cloudflarestorage.com/bucket/key'));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code?: string }).code).toBe('EGRESS_R2_NOT_CONFIGURED');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('forwards THIS account CF API (browser-rendering path) DIRECT and transparent — never env.EGRESS, no re-sign', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('cf', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { accountId: 'acc' });
    await controller.fetch(
      new Request('https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/snapshot', {
        headers: { authorization: 'Bearer caller-cf-token' },
      }),
    );
    expect(fetchSpy).toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    // CF API is a transparent passthrough (REQ-BROWSER-007): caller token preserved, not re-signed.
    const fwd = fetchSpy.mock.calls[0][0] as Request;
    expect(fwd.headers.get('authorization')).toBe('Bearer caller-cf-token');
    fetchSpy.mockRestore();
  });

  it('routes ANOTHER account R2 through env.EGRESS (Gateway) — NOT direct (closes cross-account exfil)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { accountId: 'acc' });
    await controller.fetch(new Request('https://other.r2.cloudflarestorage.com/bucket/key'));
    expect(egressFetch).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('routes ANOTHER account CF API path through env.EGRESS — NOT direct', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { accountId: 'acc' });
    await controller.fetch(new Request('https://api.cloudflare.com/client/v4/accounts/other/browser-rendering/snapshot'));
    expect(egressFetch).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('fail-secure: with NO accountId prop, even an own-looking R2 host rides env.EGRESS (nothing exempt, not re-signed)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { strict: true });
    await controller.fetch(new Request('https://acc.r2.cloudflarestorage.com/bucket/key'));
    expect(egressFetch).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('REQ-ENTERPRISE-016: EgressController bridges WebSocket upgrades (catch-all fallback)', () => {
  // The upstream socket is mocked (accept/addEventListener) so the bridge can accept it and
  // wire forwarding; the controller returns a FRESH WebSocketPair client end (not the upstream
  // as-is). Returning the upstream as-is would fail these assertions.
  const makeUpstreamWs = () => ({
    accept: vi.fn(),
    addEventListener: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  });

  // The controller bridges by creating a REAL WebSocketPair and accept()ing its server end.
  // Capture every pair it creates and close both ends after each test so the
  // vitest-pool-workers isolate tears down cleanly — a live accepted WebSocket otherwise
  // crashes the pool worker ("Worker exited unexpectedly").
  const createdPairs: Array<Record<string, WebSocket>> = [];
  const RealWebSocketPair = WebSocketPair;
  beforeEach(() => {
    createdPairs.length = 0;
    vi.stubGlobal('WebSocketPair', function WebSocketPairCapture() {
      const pair = new RealWebSocketPair();
      createdPairs.push(pair as unknown as Record<string, WebSocket>);
      return pair;
    });
  });
  afterEach(() => {
    for (const pair of createdPairs) {
      for (const end of Object.values(pair)) {
        try { end.close(); } catch { /* already closed / handed to the Response */ }
      }
    }
    vi.unstubAllGlobals();
  });

  it('bridges a THIS-account CDP upgrade: accepts the upstream, returns a 101 with a FRESH client webSocket (not as-is), direct not env.EGRESS', async () => {
    const upstreamWs = makeUpstreamWs();
    const ws101 = { status: 101, webSocket: upstreamWs, headers: new Headers() } as unknown as Response;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ws101);
    const { controller, egressFetch } = makeController({}, { accountId: 'acc' });
    const res = await controller.fetch(
      new Request('https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/devtools/browser', {
        headers: { Upgrade: 'websocket' },
      }),
    );
    expect(res.status).toBe(101);
    const clientWs = (res as unknown as { webSocket?: unknown }).webSocket;
    expect(clientWs).toBeTruthy();
    expect(clientWs).not.toBe(upstreamWs); // bridged, NOT returned as-is
    expect(upstreamWs.accept).toHaveBeenCalled(); // upstream socket taken up
    // upstream→client frame + close forwarding is wired (fails if the bridge reverts to return-as-is)
    expect(upstreamWs.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(upstreamWs.addEventListener).toHaveBeenCalledWith('close', expect.any(Function));
    expect(fetchSpy).toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('surfaces a non-101 upstream (e.g. an error response) unchanged', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('denied', { status: 403 }));
    const { controller } = makeController({}, { accountId: 'acc' });
    const res = await controller.fetch(
      new Request('https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/devtools/browser', {
        headers: { Upgrade: 'websocket' },
      }),
    );
    expect(res.status).toBe(403);
    fetchSpy.mockRestore();
  });

  it('bridges a non-account-scoped WS upgrade through env.EGRESS with the Upgrade header preserved (not stripped)', async () => {
    const upstreamWs = makeUpstreamWs();
    const ws101 = { status: 101, webSocket: upstreamWs, headers: new Headers() } as unknown as Response;
    const { controller, egressFetch } = makeController({}, { accountId: 'acc' });
    egressFetch.mockResolvedValueOnce(ws101);
    const res = await controller.fetch(
      new Request('https://example.com/socket', { headers: { Upgrade: 'websocket' } }),
    );
    expect(res.status).toBe(101);
    expect(egressFetch).toHaveBeenCalled();
    const fwd = egressFetch.mock.calls[0][0] as Request;
    expect(fwd.headers.get('upgrade')?.toLowerCase()).toBe('websocket');
    expect(upstreamWs.accept).toHaveBeenCalled();
  });
});

describe('REQ-ENTERPRISE-016: EgressController transparent proxy', () => {
  it('never adds an Authorization or identity header (non-R2 host)', async () => {
    const { controller, egressFetch } = makeController();
    await controller.fetch(new Request('https://example.com/', { method: 'GET' }));
    const fwd = egressFetch.mock.calls[0][0] as Request;
    expect(fwd.headers.get('authorization')).toBeNull();
    expect(fwd.headers.get('cf-aig-authorization')).toBeNull();
    expect(fwd.headers.get('cf-aig-metadata')).toBeNull();
    expect(fwd.headers.get('cf-aig-gateway-id')).toBeNull();
    expect(fwd.headers.get('x-access-token')).toBeNull();
  });

  it('forwards a caller-supplied authorization and cookie verbatim (non-R2 host)', async () => {
    const { controller, egressFetch } = makeController();
    await controller.fetch(
      new Request('https://example.com/', {
        method: 'GET',
        headers: { authorization: 'Bearer caller-token', cookie: 'a=1' },
      }),
    );
    const fwd = egressFetch.mock.calls[0][0] as Request;
    expect(fwd.headers.get('authorization')).toBe('Bearer caller-token');
    expect(fwd.headers.get('cookie')).toBe('a=1');
  });

  it('forwards with redirect:manual', async () => {
    const { controller, egressFetch } = makeController();
    await controller.fetch(new Request('https://example.com/'));
    const fwd = egressFetch.mock.calls[0][0] as Request;
    expect(fwd.redirect).toBe('manual');
  });

  it('preserves set-cookie on the response and strips hop-by-hop headers', async () => {
    const { controller } = makeController();
    const res = await controller.fetch(new Request('https://example.com/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBe('sess=abc');
    expect(res.headers.get('connection')).toBeNull();
  });
});
