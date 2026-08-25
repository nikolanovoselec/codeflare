import { constants } from 'node:fs';
import { open, realpath, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

import { CancellationTokenSource, window, type CancellationToken } from 'vscode';

import type { ApprovalHost, ApprovalManifest } from './approval-bridge.ts';

const MANIFEST_ROOT = '/run/codeflare/openvscode/sidebar/pi/approvals';
const MAX_MANIFEST_BYTES = 1024 * 1024;

export class VsCodeApprovalHost implements ApprovalHost {
  async loadManifest(opaqueId: string): Promise<string> {
    const path = resolve(MANIFEST_ROOT, `${opaqueId}.json`);
    if (!path.startsWith(`${MANIFEST_ROOT}/`)) throw new Error('Invalid manifest path');
    if (await realpath(MANIFEST_ROOT) !== MANIFEST_ROOT) throw new Error('Invalid manifest root');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      const currentUid = process.getuid?.();
      if (
        !stat.isFile() ||
        stat.size < 2 ||
        stat.size > MAX_MANIFEST_BYTES ||
        stat.mode & 0o077 ||
        (currentUid !== undefined && stat.uid !== currentUid)
      ) {
        throw new Error('Invalid approval manifest');
      }
      return handle.readFile({ encoding: 'utf8' });
    } finally {
      await handle.close();
      await unlink(path).catch(() => undefined);
    }
  }

  confirm(_manifest: ApprovalManifest): Promise<boolean> {
    return Promise.resolve(true);
  }

  select(title: string, options: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
    return withCancellation(signal, (token) => window.showQuickPick([...options], {
      title,
      ignoreFocusOut: true,
    }, token));
  }

  input(title: string, placeholder?: string, signal?: AbortSignal): Promise<string | undefined> {
    return withCancellation(signal, (token) => window.showInputBox({
      title,
      placeHolder: placeholder,
      ignoreFocusOut: true,
    }, token));
  }
}

async function withCancellation<T>(
  signal: AbortSignal | undefined,
  show: (token: CancellationToken) => PromiseLike<T | undefined>,
): Promise<T | undefined> {
  const cancellation = new CancellationTokenSource();
  const abort = (): void => cancellation.cancel();
  if (signal?.aborted) cancellation.cancel();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    return await show(cancellation.token);
  } finally {
    signal?.removeEventListener('abort', abort);
    cancellation.dispose();
  }
}
