import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../scripts/operator-boundary-action.mjs', import.meta.url));
const preload = fileURLToPath(new URL('../__fixtures__/operator-boundary-cli-fetch.mjs', import.meta.url));
const revision = { repositoryId: 138, pullRequest: 34, head: 'a'.repeat(40), base: 'b'.repeat(40), mergeBase: 'c'.repeat(40) };
const result = { schemaVersion: 1, activityId: 'prepared-activity', activityGeneration: 1, generation: 1,
  repositoryId: 138, pullRequest: 34, head: revision.head, status: 'complete', cleanup: 'stopped' };

async function collect(fault, inspect) {
  const root = await mkdtemp(join(tmpdir(), 'boundary-cli-'));
  try {
    const eventFile = join(root, 'event.json'), fixtureFile = join(root, 'fixture.json');
    const traceFile = join(root, 'trace.json'), transferFile = join(root, 'transfer.json');
    await writeFile(eventFile, JSON.stringify({ repository: { id: 138 }, pull_request: { number: 34,
      head: { sha: fault === 'invalid-revision' ? '../foreign' : revision.head },
      base: { sha: revision.base, ref: 'develop' } } }));
    await writeFile(fixtureFile, JSON.stringify({ fault, revision, result, traceFile, origin: 'https://integration.example.test' }));
    const outcome = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', preload, cli, 'collect'], { env: {
        ...process.env, BOUNDARY_CLI_FIXTURE: fixtureFile, GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_REPOSITORY_ID: '138', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1',
        GITHUB_WORKFLOW_SHA: 'e'.repeat(40), GITHUB_TOKEN: 'fixture-job-token',
        GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_EVENT_PATH: eventFile,
        CODEFLARE_DEV_ORIGIN: 'https://dev.example.test', CODEFLARE_INTEGRATION_ORIGIN: 'https://integration.example.test',
        CODEFLARE_PRODUCTION_ORIGIN: 'https://production.example.test',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-oidc-token',
        REVIEW_TRANSFER_FILE: transferFile,
      }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', value => { stdout += value; });
      child.stderr.on('data', value => { stderr += value; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    const trace = JSON.parse(await readFile(traceFile, 'utf8'));
    let transfer;
    try { transfer = JSON.parse(await readFile(transferFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await inspect({ outcome, trace, transfer });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('REQ-OPERATOR-053/054: real protected CLI collects the exact prepared boundary after SHA comparison', async () => {
  await collect(undefined, ({ outcome, trace, transfer }) => {
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.deepEqual(transfer.result, result);
    assert.equal(transfer.claim.head, revision.head);
    assert.equal(transfer.claim.base, revision.base);
    assert.equal(transfer.claim.mergeBase, revision.mergeBase);
    assert.deepEqual(trace.started, [{ activityId: result.activityId }]);
    // Exact comparison wire is the intentional revision/ancestry contract, not a source assertion.
    assert.ok(trace.comparisons.every(value => value.base === revision.base && value.head === revision.head));
    assert.equal(JSON.stringify(transfer).includes('s'.repeat(43)), false);
    assert.equal(JSON.stringify(transfer).includes('r'.repeat(43)), false);
  });
});

for (const fault of ['foreign-repository', 'invalid-revision', 'invalid-ancestry', 'changed-after-claim']) {
  test(`REQ-OPERATOR-054: real protected CLI never starts or transfers ${fault} work`, async () => {
    await collect(fault, ({ outcome, trace, transfer }) => {
      assert.notEqual(outcome.code, 0);
      assert.deepEqual(trace.started, []);
      assert.equal(transfer, undefined);
    });
  });
}
