import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createMockKV } from '../helpers/mock-kv';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { BUILT_IN_REASONING_PROFILES, getBuiltInProfile, normalizeCustomProfile } from '../../lib/reasoning-profiles';
import reasoningRoutes from '../../routes/admin/reasoning';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => { c.set('user', { email: 'admin@example.com', role: 'admin' }); return next(); }),
  requireAdmin: vi.fn(async (_c: any, next: any) => next()),
}));
vi.mock('../../lib/aig-config', () => ({
  getAigConfig: vi.fn(async () => ({ gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/gateway', token: 'saved-gateway-secret' })),
}));

function appWithProfiles(profiles: unknown[] = []) {
  const kv = createMockKV();
  kv._set(SETUP_KEYS.REASONING_CONFIGURATION, { schemaVersion: 1, customProfileRevisions: profiles, routeAssignments: {} });
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  app.use('*', async (c, next) => { c.env = { KV: kv } as unknown as Env; return next(); });
  app.route('/admin/reasoning', reasoningRoutes);
  return { app, kv };
}

function streamed(delta: Record<string, unknown>, finish_reason = 'stop'): Response {
  return new Response(`data: ${JSON.stringify({ id: 'private-response', choices: [{ delta, finish_reason }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

function lifecycle(body: Record<string, any>, reasoning = true): Response {
  if (!body.tools) return streamed({ content: 'private-answer', ...(reasoning ? { reasoning_content: 'private-reasoning' } : {}) });
  if (body.messages.some((message: any) => message.role === 'tool')) return streamed({ content: 'private-final' });
  return streamed({ tool_calls: [{ index: 0, id: 'private-call', type: 'function', function: { name: 'codeflare_profile_canary', arguments: '{"value":"ok"}' } }] }, 'tool_calls');
}

function provider(respond: (body: Record<string, any>) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return Response.json({ data: { routes: [{ id: 'route-id', name: 'kimi-route' }] } });
    return respond(JSON.parse(String(init?.body)));
  });
}

async function discover(app: ReturnType<typeof appWithProfiles>['app'], extra: Record<string, unknown> = {}) {
  const response = await app.request('/admin/reasoning/discover', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route: 'kimi-route', maxCompletionTokens: 512, ...extra }),
  });
  expect(response.status).toBe(200);
  return await response.json() as any;
}

function partialProfile(enabled = true) {
  const kimi = getBuiltInProfile('workers-ai-kimi-k-thinking')!;
  return normalizeCustomProfile({
    schemaVersion: 1, id: 'custom-low', name: 'My low-thinking profile', revision: 1, enabled,
    supportedLevels: ['minimal', 'low'], removePaths: kimi.removePaths,
    levels: { minimal: kimi.levels.minimal, low: kimi.levels.low }, aliases: { minimal: 'low' },
    offSemantics: { status: 'unsupported' }, toolCompatibility: { status: 'unverified', levels: [] },
    validatedTransports: [], classification: 'Compatible, unverified',
  });
}

// Real catalog and real streaming engine: these fixtures must not reduce every built-in to the same off-only mapping.
describe('REQ-ENTERPRISE-035 actionable route discovery', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('recommends the exact existing Kimi revision when non-off tools and replay pass but off still reasons', async () => {
    const { app, kv } = appWithProfiles();
    provider((body) => body.chat_template_kwargs?.clear_thinking === false
      ? lifecycle(body)
      : Response.json({ errors: [{ message: 'private unsupported mapping' }] }, { status: 400 }));
    const body = await discover(app);
    const kimi = getBuiltInProfile('workers-ai-kimi-k-thinking')!;
    expect(body).toMatchObject({ outcome: 'existing-profile', assignable: true, matchedProfiles: [{ name: kimi.name, profileRef: { id: kimi.id, revision: kimi.revision, hash: kimi.hash } }] });
    expect(body.matchedProfiles).toHaveLength(1);
    expect(body).not.toHaveProperty('profileDraft');
    expect(body.candidateResults.some((result: any) => result.diagnostics.some((diagnostic: any) => diagnostic.code === 'off_not_disabled'))).toBe(true);
    expect(vi.mocked(kv.put).mock.calls.some(([key]) => key === SETUP_KEYS.REASONING_CONFIGURATION)).toBe(false);
    for (const privateValue of ['saved-gateway-secret', 'private-answer', 'private-reasoning', 'private-final', 'private-response', 'private-call', 'private unsupported mapping']) expect(JSON.stringify(body)).not.toContain(privateValue);
  });

  it('retains equivalent Kimi and saved custom choices when alias representations differ', async () => {
    const kimi = getBuiltInProfile('workers-ai-kimi-k-thinking')!;
    const saved = normalizeCustomProfile({
      schemaVersion: 1, id: 'custom-kimi-direct', name: 'Kimi direct mappings', revision: 2, enabled: true,
      supportedLevels: kimi.supportedLevels, removePaths: kimi.removePaths, levels: kimi.levels,
      aliases: {}, offSemantics: { status: 'unsupported' },
    });
    const { app, kv } = appWithProfiles([saved]);
    provider((body) => body.chat_template_kwargs?.clear_thinking === false
      ? lifecycle(body)
      : Response.json({}, { status: 400 }));

    const body = await discover(app);

    expect(body).toMatchObject({ outcome: 'existing-profile', assignable: true });
    expect(body.matchedProfiles).toEqual([kimi, saved].map((profile) => ({
      name: profile.name,
      profileRef: { id: profile.id, revision: profile.revision, hash: profile.hash },
      supportedLevels: profile.supportedLevels,
    })));
    expect(body).not.toHaveProperty('profileDraft');
    expect(body.warnings ?? []).not.toContain('ambiguous_profile_mapping');
    expect(vi.mocked(kv.put).mock.calls.some(([key]) => key === SETUP_KEYS.REASONING_CONFIGURATION)).toBe(false);
  });

  it('retains equivalent Gemma and GLM choices instead of mistaking deduplication order for identity', async () => {
    const { app } = appWithProfiles();
    provider((body) => body.chat_template_kwargs?.clear_thinking === false
      ? lifecycle(body, body.chat_template_kwargs.enable_thinking !== false)
      : Response.json({}, { status: 400 }));
    const body = await discover(app);
    expect(body.outcome).toBe('existing-profile');
    expect(body.matchedProfiles.map((profile: any) => profile.profileRef.id)).toEqual(['workers-ai-gemma-thinking', 'workers-ai-kimi-k-thinking', 'workers-ai-glm-thinking']);
  });

  it('creates a normalized custom draft from passed modes when no complete existing profile fits', async () => {
    const { app, kv } = appWithProfiles();
    provider((body) => body.chat_template_kwargs?.clear_thinking === false && body.reasoning_effort === 'low'
      ? lifecycle(body)
      : streamed({ content: 'no tool available', reasoning_content: 'still thinking' }));
    const body = await discover(app);
    expect(body).toMatchObject({ outcome: 'custom-profile', assignable: true, matchedProfiles: [], profileDraft: {
      supportedLevels: ['minimal', 'low'], aliases: { minimal: 'low' }, offSemantics: { status: 'unsupported' },
      classification: 'Compatible, unverified', toolCompatibility: { status: 'unverified', levels: [] }, validatedTransports: [],
    } });
    const kimi = getBuiltInProfile('workers-ai-kimi-k-thinking')!;
    expect(body.profileDraft.removePaths).toEqual(kimi.removePaths);
    expect(body.profileDraft.levels).toEqual({ minimal: kimi.levels.minimal, low: kimi.levels.low });
    const normalized = normalizeCustomProfile({ ...body.profileDraft, id: 'custom-discovered', name: 'Discovered low', revision: 1 });
    expect(normalized.supportedLevels).toEqual(['minimal', 'low']);
    expect(normalized.unsupportedLevels).toContain('off');
    expect(vi.mocked(kv.put).mock.calls.some(([key]) => key === SETUP_KEYS.REASONING_CONFIGURATION)).toBe(false);
  });

  it('recommends a saved custom revision from matching bounded evidence without additional custom probes', async () => {
    const saved = partialProfile();
    const { app } = appWithProfiles([saved]);
    const fetcher = provider((body) => body.chat_template_kwargs?.clear_thinking === false && body.reasoning_effort === 'low'
      ? lifecycle(body)
      : streamed({ content: 'no tool available', reasoning_content: 'still thinking' }));
    const body = await discover(app);
    expect(body).toMatchObject({ outcome: 'existing-profile', matchedProfiles: [{ name: saved.name, profileRef: { id: saved.id, revision: saved.revision, hash: saved.hash } }] });
    expect(body).not.toHaveProperty('profileDraft');
    const calls = fetcher.mock.calls.length;
    fetcher.mockClear();
    await discover(appWithProfiles().app);
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });

  it('does not recommend disabled custom revisions', async () => {
    const { app } = appWithProfiles([partialProfile(false)]);
    provider((body) => body.chat_template_kwargs?.clear_thinking === false && body.reasoning_effort === 'low'
      ? lifecycle(body)
      : streamed({ content: 'no tool available', reasoning_content: 'still thinking' }));
    expect(await discover(app)).toMatchObject({ outcome: 'custom-profile', matchedProfiles: [] });
  });

  it('reports incomplete tool generation at the selected ceiling rather than unsupported reasoning', async () => {
    const { app } = appWithProfiles();
    provider((body) => body.tools ? streamed({ reasoning_content: 'private truncated thinking' }, 'length') : lifecycle(body));
    const body = await discover(app, { maxCompletionTokens: 32 });
    expect(body).toMatchObject({ outcome: 'inconclusive', classification: 'Inconclusive', assignable: false, requestedCompletionCeiling: 32 });
    expect(body.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'completion_limit', stage: 'tool-call' })]));
    expect(body).not.toHaveProperty('profileDraft');
    expect(JSON.stringify(body)).not.toContain('private truncated thinking');
  });

  it.each([401, 403, 429, 500, 503])('stops the whole candidate scan after HTTP %s', async (status) => {
    const { app } = appWithProfiles();
    const fetcher = provider(() => Response.json({ errors: [{ message: 'private provider error' }] }, { status }));
    const body = await discover(app);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(body).toMatchObject({ outcome: 'inconclusive', assignable: false, matchedProfiles: [] });
    expect(body.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'request_rejected', status })]));
    expect(body).not.toHaveProperty('profileDraft');
  });

  it('does not reuse custom profiles with different removals even when their level names match', async () => {
    const saved = partialProfile();
    const { hash: _hash, ...draft } = saved;
    const different = normalizeCustomProfile({ ...draft, removePaths: [] });
    const { app } = appWithProfiles([different]);
    provider((body) => body.chat_template_kwargs?.clear_thinking === false && body.reasoning_effort === 'low'
      ? lifecycle(body)
      : streamed({ content: 'no tool available', reasoning_content: 'still thinking' }));
    expect(await discover(app)).toMatchObject({ outcome: 'custom-profile', matchedProfiles: [] });
  });

  it('suppresses earlier matches when a later candidate encounters a fatal failure', async () => {
    const { app } = appWithProfiles();
    let attempts = 0;
    const fetcher = provider((body) => ++attempts <= 12 ? lifecycle(body, false) : Response.json({}, { status: 429 }));
    const body = await discover(app);
    expect(body).toMatchObject({ outcome: 'inconclusive', assignable: false, matchedProfiles: [], accounting: { httpAttempts: 13 } });
    expect(body.candidateResults[0].assignable).toBe(true);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(13);
    expect(body).not.toHaveProperty('profileDraft');
  });

  it('stops all candidates after malformed SSE without retaining the malformed content', async () => {
    const { app } = appWithProfiles();
    const fetcher = provider(() => new Response('data: {private-invalid-json}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const body = await discover(app);
    expect(body).toMatchObject({ outcome: 'inconclusive', assignable: false, matchedProfiles: [] });
    expect(body.diagnostics).toEqual([expect.objectContaining({ code: 'malformed_response', stage: 'reasoning' })]);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('private-invalid-json');
  });

  it('preserves divergent complete mappings as ambiguous without creating a profile', async () => {
    const { app } = appWithProfiles();
    provider((body) => lifecycle(body, false));
    const body = await discover(app);
    expect(body).toMatchObject({ outcome: 'ambiguous', assignable: false, warnings: ['ambiguous_profile_mapping'] });
    expect(body).not.toHaveProperty('profileDraft');
    expect(BUILT_IN_REASONING_PROFILES).toHaveLength(6);
  });
});
