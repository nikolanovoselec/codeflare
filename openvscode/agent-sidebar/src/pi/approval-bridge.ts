import { notImplemented } from '../not-implemented.ts';

export type ApprovalOperation = 'edit' | 'write' | 'bash' | 'unknown';

export interface ApprovalManifest {
  readonly id: string;
  readonly operation: ApprovalOperation;
  readonly canonicalTarget: string;
  readonly baseHash: string;
  readonly resultHash: string;
  readonly previewId: string;
  readonly expiresAt: number;
  readonly nonce: string;
}

export interface ApprovalHost {
  loadManifest(opaqueId: string): Promise<ApprovalManifest>;
  openDiff(manifest: ApprovalManifest): Promise<void>;
  confirm(manifest: ApprovalManifest): Promise<boolean>;
}

export interface PiExtensionUiRequest {
  readonly type: 'extension_ui_request';
  readonly id: string;
  readonly method: string;
  readonly title?: string;
  readonly message?: string;
}

export interface PiExtensionUiResponse {
  readonly type: 'extension_ui_response';
  readonly id: string;
  readonly confirmed: boolean;
}

export type ApprovalBridgeErrorCode =
  | 'UNSUPPORTED_UI_REQUEST'
  | 'INVALID_APPROVAL_ID'
  | 'INVALID_MANIFEST'
  | 'EXPIRED_APPROVAL';

export class ApprovalBridgeError extends Error {
  readonly code: ApprovalBridgeErrorCode;

  constructor(code: ApprovalBridgeErrorCode) {
    super(`Pi approval bridge error: ${code}`);
    this.name = 'ApprovalBridgeError';
    this.code = code;
  }
}

export class ApprovalBridge {
  readonly #host: ApprovalHost;

  constructor(host: ApprovalHost) {
    this.#host = host;
  }

  async handlePiRequest(request: PiExtensionUiRequest): Promise<PiExtensionUiResponse> {
    void request;
    void this.#host;
    return notImplemented('extension-host Pi approval bridge');
  }
}
