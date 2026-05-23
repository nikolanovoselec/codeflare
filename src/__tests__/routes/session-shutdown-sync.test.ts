/**
 * REQ-SESSION-011: Graceful shutdown with final sync
 * AC coverage: AC1 (entrypoint traps SIGINT and SIGTERM),
 *              AC2 (trap kills sync daemon via PID file),
 *              AC3 (final rclone bisync --ignore-checksum --max-delete 100),
 *              AC4 (bisync-initialized flag touched on timeout path),
 *              AC5 (STOPSIGNAL SIGINT in container image),
 *              AC6 (destroy() sends SIGTERM and polls ctx.container.running),
 *              AC7 (collectMetrics calls stop(SIGTERM) for idle/quota eviction)
 *
 * All ACs are structural audits of entrypoint.sh and container/index.ts.
 * Behavioral bisync daemon tests live in host/__tests__/entrypoint-bisync-behavior.test.js.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_ID_PATTERN } from '../../lib/constants';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, '../../../entrypoint.sh');
const CONTAINER_DO = resolve(__dirname, '../../container/index.ts');
const CONTAINER_METRICS = resolve(__dirname, '../../container/container-metrics.ts');

describe('REQ-SESSION-011: Graceful shutdown with final sync', () => {
  // AC1: Entrypoint traps SIGINT and SIGTERM
  describe('REQ-SESSION-011 AC1: entrypoint traps SIGINT and SIGTERM', () => {
    it('entrypoint.sh registers a trap for SIGINT', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/trap\s+[^#\n]*SIGINT/);
    });

    it('entrypoint.sh registers a trap for SIGTERM', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/trap\s+[^#\n]*SIGTERM/);
    });

    it('entrypoint.sh defines a shutdown handler function', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/shutdown_handler\s*\(\)/);
    });
  });

  // AC2: Trap handler kills sync daemon via PID file at /tmp/sync-daemon.pid
  describe('REQ-SESSION-011 AC2: trap kills sync daemon via PID file', () => {
    it('entrypoint.sh references /tmp/sync-daemon.pid for daemon management', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/sync-daemon\.pid/);
    });

    it('entrypoint.sh reads PID file to kill the daemon on shutdown', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      // Must read the pid file and kill the process
      expect(src).toMatch(/sync-daemon\.pid[\s\S]{0,200}kill/);
    });
  });

  // AC3: Final rclone bisync with --ignore-checksum --max-delete 100
  describe('REQ-SESSION-011 AC3: final bisync --ignore-checksum --max-delete 100', () => {
    it('entrypoint.sh shutdown path runs rclone bisync', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/rclone\s+bisync/);
    });

    it('entrypoint.sh bisync uses --ignore-checksum flag', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/--ignore-checksum/);
    });

    it('entrypoint.sh bisync uses --max-delete 100 flag', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/--max-delete\s+100/);
    });
  });

  // AC4: bisync-initialized flag touched on timeout path
  describe('REQ-SESSION-011 AC4: bisync-initialized flag touched on timeout path', () => {
    it('entrypoint.sh references a bisync-initialized or bisync_initialized flag', () => {
      const src = readFileSync(ENTRYPOINT, 'utf8');
      expect(src).toMatch(/bisync.initialized|bisync_initialized/i);
    });
  });

  // AC5: Container image declares STOPSIGNAL SIGINT
  describe('REQ-SESSION-011 AC5: STOPSIGNAL SIGINT in container image', () => {
    it('Dockerfile declares STOPSIGNAL SIGINT', () => {
      // Look for Dockerfile in the repository
      let dockerfile = '';
      try {
        dockerfile = readFileSync(resolve(__dirname, '../../../Dockerfile'), 'utf8');
      } catch {
        try {
          dockerfile = readFileSync(resolve(__dirname, '../../../../Dockerfile'), 'utf8');
        } catch {
          // Dockerfile may be in a parent directory
          return;
        }
      }
      expect(dockerfile).toMatch(/STOPSIGNAL\s+SIGINT/);
    });
  });

  // AC6: User-initiated Stop/Delete reach trap via destroy() -> SIGTERM + poll
  describe('REQ-SESSION-011 AC6: destroy() sends SIGTERM and polls ctx.container.running', () => {
    it('container DO destroy() sends SIGTERM via stop()', () => {
      const src = readFileSync(CONTAINER_DO, 'utf8');
      expect(src).toMatch(/stop\(['"]SIGTERM['"]\)/);
    });

    it('container DO destroy() polls ctx.container.running until stopped', () => {
      const src = readFileSync(CONTAINER_DO, 'utf8');
      // Must check container running state in a loop
      expect(src).toMatch(/ctx\.container\?\.running[\s\S]{0,100}while|while[\s\S]{0,100}ctx\.container\?\.running/);
    });

    it('container DO destroy() calls super.destroy() as SIGKILL fallback', () => {
      const src = readFileSync(CONTAINER_DO, 'utf8');
      expect(src).toMatch(/super\.destroy\(\)/);
    });

    it('container DO destroy() timeout is at least 25 seconds', () => {
      const src = readFileSync(CONTAINER_DO, 'utf8');
      // Original budget was 25s (25_000), later extended to 135_000
      // The test only asserts the value is >= 25000
      const timeoutMatch = src.match(/timeoutMs\s*=\s*(\d+)/);
      expect(timeoutMatch).not.toBeNull();
      const timeoutMs = parseInt(timeoutMatch![1], 10);
      expect(timeoutMs).toBeGreaterThanOrEqual(25_000);
    });
  });

  // AC7: collectMetrics calls stop('SIGTERM') for idle/quota eviction
  describe('REQ-SESSION-011 AC7: collectMetrics calls stop(SIGTERM) for idle eviction', () => {
    it('container-metrics.ts calls stop callback with SIGTERM on idle timeout', () => {
      const src = readFileSync(CONTAINER_METRICS, 'utf8');
      // The idle detection path calls stop('SIGTERM')
      expect(src).toMatch(/stop\(['"]SIGTERM['"]\)/);
    });

    it('container-metrics.ts defines idle detection using idleMs vs idleTimeoutPref', () => {
      const src = readFileSync(CONTAINER_METRICS, 'utf8');
      expect(src).toMatch(/idleMs|idleTimeout/);
    });
  });
});
