// REQ-MEM-010 AC5/AC6/AC7: behavioural tests for assert-iso-ts.sh
//
// Calls the real script with controlled env vars. No markdown extraction,
// no regex-scraping of source files - the test seam is the documented
// $ASSERT_ISO_TS_OVERRIDE env var on the script itself.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, delimiter } from 'node:path';
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
    env: { ...process.env, USER_TIMEZONE: '', ...env },
  });
}

// REQ-MEM-001: Conversation context automatically captured to vault

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

  it('AC5 prefers USER_TIMEZONE when USER_TIMEZONE and TZ disagree', () => {
    const r = run({ TZ: 'UTC', USER_TIMEZONE: 'America/New_York', ASSERT_ISO_TS_OVERRIDE: '' });
    assert.equal(r.status, 0, `exit non-zero: ${r.stderr}`);
    assert.match(r.stdout, /^RESOLVED_TZ=America\/New_York$/m);
    assert.match(r.stdout, /^ISO_TS=.*-0[45]00$/m);
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

  it('REQ-MEM-010 AC7: admits exactly 30 seconds of drift and rejects 31 in both directions', (t) => {
    const bin = mkdtempSync(join(tmpdir(), 'capture-clock-'));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    // Fix only the wall clock. Timezone lookup and parsing still use GNU date.
    const now = Date.UTC(2026, 0, 1, 12) / 1000;
    writeFileSync(join(bin, 'date'), `#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = +%s ]; then echo ${now}; else command -p date "$@"; fi\n`, { mode: 0o755 });
    for (const [time, drift] of [
      ['11-59-30', 30], ['12-00-30', -30], ['11-59-29', 31], ['12-00-31', -31],
    ]) {
      const timestamp = `2026-01-01T${time}+0000`;
      const result = run({ PATH: `${bin}${delimiter}${process.env.PATH}`, TZ: 'UTC', USER_TIMEZONE: '', ASSERT_ISO_TS_OVERRIDE: timestamp });
      assert.equal(result.signal, null);
      if (Math.abs(drift) === 30) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `ISO_TS=${timestamp}\nRESOLVED_TZ=UTC\n`);
      } else {
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, new RegExp(`drifts ${drift}s from current clock`));
      }
    }
  });

  it('AC7 freshness drift: a year-old fabricated timestamp rejected', () => {
    // 2025-01-01 is unambiguously >30s from any plausible test runtime,
    // independent of host time-of-day or DST state.
    const r = run({ TZ: 'UTC', ASSERT_ISO_TS_OVERRIDE: '2025-01-01T12-00-00+0000' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /drifts -?\d+s from current clock/);
  });
});
