import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(root, 'preseed/agents/pi/package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'preseed/agents/pi/package-lock.json'), 'utf8'));

// 21.0.3 still checks session readiness, not queued/running status, before
// manager.resume invokes agent.resume and resets its state. Retain the guard.
// Reviewed source: https://github.com/gotgenes/pi-packages/blob/3c70c4a121735deb17006c21622805b24956d207/packages/pi-subagents/src/lifecycle/subagent-manager.ts#L290-L298
// Behavioral coverage: src/__tests__/lib/pi-subagent-resume-guard.test.ts
const REVIEWED_GUARDED_VERSION = '21.0.3';
const REVIEW_MESSAGE = [
  '@gotgenes/pi-subagents changed. Re-run active-resume compatibility review.',
  'If upstream now rejects queued/running resume before manager/session invocation,',
  'remove subagent-resume-guard.ts and this sentinel. Otherwise review and advance',
  'REVIEWED_GUARDED_VERSION with behavioral evidence.',
].join(' ');

describe('REQ-AGENT-159: pi-subagents active-resume compatibility', () => {
  it('forces explicit guard review whenever the exact dependency changes', () => {
    const version = pkg.dependencies['@gotgenes/pi-subagents'];
    assert.equal(version, REVIEWED_GUARDED_VERSION, REVIEW_MESSAGE);
    const installed = lock.packages['node_modules/@gotgenes/pi-subagents'];
    assert.equal(installed?.version, version, REVIEW_MESSAGE);
    assert.equal(installed?.resolved !== undefined, true, REVIEW_MESSAGE);
  });
});
