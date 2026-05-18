// REQ-STOR-015 backfill (static source-level checks).
//
// Runtime/mock tests for fanOutBisyncTrigger live in
// src/__tests__/lib/sync-fanout.test.ts (vitest Workers pool, with
// mocked KV + CONTAINER). The Workers pool does NOT support
// readFileSync of source files; the static structural assertions for
// AC4 (upload-side wiring) and AC7 (rate-limiter shape) live here in
// the Node test runner.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../');

describe('REQ-STOR-015 AC4 (static): upload-side fire-and-forget trigger wiring', () => {
  const upload = readFileSync(resolve(repoRoot, 'src/routes/storage/upload.ts'), 'utf8');

  it('upload.ts imports fanOutBisyncTrigger from sync-fanout', () => {
    assert.ok(
      upload.includes("from '../../lib/sync-fanout'"),
      "upload.ts must import fanOutBisyncTrigger from '../../lib/sync-fanout'"
    );
    assert.ok(
      /fanOutBisyncTrigger/.test(upload),
      'upload.ts must reference fanOutBisyncTrigger somewhere'
    );
  });

  it('fan-out fires through executionCtx.waitUntil so the response is not blocked', () => {
    assert.ok(
      /c\.executionCtx\?\.waitUntil\(/.test(upload),
      'upload.ts must wire the trigger through c.executionCtx?.waitUntil(...) so successful PUTs return immediately'
    );
  });

  it('trigger rejection is swallowed via .catch(() => undefined)', () => {
    // Defensive: a trigger failure must not poison a successful R2 PUT
    // (a failed trigger is acceptable; the 15-min cadence will catch up).
    assert.ok(
      /\.catch\(\(\) => undefined\)/.test(upload),
      'upload.ts must wrap fanOutBisyncTrigger with .catch(() => undefined) to swallow trigger failures'
    );
  });
});

describe('REQ-STOR-015 AC7 (static): sessions-sync rate limiter shape', () => {
  const lifecycle = readFileSync(resolve(repoRoot, 'src/routes/session/lifecycle.ts'), 'utf8');

  it('declares sessionsSyncRateLimiter with windowMs=60_000', () => {
    assert.ok(
      /sessionsSyncRateLimiter\s*=\s*createRateLimiter\(\s*\{[\s\S]*?windowMs:\s*60_?000[\s\S]*?\}\s*\)/.test(lifecycle),
      'sessionsSyncRateLimiter must set windowMs to 60_000 (or 60000)'
    );
  });

  it('declares sessionsSyncRateLimiter with maxRequests=6', () => {
    assert.ok(
      /sessionsSyncRateLimiter\s*=\s*createRateLimiter\(\s*\{[\s\S]*?maxRequests:\s*6[\s\S]*?\}\s*\)/.test(lifecycle),
      'sessionsSyncRateLimiter must set maxRequests to 6 (matches destructive-action rate-limit pattern)'
    );
  });

  it('declares sessionsSyncRateLimiter with keyPrefix=sessions-sync', () => {
    assert.ok(
      /sessionsSyncRateLimiter\s*=\s*createRateLimiter\(\s*\{[\s\S]*?keyPrefix:\s*['"]sessions-sync['"][\s\S]*?\}\s*\)/.test(lifecycle),
      "sessionsSyncRateLimiter must set keyPrefix to 'sessions-sync'"
    );
  });

  it('attaches sessionsSyncRateLimiter to POST /sync', () => {
    assert.ok(
      /app\.post\(\s*['"]\/sync['"]\s*,\s*sessionsSyncRateLimiter/.test(lifecycle),
      'POST /sync must be guarded by sessionsSyncRateLimiter (otherwise the rate limit is dead code)'
    );
  });
});
