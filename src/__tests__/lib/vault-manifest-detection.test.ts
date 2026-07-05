import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectVaultFileHashes,
  changedVaultFilesIn,
  commitVaultManifestTo,
} from '../../../preseed/agents/pi/extensions/vault-manifest-fs';

/**
 * REQ-VAULT — vault-extract change detection is content-hash based, so it is
 * immune to the R2 restore that rewrites every vault file's mtime to
 * download-time. This is the regression oracle: the old `-newer marker` /
 * `statSync().mtimeMs > since` detector would flag the whole vault as changed
 * after a restore; the hash-based detector flags nothing when the bytes are
 * unchanged. If detection ever reverts to mtimes, the "restore" case below fails.
 */
describe('vault-manifest content-hash detection', () => {
  let vault: string;
  let manifest: string;

  const write = (rel: string, body: string) => {
    const abs = join(vault, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
    return abs;
  };

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'codeflare-vault-manifest-'));
    manifest = join(vault, 'graphify-out', 'vault-extract-manifest.json');
    write('Notes/a.md', 'alpha');
    write('Notes/sub/b.md', 'bravo');
    write('Inbox/c.md', 'charlie');
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('reports every file as new when no manifest exists yet (first boot)', () => {
    const changed = changedVaultFilesIn(vault, manifest);
    expect(changed.map((p) => p.slice(vault.length + 1)).sort()).toEqual([
      'Inbox/c.md',
      'Notes/a.md',
      'Notes/sub/b.md',
    ]);
  });

  it('reports nothing immediately after committing the baseline', () => {
    commitVaultManifestTo(vault, manifest);
    expect(changedVaultFilesIn(vault, manifest)).toEqual([]);
  });

  it('THE ORACLE: an R2-style restore (rewrite every file, fresh mtime, identical bytes) yields ZERO changes', () => {
    commitVaultManifestTo(vault, manifest);
    // Simulate the restore: re-materialise every file with its OWN bytes. This is
    // exactly what `rclone sync` does — new mtime, unchanged content. A mtime-based
    // detector would now return all three files; a content-based one returns none.
    for (const rel of ['Notes/a.md', 'Notes/sub/b.md', 'Inbox/c.md']) {
      write(rel, readFileSync(join(vault, rel), 'utf8'));
    }
    expect(changedVaultFilesIn(vault, manifest)).toEqual([]);
  });

  it('reports exactly the file whose bytes changed', () => {
    commitVaultManifestTo(vault, manifest);
    write('Notes/a.md', 'alpha EDITED');
    const changed = changedVaultFilesIn(vault, manifest).map((p) => p.slice(vault.length + 1));
    expect(changed).toEqual(['Notes/a.md']);
  });

  it('reports a brand-new file added after the baseline', () => {
    commitVaultManifestTo(vault, manifest);
    write('Notes/new.md', 'fresh');
    const changed = changedVaultFilesIn(vault, manifest).map((p) => p.slice(vault.length + 1));
    expect(changed).toEqual(['Notes/new.md']);
  });

  it('never reports excluded subtrees (agent-owned / derived / manifest itself)', () => {
    commitVaultManifestTo(vault, manifest);
    write('Raw/Sessions/2026-07-05-foo.md', 'agent-owned capture');
    write('graphify-out/graph.json', '{"nodes":[]}');
    write('Library/Codeflare/treeview.plug.js', 'bundle');
    // The manifest lives under graphify-out/, so writing it must not self-trigger.
    expect(changedVaultFilesIn(vault, manifest)).toEqual([]);
  });

  it('hashes by content: identical bytes at two paths share a hash, different bytes differ', () => {
    write('Notes/same1.md', 'identical');
    write('Notes/same2.md', 'identical');
    const hashes = collectVaultFileHashes(vault);
    expect(hashes['Notes/same1.md']).toBe(hashes['Notes/same2.md']);
    expect(hashes['Notes/a.md']).not.toBe(hashes['Notes/same1.md']);
  });

  it('excludes the four codeflare-authoritative root pages from the manifest', () => {
    write('Index.md', 'x');
    write('README.md', 'x');
    write('CONFIG.md', 'x');
    write('STYLES.md', 'x');
    const hashes = collectVaultFileHashes(vault);
    for (const page of ['Index.md', 'README.md', 'CONFIG.md', 'STYLES.md']) {
      expect(hashes[page]).toBeUndefined();
    }
  });
});
