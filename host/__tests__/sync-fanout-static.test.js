// REQ-STOR-015 backfill (static source-level checks).
//
// Runtime/mock tests for fanOutBisyncTrigger live in
// src/__tests__/lib/sync-fanout.test.ts (vitest Workers pool, with
// mocked KV + CONTAINER). The Workers pool does NOT support
// readFileSync of source files; the static structural assertion for
// AC7 (rate-limiter shape) lives here in the Node test runner.
//
// AC4 (upload-side auto-trigger) was removed: REQ-STOR-015 keeps three
// triggers only (15-min cadence, Sync-now button, shutdown). The
// inverse assertion below pins that upload.ts does NOT re-introduce
// the fan-out call site.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../');

describe('REQ-STOR-015 (static): no upload-side auto-trigger', () => {
  const upload = readFileSync(resolve(repoRoot, 'src/routes/storage/upload.ts'), 'utf8');

  it('upload.ts does NOT import fanOutBisyncTrigger from sync-fanout', () => {
    assert.ok(
      !/from\s+['"]\.\.\/\.\.\/lib\/sync-fanout['"]/.test(upload),
      "upload.ts must not import from sync-fanout (REQ-STOR-015 keeps 3 triggers only)"
    );
    assert.ok(
      !/fanOutBisyncTrigger/.test(upload),
      'upload.ts must not reference fanOutBisyncTrigger (no upload-side auto-trigger)'
    );
  });

  it('upload.ts does NOT wire any trigger through executionCtx.waitUntil', () => {
    assert.ok(
      !/c\.executionCtx\?\.waitUntil\(/.test(upload),
      'upload.ts must not use executionCtx.waitUntil (no upload-side auto-trigger)'
    );
  });
});

describe('REQ-STOR-015 AC4 (static): sessions-sync rate limiter shape', () => {
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
