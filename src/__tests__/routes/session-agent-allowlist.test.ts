/**
 * REQ-ENTERPRISE-003: Agent allowlist at session creation.
 *
 * Enterprise deploys restrict the selectable agent set to {copilot, pi, bash}
 * (OpenAI-wire-format agents only; Claude Code is excluded — AD74). A POST
 * /api/sessions with an agentType outside that set is rejected 400 only when
 * ENTERPRISE_MODE=active. When the flag is unset, all seven agents are accepted
 * exactly as today (the allowlist is a runtime filter, not an enum change — the
 * zod enum still validates all 7).
 *
 * AC1. Enterprise: a non-allowlisted agentType (claude-code/codex/antigravity/opencode) is rejected 400.
 * AC2. Enterprise: each allowlisted agent (copilot/pi/bash) is accepted 201.
 * AC3. flag-off regression: all seven agents are accepted 201.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';
import crudRoutes from '../../routes/session/crud';
import type { Env } from '../../types';

// crud.ts imports getContainer for delete; provide a minimal stub so it loads.
vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => ({
    fetch: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    destroy: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() })),
  })),
}));

// NOTE: subscription is NOT mocked here — the allowlist needs the real
// isEnterpriseMode()/allowedAgents(). The POST handler only touches tier helpers
// inside the isSaasModeActive() block, which stays false (SAAS_MODE unset).
vi.mock('../../lib/onboarding', () => ({
  isSaasModeActive: vi.fn(() => false),
}));

describe('REQ-ENTERPRISE-003: Agent allowlist at session creation', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function createApp(envOverrides: Partial<Env> = {}) {
    return createTestApp({
      routes: [{ path: '/sessions', handler: crudRoutes }],
      mockKV,
      envOverrides,
    });
  }

  // ── AC1: enterprise rejects non-allowlisted agents ──
  it.each(['claude-code', 'codex', 'antigravity', 'opencode'])(
    "AC1: agentType '%s' is rejected 400 when ENTERPRISE_MODE=active",
    async (agentType) => {
      const app = createApp({ ENTERPRISE_MODE: 'active' });
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Blocked Agent', agentType }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    },
  );

  // ── AC2: enterprise accepts allowlisted agents ──
  it.each(['copilot', 'pi', 'bash'])(
    "AC2: allowlisted agentType '%s' is accepted 201 when ENTERPRISE_MODE=active",
    async (agentType) => {
      const app = createApp({ ENTERPRISE_MODE: 'active' });
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Session ${agentType}`, agentType }),
      });
      expect(res.status, `agentType "${agentType}" should be accepted`).toBe(201);
    },
  );

  it('AC2: a session with no agentType is accepted 201 when ENTERPRISE_MODE=active', async () => {
    const app = createApp({ ENTERPRISE_MODE: 'active' });
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No Agent' }),
    });
    expect(res.status).toBe(201);
  });

  // ── AC3: flag-off regression — all seven accepted ──
  it.each(['claude-code', 'codex', 'copilot', 'antigravity', 'opencode', 'pi', 'bash'])(
    "flag-off: agentType '%s' is accepted 201 when ENTERPRISE_MODE unset",
    async (agentType) => {
      const app = createApp();
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Session ${agentType}`, agentType }),
      });
      expect(res.status, `agentType "${agentType}" should be accepted`).toBe(201);
    },
  );
});
