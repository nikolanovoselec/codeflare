import type { BackendKind } from './backend.ts';
import { notImplemented } from './not-implemented.ts';

export interface WebviewDocumentOptions {
  readonly backend: BackendKind;
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri: string;
}

export interface WebviewDocument {
  readonly html: string;
  readonly csp: string;
  readonly localResourceRoots: readonly ['webview'];
  readonly enableCommandUris: false;
  readonly enableNavigation: false;
}

export function createWebviewDocument(options: WebviewDocumentOptions): WebviewDocument {
  void options;
  return notImplemented('strict local webview CSP document');
}
