// REQ-MEM-010 AC5/AC6/AC7: behavioural tests for assert-iso-ts.sh
//
// Calls the real script with controlled env vars. No markdown extraction,
// no regex-scraping of source files - the test seam is the documented
// $ASSERT_ISO_TS_OVERRIDE env var on the script itself.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh',
);

function run(env) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, ...env },
  });
}

describe('assert-iso-ts.sh / REQ-MEM-010 AC5+AC6+AC7', () => {
  it('AC5 happy path UTC: prints valid ISO_TS=... and exits 0', () => {
    const r = run({ TZ: 'UTC', USER_TIMEZONE: '', ASSERT_ISO_TS_OVERRIDE: '' });
    assert.equal(r.signal, null, 'script timed out');
    assert.equal(r.status, 0, `exit non-zero: ${r.stderr}`);
    assert.match(r.stdout, /^ISO_TS=\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\+0000$/m);
    assert.match(r.stdout, /^RESOLVED_TZ=UTC$/m);
  });

  it('AC5 happy path Europe/Zurich: real local-TZ offset, exits 0', () => {
    const r = run({ TZ: 'Europe/Zurich', USER_TIMEZONE: '', ASSERT_ISO_TS_OVERRIDE: '' });
    assert.equal(r.status, 0, `exit non-zero: ${r.stderr}`);
    assert.match(r.stdout, /^ISO_TS=\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}[+-]\d{4}$/m);
    assert.match(r.stdout, /^RESOLVED_TZ=Europe\/Zurich$/m);
  });

  it('AC5 offset-shape: ISO_TS lacking [+-]NNNN suffix rejected', () => {
    const r = run({ TZ: 'UTC', ASSERT_ISO_TS_OVERRIDE: '2026-05-23T12-00-00' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing TZ offset/);
  });

  it('AC6 #416 regression: Europe/Zurich + ISO_TS ending in +0000 rejected', () => {
    const r = run({
      TZ: 'Europe/Zurich',
      USER_TIMEZONE: '',
      ASSERT_ISO_TS_OVERRIDE: '2026-05-23T12-00-00+0000',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /offset \+0000 does not match TZ=Europe\/Zurich expected [+-]\d{4}/);
  });

  it('AC7 freshness drift: a year-old fabricated timestamp rejected', () => {
    // 2025-01-01 is unambiguously >30s from any plausible test runtime,
    // independent of host time-of-day or DST state.
    const r = run({ TZ: 'UTC', ASSERT_ISO_TS_OVERRIDE: '2025-01-01T12-00-00+0000' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /drifts -?\d+s from current clock/);
  });
});
