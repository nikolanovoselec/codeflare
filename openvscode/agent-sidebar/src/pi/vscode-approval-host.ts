import { constants } from 'node:fs';
import { open, realpath, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

import { window, workspace } from 'vscode';

import type { ApprovalHost, ApprovalManifest } from './approval-bridge.ts';

const MANIFEST_ROOT = '/tmp/codeflare-sidebar/pi/approvals';
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

  async openDiff(manifest: ApprovalManifest): Promise<void> {
    const content = previewText(manifest);
    const language = manifest.preview?.kind === 'diff' || manifest.operation === 'edit' || manifest.operation === 'write'
      ? 'diff'
      : 'text';
    const document = await workspace.openTextDocument({ content, language });
    await window.showTextDocument(document, { preview: true, preserveFocus: true });
  }

  async confirm(manifest: ApprovalManifest): Promise<boolean> {
    const choice = await window.showWarningMessage(
      `Approve ${manifest.toolName ?? manifest.operation ?? 'guarded'} operation?`,
      { modal: true },
      'Approve',
    );
    return choice === 'Approve';
  }
}

function previewText(manifest: ApprovalManifest): string {
  if (manifest.preview?.kind === 'diff') return manifest.preview.diff;
  if (manifest.preview?.kind === 'bash') {
    return `Working directory: ${manifest.preview.cwd}\n\n${manifest.preview.command}\n`;
  }
  if (manifest.preview?.kind === 'generic') {
    return `${manifest.preview.toolName}\n\n${JSON.stringify(manifest.preview.input, null, 2)}\n`;
  }
  return `${manifest.operation ?? 'operation'}: ${manifest.canonicalTarget ?? 'unknown target'}\n`;
}
