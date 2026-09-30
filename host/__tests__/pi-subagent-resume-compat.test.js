import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(root, 'preseed/agents/pi/package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'preseed/agents/pi/package-lock.json'), 'utf8'));

// 21.8.1 manager.resume checks agent.resumeRefusal before claim or invocation.
// resumeRefusal rejects running agents and queued agents lacking a ready session.
// Keep the existing status-only managed boundary and its stable steering guidance
// for this dependency-only upgrade; no runtime guard behavior changes here.
// Reviewed npm source: @gotgenes/pi-subagents@21.8.1, src/lifecycle/subagent-manager.ts
// and src/lifecycle/subagent.ts. Behavioral managed-boundary coverage remains:
// src/__tests__/lib/pi-subagent-resume-guard.test.ts.
const REVIEWED_GUARDED_VERSION = '21.8.1';
const REVIEW_MESSAGE = [
  '@gotgenes/pi-subagents changed. Re-run active-resume compatibility review.',
  'Review upstream queued/running refusal before manager/session invocation',
  'and preserve the managed status-only boundary unless its removal is scoped.',
  'Advance REVIEWED_GUARDED_VERSION only after compatibility review.',
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
