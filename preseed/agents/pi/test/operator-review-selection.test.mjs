import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const extensions = new URL('../extensions/', import.meta.url);
// Resolve the real extension's relative TypeScript imports in native Node, as Pi does.
const imports = new Map([
  ['./review-enforcement', 'review-enforcement.ts'],
  ['./operator-review-remote', 'operator-review-remote.ts'],
  ['./active-repo-memory', 'active-repo-memory.ts'],
  ['./graphify-helpers', 'graphify-helpers.ts'],
  ['./review-helpers', 'review-helpers.ts'],
  ['./guard-helpers', 'guard-helpers.ts'],
  ['./guard-helpers.js', 'guard-helpers.ts'],
  ['./capability-helpers', 'capability-helpers.ts'],
  ['./review-completion-state', 'review-completion-state.ts'],
  ['./review-scope', 'review-scope.ts'],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const target = context.parentURL?.startsWith(extensions.href) && imports.get(specifier);
    return nextResolve(target ? new URL(target, extensions).href : specifier, context);
  },
});
let registerOperatorReviewSelector, selectOperatorReviewApplicability;
try {
  ({ registerOperatorReviewSelector, selectOperatorReviewApplicability } =
    await import(new URL('operator-review-selector.ts', extensions).href));
} finally {
  hooks.deregister();
}

const head = 'a'.repeat(40);
const push = { toolName: 'bash', input: { command: 'git push origin feature' } };
const unavailable = {
  customType: 'pr-boundary-remote-unavailable',
  content: 'Review applicability is unavailable. Neither local nor remote Review can clear this boundary.',
  display: true,
};
function wire(mode, body = { number: 42, head: { sha: head } }) {
  return `HTTP/2 200\r\nx-codeflare-operator-boundary-selection: ${mode}\r\n\r\n${JSON.stringify(body)}`;
}

function fixture(t, enrollment = 'remote-candidate', target = 'owner/repo', local = {}) {
  const previous = Object.fromEntries(['ENTERPRISE_MODE', 'GH_REPO', 'GH_HOST'].map(key => [key, process.env[key]]));
  process.env.ENTERPRISE_MODE = 'active';
  delete process.env.GH_REPO;
  delete process.env.GH_HOST;
  const root = mkdtempSync(join(tmpdir(), 'operator-review-selection-'));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const responses = new Map();
  const repo = (name, response) => {
    const cwd = join(root, name);
    mkdirSync(join(cwd, '.git'), { recursive: true });
    mkdirSync(join(cwd, 'sdd'));
    writeFileSync(join(cwd, 'sdd/README.md'), '# Requirements\n');
    responses.set(cwd, response);
    return cwd;
  };
  // Only external gh I/O is simulated. No workflow filenames are inspected or inferred.
  const runner = async (program, args, { cwd }) => {
    if (program === 'git') {
      if (args[0] === 'config') return { stdout: local.resolved ?? (target === 'owner/repo' ? '' : `remote.origin.gh-resolved ${target}`) };
      if (args[1] === '-v') return { stdout: local.remotes ?? 'origin\thttps://github.com/owner/repo.git (fetch)\n' };
      return { stdout: 'https://github.com/owner/repo.git' };
    }
    assert.equal(program, 'gh');
    const response = responses.get(cwd);
    if (response instanceof Error) throw response;
    if (args[0] === 'pr') return { stdout: JSON.stringify({ number: 42, state: 'OPEN',
      baseRefName: 'main', headRefOid: head, url: `https://github.com/${local.prRepository ?? target}/pull/42` }) };
    if (args[0] === 'repo') return { stdout: JSON.stringify({ nameWithOwner: target,
      url: `https://github.com/${target}` }) };
    if (args[0] === 'api' && !args.includes('--include')) return { stdout: '138' };
    // Intentional wire contract: applicability is a read-only exact-head check, not a launch.
    assert.deepEqual(args, ['api', '--hostname', 'github.com', '--include', '-H', 'x-codeflare-operator-boundary-select: check',
      '-H', `x-codeflare-operator-boundary-input: ${Buffer.from(JSON.stringify({
        repositoryId: 138, pullRequest: 42, acknowledgedHead: null, targetHead: head,
        payload: { range: null, rejectedFindingsStatus: 'unavailable' },
      })).toString('base64')}`, `repos/${target}/pulls/42`]);
    return { stdout: response };
  };
  const handlers = new Map();
  const messages = [];
  let remoteActive = false;
  const pi = {
    on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); },
    sendMessage: message => messages.push(message),
  };
  // Probe the public handler boundary; selector and applicability remain the real implementation.
  const route = mode => api => {
    for (const name of ['session_start', 'tool_call', 'tool_result']) {
      api.on(name, (_event, ctx) => {
        if (mode === 'remote' && name === 'session_start') remoteActive = true;
        api.sendMessage({ customType: `${mode}-${name}`, cwd: ctx.cwd });
      });
    }
    if (mode === 'remote') api.on('session_shutdown', () => {
      remoteActive = false;
      api.sendMessage({ customType: 'remote-stopped' });
    });
  };
  const readEnrollment = async repository => typeof enrollment === 'function' ? enrollment(repository) : enrollment;
  registerOperatorReviewSelector(pi, {
    local: route('local'), remote: route('remote'),
    applicability: (event, ctx) => selectOperatorReviewApplicability(event, ctx, runner, readEnrollment),
  });
  const context = cwd => ({ cwd, sessionManager: { getBranch: () => [] } });
  return {
    repo, messages, remoteActive: () => remoteActive,
    select: cwd => selectOperatorReviewApplicability(push, context(cwd), runner, readEnrollment),
    emit: (name, cwd, event = {}) => handlers.get(name)({ type: name, ...push, ...event }, context(cwd)),
  };
}

