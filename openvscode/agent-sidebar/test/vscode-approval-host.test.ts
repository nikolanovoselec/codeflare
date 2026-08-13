import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

import { ApprovalBridge, type ApprovalManifest } from '../src/pi/approval-bridge.ts';

const vscode = vi.hoisted(() => ({
  openedDocuments: 0,
  shownDocuments: 0,
  warnings: [] as unknown[][],
  quickPicks: [] as unknown[][],
  inputBoxes: [] as unknown[][],
  cancellations: 0,
  pendingDialogs: false,
}));

vi.mock('vscode', () => ({
  CancellationTokenSource: class {
    readonly #listeners = new Set<() => void>();
    readonly token = {
      onCancellationRequested: (listener: () => void) => {
        this.#listeners.add(listener);
        return { dispose: () => this.#listeners.delete(listener) };
      },
    };
    cancel(): void {
      vscode.cancellations += 1;
      for (const listener of this.#listeners) listener();
    }
    dispose(): void { this.#listeners.clear(); }
  },
  window: {
    showTextDocument: async () => { vscode.shownDocuments += 1; },
    showWarningMessage: async (...args: unknown[]) => {
      vscode.warnings.push(args);
      return 'Approve';
    },
    showQuickPick: (...args: unknown[]) => {
      vscode.quickPicks.push(args);
      if (vscode.pendingDialogs) {
        const token = args[2] as { onCancellationRequested(listener: () => void): unknown };
        return new Promise<string | undefined>((resolve) => token.onCancellationRequested(() => resolve(undefined)));
      }
      return Promise.resolve('Second');
    },
    showInputBox: (...args: unknown[]) => {
      vscode.inputBoxes.push(args);
      if (vscode.pendingDialogs) {
        const token = args[1] as { onCancellationRequested(listener: () => void): unknown };
        return new Promise<string | undefined>((resolve) => token.onCancellationRequested(() => resolve(undefined)));
      }
      return Promise.resolve('typed answer');
    },
  },
  workspace: {
    openTextDocument: async () => {
      vscode.openedDocuments += 1;
      return {};
    },
  },
}));

import { VsCodeApprovalHost } from '../src/pi/vscode-approval-host.ts';

const baseManifest = {
  id: '00112233445566778899aabbccddeeff',
  createdAt: 1,
  expiresAt: 2,
  nonce: '0'.repeat(64),
} as const;

afterEach(() => {
  vscode.openedDocuments = 0;
  vscode.shownDocuments = 0;
  vscode.warnings = [];
  vscode.quickPicks = [];
  vscode.inputBoxes = [];
  vscode.cancellations = 0;
  vscode.pendingDialogs = false;
});

test('REQ-IDE-007 AC2: Pi Edit Write and Bash need no confirmation and open no editor tabs', async () => {
  const host = new VsCodeApprovalHost();
  const manifests: ApprovalManifest[] = [
    {
      ...baseManifest,
      toolName: 'edit',
      preview: { kind: 'diff', path: '/home/user/workspace/file.ts', diff: '-before\n+after', beforeSha256: '1'.repeat(64), afterSha256: '2'.repeat(64) },
    },
    {
      ...baseManifest,
      toolName: 'write',
      preview: { kind: 'diff', path: '/home/user/workspace/new.ts', diff: '+created', beforeSha256: '1'.repeat(64), afterSha256: '2'.repeat(64) },
    },
    {
      ...baseManifest,
      toolName: 'bash',
      preview: { kind: 'bash', command: 'git status --short', cwd: '/home/user/workspace' },
    },
  ];

  for (const manifest of manifests) {
    assert.equal(await host.confirm(manifest), true);
  }

  assert.equal(vscode.openedDocuments, 0);
  assert.equal(vscode.shownDocuments, 0);
  assert.deepEqual(vscode.warnings, []);
});

test('REQ-IDE-022: Pi RPC select and input use bounded native VS Code dialogs', async () => {
  const host = new VsCodeApprovalHost();

  assert.equal(await host.select('Choose one', ['First', 'Second']), 'Second');
  assert.equal(await host.input('Type an answer', 'Answer'), 'typed answer');
  assert.deepEqual(vscode.quickPicks, [
    [['First', 'Second'], { title: 'Choose one', ignoreFocusOut: true }],
  ]);
  assert.deepEqual(vscode.inputBoxes, [
    [{ title: 'Type an answer', placeHolder: 'Answer', ignoreFocusOut: true }],
  ]);
});

test('REQ-IDE-022: cancelling active Pi dialogs closes them with correlated responses', async () => {
  const bridge = new ApprovalBridge(new VsCodeApprovalHost());
  vscode.pendingDialogs = true;
  for (const request of [
    { type: 'extension_ui_request' as const, id: 'cancel-select', method: 'select', title: 'Choose one', options: ['First'] },
    { type: 'extension_ui_request' as const, id: 'cancel-input', method: 'input', title: 'Type one' },
  ]) {
    const controller = new AbortController();
    const response = bridge.handlePiRequest(request, controller.signal);
    controller.abort();
    assert.deepEqual(await response, {
      type: 'extension_ui_response',
      id: request.id,
      cancelled: true,
    });
  }
  assert.equal(vscode.cancellations, 2);
});

test('REQ-IDE-007 AC2: arbitrary Pi confirmations auto-approve without UI', async () => {
  const host = new VsCodeApprovalHost();
  const manifest: ApprovalManifest = {
    ...baseManifest,
    toolName: 'mcp__example__mutate',
    preview: { kind: 'generic', toolName: 'mcp__example__mutate', input: { value: 'exact' } },
  };

  assert.equal(await host.confirm(manifest), true);

  assert.equal(vscode.openedDocuments, 0);
  assert.equal(vscode.shownDocuments, 0);
  assert.deepEqual(vscode.warnings, []);
});
