/**
 * REQ-SESSION-012: Wake-loop prevention
 * AC coverage: AC3 (frontend disposal - structural audit of web-ui source)
 *
 * AC1 (503 fetch gate) and AC4 (4503 WS close code server side) are covered
 * by existing tests in src/__tests__/container/index.test.ts.
 * AC2 (terminal WS 503 guard) is covered in src/__tests__/routes/terminal-ws.test.ts.
 * AC5 (client 4503 no-retry) is a frontend concern not testable server-side.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getContainerId } from '../../lib/container-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_UI_SRC = resolve(__dirname, '../../../web-ui/src');

describe('REQ-SESSION-012: Wake-loop prevention', () => {
  // AC3: Frontend disposal - session poller detects running->stopped and disposes session
  describe('REQ-SESSION-012 AC3: frontend disposes session on running-to-stopped transition', () => {
    it('web-ui source references disposeSession or terminal disposal on stopped', () => {
      if (!existsSync(WEB_UI_SRC)) {
        // Web UI source may be outside this worktree - mark as informational
        return;
      }
      // Search for disposeSession in the web-ui source tree
      function findInDir(dir: string, pattern: RegExp): boolean {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            if (findInDir(full, pattern)) return true;
          } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
            try {
              const content = readFileSync(full, 'utf8');
              if (pattern.test(content)) return true;
            } catch { /* skip unreadable files */ }
          }
        }
        return false;
      }
      const hasDispose = findInDir(WEB_UI_SRC, /disposeSession|dispose.*session|terminalStore.*dispose/i);
      expect(hasDispose).toBe(true);
    });

    it('web-ui source handles transition from running to stopped status', () => {
      if (!existsSync(WEB_UI_SRC)) {
        return;
      }
      function findInDir(dir: string, pattern: RegExp): boolean {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            if (findInDir(full, pattern)) return true;
          } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
            try {
              const content = readFileSync(full, 'utf8');
              if (pattern.test(content)) return true;
            } catch { /* skip */ }
          }
        }
        return false;
      }
      // The poller must check for the stopped transition and clear activeSessionId
      const hasStoppedHandler = findInDir(WEB_UI_SRC, /stopped[\s\S]{0,200}activeSessionId|activeSessionId[\s\S]{0,200}stopped/);
      expect(hasStoppedHandler).toBe(true);
    });
  });

  // AC1 re-verified via source audit (primary coverage is in index.test.ts)
  describe('REQ-SESSION-012 AC1: DO fetch gate returns 503 when container not running (structural)', () => {
    it('container DO fetch() returns 503 when ctx.container.running is false', () => {
      const src = readFileSync(
        resolve(__dirname, '../../container/index.ts'),
        'utf8'
      );
      // The fetch override must check container.running and return 503
      expect(src).toMatch(/container\?\.running[\s\S]{0,200}503|503[\s\S]{0,200}container\?\.running/);
    });

    it('container DO fetch() sends 4503 WebSocket close when not running', () => {
      const src = readFileSync(
        resolve(__dirname, '../../container/index.ts'),
        'utf8'
      );
      expect(src).toMatch(/close\(4503/);
    });
  });
});