// Absent and inactive enrollment share the parent's authoritative local wire verdict.
// These client tests do not claim to perform the parent's enrollment/authority discovery.
for (const enrollment of ['absent', 'inactive']) {
  test(`REQ-OPERATOR-053: confirmed ${enrollment} Action selects only local Review handlers`, async t => {
    const app = fixture(t);
    const cwd = app.repo(enrollment, wire('local'));
    assert.equal(await app.select(cwd), 'local');
    for (const name of ['session_start', 'tool_call', 'tool_result']) await app.emit(name, cwd);
    assert.deepEqual(app.messages, [
      { customType: 'local-session_start', cwd },
      { customType: 'local-tool_call', cwd },
      { customType: 'local-tool_result', cwd },
    ]);
    assert.equal(app.remoteActive(), false);
  });
}

test('REQ-OPERATOR-053: confirmed active Action selects only remote Review handlers', async t => {
  const app = fixture(t);
  const cwd = app.repo('active', wire('remote'));
  assert.equal(await app.select(cwd), 'remote');
  for (const name of ['session_start', 'tool_call', 'tool_result']) await app.emit(name, cwd);
  assert.deepEqual(app.messages, [
    { customType: 'remote-session_start', cwd },
    { customType: 'remote-tool_call', cwd },
    { customType: 'remote-tool_result', cwd },
  ]);
  assert.equal(app.remoteActive(), true);
  await app.emit('session_shutdown', cwd);
  assert.equal(app.remoteActive(), false);
});

