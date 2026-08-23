/**
 * REQ-ENTERPRISE-003: Agent allowlist at session creation.
 *
 * Enterprise deploys cap the selectable universe at the gateway-capable set
 * {copilot, pi, bash} (OpenAI-wire-format agents only; Claude Code is excluded
 * — AD74), and the Setup wizard narrows that further via KV
 * `setup:active_agents` (bash is always selectable). A POST /api/sessions with
 * an agentType outside the resolved set is rejected 400 only when
 * ENTERPRISE_MODE=active. When the flag is unset, all seven agents are accepted
 * exactly as today (the allowlist is a runtime filter, not an enum change — the
 * zod enum still validates all 7).
 *
 * AC1. Enterprise: an agentType outside the capable universe (claude-code/codex/antigravity/opencode) is rejected 400.
 * AC2. Enterprise: each active agent (all capable agents when nothing is stored; the KV subset + bash otherwise) is accepted 201, and a KV-deactivated coding agent is rejected 400.
 * AC3. Enterprise: an omitted agentType is stamped with the first active coding agent.
 * AC5. An absent/malformed/incapable stored selection resolves to the full enterprise set.
 * AC6. flag-off regression: all seven agents are accepted 201 when CODING_AGENTS is unset.
 * AC7. flag-off regression: the stored selection is ignored and nothing is stamped.
 * REQ-AGENT-123. The build-installed CODING_AGENTS set is enforced in every deployment mode; malformed values fail closed to bash.
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

  // ── AC6: flag-off regression — all seven accepted ──
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

  describe('build-installed coding agents', () => {
    it.each(['claude-code', 'codex', 'pi', 'bash'])(
      "REQ-AGENT-123 AC1: installed agentType '%s' is accepted",
      async (agentType) => {
        const app = createApp({ CODING_AGENTS: 'claude-code,codex,pi' });
        const res = await app.request('/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `Session ${agentType}`, agentType }),
        });
        expect(res.status).toBe(201);
      },
    );

    it.each(['copilot', 'antigravity', 'opencode'])(
      "REQ-AGENT-002 AC7: omitted agentType '%s' is rejected",
      async (agentType) => {
        const app = createApp({ CODING_AGENTS: 'claude-code,codex,pi' });
        const res = await app.request('/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `Session ${agentType}`, agentType }),
        });
        expect(res.status).toBe(400);
      },
    );

    it('REQ-AGENT-002 AC5: an omitted agentType falls back to the first installed coding agent', async () => {
      const app = createApp({ CODING_AGENTS: 'codex,pi' });
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Installed default' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { session: { agentType?: string } };
      expect(body.session.agentType).toBe('codex');
    });

    it('REQ-AGENT-123 AC2: malformed configuration fails closed to bash', async () => {
      const app = createApp({ CODING_AGENTS: 'pi,unknown' });
      for (const agentType of ['pi', 'claude-code']) {
        const res = await app.request('/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Rejected', agentType }),
        });
        expect(res.status).toBe(400);
      }
      const bash = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Safe shell', agentType: 'bash' }),
      });
      expect(bash.status).toBe(201);
    });

    it('REQ-AGENT-123 AC1: enterprise and build allowlists are intersected', async () => {
      mockKV._set('setup:active_agents', ['copilot', 'pi']);
      const app = createApp({ ENTERPRISE_MODE: 'active', CODING_AGENTS: 'claude-code,pi' });
      const pi = await app.request('/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Pi', agentType: 'pi' }),
      });
      const copilot = await app.request('/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Copilot', agentType: 'copilot' }),
      });
      expect(pi.status).toBe(201);
      expect(copilot.status).toBe(400);
    });
  });

  // ── Wizard-configured active agents (KV setup:active_agents) ──
  describe('wizard-configured active agents', () => {
    it('AC2: a KV-deactivated coding agent is rejected 400', async () => {
      mockKV._set('setup:active_agents', ['pi']);
      const app = createApp({ ENTERPRISE_MODE: 'active' });
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Deactivated Agent', agentType: 'copilot' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it.each(['pi', 'bash'])(
      "AC2: KV-active agentType '%s' stays accepted 201",
      async (agentType) => {
        mockKV._set('setup:active_agents', ['pi']);
        const app = createApp({ ENTERPRISE_MODE: 'active' });
        const res = await app.request('/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `Session ${agentType}`, agentType }),
        });
        expect(res.status, `agentType "${agentType}" should be accepted`).toBe(201);
      },
    );

    it('AC3: an omitted agentType is stamped with the first active coding agent', async () => {
      mockKV._set('setup:active_agents', ['pi']);
      const app = createApp({ ENTERPRISE_MODE: 'active' });
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'No Agent' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { session: { agentType?: string } };
      expect(body.session.agentType).toBe('pi');
    });

    it('AC3: an omitted agentType is stamped with the first capable agent when nothing is stored', async () => {
      const app = createApp({ ENTERPRISE_MODE: 'active' });
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'No Agent' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { session: { agentType?: string } };
      expect(body.session.agentType).toBe('copilot');
    });

    it('AC5: a malformed stored selection resolves to the full enterprise set', async () => {
      mockKV._store.set('setup:active_agents', 'not-json');
      const app = createApp({ ENTERPRISE_MODE: 'active' });
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Fallback', agentType: 'copilot' }),
      });
      expect(res.status).toBe(201);
    });

    it('AC5: a stored selection with no capable agent resolves to the full enterprise set', async () => {
      mockKV._set('setup:active_agents', ['claude-code']);
      const app = createApp({ ENTERPRISE_MODE: 'active' });
      const copilotRes = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Fallback', agentType: 'copilot' }),
      });
      expect(copilotRes.status).toBe(201);
      // The stored entry itself never widens the universe (AD74).
      const claudeRes = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Still Blocked', agentType: 'claude-code' }),
      });
      expect(claudeRes.status).toBe(400);
    });

    it('AC7: the KV selection is ignored outside enterprise mode', async () => {
      mockKV._set('setup:active_agents', ['pi']);
      const app = createApp();
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Non-enterprise', agentType: 'claude-code' }),
      });
      expect(res.status).toBe(201);
    });

    it('AC7: an omitted agentType is not stamped outside enterprise mode', async () => {
      const app = createApp();
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'No Agent' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { session: { agentType?: string } };
      expect(body.session.agentType).toBeUndefined();
    });
  });
});
