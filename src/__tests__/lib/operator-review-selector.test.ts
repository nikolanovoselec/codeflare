import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerOperatorReviewSelector, selectOperatorReviewApplicability } from '../../../preseed/agents/pi/extensions/operator-review-selector';
import { registerReviewEnforcement, queryBranch, queryHead, queryPr, queryRepository } from '../../../preseed/agents/pi/extensions/review-enforcement';
import { currentOperatorBoundary, registerOperatorReviewRemote, selectOperatorBoundary } from '../../../preseed/agents/pi/extensions/operator-review-remote';
import { readCompletion, writeCompletion } from '../../../preseed/agents/pi/extensions/review-completion-state';

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

// Compose the real consent owner and remote lifecycle. Only Git/GitHub I/O
// is simulated; dialogs, staging payloads, plans and exact markers are observed.
function cloneConsentFixture() {
  const home = mkdtempSync(join(tmpdir(), 'remote-clone-consent-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('SESSION_MODE', 'advanced');
  vi.stubEnv('ENTERPRISE_MODE', 'active');
  const parent = join(home, 'parent');
  mkdirSync(join(parent, '.git'), { recursive: true });
  const target = join(parent, 'copied');
  const sessionFile = join(home, 'root.jsonl');
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'root', cwd: parent }) + '\n');
  const identity = { gitHost: 'github.com', repository: 'owner/target', pr: 42,
    branch: 'feature', base: 'main' as const, head: 'a'.repeat(40) };
  let activeSessionFile = sessionFile;
  const state = { head: identity.head, repository: identity.repository, choice: undefined as string | undefined,
    beforePr: undefined as (() => Promise<void>) | undefined,
    select: undefined as (() => Promise<string | undefined>) | undefined, unavailable: false, published: false,
    admitted: true, findings: [] as Array<{ id: string; message: string; evidence: string }> };
  const staged: Array<{ cwd: string; targetHead: string; pullRequest: number }> = [];
  const runner = (async (program: string, args: string[], options: { cwd: string }) => {
    if (program === 'git') {
      if (args[0] === 'symbolic-ref') return { stdout: 'feature' };
      if (args[0] === 'rev-parse') return { stdout: state.head };
      if (args[0] === 'remote') return { stdout: `git@github.com:${options.cwd === target ? state.repository : 'owner/parent'}.git` };
      if (args[0] === 'config') return { stdout: 'origin' };
      throw new Error(`Unexpected Git request: ${args.join(' ')}`);
    }
    if (args[0] === 'repo') {
      const repository = options.cwd === target ? state.repository : 'owner/parent';
      return { stdout: JSON.stringify({ nameWithOwner: repository, url: `https://github.com/${repository}` }) };
    }
    if (args[0] === 'pr') {
      await state.beforePr?.();
      return { stdout: JSON.stringify({ number: 42, state: 'OPEN', baseRefName: 'main',
        headRefName: 'feature', headRefOid: state.head }) };
    }
    if (!args.includes('--include')) return { stdout: '138' };
    const mutating = args.includes('x-codeflare-operator-boundary-select: 1');
    const header = args.find(arg => arg.startsWith('x-codeflare-operator-boundary-input: '))!;
    if (mutating) staged.push({ cwd: options.cwd,
      ...JSON.parse(Buffer.from(header.split(': ')[1]!, 'base64').toString()) });
    return { stdout: `HTTP/2 200\nx-codeflare-operator-boundary-selection: ${state.unavailable && mutating ? 'unavailable' : 'remote'}\n`
      + (state.admitted ? 'x-codeflare-operator-boundary-activity: clone-activity\n' : '') + '\n'
      + JSON.stringify({ number: 42, head: { sha: state.head } }) };
  }) as never;
  const entries: any[] = [], messages: any[] = [], prompts: Array<{ options: string[] }> = [];
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const pi = { on: (name: string, handler: (event: any, ctx: any) => unknown) => {
    handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {};
  }, events: { emit() {} }, getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
  appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }),
  sendMessage: (message: any) => { messages.push(message); entries.push({ type: 'custom_message', ...message }); } };
  const ctx = { cwd: parent, hasUI: true, sessionManager: { getSessionFile: () => activeSessionFile,
    getHeader: () => ({}), getEntries: () => entries, getBranch: () => entries },
    ui: { select: async (_title: string, options: string[]) => {
      prompts.push({ options }); return state.select ? state.select() : state.choice;
    }, notify() {} } };
  registerOperatorReviewSelector(pi as never, {
    applicability: (event, context) => selectOperatorReviewApplicability(event, context, runner),
    local: api => registerReviewEnforcement(api, { queryPr: (repo, select) => queryPr(repo, runner, select),
      queryHead: (repo, revision) => queryHead(repo, revision, runner),
      queryBranch: repo => queryBranch(repo, runner), queryRepository: repo => queryRepository(repo, runner) }),
    remote: api => registerOperatorReviewRemote(api, {
      currentBoundary: (event, context) => currentOperatorBoundary(event, context, runner),
      selectBoundary: (boundary, readOnly) => selectOperatorBoundary(boundary, readOnly, runner),
      readPublishedResult: async () => state.published ? { status: 'published', repositoryId: 138,
        pullRequest: 42, activityId: 'clone-activity', head: identity.head, round: 1,
        artifactDigest: 'f'.repeat(64), findings: state.findings } : { status: 'unavailable' },
    }),
  });
  const emit = async (name: string, event: any = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
  };
  const clone = async (command: string, preexists = false, result: Record<string, unknown> = {}) => {
    const event = { toolName: 'bash', toolCallId: `clone-${prompts.length}`,
      input: { command }, result: { content: [{ type: 'text', text: "Cloning into 'copied'..." }] }, ...result };
    const create = () => { mkdirSync(join(target, '.git'), { recursive: true });
      mkdirSync(join(target, 'sdd'), { recursive: true }); writeFileSync(join(target, 'sdd/README.md'), 'requirements'); };
    if (preexists) create();
    await emit('tool_call', event);
    create();
    await emit('tool_result', event);
  };
  return { state, prompts, messages, staged, identity, target, emit, clone,
    reportCi: (reportHead = identity.head) => {
      const callId = `child-ci-${entries.length}`;
      entries.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: callId,
        name: 'subagent', arguments: { subagent_type: 'ci-monitor', run_in_background: true,
          inherit_context: false, prompt: JSON.stringify({ repo: identity.repository, pr: identity.pr,
            head: reportHead, cwd: target }) } }] } });
      entries.push({ type: 'message', message: { role: 'toolResult', toolCallId: callId,
        toolName: 'subagent', isError: false } });
      entries.push({ type: 'custom_message', customType: 'subagent-notification',
        content: `<tool-use-id>${callId}</tool-use-id><status>Done</status>`
          + `<result>CI_RESULT success\npr=${identity.pr} head=${reportHead} repo=${identity.repository}</result>` });
    },
    triage: () => entries.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'text',
      text: '| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |\n'
        + '|---|---|---|---|---|\n'
        + '| child-guard | valid | Preserve guard | minimal | accepted |',
    }] } }),
    moveSession: () => {
      activeSessionFile = join(home, 'other-root.jsonl');
      writeFileSync(activeSessionFile, JSON.stringify({ type: 'session', version: 3, id: 'other-root', cwd: parent }) + '\n');
    },
    status: () => readCompletion(identity).status,
    dispose: async () => { await emit('session_shutdown'); rmSync(home, { recursive: true, force: true }); } };
}