for (const [reason, response] of [
  ['unavailable verdict', wire('unavailable')],
  ['missing verdict', `HTTP/2 200\n\n${JSON.stringify({ number: 42, head: { sha: head } })}`],
  ['duplicate verdict', wire('local').replace('\r\n\r\n', '\r\nx-codeflare-operator-boundary-selection: local\r\n\r\n')],
  ['conflicting verdicts', wire('remote').replace('\r\n\r\n', '\r\nx-codeflare-operator-boundary-selection: local\r\n\r\n')],
  ['malformed JSON', 'HTTP/2 200\nx-codeflare-operator-boundary-selection: local\n\n{invalid'],
  ['malformed HTTP status', wire('local').replace('HTTP/2 200', 'HTTP/2 503')],
  ['mismatched head', wire('local', { number: 42, head: { sha: 'b'.repeat(40) } })],
  ['mismatched PR', wire('remote', { number: 43, head: { sha: head } })],
  ['transport failure', new Error('GitHub unavailable')],
]) {
  test(`REQ-OPERATOR-053: ${reason} permits neither local nor remote clearance`, async t => {
    const app = fixture(t);
    const cwd = app.repo('uncertain', response);
    assert.equal(await app.select(cwd), 'unavailable');
    for (const name of ['session_start', 'tool_call', 'tool_result']) await app.emit(name, cwd);
    assert.deepEqual(app.messages, [unavailable]);
    assert.equal(app.remoteActive(), false);
  });
}

test('REQ-OPERATOR-053: repository transitions stop remote Review and never retain a prior route', async t => {
  const app = fixture(t);
  const remote = app.repo('remote', wire('remote'));
  const local = app.repo('local', wire('local'));
  const uncertain = app.repo('uncertain', wire('unavailable'));
  await app.emit('session_start', remote);
  await app.emit('tool_result', remote);
  assert.equal(app.remoteActive(), true);
  assert.deepEqual(app.messages.splice(0), [
    { customType: 'remote-session_start', cwd: remote },
    { customType: 'remote-tool_result', cwd: remote },
  ]);

  await app.emit('tool_call', local);
  await app.emit('tool_result', local);
  assert.equal(app.remoteActive(), false);
  assert.deepEqual(app.messages.splice(0), [
    { customType: 'remote-stopped' },
    { customType: 'local-tool_call', cwd: local },
    { customType: 'local-tool_result', cwd: local },
  ]);

  await app.emit('tool_call', uncertain);
  await app.emit('tool_result', uncertain);
  assert.equal(app.remoteActive(), false);
  assert.deepEqual(app.messages.splice(0), [unavailable]);

  await app.emit('tool_result', remote);
  assert.equal(app.remoteActive(), true);
  assert.deepEqual(app.messages.splice(0), [
    { customType: 'remote-session_start', cwd: remote },
    { customType: 'remote-tool_result', cwd: remote },
  ]);
  await app.emit('tool_result', uncertain);
  await app.emit('agent_settled', uncertain);
  assert.equal(app.remoteActive(), false);
  assert.deepEqual(app.messages, [{ customType: 'remote-stopped' }, unavailable]);
});

for (const enrollment of ['absent', 'disabled', 'other repository']) {
  test(`REQ-OPERATOR-053: ${enrollment} enrollment selects local before unavailable GitHub discovery`, async t => {
    const app = fixture(t, 'local');
    const cwd = app.repo(enrollment, new Error('GitHub discovery is unavailable'));
    assert.equal(await app.select(cwd), 'local');
    await app.emit('session_start', cwd);
    assert.deepEqual(app.messages, [{ customType: 'local-session_start', cwd }]);
  });
}

test('REQ-OPERATOR-053: unavailable enrollment cannot silently select local', async t => {
  const app = fixture(t, 'unavailable');
  const cwd = app.repo('unknown-enrollment', wire('local'));
  assert.equal(await app.select(cwd), 'unavailable');
});

test('REQ-OPERATOR-053: an enrolled upstream PR cannot inherit local selection from its unenrolled origin', async t => {
  const app = fixture(t, repository => repository === 'upstream/repo' ? 'remote-candidate' : 'local', 'upstream/repo');
  const cwd = app.repo('fork', wire('remote'));
  assert.equal(await app.select(cwd), 'remote');
  await app.emit('session_start', cwd);
  assert.deepEqual(app.messages, [{ customType: 'remote-session_start', cwd }]);
});

