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

  async confirm(value: ApprovalManifest): Promise<boolean> {
    this.events.push(`confirm:${value.id}`);
    return this.approved;
  }

  async select(title: string, options: readonly string[]): Promise<string | undefined> {
    this.events.push(`select:${title}:${options.join('|')}`);
    return options[1];
  }

  async input(title: string, placeholder?: string): Promise<string | undefined> {
    this.events.push(`input:${title}:${placeholder ?? ''}`);
    return 'typed answer';
  }
}

test('Pi approval bridge compatibility validates a manifest before confirmation', async () => {
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
    `confirm:${manifest.id}`,
  ]);
  assert.deepEqual(response, {
    type: 'extension_ui_response',
    id: 'ui-request-1',
    confirmed: true,
  });
});

test('Pi approval bridge compatibility returns a correlated denial', async () => {
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

test('Pi approval bridge compatibility rejects substituted manifest content', async () => {
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

test('Pi approval bridge compatibility ignores a late modal answer after cancellation', async () => {
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

test('REQ-IDE-020: Pi RPC select and input dialogs return correlated values', async () => {
  const host = new RecordingApprovalHost();
  const bridge = new ApprovalBridge(host);

  assert.deepEqual(await bridge.handlePiRequest({
    type: 'extension_ui_request',
    id: 'ui-select',
    method: 'select',
    title: 'Choose one',
    options: ['First', 'Second'],
  }), {
    type: 'extension_ui_response',
    id: 'ui-select',
    value: 'Second',
  });
  assert.deepEqual(await bridge.handlePiRequest({
    type: 'extension_ui_request',
    id: 'ui-input',
    method: 'input',
    title: 'Type an answer',
    placeholder: 'Answer',
  }), {
    type: 'extension_ui_response',
    id: 'ui-input',
    value: 'typed answer',
  });
  assert.deepEqual(host.events, [
    'select:Choose one:First|Second',
    'input:Type an answer:Answer',
  ]);
});

test('REQ-IDE-020: Pi RPC dialog dismissal returns a correlated cancellation', async () => {
  const host = new RecordingApprovalHost();
  host.select = async () => undefined;
  const bridge = new ApprovalBridge(host);

  assert.deepEqual(await bridge.handlePiRequest({
    type: 'extension_ui_request',
    id: 'ui-cancelled',
    method: 'select',
    title: 'Choose one',
    options: ['First', 'Second'],
  }), {
    type: 'extension_ui_response',
    id: 'ui-cancelled',
    cancelled: true,
  });
});

test('Pi approval bridge compatibility rejects malformed or unsupported UI requests', async () => {
  const host = new RecordingApprovalHost();
  const bridge = new ApprovalBridge(host);

  for (const request of [
    { type: 'extension_ui_request' as const, id: 'ui-malformed', method: 'select', title: 'Untrusted input', options: [] },
    { type: 'extension_ui_request' as const, id: 'ui-editor', method: 'editor', title: 'Untrusted editor' },
    { type: 'extension_ui_request' as const, id: 'ui-unknown', method: 'futureBlockingDialog', title: 'Unknown dialog' },
  ]) {
    await assert.rejects(
      bridge.handlePiRequest(request),
      (error: unknown) => error instanceof ApprovalBridgeError && error.code === 'UNSUPPORTED_UI_REQUEST',
    );
  }
  assert.deepEqual(host.events, []);
});
