// REQ-MEM-010 AC5: real behavioural tests for the ISO_TS assertion suite
// inside Step 1.5 of memory-agent-prompt.md.
//
// Strategy mirrors entrypoint-tab-autostart.test.js / entrypoint-sse-c-config.test.js:
// extract the Bash block from the markdown prompt at test time, run it in a
// bash subshell with controlled $TZ / $USER_TIMEZONE / synthetic $ISO_TS
// overrides, and assert on the exit code + stdout. This is NOT a substring
// audit - the actual bash runs and the actual assertions fire.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md',
);

// Extract the Step 1.5 Bash block (between the first ```bash and the next ```
// fence after the "### 1.5." header). Acceptable to assume the Step-1.5 block
// is the first ```bash...``` after the Step 1.5 heading.
function extractStep15BashBlock() {
  const src = readFileSync(PROMPT_PATH, 'utf8');
  const headerIdx = src.indexOf('### 1.5.');
  if (headerIdx === -1) {
    throw new Error('Could not locate "### 1.5." heading in memory-agent-prompt.md');
  }
  const openFenceIdx = src.indexOf('```bash', headerIdx);
  if (openFenceIdx === -1) throw new Error('No ```bash fence after Step 1.5');
  const blockStart = src.indexOf('\n', openFenceIdx) + 1;
  const closeFenceIdx = src.indexOf('\n```', blockStart);
  if (closeFenceIdx === -1) throw new Error('Unterminated ```bash fence in Step 1.5');
  return src.slice(blockStart, closeFenceIdx);
}

function runBashBlock({ env = {}, injectAfterISO_TS = '' } = {}) {
  let body = extractStep15BashBlock();
  if (injectAfterISO_TS) {
    // Insert an override line right after the ISO_TS="$(...)" assignment so
    // the assertion suite runs against the synthetic value. This is how the
    // negative-case tests exercise the assertions without having to ship a
    // separate copy of the block.
    body = body.replace(
      /^(ISO_TS="\$\(TZ="\$RESOLVED" date '\+%Y-%m-%dT%H-%M-%S%z'\)")$/m,
      `$1\n${injectAfterISO_TS}`,
    );
  }
  const script = ['#!/usr/bin/env bash', 'set -e', body].join('\n');
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, ...env },
  });
}

describe('memory-agent-prompt Step 1.5 ISO_TS assertions / REQ-MEM-010 AC5', () => {
  // Happy path: real date call, no override. Bash block must exit 0 and print
  // a well-formed ISO_TS=... line. Run twice under different TZs to confirm
  // the offset-vs-RESOLVED assertion accepts both Zurich and UTC hosts.
  it('AC5 happy path: Europe/Zurich host produces a valid ISO_TS with matching +0200/+0100 offset', () => {
    const r = runBashBlock({ env: { TZ: 'Europe/Zurich', USER_TIMEZONE: '' } });
    assert.equal(r.status, 0, `block exited non-zero: ${r.stderr}`);
    assert.match(r.stdout, /^ISO_TS=\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}[+-]\d{4}$/m);
    assert.match(r.stdout, /^RESOLVED_TZ=Europe\/Zurich$/m);
  });

  it('AC5 happy path: UTC host produces a valid ISO_TS with +0000 offset (not a false positive)', () => {
    const r = runBashBlock({ env: { TZ: 'UTC', USER_TIMEZONE: '' } });
    assert.equal(r.status, 0, `block exited non-zero on UTC host: ${r.stderr}`);
    assert.match(r.stdout, /^ISO_TS=\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\+0000$/m);
  });

  // AC5(a) offset-shape: an ISO_TS lacking a four-digit offset must be rejected.
  it('AC5(a): missing TZ offset rejected (truncated ISO_TS without +NNNN)', () => {
    const r = runBashBlock({
      env: { TZ: 'Europe/Zurich' },
      injectAfterISO_TS: 'ISO_TS="2026-05-23T12-00-00"',
    });
    assert.equal(r.status, 1, 'block must exit 1 when offset is missing');
    assert.match(r.stderr, /missing TZ offset/);
  });

  // AC5(b) offset-vs-RESOLVED: the exact #416 symptom (Europe/Zurich host,
  // LLM dropped the TZ wrapper, output ends in +0000). Must be rejected
  // because +0000 != +0200/+0100 for Zurich.
  it('AC5(b) #416 regression: Europe/Zurich + ISO_TS ending in +0000 rejected', () => {
    const r = runBashBlock({
      env: { TZ: 'Europe/Zurich', USER_TIMEZONE: '' },
      injectAfterISO_TS: 'ISO_TS="2026-05-23T12-00-00+0000"',
    });
    assert.equal(r.status, 1, 'block must reject +0000 on a non-UTC RESOLVED');
    assert.match(r.stderr, /offset \+0000 does not match TZ=Europe\/Zurich/);
  });

  // AC5(c) freshness drift: a fabricated value far from current wall clock
  // (e.g. T12:00:00 when actual wall clock is several hours away) is rejected.
  // Use TZ=UTC + injected +0000 so Assertion 2 passes deterministically and
  // Assertion 3 is the only failing gate, regardless of host DST state.
  it('AC5(c) fabricated T12-00-00 with hours of drift is rejected', () => {
    // Reference clock is UTC here (matches injected +0000). Skip the +/-2 min
    // window around 12:00 UTC where the drift might be below 30s.
    const now = new Date();
    const utcHourMinute = now.getUTCHours() * 60 + now.getUTCMinutes();
    const noonInMinutes = 12 * 60;
    const diffMin = Math.abs(utcHourMinute - noonInMinutes);
    if (diffMin < 2) {
      return; // deterministic skip - drift could be under threshold
    }
    const ymd = now.toISOString().slice(0, 10); // YYYY-MM-DD in UTC
    const r = runBashBlock({
      env: { TZ: 'UTC', USER_TIMEZONE: '' },
      injectAfterISO_TS: `ISO_TS="${ymd}T12-00-00+0000"`,
    });
    assert.equal(r.status, 1, 'block must reject fabricated T12-00-00 when wall clock is not noon UTC');
    assert.match(r.stderr, /drifts -?\d+s from current clock/);
  });

  // Idempotency / repeatability: running the block twice in succession both
  // succeed (no side effects that break a second invocation).
  it('idempotent: two successive invocations both produce valid ISO_TS', () => {
    const r1 = runBashBlock({ env: { TZ: 'UTC' } });
    const r2 = runBashBlock({ env: { TZ: 'UTC' } });
    assert.equal(r1.status, 0);
    assert.equal(r2.status, 0);
  });
});