describe('REQ-AGENT-169 / REQ-OPERATOR-053 AC3: remote-selected clone consent', () => {
  it.each(['active', 'pending'] as const)(
    'REQ-AGENT-170 AC1: keeps the child checkout through %s delivery CI and FIX while cwd stays in its Git parent', async initial => {
      vi.useFakeTimers();
      const app = cloneConsentFixture();
      try {
        app.state.choice = 'Launch review';
        app.state.admitted = initial === 'active';
        app.state.findings = [{ id: 'child-guard', message: 'Preserve the child guard', evidence: 'Child checkout evidence' }];
        await app.clone('git clone https://github.com/owner/target.git copied');
        app.state.published = true;
        await app.emit('tool_result', { toolName: 'bash', toolCallId: 'child-push',
          input: { command: 'git -C copied push origin feature' }, result: { isError: false } });
        if (initial === 'pending') {
          app.state.admitted = true;
          await vi.advanceTimersByTimeAsync(30_000);
        }
        const plan = app.messages.filter(message => message.customType === 'pr-boundary-remote-plan').at(-1);
        expect(plan).toBeDefined();
        const request = /ci-monitor for (\{[^\n]+\}) with/.exec(plan?.content ?? '')?.[1];
        expect(request).toBeDefined();
        expect(JSON.parse(request!)).toEqual({ repo: app.identity.repository, pr: 42,
          head: app.identity.head, cwd: app.target });
        await app.emit('agent_settled');
        app.triage(); await app.emit('agent_end');
        expect(app.messages.some(message => message.customType === 'pr-boundary-original-findings')).toBe(false);
        expect(app.messages.some(message => message.customType === 'pr-boundary-fix-follow-up')).toBe(false);
        app.reportCi('b'.repeat(40)); await app.emit('agent_settled');
        expect(app.messages.some(message => message.customType === 'pr-boundary-original-findings')).toBe(false);
        app.reportCi(); await app.emit('agent_settled');
        expect(app.messages.at(-1)).toMatchObject({ customType: 'pr-boundary-original-findings', details: {
          repository: app.identity.repository, pr: 42, head: app.identity.head, findings: app.state.findings,
        } });
        app.triage(); await app.emit('agent_end');
        expect(app.messages.at(-1)?.customType).toBe('pr-boundary-fix-follow-up');
        expect(app.status()).toBe('missing');
      } finally { await app.dispose(); vi.useRealTimers(); }
    });

  const staleConsentCases = ['Launch review', 'Mark review complete'].flatMap(choice =>
    ['shutdown', 'session', 'selection'].flatMap(change =>
      ['dialog', 'identity-refresh'].map(phase => ({ choice, change, phase }))));
  it.each(staleConsentCases)(
    'REQ-AGENT-055 AC2: rejects $choice after $change during $phase', async ({ choice, change, phase }) => {
      const app = cloneConsentFixture();
      try {
        let answer: (value: string) => void = () => {};
        let entered: () => void = () => {};
        const dialog = new Promise<void>(resolve => { entered = resolve; });
        const decision = new Promise<string>(resolve => { answer = resolve; });
        app.state.select = () => { entered(); return decision; };
        const exposure = app.clone('git clone https://github.com/owner/target.git copied');
        await Promise.race([dialog, exposure]);
        expect(app.prompts).toHaveLength(1);
        let release: () => void = () => {};
        if (phase === 'identity-refresh') {
          let refreshing: () => void = () => {};
          const refresh = new Promise<void>(resolve => { refreshing = resolve; });
          const lookup = new Promise<void>(resolve => { release = resolve; });
          app.state.beforePr = () => { refreshing(); return lookup; };
          answer(choice);
          await Promise.race([refresh, exposure]);
        }
        if (change === 'shutdown') await app.emit('session_shutdown');
        if (change === 'session') app.moveSession();
        if (change === 'selection') await app.emit('tool_call', { toolName: 'bash', toolCallId: 'new-clone',
          input: { command: 'git clone https://github.com/owner/other.git other' } });
        if (phase === 'dialog') answer(choice);
        else release();
        await exposure;
        expect(app.staged).toEqual([]);
        expect(app.messages).toEqual([]);
        expect(app.status()).toBe('missing');
      } finally { await app.dispose(); }
    });

  for (const command of ['git clone https://github.com/owner/target.git copied', 'gh repo clone owner/target copied']) {
    it(`asks before staging and launches only remote Review for the produced checkout: ${command}`, async () => {
      const app = cloneConsentFixture();
      try {
        let answer: (choice: string) => void = () => {};
        let entered: () => void = () => {};
        const dialog = new Promise<void>(resolve => { entered = resolve; });
        const choice = new Promise<string>(resolve => { answer = resolve; });
        app.state.select = () => { entered(); return choice; };
        const exposure = app.clone(command);
        // Do not await the dialog alone: the broken implementation returns
        // without showing one. Observe that behavioral failure, not a timeout.
        await Promise.race([dialog, exposure]);
        expect(app.prompts).toEqual([{ options: ['Mark review complete', 'Launch review'] }]);
        expect(app.staged).toEqual([]);
        answer('Launch review');
        await exposure;
        expect(app.staged).toEqual([expect.objectContaining({ cwd: app.target,
          targetHead: app.identity.head, pullRequest: 42 })]);
        expect(app.messages.map(message => message.customType)).toEqual(['pr-boundary-remote-plan']);
        expect(app.messages[0].details).toMatchObject({ repository: 'owner/target', pr: 42, head: app.identity.head });
        expect(app.messages[0].content).not.toContain('ci-monitor');
        app.state.published = true;
        await app.emit('agent_settled');
        expect(app.messages.map(message => message.customType)).toEqual([
          'pr-boundary-remote-plan', 'pr-boundary-original-findings']);
        expect(app.messages[1].details).toMatchObject({ repository: 'owner/target', pr: 42,
          head: app.identity.head, activityId: 'clone-activity', findings: [] });
        expect(app.status()).toBe('missing');
      } finally { await app.dispose(); }
    });
  }
  it.each(['cancel', 'complete', 'saved', 'preexisting', 'failed', 'nested-failed', 'unavailable']) (
    'preserves consent/completion and failure guards: %s', async scenario => {
      const app = cloneConsentFixture();
      try {
        app.state.choice = scenario === 'complete' ? 'Mark review complete' : scenario === 'unavailable' ? 'Launch review' : undefined;
        if (scenario === 'saved') writeCompletion(app.identity);
        app.state.unavailable = scenario === 'unavailable';
        await app.clone('git clone https://github.com/owner/target.git copied', scenario === 'preexisting',
          scenario === 'failed' ? { isError: true } : scenario === 'nested-failed' ? { result: { isError: true } } : {});
        expect(app.prompts.length).toBe(['saved', 'preexisting', 'failed', 'nested-failed'].includes(scenario) ? 0 : 1);
        expect(app.messages.map(message => message.customType)).toEqual(scenario === 'unavailable' ? ['pr-boundary-remote-unavailable'] : []);
        expect(app.staged).toHaveLength(scenario === 'unavailable' ? 1 : 0);
        expect(app.status()).toBe(['complete', 'saved'].includes(scenario) ? 'complete' : 'missing');
      } finally { await app.dispose(); }
    });
  it.each(['head', 'repository', 'shutdown'])('rejects stale clone consent after %s changes', async change => {
    const app = cloneConsentFixture();
    try {
      let answer: (choice: string) => void = () => {};
      let entered: () => void = () => {};
      const dialog = new Promise<void>(resolve => { entered = resolve; });
      const choice = new Promise<string>(resolve => { answer = resolve; });
      app.state.select = () => { entered(); return choice; };
      const exposure = app.clone('git clone https://github.com/owner/target.git copied');
      await Promise.race([dialog, exposure]);
      expect(app.prompts).toHaveLength(1);
      if (change === 'head') app.state.head = 'b'.repeat(40);
      else if (change === 'repository') app.state.repository = 'owner/other';
      else await app.emit('session_shutdown');
      answer('Launch review'); await exposure;
      expect(app.staged).toEqual([]);
      expect(app.messages).toEqual([]);
      expect(app.status()).toBe('missing');
    } finally { await app.dispose(); }
  });
});

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

  it('REQ-AGENT-169 AC1: uncertain cd cannot select a same-name clone checkout in the original directory', async () => {
    vi.stubEnv('ENTERPRISE_MODE', 'active');
    const workspace = mkdtempSync(join(tmpdir(), 'review-uncertain-clone-'));
    try {
      const wrongTarget = join(workspace, 'copied');
      mkdirSync(join(wrongTarget, '.git'), { recursive: true });
      mkdirSync(join(wrongTarget, 'sdd'));
      writeFileSync(join(wrongTarget, 'sdd/README.md'), 'unrelated checkout');
      const head = 'a'.repeat(40);
      const runner = (async (_program: string, args: string[]) => {
        if (args[0] === 'pr') return { stdout: JSON.stringify({ number: 42, state: 'OPEN', baseRefName: 'main', headRefOid: head }) };
        if (args[0] === 'repo') return { stdout: JSON.stringify({ nameWithOwner: 'owner/target', url: 'https://github.com/owner/target' }) };
        if (!args.includes('--include')) return { stdout: '138' };
        return { stdout: 'HTTP/2 200\nx-codeflare-operator-boundary-selection: local\n\n'
          + JSON.stringify({ number: 42, head: { sha: head } }) };
      }) as never;
      const app = harness({}, (event, ctx) => selectOperatorReviewApplicability(event, ctx, runner));
      // The shell may have cloned somewhere else; the same basename here is not evidence.
      await app.emit('tool_result', workspace, { toolCallId: 'uncertain-clone',
        input: { command: 'cd "$CLONE_ROOT"; git clone https://github.com/owner/target.git copied' } });
      expect(app.messages).toEqual(['pr-boundary-remote-unavailable']);
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
