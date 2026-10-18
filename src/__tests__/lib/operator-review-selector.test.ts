import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerOperatorReviewSelector, selectOperatorReviewApplicability } from '../../../preseed/agents/pi/extensions/operator-review-selector';

afterEach(() => vi.unstubAllEnvs());

type Mode = 'local' | 'remote' | 'unavailable' | 'none';
function harness(verdicts: Record<string, Mode>, applicability?: (event: any, ctx: any) => Promise<Mode>) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void> | void>>();
  const messages: string[] = [];
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
      handlers.set(event, [...handlers.get(event) ?? [], handler]);
      return () => { handlers.set(event, (handlers.get(event) ?? []).filter(item => item !== handler)); };
    },
    sendMessage: (message: { customType: string }) => { messages.push(message.customType); },
  };
  registerOperatorReviewSelector(pi as never, {
    local: (reviewPi: typeof pi) => {
      reviewPi.on('session_start', () => { messages.push('local-start'); });
      reviewPi.on('tool_call', () => { messages.push('local-call'); });
      reviewPi.on('tool_result', () => { messages.push('local-result'); });
    },
    remote: (reviewPi: typeof pi) => {
      reviewPi.on('session_start', () => { messages.push('remote-start'); });
      reviewPi.on('tool_call', () => { messages.push('remote-call'); });
      reviewPi.on('tool_result', () => { messages.push('remote-result'); });
    },
    applicability: applicability ?? (async (_event: unknown, ctx: { target: string }) => verdicts[ctx.target] ?? 'unavailable'),
  });
  return { messages, emit: async (type: string, target: string, event: Record<string, unknown> = {}) => {
    for (const handler of handlers.get(type) ?? []) await handler({ type, toolName: 'bash', input: { command: 'git push' }, ...event },
      { cwd: target, target, sessionManager: { getBranch: () => [] } });
  } };
}

