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

function fixture(t) {
  const previous = process.env.ENTERPRISE_MODE;
  process.env.ENTERPRISE_MODE = 'active';
  const root = mkdtempSync(join(tmpdir(), 'operator-review-selection-'));
  t.after(() => {
    if (previous === undefined) delete process.env.ENTERPRISE_MODE;
    else process.env.ENTERPRISE_MODE = previous;
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
    assert.equal(program, 'gh');
    if (args[0] === 'pr') return { stdout: JSON.stringify({ number: 42, state: 'OPEN',
      baseRefName: 'main', headRefOid: head }) };
    if (args[0] === 'repo') return { stdout: JSON.stringify({ nameWithOwner: 'owner/repo',
      url: 'https://github.com/owner/repo' }) };
    if (args.join(' ') === 'api repos/{owner}/{repo} --jq .id') return { stdout: '138' };
    // Intentional wire contract: applicability is a read-only exact-head check, not a launch.
    assert.deepEqual(args, ['api', '--include', '-H', 'x-codeflare-operator-boundary-select: check',
      '-H', `x-codeflare-operator-boundary-input: ${Buffer.from(JSON.stringify({
        repositoryId: 138, pullRequest: 42, acknowledgedHead: null, targetHead: head,
        payload: { range: null, rejectedFindingsStatus: 'unavailable' },
      })).toString('base64')}`, 'repos/owner/repo/pulls/42']);
    const response = responses.get(cwd);
    if (response instanceof Error) throw response;
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
  registerOperatorReviewSelector(pi, {
    local: route('local'), remote: route('remote'),
    applicability: (event, ctx) => selectOperatorReviewApplicability(event, ctx, runner),
  });
  const context = cwd => ({ cwd, sessionManager: { getBranch: () => [] } });
  return {
    repo, messages, remoteActive: () => remoteActive,
    select: cwd => selectOperatorReviewApplicability(push, context(cwd), runner),
    emit: (name, cwd) => handlers.get(name)({ type: name, ...push }, context(cwd)),
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
