import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const manifestContent = JSON.stringify(manifest);
const manifestDigest = createHash('sha256').update(manifestContent).digest('hex');
const approvalReference = `${manifest.id}:${manifestDigest}`;

class RecordingApprovalHost implements ApprovalHost {
  readonly events: string[] = [];
  approved = false;

  manifestContent = JSON.stringify(manifest);

  async loadManifest(opaqueId: string): Promise<string> {
    this.events.push(`load:${opaqueId}`);
    return this.manifestContent;
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
    message: approvalReference,
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
    message: approvalReference,
  });

  assert.deepEqual(response, {
    type: 'extension_ui_response',
    id: 'ui-request-2',
    confirmed: false,
  });
  assert.equal(host.events.at(-1), `confirm:${manifest.id}`);
});

test('REQ-IDE-007 AC2: substituted approval manifest content is rejected before preview or confirmation', async () => {
  const host = new RecordingApprovalHost();
  host.manifestContent = JSON.stringify({ ...manifest, canonicalTarget: '/home/user/workspace/substituted.ts' });
  const bridge = new ApprovalBridge(host);

  await assert.rejects(
    bridge.handlePiRequest({
      type: 'extension_ui_request',
      id: 'ui-request-substituted',
      method: 'confirm',
      message: approvalReference,
    }),
    (error: unknown) => error instanceof ApprovalBridgeError && error.code === 'INVALID_MANIFEST',
  );
  assert.deepEqual(host.events, [`load:${manifest.id}`]);
});

test('REQ-IDE-007 AC2 + REQ-IDE-008 AC1: cancellation denies a pending approval and ignores its late modal answer', async () => {
  let enterConfirmation = (): void => undefined;
  let resolveConfirmation = (_approved: boolean): void => undefined;
  const entered = new Promise<void>((resolve) => { enterConfirmation = resolve; });
  const decision = new Promise<boolean>((resolve) => { resolveConfirmation = resolve; });
  const host = new RecordingApprovalHost();
  host.confirm = async (value) => {
    host.events.push(`confirm:${value.id}`);
    enterConfirmation();
    return decision;
  };
  const bridge = new ApprovalBridge(host) as ApprovalBridge & {
    handlePiRequest(request: Parameters<ApprovalBridge['handlePiRequest']>[0], signal?: AbortSignal): ReturnType<ApprovalBridge['handlePiRequest']>;
  };
  const controller = new AbortController();

  const pending = bridge.handlePiRequest({
    type: 'extension_ui_request',
    id: 'ui-request-cancelled',
    method: 'confirm',
    title: 'Guarded operation',
    message: approvalReference,
  }, controller.signal);
  await entered;
  controller.abort();

  assert.deepEqual(await pending, {
    type: 'extension_ui_response',
    id: 'ui-request-cancelled',
    confirmed: false,
  });
  resolveConfirmation(true);
  await Promise.resolve();
  assert.equal(host.events.filter((event) => event.startsWith('confirm:')).length, 1);
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
