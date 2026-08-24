import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(root, 'preseed/agents/pi/package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'preseed/agents/pi/package-lock.json'), 'utf8'));
const guard = readFileSync(resolve(root, 'preseed/agents/pi/extensions/subagent-resume-guard.ts'), 'utf8');

const REVIEWED_GUARDED_VERSION = '19.2.1';
const REVIEW_MESSAGE = [
  '@gotgenes/pi-subagents changed. Re-run active-resume compatibility review.',
  'If upstream now rejects queued/running resume before manager/session invocation,',
  'remove subagent-resume-guard.ts and this sentinel. Otherwise review and advance',
  'REVIEWED_GUARDED_VERSION with behavioral evidence.',
].join(' ');

describe('REQ-AGENT-158 AC7: pi-subagents active-resume compatibility', () => {
  it('forces explicit guard review whenever the exact dependency changes', () => {
    const version = pkg.dependencies['@gotgenes/pi-subagents'];
    assert.equal(version, REVIEWED_GUARDED_VERSION, REVIEW_MESSAGE);
    const installed = lock.packages['node_modules/@gotgenes/pi-subagents'];
    assert.equal(installed?.version, version, REVIEW_MESSAGE);
    assert.equal(installed?.resolved !== undefined, true, REVIEW_MESSAGE);
    assert.match(
      guard,
      /\.\.\/npm\/node_modules\/@gotgenes\/pi-subagents\/src\/service\/service\.ts/,
      `${REVIEW_MESSAGE} The local guard path must keep resolving the package's reviewed public accessor entrypoint.`,
    );
  });
});
