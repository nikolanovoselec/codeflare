import { describe, it, expect } from 'vitest';
import {
  SPECIAL_FOLDERS,
  ALWAYS_VISIBLE_SPECIAL_PREFIXES,
  getSpecialFolder,
} from '../../lib/special-folders';

// Real-test gut-check: every assertion below would fail if the
// special-folders registry were mutated incorrectly. None of them
// re-implement the production filter; they pin the contract that
// StorageBrowser + FileList + entrypoint.sh + RCLONE_FILTERS_COMMON all
// rely on staying in sync.

// REQ-VAULT-001 AC6 (R2 storage panel surfaces Workspace/Vault/Uploads/Temporary as special folders with container-path tooltip)
describe('SPECIAL_FOLDERS registry / REQ-VAULT-001 AC6 (R2 panel surfaces special folders)', () => {
  // REQ-VAULT-001 AC6 (four special-folder entries surfaced at bucket root)
  it('covers the four expected prefixes in canonical order', () => {
    // Prefix order is load-bearing: the Storage panel relies on
    // ALWAYS_VISIBLE_SPECIAL_PREFIXES.filter() preserving registry
    // order, and the UI test relies on Workspace being the first entry
    // (excluded from the always-visible set).
    expect(SPECIAL_FOLDERS.map((f) => f.prefix)).toEqual([
      'workspace/',
      'Vault/',
      'Uploads/',
      'Temporary/',
    ]);
  });

  // REQ-VAULT-001 AC6 (tooltip surfaces in-container path; must match where entrypoint mkdirs the folder)
  it('every entry carries an in-container path under /home/user/', () => {
    // Container paths are surfaced in the tooltip body. The auto-create
    // logic in entrypoint.sh init_user_vault() and the bisync filters in
    // RCLONE_FILTERS_COMMON must materialise files at exactly the path
    // shown here, otherwise the tooltip lies to the user.
    for (const f of SPECIAL_FOLDERS) {
      expect(f.containerPath.startsWith('/home/user/')).toBe(true);
    }
  });

  // REQ-VAULT-001 AC6 (registry consistency: prefix label and container path must agree)
  it('container path basename matches the prefix label semantically', () => {
    // Catches a future entry that disagrees between its R2 prefix and
    // the container directory it claims to materialise at.
    for (const f of SPECIAL_FOLDERS) {
      const prefixBase = f.prefix.replace(/\/$/, '').toLowerCase();
      const containerBase = f.containerPath.split('/').pop()!.toLowerCase();
      expect(containerBase).toBe(prefixBase);
    }
  });

  // REQ-VAULT-001 AC6 (Workspace gated by workspace-sync preference; other three appear unconditionally)
  it('always-visible set excludes workspace (gated by sync preference)', () => {
    // Workspace is only shown when the user has enabled "Sync workspace
    // folder" in settings; the other three appear unconditionally.
    expect(ALWAYS_VISIBLE_SPECIAL_PREFIXES).not.toContain('workspace/');
    expect(ALWAYS_VISIBLE_SPECIAL_PREFIXES).toContain('Vault/');
    expect(ALWAYS_VISIBLE_SPECIAL_PREFIXES).toContain('Uploads/');
    expect(ALWAYS_VISIBLE_SPECIAL_PREFIXES).toContain('Temporary/');
  });

  // REQ-VAULT-001 AC6 (lookup helper for caller code: null on non-match, exact case)
  it('getSpecialFolder returns null for non-special prefixes', () => {
    expect(getSpecialFolder('docs/')).toBeNull();
    expect(getSpecialFolder('')).toBeNull();
    // Case matters: the R2 prefix is exact-string. A lowercase 'vault/'
    // is a different folder from the registered 'Vault/'.
    expect(getSpecialFolder('vault/')).toBeNull();
  });

  // REQ-VAULT-001 AC6 (lookup helper returns the populated registry entry)
  it('getSpecialFolder returns the registry entry for an exact prefix match', () => {
    const vault = getSpecialFolder('Vault/');
    expect(vault).not.toBeNull();
    expect(vault!.label).toBe('Vault');
    expect(vault!.containerPath).toBe('/home/user/Vault');
  });

  // Project-wide no-em-dash rule (enforced globally; this test is a tooltip-content guard)
  it('descriptions are non-empty and ASCII-safe (no em-dashes)', () => {
    // Project rule: no em-dashes anywhere. Catch a future tooltip edit
    // that drops one in.
    for (const f of SPECIAL_FOLDERS) {
      expect(f.description.length).toBeGreaterThan(0);
      expect(f.description.includes('—')).toBe(false); // em-dash
      expect(f.description.includes('–')).toBe(false); // en-dash
    }
  });
});
