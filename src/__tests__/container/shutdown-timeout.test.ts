import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const containerSrc = readFileSync(
  resolve(__dirname, '../../container/index.ts'),
  'utf8',
);

/**
 * Structural tests for the bundled shutdown-bisync reliability fix.
 *
 * destroy() needs a complete DurableObject ctx (storage, container.stop,
 * container.running) to test end-to-end; a structural check at this
 * layer catches the most common regression — someone reverting the
 * timeout back to 25_000 — without the cost of full DO mocking.
 */
describe('Container DO shutdown budget', () => {
  it('destroy() uses a 75_000ms SIGTERM-to-SIGKILL budget (not 25_000)', () => {
    expect(containerSrc).toContain('const timeoutMs = 75_000;');
    expect(containerSrc).not.toContain('const timeoutMs = 25_000;');
  });

  it('destroy() records _shutdownStartedAt for telemetry', () => {
    expect(containerSrc).toMatch(/this\._shutdownStartedAt\s*=\s*Date\.now\(\)/);
  });

  it('onStop() logs shutdownElapsedMs so we can tune the budget over time', () => {
    expect(containerSrc).toMatch(/Container stopped['"][^)]*shutdownElapsedMs/);
  });

  it('comment documents WHY the budget changed (avoids accidental revert)', () => {
    // Whoever next touches destroy() needs to know the 75s figure pairs
    // with the entrypoint.sh shutdown bisync 60s budget plus headroom.
    expect(containerSrc).toMatch(/60s budget|entrypoint.*bisync|vault rollout/i);
  });
});
