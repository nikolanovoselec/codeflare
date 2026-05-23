/**
 * Structural audit for REQ-SESSION-011 entrypoint shell + Dockerfile slice
 * (AC1..AC5). The audit reads entrypoint.sh and the Dockerfile to assert the
 * trap registration, sync-daemon PID handling, final bisync flags, and the
 * STOPSIGNAL directive exist as the spec describes. These artifacts are
 * declarative (a shell trap, a build-time directive); the runtime behavior
 * that flows from them is exercised by REAL behavioral tests elsewhere:
 *
 *   - REQ-SESSION-011 AC6 (destroy() sends SIGTERM, polls ctx.container.running,
 *     calls super.destroy() as fallback):
 *       src/__tests__/container/index.test.ts (destroy describe — L654..L860)
 *   - REQ-SESSION-011 AC7 (collectMetrics calls stop('SIGTERM') on idle):
 *       src/__tests__/container-metrics.test.ts (idle timeout resolution describe — L272..L400)
 *   - REQ-STOR-005 / REQ-SESSION-011 bisync daemon behavior:
 *       host/__tests__/entrypoint-bisync-behavior.test.js (real bash spawn rig)
 *
 * Follow-up: extend the entrypoint-bisync-behavior harness to also fire
 * SIGTERM into the daemon and assert the trap-driven final bisync runs with
 * the --ignore-checksum --max-delete 100 flags. Tracked in the /sdd clean
 * follow-up issue.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, '../../../entrypoint.sh');
const DOCKERFILE_CANDIDATES = [
  resolve(__dirname, '../../../Dockerfile'),
  resolve(__dirname, '../../../../Dockerfile'),
];

function readDockerfile(): string | null {
  for (const p of DOCKERFILE_CANDIDATES) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
}

describe('REQ-SESSION-011: Graceful shutdown — entrypoint + image-level directives', () => {
  describe('REQ-SESSION-011 AC1: entrypoint.sh traps SIGINT and SIGTERM via shutdown_handler', () => {
    it('registers a trap for SIGINT', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/trap\s+[^#\n]*SIGINT/);
    });

    it('registers a trap for SIGTERM', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/trap\s+[^#\n]*SIGTERM/);
    });

    it('defines a shutdown_handler function', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/shutdown_handler\s*\(\)/);
    });
  });

  describe('REQ-SESSION-011 AC2: trap kills sync daemon via /tmp/sync-daemon.pid', () => {
    it('references the PID file', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/sync-daemon\.pid/);
    });

    it('reads the PID file and kills the daemon', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/sync-daemon\.pid[\s\S]{0,200}kill/);
    });
  });

  describe('REQ-SESSION-011 AC3: shutdown path runs final bisync with safety flags', () => {
    it('runs rclone bisync', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/rclone\s+bisync/);
    });

    it('uses --ignore-checksum', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/--ignore-checksum/);
    });

    it('uses --max-delete 100', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/--max-delete\s+100/);
    });
  });

  describe('REQ-SESSION-011 AC4: bisync-initialized flag is touched on the timeout path', () => {
    it('references the bisync-initialized sentinel', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/bisync.initialized|bisync_initialized/i);
    });
  });

  describe('REQ-SESSION-011 AC5: container image declares STOPSIGNAL SIGINT', () => {
    it('Dockerfile declares STOPSIGNAL SIGINT', () => {
      const dockerfile = readDockerfile();
      if (dockerfile === null) {
        throw new Error('Dockerfile not found in expected locations');
      }
      expect(dockerfile).toMatch(/STOPSIGNAL\s+SIGINT/);
    });
  });
});
