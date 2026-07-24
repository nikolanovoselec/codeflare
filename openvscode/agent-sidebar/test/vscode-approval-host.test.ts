import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

import type { ApprovalManifest } from '../src/pi/approval-bridge.ts';

const vscode = vi.hoisted(() => ({
  openedDocuments: 0,
  shownDocuments: 0,
  warnings: [] as unknown[][],
}));

vi.mock('vscode', () => ({
  window: {
    showTextDocument: async () => { vscode.shownDocuments += 1; },
    showWarningMessage: async (...args: unknown[]) => {
      vscode.warnings.push(args);
      return 'Approve';
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
});

test('REQ-IDE-007 AC1: routine local actions need no confirmation and open no editor tabs', async () => {
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
    await host.openDiff(manifest);
    assert.equal(await host.confirm(manifest), true);
  }

  assert.equal(vscode.openedDocuments, 0);
  assert.equal(vscode.shownDocuments, 0);
  assert.deepEqual(vscode.warnings, []);
});

test('REQ-IDE-007 AC3: remaining guarded actions use one modal and no editor tab', async () => {
  const host = new VsCodeApprovalHost();
  const manifest: ApprovalManifest = {
    ...baseManifest,
    toolName: 'mcp__example__mutate',
    preview: { kind: 'generic', toolName: 'mcp__example__mutate', input: { value: 'exact' } },
  };

  await host.openDiff(manifest);
  assert.equal(await host.confirm(manifest), true);

  assert.equal(vscode.openedDocuments, 0);
  assert.equal(vscode.shownDocuments, 0);
  assert.equal(vscode.warnings.length, 1);
  assert.match(String((vscode.warnings[0]?.[1] as { detail?: string } | undefined)?.detail), /mcp__example__mutate/);
});
