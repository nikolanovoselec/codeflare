import type { BackendKind } from './backend.ts';

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
  // OpenVSCode's pinned host source is `'self' https://*.vscode-cdn.net`.
  // That single quote is CSP syntax and cannot terminate the double-quoted
  // content attribute. Other generated attribute values retain the stricter
  // quote rejection; double quotes, angle brackets, and line breaks always fail.
  const unsafeCspSource = /[\r\n<>"]/.test(options.cspSource);
  const unsafeGeneratedValue = [options.nonce, options.scriptUri, options.styleUri]
    .some((value) => /[\r\n<>"']/.test(value));
  if (unsafeCspSource || unsafeGeneratedValue) {
    throw new Error('Unsafe webview document option');
  }

  const csp = [
    "default-src 'none'",
    `img-src ${options.cspSource}`,
    `font-src ${options.cspSource}`,
    `style-src ${options.cspSource}`,
    `script-src 'nonce-${options.nonce}'`,
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const label = options.backend === 'pi' ? 'Pi' : 'Claude Code';
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${options.styleUri}">
  <title>${label}</title>
</head>
<body>
  <main id="app" aria-label="${label} sidebar"></main>
  <script nonce="${options.nonce}" src="${options.scriptUri}"></script>
</body>
</html>`;

  return {
    html,
    csp,
    localResourceRoots: ['webview'],
    enableCommandUris: false,
    enableNavigation: false,
  };
}
