import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  ApprovalBridge,
  ApprovalBridgeError,
  type ApprovalHost,
  type ApprovalManifest,
} from '../src/pi/approval-bridge.ts';

const manifest: ApprovalManifest = {
  id: '00112233445566778899aabbccddeeff',
  operation: 'edit',
  canonicalTarget: '/home/user/workspace/example.ts',
  baseHash: 'sha256:base',
  resultHash: 'sha256:result',
  previewId: 'preview-1',
  expiresAt: 4_102_444_800_000,
  nonce: 'nonce-1',
};

class RecordingApprovalHost implements ApprovalHost {
  readonly events: string[] = [];
  approved = false;

  async loadManifest(opaqueId: string): Promise<ApprovalManifest> {
    this.events.push(`load:${opaqueId}`);
    return manifest;
  }

  async openDiff(value: ApprovalManifest): Promise<void> {
    this.events.push(`diff:${value.previewId}:${value.canonicalTarget}`);
  }

  async confirm(value: ApprovalManifest): Promise<boolean> {
    this.events.push(`confirm:${value.id}`);
    return this.approved;
  }
}

test('REQ-IDE-007 AC1: Pi approval resolves through extension-host manifest, diff, and confirmation authority', async () => {
  const host = new RecordingApprovalHost();
  host.approved = true;
  const bridge = new ApprovalBridge(host);

  const response = await bridge.handlePiRequest({
    type: 'extension_ui_request',
    id: 'ui-request-1',
    method: 'confirm',
    title: 'Guarded operation',
    message: manifest.id,
  });

  assert.deepEqual(host.events, [
    `load:${manifest.id}`,
    `diff:${manifest.previewId}:${manifest.canonicalTarget}`,
    `confirm:${manifest.id}`,
  ]);
  assert.deepEqual(response, {
    type: 'extension_ui_response',
    id: 'ui-request-1',
    confirmed: true,
  });
});

test('REQ-IDE-007 AC2: rejected extension-host approval returns a correlated denial', async () => {
  const host = new RecordingApprovalHost();
  const bridge = new ApprovalBridge(host);

  const response = await bridge.handlePiRequest({
    type: 'extension_ui_request',
    id: 'ui-request-2',
    method: 'confirm',
    title: 'Guarded operation',
    message: manifest.id,
  });

  assert.deepEqual(response, {
    type: 'extension_ui_response',
    id: 'ui-request-2',
    confirmed: false,
  });
  assert.equal(host.events.at(-1), `confirm:${manifest.id}`);
});

test('Pi fire-and-forget notifications require no response and never enter approval UI', async () => {
  const host = new RecordingApprovalHost();
  const bridge = new ApprovalBridge(host);

  const response = await bridge.handlePiRequest({
    type: 'extension_ui_request',
    id: 'ui-notify-1',
    method: 'notify',
    message: 'Status updated',
  });

  assert.equal(response, undefined);
  assert.deepEqual(host.events, []);
});

test('REQ-IDE-007 AC2: malformed or non-confirm Pi UI requests fail closed before host UI', async () => {
  const host = new RecordingApprovalHost();
  const bridge = new ApprovalBridge(host);

  await assert.rejects(
    bridge.handlePiRequest({
      type: 'extension_ui_request',
      id: 'ui-request-3',
      method: 'input',
      title: 'Untrusted input',
      message: manifest.id,
    }),
    (error: unknown) => error instanceof ApprovalBridgeError && error.code === 'UNSUPPORTED_UI_REQUEST',
  );
  assert.deepEqual(host.events, []);
});