describe('REQ-OPERATOR-053: exclusive local versus dedicated remote Review extensions', () => {
  it('REQ-OPERATOR-053 AC1: non-enterprise boundaries keep local Review', async () => {
    vi.stubEnv('ENTERPRISE_MODE', '');
    expect(await selectOperatorReviewApplicability({ toolName: 'bash', input: { command: 'git push origin feature' } },
      { cwd: '/non-enterprise' })).toBe('local');
  });
  it('trusts only a parent-verified exact PR selection, and treats broken/ambiguous response as unavailable', async () => {
    vi.stubEnv('ENTERPRISE_MODE', 'active');
    const repo = mkdtempSync(join(tmpdir(), 'operator-review-target-'));
    try {
      mkdirSync(join(repo, '.git'));
      mkdirSync(join(repo, 'sdd'));
      writeFileSync(join(repo, 'sdd/README.md'), 'requirements');
      const head = 'a'.repeat(40);
      const event = { toolName: 'bash', input: { command: 'git push origin feature' } };
      const ctx = { cwd: repo };
      const runner = (mode: string, responseHead = head, repeatHeader = false) =>
        (async (_program: string, args: string[]) => {
          if (args[0] === 'pr') return { stdout: JSON.stringify({ number: 42, state: 'OPEN',
            baseRefName: 'main', headRefOid: head }) };
          if (args[0] === 'repo') return { stdout: JSON.stringify({ nameWithOwner: 'owner/repo',
            url: 'https://github.com/owner/repo' }) };
          if (!args.includes('--include')) return { stdout: '138' };
          const header = `x-codeflare-operator-boundary-selection: ${mode}`;
          return { stdout: `HTTP/2 200\n${header}${repeatHeader ? `\n${header}` : ''}\n\n`
            + JSON.stringify({ number: 42, head: { sha: responseHead } }) };
        }) as never;
      expect(await selectOperatorReviewApplicability(event, ctx, runner('remote'))).toBe('remote');
      expect(await selectOperatorReviewApplicability(event, ctx, runner('local'))).toBe('local');
      expect(await selectOperatorReviewApplicability(event, ctx, runner('remote', head, true))).toBe('unavailable');
      expect(await selectOperatorReviewApplicability(event, ctx, runner('remote', 'b'.repeat(40)))).toBe('unavailable');
      expect(await selectOperatorReviewApplicability(event, ctx, runner('unavailable'))).toBe('unavailable');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
  it.each(['git clone https://github.com/owner/target.git copied', 'gh repo clone owner/target copied',
    'git clone --branch develop https://github.com/owner/target.git']) (
    'REQ-AGENT-169: clone selection uses the produced checkout outside and inside another repository: %s', async command => {
      vi.stubEnv('ENTERPRISE_MODE', 'active');
      const workspace = mkdtempSync(join(tmpdir(), 'review-clone-'));
      try {
        const parent = join(workspace, 'parent');
        mkdirSync(join(parent, '.git'), { recursive: true });
        mkdirSync(join(parent, 'sdd')); writeFileSync(join(parent, 'sdd/README.md'), 'parent');
        for (const cwd of [workspace, parent]) {
          const target = join(cwd, command.endsWith(' copied') ? 'copied' : 'target');
          const head = 'a'.repeat(40);
          const runner = (async (_program: string, args: string[], options: { cwd: string }) => {
            // The external GitHub responses differ by checkout; selecting the parent
            // would choose remote Review rather than the target's local consent path.
            if (args[0] === 'pr') return { stdout: JSON.stringify({ number: 42, state: 'OPEN', baseRefName: 'main', headRefOid: head }) };
            if (args[0] === 'repo') return { stdout: JSON.stringify({ nameWithOwner: 'owner/target', url: 'https://github.com/owner/target' }) };
            if (!args.includes('--include')) return { stdout: '138' };
            return { stdout: `HTTP/2 200\nx-codeflare-operator-boundary-selection: ${options.cwd === target ? 'local' : 'remote'}\n\n`
              + JSON.stringify({ number: 42, head: { sha: head } }) };
          }) as never;
          const app = harness({}, (event, ctx) => selectOperatorReviewApplicability(event, ctx, runner));
          const event = { toolCallId: 'clone-target', input: { command } };
          await app.emit('tool_call', cwd, event);
          mkdirSync(join(target, '.git'), { recursive: true });
          mkdirSync(join(target, 'sdd')); writeFileSync(join(target, 'sdd/README.md'), 'target');
          await app.emit('tool_result', cwd, { ...event, result: { content: [{ type: 'text', text: `Cloning into '${target}'...` }] } });
          expect(app.messages).toEqual(['local-result']);
        }
      } finally { rmSync(workspace, { recursive: true, force: true }); }
    });

  it('REQ-AGENT-171: failed clones are inert even when the invocation directory has an eligible Review', async () => {
    const app = harness({ '/remote': 'remote' });
    const event = { toolCallId: 'failed-clone', input: { command: 'git clone https://github.com/owner/target.git' } };
    await app.emit('tool_call', '/remote', event);
    await app.emit('tool_result', '/remote', { ...event, isError: true });
    expect(app.messages).toEqual([]);
  });

  it('REQ-OPERATOR-053: a reported successful clone with an unresolved checkout stays unavailable', async () => {
    vi.stubEnv('ENTERPRISE_MODE', 'active');
    const workspace = mkdtempSync(join(tmpdir(), 'review-unresolved-clone-'));
    try {
      const app = harness({}, (event, ctx) => selectOperatorReviewApplicability(event, ctx));
      await app.emit('tool_result', workspace, { toolCallId: 'unresolved-clone',
        input: { command: 'git clone https://github.com/owner/target.git missing' } });
      expect(app.messages).toEqual(['pr-boundary-remote-unavailable']);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it.each(['non-sdd', 'no-pr', 'closed', 'unprotected', 'transport', 'malformed', 'malformed-base']) (
    'REQ-OPERATOR-053: distinguishes confirmed non-candidates from unavailable applicability: %s', async state => {
      vi.stubEnv('ENTERPRISE_MODE', 'active');
      const repo = mkdtempSync(join(tmpdir(), 'review-applicability-'));
      try {
        mkdirSync(join(repo, '.git'));
        if (state !== 'non-sdd') { mkdirSync(join(repo, 'sdd')); writeFileSync(join(repo, 'sdd/README.md'), 'requirements'); }
        const runner = (async () => {
          if (state === 'no-pr') throw Object.assign(new Error('no PR'), { stderr: 'no pull requests found for branch main' });
          if (state === 'transport' || state === 'non-sdd') throw new Error('Network unavailable');
          return { stdout: state === 'malformed' ? '{invalid' : JSON.stringify({ number: 42,
            state: state === 'closed' ? 'CLOSED' : 'OPEN', baseRefName: state === 'malformed-base' ? '' : state === 'unprotected' ? 'sandbox' : 'main', headRefOid: 'a'.repeat(40) }) };
        }) as never;
        const app = harness({}, (event, ctx) => selectOperatorReviewApplicability(event, ctx, runner));
        await app.emit('session_start', repo);
        expect(app.messages).toEqual(['transport', 'malformed', 'malformed-base'].includes(state) ? ['pr-boundary-remote-unavailable'] : []);
      } finally { rmSync(repo, { recursive: true, force: true }); }
    });

  it('runs only dedicated remote handlers for an authenticated applicable Action', async () => {
    const app = harness({ '/remote': 'remote' });
    await app.emit('session_start', '/remote');
    await app.emit('tool_call', '/remote');
    await app.emit('tool_result', '/remote');
    expect(app.messages).toEqual(['remote-start', 'remote-call', 'remote-result']);
  });
  it('retains unchanged local behavior only for confirmed absence or inactive enrollment', async () => {
    const app = harness({ '/local': 'local' });
    await app.emit('session_start', '/local');
    await app.emit('tool_call', '/local');
    await app.emit('tool_result', '/local');
    expect(app.messages).toEqual(['local-start', 'local-call', 'local-result']);
  });
  it('never falls back to local or runs both paths for a broken or ambiguous active Action', async () => {
    const app = harness({ '/uncertain': 'unavailable' });
    await app.emit('session_start', '/uncertain');
    await app.emit('tool_call', '/uncertain');
    await app.emit('tool_result', '/uncertain');
    expect(app.messages).not.toContain('local-result');
    expect(app.messages).not.toContain('remote-result');
    expect(app.messages).toContain('pr-boundary-remote-unavailable');
  });
  it('stops the remote lifecycle before selecting local or unavailable in the same Pi session', async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const messages: string[] = [];
    const pi = { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler); return () => handlers.delete(event);
    }, sendMessage: (message: { customType: string }) => { messages.push(message.customType); } };
    let active = false;
    registerOperatorReviewSelector(pi as never, {
      applicability: async (_event, ctx: { target: string }) => ctx.target === '/remote'
        ? 'remote' : ctx.target === '/local' ? 'local' : 'unavailable',
      local: (reviewPi: typeof pi) => { reviewPi.on('tool_result', () => {
        messages.push('local-boundary');
      }); },
      remote: (reviewPi: typeof pi) => {
        reviewPi.on('session_start', () => { active = true; });
        reviewPi.on('session_shutdown', () => { active = false; });
        reviewPi.on('tool_result', () => { if (active) messages.push('remote-boundary'); });
      },
    });
    const emit = async (target: string) => handlers.get('tool_result')?.(
      { toolName: 'bash', input: { command: 'git push origin feature' } }, { cwd: target, target });
    await emit('/remote');
    await emit('/local');
    await emit('/remote');
    await emit('/uncertain');
    expect(messages).toEqual(['remote-boundary', 'local-boundary', 'remote-boundary',
      'pr-boundary-remote-unavailable']);
    expect(active).toBe(false);
  });

  it('discards an older asynchronous applicability answer after a newer boundary selects another path', async () => {
    let release: (mode: Mode) => void = () => {};
    const old = new Promise<Mode>(resolve => { release = resolve; });
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const messages: string[] = [];
    const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler); return () => handlers.delete(name);
    }, sendMessage: (message: { customType: string }) => { messages.push(message.customType); } };
    let entered: () => void = () => {};
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    registerOperatorReviewSelector(pi as never, { local: (api: typeof pi) => {
      api.on('tool_result', () => { messages.push('local-result'); });
    }, remote: (api: typeof pi) => {
      api.on('tool_result', () => { messages.push('remote-result'); });
    }, applicability: async (_event, ctx: { target: string }) => {
      if (ctx.target === '/old') { entered(); return old; }
      return 'local';
    } });
    const event = { toolName: 'bash', input: { command: 'git push origin feature' } };
    const first = handlers.get('tool_result')?.(event, { cwd: '/old', target: '/old' });
    await waiting;
    await handlers.get('tool_result')?.(event, { cwd: '/new', target: '/new' });
    release('remote');
    await first;
    expect(messages).toEqual(['local-result']);
  });

  it('does not dispatch an old remote boundary after its startup overlaps a local transition', async () => {
    let release: () => void = () => {};
    const startup = new Promise<void>(resolve => { release = resolve; });
    let entered: () => void = () => {};
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const messages: string[] = [];
    const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler); return () => handlers.delete(name);
    }, sendMessage: (message: { customType: string }) => { messages.push(message.customType); } };
    registerOperatorReviewSelector(pi as never, {
      applicability: async (_event, ctx: { target: string }) => ctx.target === '/remote' ? 'remote' : 'local',
      local: (api: typeof pi) => { api.on('tool_result', () => { messages.push('local-result'); }); },
      remote: (api: typeof pi) => {
        api.on('session_start', async () => { entered(); await startup; });
        api.on('session_shutdown', () => { messages.push('remote-cancelled'); });
        api.on('tool_result', () => { messages.push('remote-result'); });
      },
    });
    const event = { toolName: 'bash', input: { command: 'git push origin feature' } };
    const first = handlers.get('tool_result')?.(event, { cwd: '/remote', target: '/remote' });
    await waiting;
    await handlers.get('tool_result')?.(event, { cwd: '/local', target: '/local' });
    release();
    await first;
    expect(messages).toEqual(['remote-cancelled', 'local-result']);
  });

  it('switches repositories in one Pi session without delivering the switched boundary to the prior path', async () => {
    const app = harness({ '/local': 'local', '/remote': 'remote', '/uncertain': 'unavailable' });
    await app.emit('session_start', '/local');
    await app.emit('tool_call', '/remote');
    await app.emit('tool_result', '/remote');
    await app.emit('tool_call', '/uncertain');
    await app.emit('tool_result', '/uncertain');
    await app.emit('tool_call', '/local');
    await app.emit('tool_result', '/local');
    expect(app.messages.filter(item => item.endsWith('-result'))).toEqual(['remote-result', 'local-result']);
    expect(app.messages.filter(item => item.endsWith('-call'))).toEqual(['remote-call', 'local-call']);
  });
});