test('REQ-OPERATOR-053: an unenrolled configured PR target stays local even when origin is enrolled', async t => {
  const app = fixture(t, repository => repository === 'owner/repo' ? 'remote-candidate' : 'local', 'upstream/repo');
  const cwd = app.repo('configured-target', new Error('GitHub discovery is unavailable'));
  assert.equal(await app.select(cwd), 'local');
  await app.emit('session_start', cwd);
  assert.deepEqual(app.messages, [{ customType: 'local-session_start', cwd }]);
});

test('REQ-OPERATOR-053: unavailable target enrollment cannot inherit a local origin verdict', async t => {
  const app = fixture(t, repository => repository === 'upstream/repo' ? 'unavailable' : 'local', 'upstream/repo');
  const cwd = app.repo('unknown-target', wire('local'));
  assert.equal(await app.select(cwd), 'unavailable');
});

test('REQ-OPERATOR-053: malformed configured PR target cannot inherit a local origin verdict', async t => {
  const app = fixture(t, 'local', 'invalid-target');
  const cwd = app.repo('malformed-target', wire('local'));
  assert.equal(await app.select(cwd), 'unavailable');
});

test('REQ-OPERATOR-053: upstream remote priority selects its enrollment without a configured default', async t => {
  const app = fixture(t, repository => repository === 'upstream/repo' ? 'remote-candidate' : 'local', 'upstream/repo', {
    resolved: '', remotes: 'origin\thttps://github.com/owner/repo.git (fetch)\nupstream\thttps://github.com/upstream/repo.git (fetch)\n',
  });
  assert.equal(await app.select(app.repo('upstream-priority', wire('remote'))), 'remote');
});

test('REQ-OPERATOR-053: explicit GH_REPO selects enrollment before unavailable GitHub discovery', async t => {
  const app = fixture(t, repository => repository === 'upstream/repo' ? 'local' : 'remote-candidate', 'upstream/repo', { resolved: '' });
  process.env.GH_REPO = 'github.com/upstream/repo';
  assert.equal(await app.select(app.repo('environment-target', new Error('GitHub unavailable'))), 'local');
});

test('REQ-OPERATOR-053: conflicting custom remotes cannot prove a local target', async t => {
  const app = fixture(t, 'local', 'owner/repo', {
    remotes: 'first\thttps://github.com/owner/repo.git (fetch)\nsecond\thttps://github.com/other/repo.git (fetch)\n',
  });
  assert.equal(await app.select(app.repo('ambiguous-target', wire('local'))), 'unavailable');
});

test('REQ-OPERATOR-053: a mismatched PR base repository cannot reuse candidate enrollment', async t => {
  const app = fixture(t, 'remote-candidate', 'owner/repo', { prRepository: 'other/repo' });
  assert.equal(await app.select(app.repo('mismatched-pr', wire('remote'))), 'unavailable');
});

test('REQ-OPERATOR-053: a mismatched GH_HOST cannot borrow public GitHub enrollment', async t => {
  const app = fixture(t, 'local');
  process.env.GH_HOST = 'github.example.test';
  assert.equal(await app.select(app.repo('wrong-host', wire('local'))), 'unavailable');
});

for (const [name, failure] of [
  ['outer failure', { isError: true }],
  ['nested failure', { result: { isError: true } }],
]) {
  for (const command of ['git push origin feature', 'gh pr create', 'gh pr reopen 42']) {
    test(`REQ-AGENT-036: ${name} from ${command} creates no review boundary`, async t => {
      const app = fixture(t);
      const cwd = app.repo('failed-transition', wire('unavailable'));
      await app.emit('tool_call', cwd, { input: { command } });
      await app.emit('tool_result', cwd, { input: { command }, ...failure });
      assert.deepEqual(app.messages, []);
      assert.equal(app.remoteActive(), false);
    });
  }
}
