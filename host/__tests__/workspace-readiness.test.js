import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  EDITOR_WARMING_BUDGET_MS,
  resolveSessionWorkspace,
  shouldPrewarmTerminal,
  startWorkspaceServices,
  waitForEditorReady,
} from '../dist/workspace-readiness.js';

describe('REQ-IDE-048 AC3: host workspace startup selection', () => {
  it('defaults missing and invalid workspace values to the existing Terminal prewarm path', () => {
    assert.equal(resolveSessionWorkspace(undefined), 'terminal');
    assert.equal(resolveSessionWorkspace(''), 'terminal');
    assert.equal(resolveSessionWorkspace('invalid'), 'terminal');
    assert.equal(shouldPrewarmTerminal(resolveSessionWorkspace(undefined)), true);
  });

  it('selects VS Code startup without selecting host terminal prewarm', () => {
    const workspace = resolveSessionWorkspace('vscode');
    assert.equal(workspace, 'vscode');
    assert.equal(shouldPrewarmTerminal(workspace), false);
  });

  it('keeps editor probing inside the existing 120-second warming budget', () => {
    assert.equal(EDITOR_WARMING_BUDGET_MS, 120_000);
  });
});

describe('REQ-IDE-048 AC3: host startup composition', () => {
  it('constructs, inserts, and starts exactly one Terminal prewarm session', async () => {
    const calls = [];
    const session = { id: 'prewarm-1' };

    const result = await startWorkspaceServices('terminal', {
      createTerminalSession: () => { calls.push('create'); return session; },
      insertTerminalSession: (value) => { assert.equal(value, session); calls.push('insert'); },
      startTerminalSession: (value) => { assert.equal(value, session); calls.push('start'); },
      beginEditorProbe: () => calls.push('probe'),
      waitForEditor: async () => { calls.push('editor'); return true; },
    });

    assert.deepEqual(result, { kind: 'terminal', session });
    assert.deepEqual(calls, ['create', 'insert', 'start']);
  });

  it('never constructs, inserts, or starts a host Session for VS Code', async () => {
    const calls = [];

    const result = await startWorkspaceServices('vscode', {
      createTerminalSession: () => { calls.push('create'); return {}; },
      insertTerminalSession: () => calls.push('insert'),
      startTerminalSession: () => calls.push('start'),
      beginEditorProbe: () => calls.push('probe'),
      waitForEditor: async () => { calls.push('editor'); return true; },
    });

    assert.deepEqual(result, { kind: 'vscode', ready: true });
    assert.deepEqual(calls, ['probe', 'editor']);
  });

  it('REQ-IDE-049 AC3: clears a bounded timeout while the retry probe is pending', async () => {
    let editorReady = false;
    let editorReadyTimedOut = false;
    let probeCount = 0;
    let resolveRetry;
    const actions = {
      createTerminalSession: () => { throw new Error('must not create PTY'); },
      insertTerminalSession: () => { throw new Error('must not insert PTY'); },
      startTerminalSession: () => { throw new Error('must not start PTY'); },
      beginEditorProbe: () => { editorReadyTimedOut = false; },
      waitForEditor: async () => {
        probeCount += 1;
        if (probeCount === 1) return false;
        return new Promise((resolve) => { resolveRetry = resolve; });
      },
    };

    const first = await startWorkspaceServices('vscode', actions);
    assert.equal(first.kind, 'vscode');
    editorReady = first.ready;
    editorReadyTimedOut = !editorReady;
    assert.deepEqual({ editorReady, editorReadyTimedOut }, { editorReady: false, editorReadyTimedOut: true });

    const retry = startWorkspaceServices('vscode', actions);
    assert.equal(editorReadyTimedOut, false);
    resolveRetry(true);
    const second = await retry;
    assert.equal(second.kind, 'vscode');
    editorReady = second.ready;
    editorReadyTimedOut = !editorReady;
    assert.deepEqual({ editorReady, editorReadyTimedOut }, { editorReady: true, editorReadyTimedOut: false });
  });
});

describe('REQ-IDE-048 AC3 + REQ-IDE-049 AC2: bounded loopback editor readiness', () => {
  it('becomes ready only after the code-server health endpoint succeeds', async () => {
    let probes = 0;
    const server = http.createServer((req, res) => {
      assert.equal(req.url, '/healthz');
      probes += 1;
      res.writeHead(probes < 2 ? 503 : 200);
      res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const address = server.address();
      const ready = await waitForEditorReady(
        { host: '127.0.0.1', port: address.port },
        { timeoutMs: 500, pollMs: 5 },
      );
      assert.equal(ready, true);
      assert.equal(probes, 2);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('stops probing after the bounded budget without falling back', async () => {
    let probes = 0;
    const server = http.createServer((_req, res) => {
      probes += 1;
      res.writeHead(503);
      res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const startedAt = Date.now();
    try {
      const address = server.address();
      const ready = await waitForEditorReady(
        { host: '127.0.0.1', port: address.port },
        { timeoutMs: 30, pollMs: 5 },
      );
      assert.equal(ready, false);
      assert.ok(probes > 0);
      assert.ok(Date.now() - startedAt < 500);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
